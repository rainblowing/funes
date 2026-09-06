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
// daemon ever runs an in-process reindex. Known ceiling: pid reuse can make a dead holder look
// alive indefinitely, and a wedged-but-alive holder blocks until the caller's timeout (which names
// its pid and lock path so it can be cleared by hand); cross-HOST races don't apply (the lock home and the libsql index are both
// per-machine, un-synced). Lives HERE (not funes-core) because core is runtime-portable by lint
// (H7) and a file lock is fs/pid-bound by nature; funes-libsql imports it cross-package like the
// other shared helpers (zones, chunking).
import { mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export interface WriteLockOpts {
  /** how long acquire() waits on a live foreign holder (default 10s; env FUNES_LOCK_TIMEOUT_MS) */
  timeoutMs?: number;
  /** an OWNERLESS lock (crashed between mkdir and owner.json) older than this is reclaimed
   *  (default 30s). A live-pid lock is NEVER reclaimed by age — see acquireWriteLock. */
  ownerlessGraceMs?: number;
}

export interface WriteLock {
  release(): void;
}

const locksHome = (): string => process.env.FUNES_LOCK_DIR || join(homedir(), ".twinkling", "locks");

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

// `token` is optional: locks written before P3.15 carry only a pid, and a legacy lock held by a
// dead process must still be reclaimed IMMEDIATELY rather than sitting out the ownerless grace.
interface LockOwner { pid: number; token?: string }

function readOwner(lockPath: string): LockOwner | null {
  try {
    const o = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as Partial<LockOwner>;
    if (typeof o.pid !== "number") return null;
    return { pid: o.pid, token: typeof o.token === "string" ? o.token : undefined };
  } catch { return null; } // absent (mid-initialization or crashed) or corrupt
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
  const lockPath = lockPathFor(resource);
  const timeoutMs = opts.timeoutMs ?? Number(process.env.FUNES_LOCK_TIMEOUT_MS ?? 10_000);
  const ownerlessGraceMs = opts.ownerlessGraceMs ?? 30_000;

  const entry = held.get(lockPath);
  if (entry) {
    entry.depth += 1; // reentrant frame (remember() inside a reindex)
    return { release: () => releaseOne(lockPath) };
  }

  mkdirSync(locksHome(), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lockPath); // atomic: EEXIST ⇒ someone holds it
      const token = randomUUID();
      writeFileSync(
        join(lockPath, "owner.json"),
        JSON.stringify({ pid: process.pid, token, host: hostname(), resource: resolve(resource), acquiredAt: new Date().toISOString() }),
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
      } else if (!pidAlive(owner.pid)) {
        rmSync(lockPath, { recursive: true, force: true }); // demonstrably dead holder — reclaim
        continue;
      }
      // P3.15: a LIVE holder is never reclaimed by age. The old `|| age > staleMs` arm stole the
      // lock from a healthy long reindex — and first-run indexing with a real embedding model is
      // exactly the workload that runs past half an hour. A wedged-but-alive holder now blocks
      // until the caller's timeout, which reports its pid and path so it can be killed by hand.
      if (Date.now() >= deadline) {
        throw new Error(
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
// writes interleave. Mirrors the coordination lock's fix (Codex R1#10, coordination-lock.ts:155):
//   • reentrancy is tracked by ASYNC OWNER, so a nested call on a resource the current context
//     already holds is a true no-op and never waits;
//   • an unrelated concurrent context QUEUES on a per-resource FIFO and only then takes a fresh
//     cross-process lock, so no two contexts in one process hold the same index at once.
//
// ponytail: applied at the FunesStore mutation boundary, which is what makes canonical-markdown +
// index one operation. A caller reaching past it straight into `index.remember()` still nests on the
// process-global refcount — reindex is the only such caller and it holds the lock for its whole run.
const ownedResources = new AsyncLocalStorage<ReadonlySet<string>>();

interface InProcessMutex { held: boolean; waiters: Array<() => void> }
const mutexes = new Map<string, InProcessMutex>();

/** The in-process half of the lock. `timeoutMs` mirrors the cross-process budget: without it this
 *  queue was the ONLY unbounded wait in the system — acquireWriteLock gives up on a foreign holder
 *  after 10s, but a caller whose own `fn` never settled parked every subsequent writer in this
 *  process forever, with no error, no log, and nothing naming the resource. A hang that reports
 *  itself is a bug; a hang that does not is an outage. */
function acquireInProcess(key: string, timeoutMs: number): Promise<() => void> {
  let m = mutexes.get(key);
  if (!m) { m = { held: false, waiters: [] }; mutexes.set(key, m); }
  const mux = m;
  const releaser = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = mux.waiters.shift();
      if (next) next(); // hand the hold straight over — `held` stays true, so there is no gap
      else { mux.held = false; if (mux.waiters.length === 0) mutexes.delete(key); }
    };
  };
  if (!mux.held) { mux.held = true; return Promise.resolve(releaser()); }
  return new Promise((resolve, reject) => {
    const waiter = () => { clearTimeout(timer); resolve(releaser()); };
    const timer = setTimeout(() => {
      // Removing the waiter is load-bearing, not cleanup. release() hands the hold DIRECTLY to
      // waiters.shift() and leaves `held` true to avoid a gap — so handing it to a waiter whose
      // promise is already rejected would leave the mutex held by nobody, forever. That turns a
      // recoverable timeout into the permanent deadlock this timeout exists to prevent.
      const i = mux.waiters.indexOf(waiter);
      if (i >= 0) mux.waiters.splice(i, 1);
      if (!mux.held && mux.waiters.length === 0) mutexes.delete(key);
      reject(new Error(`write lock: waited ${timeoutMs}ms for an in-process holder of ${key} that never released — a writer is hung`));
    }, timeoutMs);
    timer.unref?.(); // a pending waiter must not hold the process open
    mux.waiters.push(waiter);
  });
}

/** Run `fn` holding the cross-process write lock for `resource`, serialized against other async
 *  contexts in this process. Use this — not `withWriteLock` — to make a multi-step mutation
 *  (canonical markdown write THEN index update) indivisible. */
export async function withScopedWriteLock<T>(resource: string, fn: () => Promise<T>, opts?: WriteLockOpts): Promise<T> {
  const key = lockPathFor(resource);
  const owned = ownedResources.getStore();
  if (owned?.has(key)) return fn(); // genuinely nested in this async context — already ours
  const releaseInProcess = await acquireInProcess(key, opts?.timeoutMs ?? Number(process.env.FUNES_LOCK_TIMEOUT_MS ?? 10_000));
  try {
    const lock = await acquireWriteLock(resource, opts);
    try {
      const next = new Set(owned ?? []);
      next.add(key);
      return await ownedResources.run(next, fn);
    } finally {
      lock.release();
    }
  } finally {
    releaseInProcess();
  }
}
