// E1 Rev 2 — the bounded, deterministic graph arm (spec: twinkling docs/superpowers/specs/
// 2026-07-14-inbound-edge-arm-spec.md, gpt-5.6-sol grill folded).
//
// ONE pure helper owns ALL arm logic — seed weighting, max-aggregation, total ordering, truncation
// (grill M9: duplicating float scoring in two store files invites drift). Stores own only SQL row
// normalization + cap enforcement (distinct neighbors, row_number ≤ cap, nodes-join existence filter
// — grill M7/M8).
//
// OUT edges only: "v2" adopted 2026-07-22 (P2.11) — MRR 0.849→0.873 and violations 4→3 on the
// holdout. The inbound variant ("v2in") regressed train violations 3→7 and left with its env knob
// in 0.6.0 (RAI-307); an eval sweep edits this file in a branch. CAP_OUT = 16 distinct neighbors per
// seed, enforced in SQL and re-checked here. A change here is a ranking change: bump RANKING_VERSION.

export const GRAPH_ARM_CAP_OUT = 16;

/** One normalized OUT row: seed → candidate. */
export interface GraphNeighborRow {
  seed: string;
  candidate: string;
}

export interface GraphArmInput {
  /** union of top-k FTS + vector seed ids */
  seeds: readonly string[];
  /** seed id -> best (lowest, ZERO-based) rank across the FTS and vector lists (grill M4) */
  seedBestRank: ReadonlyMap<string, number>;
  /** SQL-normalized rows: distinct (seed,candidate) pairs, existence-filtered, per-seed capped, deterministically ordered */
  rows: readonly GraphNeighborRow[];
  /** final list truncation (caller passes 4 × k) */
  graphListMax: number;
}

/** Build the single ordered graph list RRF consumes as its third arm. Deterministic: the output is
 *  a pure function of the input — score desc, id asc total order. Aggregation is MAX over
 *  contributing seeds (one strong path beats accumulation, which would re-create hub floods). */
export function buildGraphArm(input: GraphArmInput): string[] {
  const { seeds, seedBestRank, rows, graphListMax } = input;
  const seedSet = new Set(seeds);
  const seedW = (s: string) => 1 / (1 + (seedBestRank.get(s) ?? seeds.length)); // zero-based rank

  const score = new Map<string, number>();
  const capCount = new Map<string, number>(); // defensive re-cap (SQL already enforces)
  for (const r of rows) {
    if (!r.candidate || seedSet.has(r.candidate)) continue; // seeds are already FTS/vec members
    const used = capCount.get(r.seed) ?? 0;
    if (used >= GRAPH_ARM_CAP_OUT) continue;
    capCount.set(r.seed, used + 1);
    const s = seedW(r.seed);
    const prev = score.get(r.candidate);
    if (prev === undefined || s > prev) score.set(r.candidate, s);
  }

  return [...score.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, graphListMax)
    .map(([id]) => id);
}
