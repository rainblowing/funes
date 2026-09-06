// FUNES_COORDINATION_DIR — the opt-in seam onto the per-checkout vault transaction lock (canon host
// re-homing plan item 12; conformance review major #4). When a composition sets the env var (the
// NAS passes /star/.twinkling-sync — the SAME lock.db the git sidecar's star-sync uses, so the
// one-lock contract is real), every funes WRITE path (FunesStore mutations, reindex) runs under
// the cross-container BEGIN-IMMEDIATE lock implemented in funes-libsql/src/coordination-lock.ts.
// Unset ⇒ pass-through: today's Mac single-process behaviour, byte for byte.
//
// The libsql-backed lock is imported LAZILY and only when configured, so a pglite-only deployment
// never loads the libsql native binding just because this seam exists.

/** The configured coordination dir, or null (feature off). */
export function coordinationDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const d = env.FUNES_COORDINATION_DIR?.trim();
  return d ? d : null;
}

/** Run `fn` under the shared vault transaction lock when FUNES_COORDINATION_DIR is set; plain
 *  call-through when it is not. Acquisition is timeout-bounded (never an indefinite block, R2#4) —
 *  a CoordinationLockTimeoutError propagates to the caller, deny-biased. */
export async function withCoordination<T>(fn: () => Promise<T>): Promise<T> {
  const dir = coordinationDir();
  if (!dir) return fn();
  const { withCoordinationLock } = await import("funes-libsql/coordination-lock");
  return withCoordinationLock(dir, fn);
}

/** Serialize `fn` on the configured coordination dir, or — when FUNES_COORDINATION_DIR is unset —
 *  on `fallbackDir` (never a pass-through). Publish uses THIS, not withCoordination: two publishers
 *  MUST NOT run unserialized (F1 — they clobber each other's build / a just-published gen db), so
 *  with no composition-configured lock the publish serializes on the publication home's own lock.
 *  Same libsql fcntl primitive either way; cross-process/container safe. (In-process concurrent
 *  publishers reenter the lock — the collision-proof temp-build+rename covers that case, header.) */
export async function withCoordinationOrLock<T>(fallbackDir: string, fn: () => Promise<T>): Promise<T> {
  const dir = coordinationDir() ?? fallbackDir;
  const { withCoordinationLock } = await import("funes-libsql/coordination-lock");
  return withCoordinationLock(dir, fn);
}
