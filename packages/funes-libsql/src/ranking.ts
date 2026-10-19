// libSQL's write-side field encoders (volatility, freshness, authored -> the REAL columns the
// recency tiebreak reads back). The ranking itself — adjustments, collapse, tiebreak — is ONE
// module, funes-shared/src/ranking.ts (PLAN-0.5.0 item 15); this file no longer mirrors it.
import type { MemoryItem } from "funes-core";

/** Content hash for incremental reindex — re-exported from funes-engine's generation.ts (THE one
 *  encoding module; pure, no PGLite-WASM import), so a vault keeps the same change-detection
 *  across a backend switch AND generation-v1 records can never disagree with the store hash. */
export { hashItem } from "funes-shared";

/** volatility/freshness frontmatter carried on MemoryItem past the funes-core type (metadata-only,
 *  excluded from the content hash, synced every remember() pass). */
export interface FreshnessFields {
  volatile?: boolean;
  freshness?: string | null;
}
export const isVolatile = (it: MemoryItem) => (it as MemoryItem & FreshnessFields).volatile === true;

/** Frontmatter freshness value -> epoch SECONDS or null (SQLite stores it as a REAL for the recency
 *  tiebreak). Lenient: an unparsable date is null (sorts last in a volatile tie). */
export function freshnessEpoch(it: MemoryItem): number | null {
  const v = (it as MemoryItem & FreshnessFields).freshness;
  if (v == null) return null;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t / 1000;
}

/** Provenance-v1 declared `authored` timestamp -> epoch SECONDS or null (stored as REAL). Same
 *  lenient parse as freshness; a distinct field (provenance authoring time, not the recency thumb). */
export function authoredEpoch(it: MemoryItem): number | null {
  if (it.authored == null) return null;
  const t = Date.parse(String(it.authored));
  return Number.isNaN(t) ? null : t / 1000;
}
