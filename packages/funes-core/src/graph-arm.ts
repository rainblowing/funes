// E1 Rev 2 — the v2 bounded, deterministic graph arm (spec: twinkling docs/superpowers/specs/
// 2026-07-14-inbound-edge-arm-spec.md, gpt-5.6-sol grill folded).
//
// ONE pure helper owns ALL arm logic — seed weighting, hub eligibility, damping, max-
// aggregation, total ordering, truncation (grill M9: duplicating float scoring in two store
// files invites drift). Stores own only SQL row normalization + cap enforcement (distinct
// neighbors, row_number/lateral ≤ cap, nodes-join existence filter — grill M7/M8).
//
// Frozen constants (a priori, never tuned on the adoption fixture — grill M5):
//   DIR_W_IN = 0.7 · HUB_MAX = 32 (data-derived: personal star 2026-07-13 — only 4 targets
//   exceed 32: UI Translation 581, RAG 251, OpenClaw 61, Obsidian 53; entity pages ≤ 29)
//   CAP_OUT = 16 · CAP_IN = 8 (distinct neighbors per seed, enforced in SQL; re-checked here)

export const GRAPH_ARM_DIR_W_IN = 0.7;
export const GRAPH_ARM_HUB_MAX = 32;
export const GRAPH_ARM_CAP_OUT = 16;
export const GRAPH_ARM_CAP_IN = 8;

/** The graph arm resolved when FUNES_GRAPH_ARM is unset. Adopted "v2" (OUT-only bounded) on
 *  2026-07-22 (P2.11 / Wave-B re-adoption) after the pre-registered re-run at k=5 on the grown
 *  personal fixture: v2 improved the holdout gate on BOTH axes (MRR 0.849→0.873, violations 4→3),
 *  held train exactly, and lifted dev MRR 0.800→0.880. "v2in" (adds IN edges) matched v2's holdout
 *  but regressed train violations 3→7 (IN edges surface hub/MOC pages — the adjacent-topic bleed
 *  this targets), so it stays opt-in only. The env still pins "legacy" or "v2in" explicitly. */
export const DEFAULT_GRAPH_ARM = "v2";
export type GraphArm = "legacy" | "v2" | "v2in";
/** Resolve the arm from the env override, falling back to DEFAULT_GRAPH_ARM. The one place both
 *  backends agree on the default (no more divergent inline ternaries). */
export function resolveGraphArm(env: string | undefined): GraphArm {
  return env === "legacy" || env === "v2" || env === "v2in" ? env : DEFAULT_GRAPH_ARM;
}

/** One normalized neighbor row: seed → candidate, with the collection direction. */
export interface GraphNeighborRow {
  seed: string;
  candidate: string;
  dir: "out" | "in";
}

export interface GraphArmInput {
  /** union of top-k FTS + vector seed ids */
  seeds: readonly string[];
  /** seed id -> best (lowest, ZERO-based) rank across the FTS and vector lists (grill M4) */
  seedBestRank: ReadonlyMap<string, number>;
  /** SQL-normalized rows: distinct (seed,candidate) pairs, existence-filtered, per-seed capped, deterministically ordered */
  rows: readonly GraphNeighborRow[];
  /** seed id -> count(DISTINCT source) inbound (grill M6); consulted for hub gate + IN damping */
  seedInDegree: ReadonlyMap<string, number>;
  /** IN-contributor id -> count(DISTINCT target) outbound — a generic MOC citing many seeds is weak evidence (grill M6) */
  contribOutDegree: ReadonlyMap<string, number>;
  /** enable IN rows (FUNES_GRAPH_ARM=v2in); v2 = out-only */
  inbound: boolean;
  /** final list truncation (caller passes 4 × k) */
  graphListMax: number;
}

/** Build the single ordered graph list RRF consumes as its third arm. Deterministic: the
 *  output is a pure function of the input maps/rows — score desc, id asc total order.
 *  Aggregation is MAX over contributing seeds (pre-registered primary — one strong path beats
 *  accumulation, which would re-create hub floods; grill M4 records the corroboration variant
 *  as a possible follow-up, chosen never on the adoption fixture). */
export function buildGraphArm(input: GraphArmInput): string[] {
  const { seeds, seedBestRank, rows, seedInDegree, contribOutDegree, inbound, graphListMax } = input;
  const seedSet = new Set(seeds);
  const seedW = (s: string) => 1 / (1 + (seedBestRank.get(s) ?? seeds.length)); // zero-based rank
  const dampSeedIn = (s: string) => 1 / Math.log2(2 + (seedInDegree.get(s) ?? 0));
  const dampContribOut = (c: string) => 1 / Math.log2(2 + (contribOutDegree.get(c) ?? 0));

  const score = new Map<string, number>();
  const capCount = new Map<string, number>(); // defensive re-cap (SQL already enforces)
  for (const r of rows) {
    if (!r.candidate || seedSet.has(r.candidate)) continue; // seeds are already FTS/vec members
    if (r.dir === "in") {
      if (!inbound) continue;
      if ((seedInDegree.get(r.seed) ?? 0) > GRAPH_ARM_HUB_MAX) continue; // hub gate (seed side)
    }
    const capKey = `${r.dir}\x00${r.seed}`;
    const used = capCount.get(capKey) ?? 0;
    if (used >= (r.dir === "out" ? GRAPH_ARM_CAP_OUT : GRAPH_ARM_CAP_IN)) continue;
    capCount.set(capKey, used + 1);
    const s = r.dir === "out"
      ? seedW(r.seed)
      : seedW(r.seed) * GRAPH_ARM_DIR_W_IN * dampSeedIn(r.seed) * dampContribOut(r.candidate);
    const prev = score.get(r.candidate);
    if (prev === undefined || s > prev) score.set(r.candidate, s);
  }

  return [...score.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, graphListMax)
    .map(([id]) => id);
}
