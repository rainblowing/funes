// The cross-container vault transaction lock (canon re-homing plan R2#2/#3, R4#8; conformance
// review major #4) — ONE lock per checkout, implemented as a libsql/SQLite lock DATABASE at
// <coordination dir>/lock.db acquired via BEGIN IMMEDIATE. Why this primitive: funes's mkdir
// write-lock reclaims on pidAlive(), which is MEANINGLESS across PID namespaces — a live holder in
// another container looks dead from this one and gets its lock stolen. SQLite's RESERVED lock is
// fcntl-based: valid across processes AND containers sharing one host volume, on both shipped
// platforms (Mac + NAS), with NO PID-reclamation protocol and no shell `flock` dependency.
// Crash-release is structural — the lock dies with its holder's process; the next acquirer
// proceeds after at most its own timeout, never a stale-PID stand-off.
//
// This is a LOCAL re-implementation of the proven twinkling shape (ts/src/control-plane/
// vault-lock.ts) — deliberately NOT imported cross-repo. Same lock.db, same `vault_lock` singleton
// row, so funes and the git sidecar's star-sync contend on the ONE lock (plan item 12's contract).
//
// The two libsql 0.5.x gotchas, inherited from the twinkling probe battery:
//   • an EMPTY `BEGIN IMMEDIATE` does not reliably pin RESERVED once the file is initialized —
//     the acquire anchors the transaction with a REAL write (UPDATE of the singleton row), which
//     also records acquired_at for operator debugging;
//   • the process holds ONE cached connection per lock.db for its lifetime and NEVER closes it:
//     POSIX fcntl drops ALL of a process's locks on a file when ANY of its fds for that file
//     closes, and this binding's close() cleanup is asynchronous — a per-acquire open/close cycle
//     silently evaporates a concurrently-held lock. Process exit releases everything at the OS
//     level (the crash-release contract).
//
// ONE deviation from the plane's shape, by need: funes write paths NEST (supersede() delegates to
// remember(); publishReindex() wraps indexDir()), so an in-process re-acquire is a reentrant
// depth++ instead of the plane's immediate throw. Ceiling (same as the existing write-lock):
// reentrancy is per-PROCESS, not per-task — serializing concurrent async writers INSIDE one
// process stays the store owner's job.
import Database from "libsql";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

type DB = InstanceType<typeof Database>;

/** Acquisition timed out — callers surface it (202/503 on a serving path), never block forever. */
export class CoordinationLockTimeoutError extends Error {
  // P3.15: explicit fields, not parameter properties (non-erasable TS — Node's loader refuses it).
  public dir: string;
  public timeoutMs: number;

  constructor(dir: string, timeoutMs: number) {
    super(`coordination lock busy after ${timeoutMs}ms (${join(dir, "lock.db")}) — another participant holds the vault transaction`);
    this.dir = dir;
    this.timeoutMs = timeoutMs;
    this.name = "CoordinationLockTimeoutError";
  }
}

export interface CoordinationLock {
  /** Idempotent. COMMITs the anchor write at depth 0 — the cached connection stays open (header). */
  release(): void;
}

export const DEFAULT_COORDINATION_TIMEOUT_MS = 5_000;

const isBusy = (e: unknown): boolean =>
  (e as { code?: string })?.code === "SQLITE_BUSY" || /SQLITE_BUSY|database is locked/i.test((e as Error)?.message ?? "");

interface CacheEntry {
  db: DB;
  depth: number; // in-process reentrancy (funes write paths nest — header)
}
/** One connection per lock.db for the PROCESS lifetime (never closed — fcntl hazard, header). */
const connections = new Map<string, CacheEntry>();

const cacheKey = (dir: string): string => {
  try {
    return realpathSync(dir); // one entry even when callers reach the dir via a symlinked path
  } catch {
    return dir;
  }
};

/** Acquire the per-checkout vault transaction lock. Synchronous under the hood: BEGIN IMMEDIATE +
 *  the anchor UPDATE either take RESERVED or wait inside the busy handler up to `timeoutMs`, then
 *  throw CoordinationLockTimeoutError. Any other failure (uncreatable dir, corrupt lock.db) throws
 *  as-is — callers treat both as "not acquired", deny-biased. */
export function acquireCoordinationLock(dir: string, opts: { timeoutMs?: number } = {}): CoordinationLock {
  const timeoutMs = Math.max(
    0,
    Math.floor(opts.timeoutMs ?? Number(process.env.FUNES_COORDINATION_TIMEOUT_MS ?? DEFAULT_COORDINATION_TIMEOUT_MS)),
  );
  mkdirSync(dir, { recursive: true });
  const key = cacheKey(dir);
  let entry = connections.get(key);
  if (!entry) {
    const db = new Database(join(dir, "lock.db"));
    try {
      // Idempotent seed (busy-bounded like the acquire itself — a cross-process holder makes it
      // wait, and a still-busy seed IS a timeout, classified as such). Schema is byte-identical to
      // twinkling's vault-lock so both participants share one table.
      db.exec(`PRAGMA busy_timeout=${timeoutMs};`);
      db.exec("CREATE TABLE IF NOT EXISTS vault_lock(id INTEGER PRIMARY KEY CHECK(id=1), acquired_at INTEGER NOT NULL)");
      db.exec("INSERT OR IGNORE INTO vault_lock(id, acquired_at) VALUES (1, 0)");
    } catch (e) {
      try {
        db.close(); // safe: nothing cached yet ⇒ no in-process holder whose fcntl locks this close could drop
      } catch {
        /* already unusable */
      }
      if (isBusy(e)) throw new CoordinationLockTimeoutError(dir, timeoutMs);
      throw e;
    }
    entry = { db, depth: 0 };
    connections.set(key, entry);
  }
  if (entry.depth > 0) {
    // Reentrant frame: this process already holds the vault transaction (a nested write path).
    entry.depth++;
    return makeRelease(entry);
  }
  try {
    entry.db.exec(`PRAGMA busy_timeout=${timeoutMs};`);
    entry.db.exec("BEGIN IMMEDIATE");
    entry.db.prepare("UPDATE vault_lock SET acquired_at=? WHERE id=1").run(Date.now()); // anchor write — RESERVED is now truly held
    entry.depth = 1;
  } catch (e) {
    try {
      if (entry.db.inTransaction) entry.db.exec("ROLLBACK"); // BEGIN landed but the anchor hit BUSY
    } catch {
      /* nothing held */
    }
    if (isBusy(e)) throw new CoordinationLockTimeoutError(dir, timeoutMs);
    throw e;
  }
  return makeRelease(entry);
}

