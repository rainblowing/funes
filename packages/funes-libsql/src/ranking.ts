// Ranking helpers — a deliberate MIRROR of the Postgres-dialect store's ranking (funes-engine/src/
// store.ts, "Move 5 / Rev 7" composition). Duplicated, NOT imported, so the libSQL backend stays
// independent of the Postgres store's module graph (node-postgres/pg). They are "FROZEN-ish"
// (changing them is a versioned ranking change against the H5 golden) — keep the two copies in sync;
// a future funes-shared package should host one copy. zoneOfFile IS shared from funes-engine (pure)
// so the zone logic can't drift.
import type { MemoryItem, Trust } from "funes-core";
import { zoneOfFile, type Zone } from "funes-shared";

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

/** Two fused RRF scores within this epsilon count as a tie (RRF produces frequent EXACT ties). */
export const RRF_TIE_EPS = 1e-9;

/** Recency tiebreak (H5-pinned) over the RRF-ordered list. HEAD-anchored run-cutting: a run extends
 *  over consecutive items within RRF_TIE_EPS of the run head's score; a run with any volatile member
 *  is stable-sorted by freshness desc (nulls last), others keep RRF order. Output is a deterministic
 *  permutation; scores never change. (Verbatim mirror of funes-engine.) */
export function recencyTiebreak<T extends { score: number }>(
  items: readonly T[],
  meta: (item: T) => { volatile?: boolean; fresh?: number | null } | undefined,
): T[] {
  const out: T[] = [];
  for (let i = 0; i < items.length; ) {
    const head = items[i]!.score;
    let j = i + 1;
    while (j < items.length && Math.abs(head - items[j]!.score) <= RRF_TIE_EPS) j++;
    const run = items.slice(i, j);
    if (run.length > 1 && run.some((r) => meta(r)?.volatile)) {
      run.sort((a, b) => {
        const fa = meta(a)?.fresh ?? null, fb = meta(b)?.fresh ?? null;
        if (fa === fb) return 0;
        if (fa === null) return 1;
        if (fb === null) return -1;
        return fb - fa;
      });
    }
    out.push(...run);
    i = j;
  }
  return out;
}

/** Per-trust multiplier applied to the fused RRF score to produce the ORDERING key (a thumb, not a
 *  gate). FROZEN-ish (versioned vs the H5 golden). */
export const TRUST_WEIGHT: Record<Trust, number> = { trusted: 1.0, derived: 0.95, untrusted: 0.85 };

/** Trust-adjusted ORDERING score — `rrfScore * weight(trust)`. The emitted RecallResult.score stays
 *  the raw RRF score; this is used ONLY to sort + feed the recency tiebreak. Unknown trust -> untrusted. */
export function trustAdjust(rrfScore: number, trust: Trust | undefined): number {
  return rrfScore * (TRUST_WEIGHT[trust ?? "untrusted"] ?? TRUST_WEIGHT.untrusted);
}

/** Per-zone CURATION multiplier (the zone analogue of TRUST_WEIGHT): lifts curated wiki pages over
 *  generated output + raw ingest so a short query surfaces the curated page, not the artifacts that
 *  mention it. ORDERING-only thumb (emitted score stays raw RRF); never zero -> re-ranks, never
 *  filters. FROZEN-ish (versioned vs the H5 golden). Keep in sync with funes-engine/src/store.ts. */
export const ZONE_WEIGHT: Record<Zone, number> = { wiki: 1.0, output: 0.7, incoming: 0.8 };

/** Ruling-B refinement (2026-07-02): out_distill/** = the designated telegram recall layer —
 *  above raw ingest (0.8), below wiki (1.0). MIRROR of funes-engine/src/store.ts. */
export const DISTILL_WEIGHT = 0.87;
const isDistill = (path: string): boolean => path.split("/").some((s) => s === "out_distill");

export function zoneAdjust(score: number, path: string): number {
  const zone = zoneOfFile(path);
  if (zone === "output" && isDistill(path)) return score * DISTILL_WEIGHT;
  return score * (ZONE_WEIGHT[zone] ?? ZONE_WEIGHT.wiki);
}

/** Entity boost (stack review B-1 follow-up): an exact-NAME query surfaces the page NAMED that
 *  ("ada" → people/ada) over artifacts that merely mention it. High-precision trigger: whole
 *  normalized query == title or id stem; ×1.5 on the ORDERING score only. (Mirror of funes-engine —
 *  see the full rationale there.) VERSIONED ranking change (H5). */
export const ENTITY_BOOST = 1.5;
export function entityAdjust(score: number, query: string, title: string | null | undefined, id: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return score;
  const stem = (id.split("/").pop() ?? id).toLowerCase();
  const t = (title ?? "").trim().toLowerCase();
  return q === t || q === stem ? score * ENTITY_BOOST : score;
}

/** Near-duplicate collapse — fold items sharing (normalized title, trust, zone) to their best slot,
 *  carrying a `duplicates` count. Title-identity (not score) is the signal. (Mirror of funes-engine.) */
export function collapseDuplicates<
  T extends { id: string; title: string; path?: string; trust?: Trust; duplicates?: number;
              volatile?: boolean; freshness?: string },
>(items: readonly T[], _scoreOf: (item: T) => number): T[] {
  const out: T[] = [];
  const seen = new Map<string, T>(); // collapse key -> keeper
  const norm = (s: string) => s.trim().toLowerCase();
  // Between two VOLATILE twins the later claim wins, regardless of fused score. Keeping the
  // best-scoring one meant collapse could hide the current value behind the outdated one — the
  // exact failure the state/event split exists to prevent, made invisible by the very mechanism
  // meant to tidy the results. Events (non-volatile) stay append-only: score order is the right
  // answer there and there is nothing to supersede.
  const supersedes = (a: T, b: T) =>
    a.volatile === true && b.volatile === true &&
    a.freshness != null && b.freshness != null && a.freshness > b.freshness;
  for (const it of items) {
    const zone = zoneOfFile(it.path ?? `${it.id}.md`);
    const key = `${it.trust ?? "untrusted"}\x00${zone}\x00${norm(it.title)}`;
    const keeper = seen.get(key);
    if (!keeper) { seen.set(key, it); out.push(it); continue; }
    if (supersedes(it, keeper)) {
      out[out.indexOf(keeper)] = it;          // take the keeper's rank, not a lower slot
      it.duplicates = (keeper.duplicates ?? 0) + 1;
      seen.set(key, it);
    } else {
      keeper.duplicates = (keeper.duplicates ?? 0) + 1;
    }
  }
  return out;
}
