/** RRF k — how flat the fusion is. 60 (the classic paper value, and A1's) was measured on the
 *  2026-07-21 personal-index sweep to swamp per-arm rank moves: the P2.10 title weighting
 *  reordered the FTS arm and moved ZERO fused metrics. k=5 won every metric on all three
 *  fixture sets (holdout MRR 0.724→0.849, hit@5 0.857→0.952, violations 5→4; dev+train agree,
 *  so not holdout-overfit). Adopted as the default 2026-07-21 (task P2.10b, Vlad-approved).
 *  A1 parity remains defined at the historical k=60 — parity.test.ts pins it explicitly. */
export const DEFAULT_RRF_K = 5;

/** Reciprocal Rank Fusion over ranked id-lists — the substrate-independent core of recall
 *  (ported from twinkling A1's `_rrf`). Higher score = better; items appearing across more
 *  lists / higher ranks win. Parity is asserted on this output (PLAN.md §5). */
export function rrfScores(rankLists: string[][], k = DEFAULT_RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of rankLists) {
    list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  }
  return scores;
}

/** Fused ordering. Legacy (default): exact ties keep Map insertion order — pinned behavior the
 *  goldens assert. `tieBreakIds` (v2 graph arm only, grill H2): ties break on id asc, making the
 *  output a total order independent of input row order. A versioned ranking change — never
 *  enabled on the legacy path. */
export function rrf(rankLists: string[][], k = DEFAULT_RRF_K, opts: { tieBreakIds?: boolean } = {}): string[] {
  const s = rrfScores(rankLists, k);
  const ids = [...s.keys()];
  if (opts.tieBreakIds) {
    return ids.sort((a, b) => ((s.get(b) ?? 0) - (s.get(a) ?? 0)) || (a < b ? -1 : a > b ? 1 : 0));
  }
  return ids.sort((a, b) => (s.get(b) ?? 0) - (s.get(a) ?? 0));
}
