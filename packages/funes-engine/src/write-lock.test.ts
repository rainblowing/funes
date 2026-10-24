import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { acquireWriteLock, withWriteLock, withScopedWriteLock, lockPathFor, heldLocks } from "./write-lock.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "funes-lock-"));
  process.env.FUNES_HOME = home;
});
afterEach(() => {
  delete process.env.FUNES_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("lockPathFor", () => {
  test("keys by basename + full-path hash — same-named resources at different paths get DIFFERENT locks", () => {
    const a = lockPathFor("/tmp/one/personal/index.db");
    const b = lockPathFor("/tmp/two/personal/index.db");
    expect(a).not.toBe(b);
    expect(a).toContain("index.db-");
    expect(a.startsWith(home)).toBe(true);
  });

  test("same resource → same lock path (deterministic)", () => {
    expect(lockPathFor("/tmp/x/index.db")).toBe(lockPathFor("/tmp/x/index.db"));
  });
});

describe("acquire/release", () => {
  test("creates the lock dir with owner.json, release removes it", async () => {
    const lock = await acquireWriteLock("/tmp/star-a/index.db");
    const p = lockPathFor("/tmp/star-a/index.db");
    expect(existsSync(join(p, "owner.json"))).toBe(true);
    lock.release();
    expect(existsSync(p)).toBe(false);
  });

  test("reentrant in-process: nested acquires refcount, outermost release removes", async () => {
    const outer = await acquireWriteLock("/tmp/star-b/index.db");
    const inner = await acquireWriteLock("/tmp/star-b/index.db"); // e.g. remember() inside a reindex
    const p = lockPathFor("/tmp/star-b/index.db");
    inner.release();
    expect(existsSync(p)).toBe(true); // still held by the outer frame
    outer.release();
    expect(existsSync(p)).toBe(false);
  });

  test("a FOREIGN live-pid lock blocks until timeout", async () => {
    const p = lockPathFor("/tmp/star-c/index.db");
    mkdirSync(p, { recursive: true });
    // this process's pid is alive, but the in-process refcount doesn't know it → foreign holder
    writeFileSync(join(p, "owner.json"), JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    const t0 = Date.now();
    await expect(acquireWriteLock("/tmp/star-c/index.db", { timeoutMs: 300 })).rejects.toThrow(/write lock busy/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });

  test("a DEAD-pid lock is reclaimed immediately", async () => {
    const p = lockPathFor("/tmp/star-d/index.db");
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "owner.json"), JSON.stringify({ pid: 99999999, acquiredAt: new Date().toISOString() }));
    const lock = await acquireWriteLock("/tmp/star-d/index.db", { timeoutMs: 1000 });
    expect(existsSync(join(p, "owner.json"))).toBe(true); // OUR owner file now
    lock.release();
  });

  // PID reuse: the holder died and the OS handed its pid to an unrelated process. On the writer's machine a
  // 2-month-old lock named iconservicesd's pid, and `funes home move` refused on it.
  test("a REUSED pid (its process started after acquiredAt) is not the holder", async () => {
    const p = lockPathFor("/tmp/star-r/index.db");
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "owner.json"), JSON.stringify({ pid: process.pid, token: "dead-holder", acquiredAt: "2000-01-01T00:00:00.000Z" }));
    expect(heldLocks(join(home, "locks"))).toEqual([]);
    const lock = await acquireWriteLock("/tmp/star-r/index.db", { timeoutMs: 1000 });
    expect(readFileSync(join(p, "owner.json"), "utf8")).not.toContain("dead-holder");
    lock.release();
  });

  test("a live pid that started before acquiredAt is still the holder", () => {
    const p = lockPathFor("/tmp/star-s/index.db");
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "owner.json"), JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    expect(heldLocks(join(home, "locks"))).toHaveLength(1);
  });

  // Two containers on one named volume share the lock home but not a pid namespace: B's pid 1 (or a
  // pid B does not have) says nothing about A's holder, so a lock from another host is kept.
  test("a lock taken on another host is never judged by this host's pids", async () => {
    const live = lockPathFor("/tmp/star-h1/index.db"), dead = lockPathFor("/tmp/star-h2/index.db");
    for (const [p, pid] of [[live, process.pid], [dead, 99999999]] as const) {
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, "owner.json"), JSON.stringify({ pid, token: "other-host", host: `not-${hostname()}`, acquiredAt: "2000-01-01T00:00:00.000Z" }));
    }
    expect(heldLocks(join(home, "locks"))).toHaveLength(2);
    await expect(acquireWriteLock("/tmp/star-h2/index.db", { timeoutMs: 300 })).rejects.toThrow(/write lock busy/);
    expect(readFileSync(join(dead, "owner.json"), "utf8")).toContain("other-host");
  });

  // The holder's start is compared with the start it recorded, not with the wall-clock acquiredAt: a
  // clock stepped forward (a VM waking from sleep) moves every computed start past acquiredAt.
  test("a live holder is still the holder after the wall clock steps past its acquiredAt", async () => {
    const res = "/tmp/star-step/index.db";
    const lock = await acquireWriteLock(res);
    const f = join(lockPathFor(res), "owner.json");
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), acquiredAt: "2000-01-01T00:00:00.000Z" }));
    expect(heldLocks(join(home, "locks"))).toHaveLength(1);
    lock.release();
  });

  test("a holder's recorded pid now naming another process is not the holder", async () => {
    const res = "/tmp/star-reuse/index.db";
    // ps lstart has 1 s resolution (macOS): a child started in the runner's own second has the runner's start
    const wait = 1100 - (Date.now() - performance.timeOrigin);
    if (wait > 0) await Bun.sleep(wait);
    // a child takes the lock and exits holding it; then its pid "is reused" by this test runner
    const child = Bun.spawnSync(["bun", "-e", `const { acquireWriteLock } = await import(${JSON.stringify(join(import.meta.dir, "write-lock.ts"))}); await acquireWriteLock(${JSON.stringify(res)}); process.exit(0);`], {
      cwd: import.meta.dir, env: { ...process.env, FUNES_HOME: home },
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const f = join(lockPathFor(res), "owner.json");
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), pid: process.pid, token: "dead-holder" }));
    expect(heldLocks(join(home, "locks"))).toEqual([]);
    const lock = await acquireWriteLock(res, { timeoutMs: 1000 });
    expect(readFileSync(f, "utf8")).not.toContain("dead-holder");
    lock.release();
  });

  test("an OWNERLESS lock (crash between mkdir and owner.json) is reclaimed after the grace period", async () => {
    const p = lockPathFor("/tmp/star-e/index.db");
    mkdirSync(p, { recursive: true });
    const lock = await acquireWriteLock("/tmp/star-e/index.db", { timeoutMs: 1000, ownerlessGraceMs: 0 });
    lock.release();
  });

  // P3.15. The old reclaim was `(dead pid) || age > staleMs`, so a healthy long reindex — first-run
  // indexing with a real model is exactly that — had its lock stolen at 30 minutes and a second
  // writer walked into the index. Liveness is now the only reason to reclaim.
  test("a LIVE holder is NEVER reclaimed by age, however old the lock is", async () => {
    const res = "/tmp/star-live/index.db";
    const p = lockPathFor(res);
    mkdirSync(p, { recursive: true });
    // our own pid: demonstrably alive. mtime backdated well past any plausible staleness window.
    writeFileSync(join(p, "owner.json"), JSON.stringify({ pid: process.pid, token: "someone-elses-token" }));
    const old = new Date(Date.now() - 24 * 60 * 60_000);
    utimesSync(p, old, old);
    await expect(acquireWriteLock(res, { timeoutMs: 300, ownerlessGraceMs: 0 })).rejects.toThrow(/write lock busy/);
    expect(readFileSync(join(p, "owner.json"), "utf8")).toContain("someone-elses-token"); // untouched
    rmSync(p, { recursive: true, force: true });
  });

  // Without a token, a process whose lock had been reclaimed under it would delete the SUCCESSOR's
  // lock when it released, handing the index to a third writer.
  test("release does not remove a lock that has been reclaimed by someone else", async () => {
    const res = "/tmp/star-token/index.db";
    const p = lockPathFor(res);
    const lock = await acquireWriteLock(res, { timeoutMs: 500 });
    // simulate: our lock was reclaimed and a successor took it
    writeFileSync(join(p, "owner.json"), JSON.stringify({ pid: process.pid, token: "successor" }));
    lock.release();
    expect(existsSync(p)).toBe(true); // the successor still holds it
    expect(readFileSync(join(p, "owner.json"), "utf8")).toContain("successor");
    rmSync(p, { recursive: true, force: true });
  });
});

