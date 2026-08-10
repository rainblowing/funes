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
