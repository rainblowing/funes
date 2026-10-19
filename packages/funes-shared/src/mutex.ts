// The in-process mutex (PLAN-0.5.0 item 14; record 24 §5): a per-key FIFO, reentrant per async
// context through AsyncLocalStorage. It was the in-process half of write-lock.ts; it left so the edge
// writer (funes-cf, one hold per DO instance) and the folder lock share one serializer. It imports
// only `node:async_hooks` (Workers provide `AsyncLocalStorage.run` from it; `enterWith` is absent
// there, so do not use it), which is why it is not in funes-core (H7) and why write-lock.ts's fs/pid
// half stays out of it. Home: funes-shared, per the workerd probe's placement table (record 36).
//
// ponytail: one mutex per key, process- (or isolate-) wide. Fine at personal scale; per-page keys
// only if throughput ever matters. Across processes or DO instances it does nothing.
import { AsyncLocalStorage } from "node:async_hooks";

/** A serializer as FunesStore takes it: run `fn` holding one hold, re-entering if already held. */
export type Serialize = <T>(fn: () => Promise<T>) => Promise<T>;

// keys this async context already holds — a nested call on one of them is a true no-op
const ownedKeys = new AsyncLocalStorage<ReadonlySet<string>>();

interface Mutex { held: boolean; waiters: Array<() => void> }
const mutexes = new Map<string, Mutex>();

/** `timeoutMs` bounds the wait: without it a holder whose `fn` never settles parks every later
 *  caller forever, with no error and nothing naming the key. A hang that reports itself is a bug; a
 *  hang that does not is an outage. A timed-out waiter is rejected; the hold is never stolen. */
function acquire(key: string, timeoutMs: number): Promise<() => void> {
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
    (timer as { unref?: () => void }).unref?.(); // a pending waiter must not hold the process open
    mux.waiters.push(waiter);
  });
}

/** Run `fn` holding `key`'s mutex: unrelated async contexts queue in arrival order; a call nested in
 *  a context that already holds `key` runs at once. */
export async function serialize<T>(key: string, fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  const owned = ownedKeys.getStore();
  if (owned?.has(key)) return fn();
  const release = await acquire(key, timeoutMs);
  try {
    return await ownedKeys.run(new Set([...(owned ?? []), key]), fn);
  } finally {
    release();
  }
}
