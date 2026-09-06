// The recall eval — the gate that says whether a change to retrieval made it BETTER (PLAN-0.2.1
// step 8). The methodology is twinkling's judged harness (scripts/drills/offline-eval.sh); the
// fixture and the gate live HERE, because a funes gate must not import twinkling.
//
// Four things the shell harness did not have, and each is load-bearing:
//
//  1. A RELEVANT SET, not one expected id. Real questions have several right answers, and scoring
//     one of them as the truth punishes a ranking that found another.
//  2. NEGATIVES. A wrong hit is not neutral. Without them, a change that drags an irrelevant page
//     into every top-5 scores identically to one that does not, as long as the relevant page is
//     still there.
//  3. MRR beside P@k. P@5 cannot tell rank 1 from rank 5, so a re-ranking regression that pushes
//     every answer to position 5 looks like a perfect score.
//  4. A FROZEN SPLIT. `seen` cases come from pages recall telemetry has recorded; `unseen` from
//     pages it never has. A harness built only from what the corpus is already good at measures
//     its own history — the `unseen` split is where a retrieval change actually shows.
//
// THE ANTI-PEEKING RULE. Thresholds and expected ids are authored BEFORE any run output is visible,
// and this module cannot author either: it refuses an incomplete fixture rather than filling gaps
// with what the index happens to return. A gate whose answers were derived from the system it
// gates is a mirror, not a gate.
import type { RecallResult } from "funes-core";

export interface EvalCase {
  /** Stable case id — the fixture is a frozen split, so cases are named, never positional. */
  id: string;
  query: string;
  /** ANY of these ids in the top-k is a hit. Authored by a human, before any run. */
  relevant: string[];
  /** Ids that must NOT appear in the top-k. A change that adds one of these is a regression even
   *  when the relevant page is still present. */
  negatives?: string[];
  split: "seen" | "unseen";
  note?: string;
}

export interface EvalThresholds {
  /** Minimum share of cases with a relevant id in the top-k. */
  pAtK: number;
  /** Minimum mean reciprocal rank of the first relevant hit. */
  mrr: number;
  /** MAXIMUM share of cases where a negative appears in the top-k. */
  negativeRate: number;
  /** The `unseen` split carries its own, lower P@k floor: it is the harder half by construction,
   *  and folding it into one number lets a strong `seen` score hide a weak one. */
  unseenPAtK: number;
}

export interface EvalFixture {
  /** What this fixture measures — the star, and the generation the baseline was taken on. */
  vault: string;
  k: number;
  thresholds: EvalThresholds;
  cases: EvalCase[];
  /** Set by the FIRST baseline run and never edited by hand: the numbers a later run is compared
   *  against, beside the generation they were measured on. */
  baseline?: { generation: string | null; pAtK: number; mrr: number; negativeRate: number; unseenPAtK: number; at: string };
}

export interface CaseResult {
  id: string;
  split: EvalCase["split"];
  query: string;
  /** 1-based rank of the first relevant id, or null when none is in the top-k. */
  rank: number | null;
  hit: boolean;
  /** Negatives that appeared in the top-k — named, so a regression report is actionable. */
  negativesHit: string[];
  returned: string[];
}

export interface EvalReport {
  k: number;
  cases: CaseResult[];
  pAtK: number;
  mrr: number;
  negativeRate: number;
  bySplit: Record<"seen" | "unseen", { n: number; pAtK: number; mrr: number }>;
  passed: boolean;
  failures: string[];
}

/** Refuse a fixture that cannot be scored honestly. Every one of these is a way to get a number
 *  that means nothing, and a number that means nothing is worse than no number. */
export function validateFixture(f: EvalFixture): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(f.k) || f.k < 1) errors.push("k must be a positive integer");
  if (f.cases.length === 0) errors.push("the fixture has no cases");
  const ids = new Set<string>();
  for (const c of f.cases) {
    const where = `case "${c.id}"`;
    if (!c.id) errors.push("a case has no id");
    if (ids.has(c.id)) errors.push(`duplicate case id "${c.id}"`);
    ids.add(c.id);
    if (!c.query?.trim()) errors.push(`${where}: empty query`);
    if (!Array.isArray(c.relevant) || c.relevant.length === 0) errors.push(`${where}: no relevant ids — author them before running`);
    if (c.split !== "seen" && c.split !== "unseen") errors.push(`${where}: split must be "seen" or "unseen"`);
    for (const n of c.negatives ?? []) {
      if (c.relevant.includes(n)) errors.push(`${where}: "${n}" is both relevant and a negative`);
    }
  }
  if (!f.cases.some((c) => c.split === "unseen")) {
    errors.push("no `unseen` cases — a fixture drawn only from recalled pages measures the corpus's own history");
  }
  const t = f.thresholds;
  for (const [key, v] of Object.entries({ pAtK: t?.pAtK, mrr: t?.mrr, negativeRate: t?.negativeRate, unseenPAtK: t?.unseenPAtK })) {
    if (typeof v !== "number" || v < 0 || v > 1) errors.push(`thresholds.${key} must be a number in [0,1] — commit it BEFORE the baseline run`);
  }
  return errors;
}

