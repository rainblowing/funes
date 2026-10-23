// Cross-process write mutex for a funes index (slice 4, 2026-07-02). funes was single-writer BY
// CONVENTION only — the surface owns the index and `reindex-safe` stops it first, but nothing
// mechanical stopped a second writer (a parallel CLI reindex, an agent remember()) from
// interleaving with a rebuild and logically corrupting the index. This lock makes the invariant
// mechanical, which is what unlocks agent `remember()` and multi-star constellations (D-spec:
// second writers are scoped agents, never humans).
//
// Design: an mkdir lock (atomic everywhere) OUTSIDE the vault — lock state must never ride
// Dropbox/Obsidian sync. Keyed by the RESOLVED index path (basename + path hash), so two stars
// that happen to share a folder name get distinct locks. Liveness: a lock whose owner pid is
// demonstrably dead is reclaimed immediately; a LIVE holder is never reclaimed, at any age (P3.15 —
// the old age-based arm stole the lock from healthy long reindexes). Reentrant PER PROCESS via refcount — a full reindex holds the
// lock across begin → remember batches → prune → end without self-deadlock.
//
// ponytail: process-level mutex; serializing concurrent tasks INSIDE one process (the daemon's
// own writes) stays the store owner's job — upgrade to AsyncLocalStorage-scoped ownership if a
// daemon ever runs an in-process reindex. Known ceiling: a wedged-but-alive holder blocks until the
// caller's timeout (which names its pid and lock path so it can be cleared by hand), and so does a
// lock taken on another host — containers on one volume share the lock home but not a pid space, so
// such a lock is never reclaimed by pid (the home itself is never synced). Lives HERE (not funes-core)
// because the kernel imports only its allowlist (RAI-313) and a file lock is fs/pid-bound by nature.
import { mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { spawnSync } from "node:child_process";
import { locksHome } from "./funes-home.ts";
import { dirname, join, resolve, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { serialize } from "funes-core/internal";

export interface WriteLockOpts {
  /** how long acquire() waits on a live foreign holder (default 10s; the publish lock passes 0) */
  timeoutMs?: number;
  /** an OWNERLESS lock (crashed between mkdir and owner.json) older than this is reclaimed
   *  (default 30s). A live-pid lock is NEVER reclaimed by age — see acquireWriteLock. */
  ownerlessGraceMs?: number;
  /** The lock directory itself, instead of `lockPathFor(resource)`: the publish lock lives in its
   *  publication home (`<home>/.publish.lock`), so FUNES_HOME never splits it (RAI-309 Q4). */
  lockPath?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** A held lock refuses with this `code`, so a caller tells "busy" from any other failure. */
const busy = (message: string): Error => Object.assign(new Error(message), { code: "busy" });

export interface WriteLock {
  release(): void;
}

/** Deterministic lock path for a resource (an index.db file or a pgdata dir). */
export const lockPathFor = (resource: string): string => {
  const abs = resolve(resource);
  const h = createHash("sha256").update(abs).digest("hex").slice(0, 10);
  return join(locksHome(), `${basename(abs)}-${h}.lock`);
};

// in-process reentrancy: lock path → { hold depth, our acquisition token }
const held = new Map<string, { depth: number; token: string }>();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** P3.15: `catch { return false }` treated EVERY error as death. `process.kill(pid, 0)` raises
 *  EPERM when the process EXISTS but belongs to another user — reporting that as dead let us
 *  reclaim a live holder's lock. Only ESRCH means "no such process". */
const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
};

/** PID reuse: a live pid whose process STARTED after the lock was taken is not its holder (the
 *  holder died and the OS reused the pid). Elapsed time (`etime`, [[dd-]hh:]mm:ss), not `lstart`:
 *  lstart is local time with no zone, so a process under another TZ misreads it by hours. 1 s
 *  resolution; an unreadable answer (no `ps`, a parse failure) counts as the holder (fails closed).
 *  On Linux /proc answers first: the slim reader image has no `ps`, and its processes restart at the
 *  same low pids, so without it a lock left by a killed container names a live pid for good. */
const startedAfter = (pid: number, acquiredAt: number): boolean => {
  const proc = procStartMs(pid);
  if (proc !== null) return proc > acquiredAt + 2000;
  const out = (spawnSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "").trim();
  const m = out.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return false;
  const elapsedS = ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]);
  return Date.now() - elapsedS * 1000 > acquiredAt + 2000;
};

