// The post-arm ranking pipeline — ONE module (PLAN-0.5.0 item 15, record 31). Every backend fuses
// its own arms (FTS, vector, graph -> RRF) and hands the existence-filtered rows here: libSQL,
// the Postgres store, and funes-cf's DO SQLite index. Before 0.5.0 funes-libsql and funes-engine
// each carried a "deliberate mirror" of this code; one copy is what lets three backends claim one
// RANKING_SEMANTICS_VERSION honestly.
//
// Placement (item 4's table): funes-shared, beside the mutex — funes-libsql and funes-engine both
// import it and funes-cf ranks above both. It imports only funes-core types and `zones.ts`, both
// of which load and bundle under workerd.
//
// Every constant and predicate here is FROZEN-ish: a change is a VERSIONED ranking change — bump
// the matching *_VERSION in serving-signature.ts and regenerate the recall goldens with a reviewed
// diff, in the same commit.
import type { RecallQuery, RecallResult, Trust } from "funes-core";
import { zoneOfFile, type Zone } from "./zones.ts";

/** The FTS arm's terms: Unicode letter/digit runs (RU recall, not ASCII-only) of two or more
 *  characters. The arm runs iff there is one — libSQL and the DO SQLite twin both build their MATCH
 *  from this, and the recall planner's `plan.arms` reads it, so the echo cannot drift from the arm. */
export function ftsTerms(query: string): string[] {
  return (query.match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length >= 2);
}

/** Rev 7 freshness (a): two fused RRF scores within this epsilon count as a tie (RRF produces
 *  frequent EXACT ties — same ranks across different arms sum to the same float). */
export const RRF_TIE_EPS = 1e-9;

/** What the recency tiebreak reads per row: the volatility flag and the freshness instant (epoch
 *  seconds, full precision — RecallResult.freshness is cut to the day, so the backend supplies it). */
export type TieMeta = { volatile?: boolean; fresh?: number | null };

/** Rev 7 freshness (a) — recency tiebreak, a versioned ranking change pinned by H5, applied to
 *  the RRF-ordered candidate list. Deliberately NOT a comparator handed to Array.sort: epsilon
 *  equality is non-transitive on epsilon-chains (a≈b, b≈c, a≉c), which violates the sort
 *  contract and makes chain order implementation-defined. This is a total run-grouping pass:
 *
 *  Run-cutting rule (HEAD-anchored): walk the list once; a run opens at the first unconsumed
 *  item (its HEAD) and extends over CONSECUTIVE items whose fused score is within RRF_TIE_EPS
 *  of the HEAD's score — anchored to the run head, not the previous item — so a run's total
 *  score spread is bounded by EPS and an epsilon-chain (s, s-0.6e-9, s-1.2e-9) cuts before the
 *  third item instead of gluing arbitrarily distant scores into one tie.
 *
 *  A run containing at least one volatile item is stable-sorted by freshness desc (nulls
 *  last) — that comparator is a total preorder, so the sort is well-defined and deterministic;
 *  runs with no volatile member keep RRF order. Runs concat back in place: the output is a
 *  deterministic permutation of the input, and RRF scores are never altered. */