// RAI-309 Q4: the publish lock is the same primitive at a fixed directory in its publication home.
describe("the lockPath override", () => {
  test("the lock lives at the named directory, never under the funes home, and a second holder fails fast", async () => {
    const pubHome = mkdtempSync(join(tmpdir(), "funes-pubhome-"));
    const at = join(pubHome, ".publish.lock");
    let release!: () => void;
    const held = withScopedWriteLock(pubHome, () => new Promise<void>((r) => { release = r; }), { lockPath: at, timeoutMs: 0 });
    await Bun.sleep(10);
    expect(JSON.parse(readFileSync(join(at, "owner.json"), "utf8")).pid).toBe(process.pid);
    expect(existsSync(join(home, "locks"))).toBe(false);
    const t = performance.now();
    await expect(withScopedWriteLock(pubHome, async () => {}, { lockPath: at, timeoutMs: 0 })).rejects.toMatchObject({ code: "busy" });
    expect(performance.now() - t).toBeLessThan(500);
    release();
    await held;
    expect(existsSync(at)).toBe(false);
  });

  test("another process's live holder refuses at once as busy and names the directory", async () => {
    const at = join(mkdtempSync(join(tmpdir(), "funes-pubhome-")), ".publish.lock");
    mkdirSync(at);
    writeFileSync(join(at, "owner.json"), JSON.stringify({ pid: process.pid, token: "other", host: hostname() }));
    await expect(acquireWriteLock("x", { lockPath: at, timeoutMs: 0 })).rejects.toMatchObject({ code: "busy", message: expect.stringContaining(at) });
  });
});