/** Score one case against the ids a recall returned, in rank order. */
export function scoreCase(c: EvalCase, returned: string[]): CaseResult {
  const rankOf = returned.findIndex((id) => c.relevant.includes(id));
  const negativesHit = (c.negatives ?? []).filter((n) => returned.includes(n));
  return {
    id: c.id, split: c.split, query: c.query, returned,
    rank: rankOf < 0 ? null : rankOf + 1,
    hit: rankOf >= 0,
    negativesHit,
  };
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

export function scoreAll(fixture: EvalFixture, results: CaseResult[]): EvalReport {
  const of = (split: "seen" | "unseen") => results.filter((r) => r.split === split);
  const pAtK = mean(results.map((r) => (r.hit ? 1 : 0)));
  const mrr = mean(results.map((r) => (r.rank ? 1 / r.rank : 0)));
  const negativeRate = mean(results.map((r) => (r.negativesHit.length > 0 ? 1 : 0)));
  const bySplit = {
    seen: { n: of("seen").length, pAtK: mean(of("seen").map((r) => (r.hit ? 1 : 0))), mrr: mean(of("seen").map((r) => (r.rank ? 1 / r.rank : 0))) },
    unseen: { n: of("unseen").length, pAtK: mean(of("unseen").map((r) => (r.hit ? 1 : 0))), mrr: mean(of("unseen").map((r) => (r.rank ? 1 / r.rank : 0))) },
  };
  const t = fixture.thresholds;
  const failures: string[] = [];
  if (pAtK < t.pAtK) failures.push(`P@${fixture.k} ${pAtK.toFixed(3)} < ${t.pAtK}`);
  if (mrr < t.mrr) failures.push(`MRR ${mrr.toFixed(3)} < ${t.mrr}`);
  if (negativeRate > t.negativeRate) failures.push(`negative rate ${negativeRate.toFixed(3)} > ${t.negativeRate}`);
  if (bySplit.unseen.pAtK < t.unseenPAtK) failures.push(`unseen P@${fixture.k} ${bySplit.unseen.pAtK.toFixed(3)} < ${t.unseenPAtK}`);
  return { k: fixture.k, cases: results, pAtK, mrr, negativeRate, bySplit, passed: failures.length === 0, failures };
}

/** Run the fixture against one recall function. The CALLER supplies recall — the eval does not open
 *  a store, so the same fixture scores the direct published generation and (for the hub-parity
 *  assertion) a hub group, through one code path and one set of numbers. */
export async function runEval(
  fixture: EvalFixture,
  recall: (query: string, k: number) => Promise<RecallResult[]>,
): Promise<EvalReport> {
  const errors = validateFixture(fixture);
  if (errors.length > 0) throw new Error(`recall-eval: the fixture is not runnable —\n  ${errors.join("\n  ")}`);
  const results: CaseResult[] = [];
  for (const c of fixture.cases) {
    const hits = await recall(c.query, fixture.k);
    results.push(scoreCase(c, hits.map((h) => h.id)));
  }
  return scoreAll(fixture, results);
}

export function formatReport(r: EvalReport): string {
  const lines = r.cases.map((c) =>
    `  ${c.hit ? "PASS" : "MISS"} ${c.split.padEnd(6)} rank ${String(c.rank ?? "-").padStart(2)}  ${c.query}` +
    (c.negativesHit.length ? `   NEGATIVE: ${c.negativesHit.join(",")}` : ""));
  lines.push("");
  lines.push(`  P@${r.k} ${r.pAtK.toFixed(3)} · MRR ${r.mrr.toFixed(3)} · negatives ${r.negativeRate.toFixed(3)}`);
  lines.push(`  seen  n=${r.bySplit.seen.n}  P@${r.k} ${r.bySplit.seen.pAtK.toFixed(3)} · MRR ${r.bySplit.seen.mrr.toFixed(3)}`);
  lines.push(`  unseen n=${r.bySplit.unseen.n}  P@${r.k} ${r.bySplit.unseen.pAtK.toFixed(3)} · MRR ${r.bySplit.unseen.mrr.toFixed(3)}`);
  lines.push(r.passed ? "  GATE: pass" : `  GATE: FAIL\n${r.failures.map((f) => `    ${f}`).join("\n")}`);
  return lines.join("\n");
}