export function recencyTiebreak<T extends { score: number }>(
  items: readonly T[],
  meta: (item: T) => TieMeta | undefined,
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

/** Move 5 (trust-aware ranking) — the per-trust multiplier applied to the fused RRF score to
 *  produce the ORDERING key. A thumb on the scale, NOT a gate (every weight is in (0,1], so no
 *  result is ever excluded — recall stays unrestricted + trust-labeled per S3). trusted is the
 *  ceiling (1.0); derived takes a small haircut; untrusted a larger but bounded one. The default
 *  spread is deliberately modest: it breaks a cross-trust RRF tie and closes a small relevance
 *  gap, but cannot bury a strongly-relevant untrusted hit under weak trusted noise (the RRF gap
 *  there exceeds 1 - untrusted weight). Versioned by TRUST_ADJUST_VERSION. */
export const TRUST_WEIGHT: Record<Trust, number> = {
  trusted: 1.0,
  derived: 0.95,
  untrusted: 0.85,
};

/** Move 5: the trust-adjusted ORDERING score — `rrfScore * weight(trust)`. The emitted
 *  RecallResult.score stays the raw RRF score (parity contract: "scores stay RRF, by design");
 *  this adjusted value is used ONLY to sort and to feed the recency tiebreak's run-cutting.
 *  A missing/unknown trust is treated as untrusted (deny-biased, matches ops.ts default). */
export function trustAdjust(rrfScore: number, trust: Trust | undefined): number {
  return rrfScore * (TRUST_WEIGHT[trust ?? "untrusted"] ?? TRUST_WEIGHT.untrusted);
}

/** Zone-weight: a CURATION prior, the zone analogue of TRUST_WEIGHT. A short/ambiguous query (e.g.
 *  "ada") should surface the curated `people/ada` WIKI page over the `out_distill/telegram/*`
 *  artifacts that merely mention the name. Like trust, a modest thumb on the ORDERING score only
 *  (the emitted RecallResult.score stays raw RRF — parity contract); never zero, so it RE-RANKS and
 *  never FILTERS (a strongly-relevant ingest hit still beats weak wiki noise — the RRF gap exceeds
 *  the spread). Versioned by ZONE_ADJUST_VERSION. */
export const ZONE_WEIGHT: Record<Zone, number> = {
  // Curated wiki is the ceiling. OUTPUT (machine digests / telegram distills) gets the stronger
  // haircut — it's the most disposable (a curated entity page is preferred over a distill that merely
  // mentions the name, and that noise is exactly what we want under the curated page). INCOMING (raw
  // ingest) stays GENTLER so the prior remains a THUMB not a gate: a strongly-relevant raw message
  // (multi-arm RRF lead) is often genuinely important and must stay findable (the trust-ranking
  // guardrail enforces this — incoming below ~0.8 buries it). Never zero -> never a filter.
  wiki: 1.0,
  output: 0.7,
  incoming: 0.8,
};

/** Ruling-B refinement (stack review 2026-07-02, Vlad-locked): out_distill/** is the DESIGNATED
 *  telegram recall layer — machine-curated, PII-redacted — so it ranks ABOVE raw ingest (0.8) but
 *  below hand-authored wiki (1.0). Generic OUTPUT 0.7 was demoting the very layer Ruling B promoted.
 *  Segment match at any depth (vault-v2 zone semantics). Versioned by DISTILL_ADJUST_VERSION. */
export const DISTILL_WEIGHT = 0.87;
const isDistill = (path: string): boolean => path.split("/").some((s) => s === "out_distill");

export function zoneAdjust(score: number, path: string): number {
  const zone = zoneOfFile(path);
  if (zone === "output" && isDistill(path)) return score * DISTILL_WEIGHT;
  return score * (ZONE_WEIGHT[zone] ?? ZONE_WEIGHT.wiki);
}

/** Entity boost (stack review B-1 follow-up, 2026-07-02): an exact-NAME query must surface the
 *  page NAMED that ("ada" → `people/ada`) over distill artifacts that merely mention the name —
 *  the measured failure was a 1.44× distill RRF lead burying the curated entity page. Trigger is
 *  deliberately HIGH-PRECISION: the normalized whole query equals the node's title or its id stem
 *  (the user typed the page's name); anything else is untouched, so ordinary queries never shift.
 *  ×1.5 outweighs the observed RRF lead plus the trust haircut. Ordering-score only (emitted score
 *  stays raw RRF — parity contract). Versioned by ENTITY_ADJUST_VERSION. */
export const ENTITY_BOOST = 1.5;
export function entityAdjust(score: number, query: string, title: string | null | undefined, id: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return score;
  const stem = (id.split("/").pop() ?? id).toLowerCase();
  const t = (title ?? "").trim().toLowerCase();
  return q === t || q === stem ? score * ENTITY_BOOST : score;
}

/** Move 5 (near-duplicate collapse) — two near-identical results collapse to the best
 *  (already-ordered-first) one, which absorbs the rest and carries a `duplicates` count of how
 *  many it stood in for. Collapse KEY = (trust, zone, normalized title), plus — ADR-0015 — the
 *  values of the star's DECLARED collapse keys (`memory.recall.collapse`) read from the row's
 *  `frontmatter`: a film and a book that share a title are distinct once `type` is declared. A
 *  value keys by its JSON form (1979 ≠ "1979"); an absent key keys as absent. Lookups use
 *  Object.hasOwn, never `in` (record 28: `in` matches Object.prototype names).
 *
 *  Why title-identity, NOT score-equality, is the signal: RRF produces FREQUENT exact ties (see
 *  recencyTiebreak) — distinct pages routinely share a fused score, so collapsing on score-within-
 *  EPS would wrongly fold genuinely-different content into one slot.
 *
 *  Deterministic and cheap: one linear pass over the already-ordered list, no embeddings, no extra
 *  queries; the first member of a cluster (best slot) is the keeper, so collapsing frees its
 *  lower-ranked twins' slots and later DISTINCT candidates backfill into the top-k. */
export function collapseDuplicates<
  T extends { id: string; title: string; path?: string; trust?: Trust; duplicates?: number;
              volatile?: boolean; freshness?: string; frontmatter?: RecallResult["frontmatter"] },
>(items: readonly T[], keys: readonly string[] = []): T[] {
  const out: T[] = [];
  const seen = new Map<string, T>(); // collapse key -> keeper
  const norm = (s: string) => s.trim().toLowerCase();
  const declared = [...new Set(keys)].sort();
  const valueOf = (fm: T["frontmatter"], k: string) => (fm && Object.hasOwn(fm, k) ? JSON.stringify(fm[k]) : "");
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
    let key = `${it.trust ?? "untrusted"}\x00${zone}\x00${norm(it.title)}`;
    for (const k of declared) key += `\x00${valueOf(it.frontmatter, k)}`;
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

/** THE pipeline, after fusion: trust-weight -> zone-weight -> entity-boost (one composed
 *  multiplicative ORDERING key) -> stable sort -> dup-collapse (declared keys) -> recency tiebreak.
 *  Returns every row, uncut — the caller slices to its cap and runs any rerank stage.
 *
 *  `rows` arrive in fused (RRF) order with the raw RRF `score`, which the output keeps (parity
 *  contract); only the ORDER changes. The sort is stable, so a tie the adjustments do not separate
 *  keeps its deterministic fusion order. The tiebreak runs over the ADJUSTED key, so ties resolve
 *  after trust, zone and entity have had their say, and before the cap so a tie run spanning the
 *  boundary still resolves the slot. `meta` answers the tiebreak per row. */
export function rankRecall(
  rows: readonly RecallResult[],
  q: Pick<RecallQuery, "query" | "collapse">,
  meta: (r: RecallResult) => TieMeta | undefined,
): RecallResult[] {
  const adj = new Map(rows.map((r) => [r.id, entityAdjust(zoneAdjust(trustAdjust(r.score, r.trust), r.path ?? `${r.id}.md`), q.query, r.title, r.id)]));
  const weighted = [...rows].sort((a, b) => adj.get(b.id)! - adj.get(a.id)!);
  const collapsed = collapseDuplicates(weighted, q.collapse);
  return recencyTiebreak(collapsed.map((r) => ({ r, score: adj.get(r.id)! })), (x) => meta(x.r)).map((x) => x.r);
}
