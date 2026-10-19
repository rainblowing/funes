// The cross-star serve guard (H9) — PURE decision logic over a persisted index_scope signature,
// shared by both backends' guardedRead. Lives in the portable core (P3.14) so funes-libsql no longer
// reaches into funes-engine for it. The fs/yaml side of scope handling (reading star.yaml) and the
// crypto side (scopeHash) stay out of core: see funes-engine/src/scope.ts + funes-shared.
import type { ScopeSignature } from "./types.ts";

/** Why a cross-star read must be refused for this {persisted signature, current hash} pair, or null
 *  when the boundary holds. Missing signature / --ignore-scope build / hash mismatch each refuse. */
export function scopeRefusalReason(persisted: ScopeSignature | null, currentHash: string): string | null {
  if (!persisted || !persisted.hash) {
    return "cross-star read refused — the index carries no index_scope signature; run a full `funes reindex` to stamp the boundary.";
  }
  if (persisted.ignoreScope) {
    return "cross-star read refused — the index was built with --ignore-scope (index_scope not enforced); run a full `funes reindex` WITHOUT --ignore-scope.";
  }
  if (persisted.hash !== currentHash) {
    return "cross-star read refused — star.yaml index_scope changed since the index was built (scope-hash mismatch); run a full `funes reindex` to re-establish the boundary.";
  }
  return null;
}

/** H9: the cross-star serve guard's refusal decision over a {scope-signature, reindex-dirty} tuple —
 *  the signature check (missing / --ignore-scope / hash-mismatch) PLUS an in-progress-reindex
 *  refusal: a full rebuild sets reindexDirty at begin (before it re-admits any row) and only
 *  re-stamps the signature at end, so refusing while dirty means nothing re-admitted mid-run is ever
 *  served. Shared by both backends' guardedRead. null = the boundary holds. */
export function guardRefusal(
  state: { scopeHash: string | null; ignoreScope: boolean; reindexDirty: boolean },
  expectedHash: string,
): string | null {
  if (state.reindexDirty) {
    return "cross-star read refused — a reindex is in progress (the index_scope boundary is not re-stamped yet); retry once it completes.";
  }
  return scopeRefusalReason(state.scopeHash ? { hash: state.scopeHash, ignoreScope: state.ignoreScope } : null, expectedHash);
}

/** PLAN-0.3.0 item 16: what a serving surface EXPECTS of the built scope, recomputed from live
 *  local policy on every check. Three cases, because collapsing any two of them was the bug:
 *
 *  - `{ hash, refuseWhileDirty }` — a DECLARED policy. Serving requires an equal hash AND
 *    `ignoreScope === false`. `refuseWhileDirty` is the CROSS-STAR posture: a foreign caller must
 *    not be served mid-rebuild, because the built scope is not re-stamped until the run's prune.
 *    An OWN-STAR surface sets it false deliberately — at the moment a local reindex starts, the
 *    built scope still equals the policy that produced it, so a dirty refusal buys no safety and
 *    costs the operator their own daemon for the length of every rebuild.
 *  - `{ refusal }` — the desired scope itself cannot be established (an absent or invalid manifest
 *    on a governed cross-star boundary). Fail closed.
 *  - `null` — NO declared policy at all (a configless own-star vault). There is nothing to enforce,
 *    so enforcing an empty-list hash would refuse every configless index ever built. */
export type ScopeExpectation =
  | { refusal: string }
  | { hash: string; refuseWhileDirty: boolean }
  | null;

/** The refusal decision for one {built state, desired expectation} pair — the ONE place the two
 *  scopes meet, so a serving surface cannot hold a private opinion about what "agrees" means. */
export function expectationRefusal(
  state: { scopeHash: string | null; ignoreScope: boolean; reindexDirty: boolean },
  expected: ScopeExpectation,
): string | null {
  if (expected === null) return null;
  if ("refusal" in expected) return expected.refusal;
  if (expected.refuseWhileDirty && state.reindexDirty) {
    return "cross-star read refused — a reindex is in progress (the index_scope boundary is not re-stamped yet); retry once it completes.";
  }
  return scopeRefusalReason(state.scopeHash ? { hash: state.scopeHash, ignoreScope: state.ignoreScope } : null, expected.hash);
}