/** A process's start (epoch ms) from /proc: `starttime`, field 22 of /proc/<pid>/stat in USER_HZ
 *  (100) ticks since boot, plus /proc/stat's `btime`. Null where there is no readable /proc. */
const procStartMs = (pid: number): number | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]); // fields from 3 (state) on; comm may hold spaces
    const btime = Number(readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m)?.[1]);
    return Number.isInteger(ticks) && btime > 0 ? btime * 1000 + ticks * 10 : null;
  } catch { return null; }
};

/** A process's start, as an identity no wall-clock step moves: on Linux the boot id plus
 *  `starttime` (ticks since boot), elsewhere `ps` lstart in UTC (fixed at start, 1 s resolution).
 *  Null when unreadable. Equal to the recorded one ⇔ the pid still names the holder. */
const startId = (pid: number): string | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
  } catch { /* no /proc: ps */ }
  const out = (spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, TZ: "UTC", LC_ALL: "C" } }).stdout ?? "").trim();
  return out || null;
};
let selfStart: string | null | undefined;

// `token` is optional: locks written before P3.15 carry only a pid, and a legacy lock held by a
// dead process must still be reclaimed IMMEDIATELY rather than sitting out the ownerless grace.
// Locks written before 0.5.0 carry no `start`; those keep the acquiredAt rule.
interface LockOwner { pid: number; token?: string; acquiredAt?: number; host?: string; start?: string }

/** A lock from another host (a container on a shared volume, so another pid namespace) is never
 *  judged by this host's pids: it is kept (fails closed). */
const ownerAlive = (o: LockOwner): boolean => {
  if (o.host !== undefined && o.host !== hostname()) return true;
  if (!pidAlive(o.pid)) return false;
  if (o.start !== undefined) { const now = startId(o.pid); return now === null || now === o.start; }
  return !(o.acquiredAt !== undefined && startedAfter(o.pid, o.acquiredAt));
};

function readOwner(lockPath: string): LockOwner | null {
  try {
    const o = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as { pid?: unknown; token?: unknown; acquiredAt?: unknown; host?: unknown; start?: unknown };
    if (typeof o.pid !== "number") return null;
    const at = typeof o.acquiredAt === "string" ? Date.parse(o.acquiredAt) : NaN;
    const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
    return { pid: o.pid, token: str(o.token), acquiredAt: Number.isFinite(at) ? at : undefined, host: str(o.host), start: str(o.start) };
  } catch { return null; } // absent (mid-initialization or crashed) or corrupt
}

/** The locks in `dir` that acquireWriteLock would NOT reclaim right now — a live owner, or an
 *  ownerless one still inside its grace (an acquirer between mkdir and owner.json) — each named
 *  with its pid. `funes home move` refuses while any exists. */
export function heldLocks(dir: string, ownerlessGraceMs = 30_000): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.map((name) => lockHolder(join(dir, name), ownerlessGraceMs)).filter((h): h is string => h !== null);
}

/** `<lockPath> (pid N)` when acquireWriteLock would not reclaim that one lock right now, else null. */
export function lockHolder(lockPath: string, ownerlessGraceMs = 30_000): string | null {
  const young = (): boolean => { try { return Date.now() - statSync(lockPath).mtimeMs <= ownerlessGraceMs; } catch { return false; } };
  const owner = readOwner(lockPath);
  return (owner ? ownerAlive(owner) : young()) ? `${lockPath} (pid ${owner?.pid ?? "unknown"})` : null;
}

/** P3.15: release only removes the lock DIRECTORY if we still own it. Without the token check a
 *  process whose lock had been reclaimed under it would delete the successor's lock on release,
 *  handing the index to a third writer. */
function releaseOne(lockPath: string): void {
  const entry = held.get(lockPath);
  if (!entry) return;
  if (entry.depth > 1) { entry.depth -= 1; return; }
  held.delete(lockPath);
  if (readOwner(lockPath)?.token !== entry.token) return; // no longer ours — leave it alone
  rmSync(lockPath, { recursive: true, force: true });
}

