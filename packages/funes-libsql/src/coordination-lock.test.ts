import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "libsql";
import {
  CoordinationLockTimeoutError, acquireCoordinationLock, withCoordinationLock,
} from "./coordination-lock.ts";

// The cross-container vault transaction lock (re-homing plan item 12; review major #4). True
// cross-PID-NAMESPACE coverage needs two containers (the NAS acceptance drill runs it there);
// the portable proxy here is two PROCESSES — the primitive (fcntl RESERVED via BEGIN IMMEDIATE)
// is namespace-blind by construction, unlike the pidAlive() reclamation it replaces.

const freshDir = () => mkdtempSync(join(tmpdir(), "funes-coord-"));

test("coordination lock: acquire creates lock.db with the shared vault_lock schema; release re-opens the door", () => {
  const dir = freshDir();
  const lock = acquireCoordinationLock(dir, { timeoutMs: 500 });
  expect(existsSync(join(dir, "lock.db"))).toBe(true);
  lock.release();
  lock.release(); // idempotent
  // schema is byte-compatible with twinkling's star-sync vault-lock (ONE lock contract): the
  // singleton row exists and the anchor write persisted acquired_at
  const db = new Database(join(dir, "lock.db"));
  const row = db.prepare("select id, acquired_at from vault_lock").get() as { id: number; acquired_at: number };
  expect(row.id).toBe(1);
  expect(row.acquired_at).toBeGreaterThan(0);
  db.close();
  // re-acquirable after release
  const again = acquireCoordinationLock(dir, { timeoutMs: 500 });
  again.release();
});

test("coordination lock: reentrant per process — nested funes write paths stack, inner release keeps the hold", async () => {
  const dir = freshDir();
  const outer = acquireCoordinationLock(dir, { timeoutMs: 500 });
  const inner = acquireCoordinationLock(dir, { timeoutMs: 500 }); // supersede()->remember() nesting
  inner.release();
  // still held after the inner frame: a SECOND process contending must time out
  const contender = await spawnHolder(dir, { mode: "try", timeoutMs: 250 });
  expect(contender.result).toBe("timeout");
  outer.release();
  // fully released: a second process now acquires cleanly
  const winner = await spawnHolder(dir, { mode: "try", timeoutMs: 500 });
  expect(winner.result).toBe("acquired");
});

test("coordination lock: cross-process contention -> CoordinationLockTimeoutError; holder crash releases structurally (no PID reclamation)", async () => {
  const dir = freshDir();
  // child acquires, signals, HOLDS, then exits WITHOUT releasing (the crash contract)
  const child = spawnHolder(dir, { mode: "hold", holdMs: 1500 });
  await (await child).held; // sentinel: the child truly holds RESERVED
  const t0 = Date.now();
  expect(() => acquireCoordinationLock(dir, { timeoutMs: 200 })).toThrow(CoordinationLockTimeoutError);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(150); // it WAITED (busy handler), not failed instantly
  await (await child).exited;
  // the holder died without COMMIT — fcntl released with its process; we acquire within one timeout
  const lock = acquireCoordinationLock(dir, { timeoutMs: 2000 });
  lock.release();
}, 15_000);

test("withCoordinationLock: releases on success AND on throw", async () => {
  const dir = freshDir();
  const out = await withCoordinationLock(dir, async () => 42, { timeoutMs: 500 });
  expect(out).toBe(42);
  await expect(withCoordinationLock(dir, async () => { throw new Error("boom"); }, { timeoutMs: 500 })).rejects.toThrow("boom");
  // both paths released: a fresh process can take the lock immediately
  const winner = await spawnHolder(dir, { mode: "try", timeoutMs: 500 });
  expect(winner.result).toBe("acquired");
});