describe("withWriteLock", () => {
  test("releases on success AND on throw", async () => {
    const p = lockPathFor("/tmp/star-f/index.db");
    const out = await withWriteLock("/tmp/star-f/index.db", async () => 42);
    expect(out).toBe(42);
    expect(existsSync(p)).toBe(false);
    await expect(withWriteLock("/tmp/star-f/index.db", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(existsSync(p)).toBe(false);
  });
});

// The in-process queue used to be the only unbounded wait in the system: acquireWriteLock gives up
// on a foreign holder after timeoutMs, but a hung holder INSIDE this process parked every later
// writer forever, silently. These two tests cover the timeout and the trap in implementing it.
describe("in-process queue is bounded", () => {
  test("a waiter gives up instead of parking forever, and names the resource", async () => {
    let releaseHolder!: () => void;
    const holder = withScopedWriteLock("hung", () => new Promise<void>((r) => { releaseHolder = r; }));
    await Bun.sleep(20); // let the holder actually take the lock

    const waited = withScopedWriteLock("hung", async () => "never runs", { timeoutMs: 60 });
    expect(waited).rejects.toThrow(/waited 60ms for an in-process holder .* that never released/);

    releaseHolder();
    await holder;
  });

  test("a timed-out waiter does not deadlock the mutex for everyone after it", async () => {
    // The trap: release() hands the hold straight to waiters.shift() and leaves `held` true so
    // there is no gap. Hand it to a waiter whose promise already rejected and the mutex is held by
    // nobody, permanently — a worse failure than the hang the timeout was added to fix.
    let releaseHolder!: () => void;
    const holder = withScopedWriteLock("recover", () => new Promise<void>((r) => { releaseHolder = r; }));
    await Bun.sleep(20);

    await expect(withScopedWriteLock("recover", async () => "x", { timeoutMs: 40 })).rejects.toThrow();
    releaseHolder();
    await holder;

    expect(await withScopedWriteLock("recover", async () => "acquired")).toBe("acquired");
  });
});