export async function acquireWriteLock(resource: string, opts: WriteLockOpts = {}): Promise<WriteLock> {
  const lockPath = opts.lockPath ?? lockPathFor(resource);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ownerlessGraceMs = opts.ownerlessGraceMs ?? 30_000;

  const entry = held.get(lockPath);
  if (entry) {
    entry.depth += 1; // reentrant frame (remember() inside a reindex)
    return { release: () => releaseOne(lockPath) };
  }

  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lockPath); // atomic: EEXIST ⇒ someone holds it
      const token = randomUUID();
      if (selfStart === undefined) selfStart = startId(process.pid);
      writeFileSync(
        join(lockPath, "owner.json"),
        JSON.stringify({ pid: process.pid, token, host: hostname(), resource: resolve(resource), acquiredAt: new Date().toISOString(), start: selfStart ?? undefined }),
      );
      held.set(lockPath, { depth: 1, token });
      return { release: () => releaseOne(lockPath) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let age = Infinity;
      try { age = Date.now() - statSync(lockPath).mtimeMs; } catch { continue; } // vanished between mkdir and stat — retry now
      const owner = readOwner(lockPath);

      if (owner === null) {
        // No readable owner: either an acquirer is between its mkdir and its owner.json RIGHT NOW,
        // or one died in that window and left an ownerless lock nothing could ever reclaim. Only
        // the age distinguishes them, so wait out the grace period before breaking it.
        if (age > ownerlessGraceMs) { rmSync(lockPath, { recursive: true, force: true }); continue; }
      } else if (!ownerAlive(owner)) {
        rmSync(lockPath, { recursive: true, force: true }); // demonstrably dead holder — reclaim
        continue;
      }
      // P3.15: a LIVE holder is never reclaimed by age. The old `|| age > staleMs` arm stole the
      // lock from a healthy long reindex — and first-run indexing with a real embedding model is
      // exactly the workload that runs past half an hour. A wedged-but-alive holder now blocks
      // until the caller's timeout, which reports its pid and path so it can be killed by hand.
      if (Date.now() >= deadline) {
        throw busy(
          `funes: write lock busy for ${resource} (held by pid ${owner?.pid ?? "unknown"}, ${lockPath}) — another writer (a reindex?) is running; retry when it finishes, or remove that directory if the process is gone`,
        );
      }
      await sleep(150);
    }
  }
}

export async function withWriteLock<T>(resource: string, fn: () => Promise<T>, opts?: WriteLockOpts): Promise<T> {
  const lock = await acquireWriteLock(resource, opts);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

// ── async-scoped ownership + in-process FIFO queue (P3.15) ───────────────────────────────────────
// acquireWriteLock above is reentrant per PROCESS: any acquisition while `held.depth > 0` nests.
// That is right for a genuinely nested call (supersede → remember) and WRONG for two unrelated
// concurrent ones — both see depth > 0, both enter as "reentrant frames", and their canonical file
// writes interleave. So an unrelated concurrent context first QUEUES on the in-process mutex
// (mutex.ts: per-key FIFO, reentrant per async context) and only then takes the cross-process lock;
// a nested call re-enters both. The mutex is its own module since 0.5.0 item 14, so the edge writer
// takes the same serializer without this file's fs/pid half.
//
// ponytail: applied at the FunesStore mutation boundary, which is what makes canonical-markdown +
// index one operation. A caller reaching past it straight into `index.remember()` still nests on the
// process-global refcount — reindex is the only such caller and it holds the lock for its whole run.

/** Run `fn` holding the cross-process write lock for `resource`, serialized against other async
 *  contexts in this process. Use this — not `withWriteLock` — to make a multi-step mutation
 *  (canonical markdown write THEN index update) indivisible. */
export async function withScopedWriteLock<T>(resource: string, fn: () => Promise<T>, opts?: WriteLockOpts): Promise<T> {
  return serialize(opts?.lockPath ?? lockPathFor(resource), () => withWriteLock(resource, fn, opts), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}