test("withCoordinationLock: UNRELATED concurrent contexts do NOT overlap (Codex R1#10 — no confused reentrancy)", async () => {
  // The bug: process-wide depth reentrancy let a second concurrent broker write see depth>0 and
  // enter as a "reentrant frame" WITHOUT waiting, overlapping canonical file ops. With async-scoped
  // ownership + the in-process FIFO mutex, two unrelated contexts serialize.
  const dir = freshDir();
  const trace: string[] = [];
  const critical = (id: string) => withCoordinationLock(dir, async () => {
    trace.push(`enter-${id}`);
    await new Promise((r) => setTimeout(r, 30)); // hold across an await — the overlap window
    trace.push(`exit-${id}`);
  }, { timeoutMs: 2000 });

  await Promise.all([critical("A"), critical("B")]); // launched together, distinct async owners
  // strictly serialized: one whole critical section completes before the other enters (either order)
  expect(trace).toBeOneOf([
    ["enter-A", "exit-A", "enter-B", "exit-B"],
    ["enter-B", "exit-B", "enter-A", "exit-A"],
  ]);
});

test("withCoordinationLock: nested SAME-context calls are reentrant (supersede→remember, publish→indexDir)", async () => {
  const dir = freshDir();
  // A nested withCoordinationLock on the same key inside the same async owner must NOT deadlock and
  // must NOT wait — it rides the outer frame's hold.
  const out = await withCoordinationLock(dir, async () => {
    const inner = await withCoordinationLock(dir, async () => "inner-ran", { timeoutMs: 300 });
    return `outer:${inner}`;
  }, { timeoutMs: 300 });
  expect(out).toBe("outer:inner-ran");
  // fully released after the outer frame: a second process acquires cleanly
  const winner = await spawnHolder(dir, { mode: "try", timeoutMs: 500 });
  expect(winner.result).toBe("acquired");
});

test("withCoordinationLock: a queued waiter times out (deny-biased) while another context holds", async () => {
  const dir = freshDir();
  let releaseHolder!: () => void;
  const holderInside = new Promise<void>((r) => { releaseHolder = r; });
  const holder = withCoordinationLock(dir, async () => { await holderInside; }, { timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 20)); // let the holder enter its critical section
  // a second context queues and must give up within its own timeout rather than block forever
  await expect(withCoordinationLock(dir, async () => "never", { timeoutMs: 100 })).rejects.toThrow(CoordinationLockTimeoutError);
  releaseHolder();
  await holder;
});

// ── helper: a real second PROCESS working the same lock.db ───────────────────────────────────────
interface HolderOut { held: Promise<void>; exited: Promise<void>; result?: string }

async function spawnHolder(dir: string, opts: { mode: "hold" | "try"; holdMs?: number; timeoutMs?: number }): Promise<HolderOut & { result: string }> {
  const script = join(freshDir(), "holder.ts");
  const lockModule = join(import.meta.dir, "coordination-lock.ts");
  writeFileSync(
    script,
    `import { acquireCoordinationLock, CoordinationLockTimeoutError } from ${JSON.stringify(lockModule)};
const [dir, mode, holdMs, timeoutMs] = process.argv.slice(2);
try {
  const lock = acquireCoordinationLock(dir!, { timeoutMs: Number(timeoutMs ?? 500) });
  console.log("acquired");
  if (mode === "hold") {
    await new Promise((r) => setTimeout(r, Number(holdMs ?? 1000)));
    process.exit(0); // exit WITHOUT release — crash-release is structural
  }
  lock.release();
} catch (e) {
  console.log(e instanceof CoordinationLockTimeoutError ? "timeout" : "error:" + (e as Error).message);
}
`,
  );
  const proc = Bun.spawn(["bun", script, dir, opts.mode, String(opts.holdMs ?? 1000), String(opts.timeoutMs ?? 500)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exited = proc.exited.then(() => undefined);
  if (opts.mode === "try") {
    const text = await new Response(proc.stdout).text();
    await exited;
    return { held: Promise.resolve(), exited, result: text.trim().split("\n")[0] ?? "" };
  }
  // hold mode: "acquired" streams BEFORE the hold sleep — read incrementally until it shows up,
  // so the caller can contend while the child TRULY holds RESERVED.
  const held = (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += new TextDecoder().decode(value);
      if (buf.includes("acquired")) { reader.releaseLock(); return; }
      if (done) throw new Error(`holder never acquired (stdout: ${JSON.stringify(buf)})`);
    }
  })();
  return { held, exited, result: "held" };
}