function makeRelease(entry: CacheEntry): CoordinationLock {
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      if (entry.depth > 1) {
        entry.depth--;
        return; // an outer frame still holds the transaction
      }
      try {
        entry.db.exec("COMMIT"); // persists acquired_at (observability) and releases RESERVED
      } catch {
        try {
          entry.db.exec("ROLLBACK");
        } catch {
          /* transaction already gone */
        }
      }
      entry.depth = 0;
    },
  };
}

// ── async-scoped ownership + in-process FIFO mutex (Codex R1#10) ─────────────────────────────────
// The acquireCoordinationLock primitive above is reentrant per PROCESS (any depth>0 acquisition
// nests). That is wrong for concurrent async work: two unrelated broker writes in one process would
// BOTH see depth>0 and enter as "reentrant frames", overlapping canonical file ops before the
// store's narrower write mutex applies. withCoordinationLock (the ONLY path production code takes —
// funes-store, reindex, publication all route through coordination.ts to here) fixes this:
//   • reentrancy is tracked by ASYNC OWNER (AsyncLocalStorage): a nested withCoordinationLock on a
//     key the current async context already holds is a true reentrant no-op (supersede→remember,
//     publishReindex→indexDir), NEVER re-BEGINs, NEVER waits;
//   • an UNRELATED concurrent context QUEUES on an in-process FIFO mutex (bounded by timeoutMs) and
//     takes a fresh depth-0 cross-process lock only when it reaches the head — so no two contexts in
//     one process ever hold the vault transaction simultaneously.

/** The lock keys the CURRENT async context holds. Reentrancy is per async owner, not per process. */
const ownedKeys = new AsyncLocalStorage<ReadonlySet<string>>();

/** A per-key in-process mutex: `held` gates entry, `waiters` is the FIFO handoff queue. Handoff
 *  transfers the held state directly to the next waiter, so entry is never overlapped. */
interface InProcessMutex { held: boolean; waiters: Array<() => void> }
const mutexes = new Map<string, InProcessMutex>();

function mutexFor(key: string): InProcessMutex {
  let m = mutexes.get(key);
  if (!m) { m = { held: false, waiters: [] }; mutexes.set(key, m); }
  return m;
}

function makeInProcessReleaser(key: string, m: InProcessMutex): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = m.waiters.shift();
    if (next) next(); // hand the hold straight to the next waiter (held stays true — no gap)
    else { m.held = false; if (m.waiters.length === 0) mutexes.delete(key); } // free + GC empty mutex
  };
}

/** Acquire the in-process slot for `key`, FIFO, bounded by `timeoutMs` (a timed-out waiter removes
 *  itself from the queue and never held the lock, so the current holder is undisturbed). */
function acquireInProcess(dir: string, key: string, timeoutMs: number): Promise<() => void> {
  const m = mutexFor(key);
  if (!m.held) {
    m.held = true;
    return Promise.resolve(makeInProcessReleaser(key, m));
  }
  return new Promise<() => void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waiter = (): void => {
      if (timer) clearTimeout(timer);
      resolve(makeInProcessReleaser(key, m)); // held is already true (handed off)
    };
    m.waiters.push(waiter);
    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        const i = m.waiters.indexOf(waiter);
        if (i >= 0) m.waiters.splice(i, 1); // give up our slot; we never held it
        reject(new CoordinationLockTimeoutError(dir, timeoutMs));
      }, timeoutMs);
    }
  });
}

export async function withCoordinationLock<T>(dir: string, fn: () => Promise<T>, opts?: { timeoutMs?: number }): Promise<T> {
  const timeoutMs = Math.max(
    0,
    Math.floor(opts?.timeoutMs ?? Number(process.env.FUNES_COORDINATION_TIMEOUT_MS ?? DEFAULT_COORDINATION_TIMEOUT_MS)),
  );
  const key = cacheKey(dir);
  const owned = ownedKeys.getStore();
  if (owned?.has(key)) return fn(); // reentrant within THIS async owner — the frame already holds it

  const releaseInProc = await acquireInProcess(dir, key, timeoutMs);
  try {
    // In-process serialization above guarantees no other context in this process is mid-transaction
    // on the cached connection, so this is always a real depth-0 cross-process acquire (BEGIN
    // IMMEDIATE + anchor). Cross-CONTAINER contention is still handled by BEGIN IMMEDIATE's busy
    // timeout inside acquireCoordinationLock.
    const lock = acquireCoordinationLock(dir, { timeoutMs });
    try {
      const next = new Set(owned ?? []);
      next.add(key);
      return await ownedKeys.run(next, fn);
    } finally {
      lock.release();
    }
  } finally {
    releaseInProc();
  }
}
