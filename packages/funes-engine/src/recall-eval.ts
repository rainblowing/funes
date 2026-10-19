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
import { createHash } from "node:crypto";
import type { RecallResult } from "funes-core";
import { ftsTerms } from "funes-shared";
import type { Where } from "./recall-planner.ts";
import { validLocus } from "./write-designation.ts";

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
  /** PLAN-0.5.0 item 25: a recall_v2 `where` (ADR-0013), sent verbatim. The star's declaration
   *  decides it at recall time, so a key it does not declare refuses there, never silently here. */
  where?: Where;
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
  // PLAN-0.5.0 item 25: no in-fixture `baseline` any more — each locus writes its own file beside
  // the fixture (`baselinePath`), so taking a baseline never moves the fixture's sha256.
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
  /** The fused score of each `returned` id, same order (PLAN-0.4.0 item 17, RAI-128). Carried, never
   *  scored: the release gate compares (id, rank, score) triples across loci, because an id-only
   *  comparison passed RAI-123 with the defect present — `score` is the raw RRF sum of per-arm ranks
   *  (rrf.ts:12), so a score that moves under an equal order is one arm's order moving. */
  scores: number[];
  /** PLAN-0.5.0 item 25: which arm each `returned` id can be credited to, same order — present only
   *  when the run was given a page lookup. See `attributeArm`. */
  arms?: Arm[];
}

/** Record 35's arm attribution for one hit. The fused score exposes no per-arm rank, so a hit is
 *  `vector` only when neither other arm could have produced it: it shares no FTS term (a unicode61
 *  token of two or more characters — case and diacritics folded, as unicode61 folds them) with the
 *  query, and it has no graph edge to another hit of the same case. Unknown links (`null`, as over
 *  an MCP surface that serves no edges) are never read as "no edge". UNVERIFIED at the edge. */
export type Arm = "vector" | "unattributed";
const fold = (s: string): string[] => ftsTerms(s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase());
export function attributeArm(query: string, indexedText: string, linkedToAnotherHit: boolean | null): Arm {
  if (linkedToAnotherHit !== false) return "unattributed";
  const terms = new Set(fold(indexedText));
  return fold(query).some((t) => terms.has(t)) ? "unattributed" : "vector";
}

/** What attribution needs of one hit: its indexed text (title, description, body — the identity
 *  line rides in the body) and the ids it has an edge to or from, or null when unknown. */
export type EvalPage = { text: string; links: string[] | null };

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
    if (c.where !== undefined && (c.where === null || typeof c.where !== "object" || Array.isArray(c.where))) errors.push(`${where}: \`where\` must be an object`);
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

/** Score one case against the ids a recall returned, in rank order. `scores` rides along untouched;
 *  the pure scoring tests pass none. */
export function scoreCase(c: EvalCase, returned: string[], scores: number[] = []): CaseResult {
  const rankOf = returned.findIndex((id) => c.relevant.includes(id));
  const negativesHit = (c.negatives ?? []).filter((n) => returned.includes(n));
  return {
    id: c.id, split: c.split, query: c.query, returned, scores,
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
  recall: (query: string, k: number, where?: Where) => Promise<RecallResult[]>,
  opts: { page?: (id: string) => Promise<EvalPage | null> } = {},
): Promise<EvalReport> {
  const errors = validateFixture(fixture);
  if (errors.length > 0) throw new Error(`recall-eval: the fixture is not runnable —\n  ${errors.join("\n  ")}`);
  const results: CaseResult[] = [];
  for (const c of fixture.cases) {
    const hits = await recall(c.query, fixture.k, c.where);
    const r = scoreCase(c, hits.map((h) => h.id), hits.map((h) => h.score));
    if (opts.page) {
      const pages = await Promise.all(r.returned.map((id) => opts.page!(id)));
      // An edge counts in either direction, whichever side's lookup reported it; a hit whose own
      // links are unknown is never read as unlinked.
      const linked = (i: number): boolean | null => {
        const own = pages[i]?.links;
        if (own == null) return null;
        return r.returned.some((other, j) => j !== i && (own.includes(other) || (pages[j]?.links ?? []).includes(r.returned[i]!)));
      };
      r.arms = pages.map((p, i) => (p ? attributeArm(c.query, p.text, linked(i)) : "unattributed"));
    }
    results.push(r);
  }
  return scoreAll(fixture, results);
}

/** The `funes eval --json` document. PLAN-0.4.0 item 17 (RAI-128): eval and doctor open the manifest
 *  independently, so the release gate can only bind the two reads of one locus if eval names the
 *  publication it measured — `publicationId` beside `generation`, null for a legacy manifest that
 *  names none — and it can only compare two loci's triples if both read the same fixture: an
 *  EvalReport carries neither thresholds nor `relevant`, so equal triples over two different
 *  fixtures prove nothing. `fixtureSha256` is over the BYTES read, before any parse.
 *
 *  `vaultGeneration` is the target a publish of the vault would stamp NOW (null when star.yaml's
 *  scope is unreadable): mesh convergence proves two loci hold the same vault FILES, not that each
 *  has PUBLISHED them — a direct edit after `funes publish` clears no stamp, so the served generation
 *  reads valid and stale. The gate calls `generation !== vaultGeneration` a lagging publication. */
export type EvalJson = EvalReport & {
  /** Null only over MCP (PLAN-0.5.0 item 25), where it is recall_v2's `contentGeneration` and the
   *  server answered `generationValid: false`; a manifest always names one. */
  generation: string | null; publicationId: string | null; fixtureSha256: string; vaultGeneration: string | null;
};
export function evalJson(
  report: EvalReport,
  manifest: { generation: string | null; publicationId?: string | null },
  fixtureBytes: Uint8Array,
  vaultGeneration: string | null,
): EvalJson {
  return {
    ...report,
    generation: manifest.generation,
    publicationId: manifest.publicationId ?? null,
    fixtureSha256: createHash("sha256").update(fixtureBytes).digest("hex"),
    vaultGeneration,
  };
}

// ── Per-locus baselines (PLAN-0.5.0 item 25, record 35 Handed on) ────────────────────────────────
// `<fixture>.baseline.<locus>.json` beside the frozen fixture, written ONCE by `funes eval
// --baseline` and never by hand. It names what it measured — the content generation, the embedding
// and serving signatures, the fixture's bytes — so a later run can say whether it is comparable
// before it says whether it is Identical (GLOSSARY): one generation, one signature, the same
// (id, rank, score) triples for every case.

export interface EvalSignature { embedding: string | null; serving: string | null }
export interface EvalMetrics { pAtK: number; mrr: number; negativeRate: number; unseenPAtK: number }
export type Triple = [id: string, rank: number, score: number];
export interface EvalBaseline {
  format: 1;
  locus: string;
  generation: string;
  signature: EvalSignature;
  fixtureSha256: string;
  metrics: EvalMetrics;
  /** Per case id, the returned ids in rank order with their fused scores. */
  triples: Record<string, Triple[]>;
  at: string;
}

export function baselinePath(fixturePath: string, locus: string): string {
  return `${fixturePath.replace(/\.json$/, "")}.baseline.${validLocus(locus, "the baseline's locus")}.json`;
}

const metricsOf = (r: EvalReport): EvalMetrics =>
  ({ pAtK: r.pAtK, mrr: r.mrr, negativeRate: r.negativeRate, unseenPAtK: r.bySplit.unseen.pAtK });
const triplesOf = (r: EvalReport): Record<string, Triple[]> =>
  Object.fromEntries(r.cases.map((c) => [c.id, c.returned.map((id, i): Triple => [id, i + 1, c.scores[i]!])]));

/** A baseline names a build or it is not taken: a null content generation (never stamped, cleared by
 *  a mutation, or `generationValid: false` at the edge) names no rows (Q1). */
export function makeBaseline(
  r: EvalReport,
  o: { locus: string; generation: string | null; signature: EvalSignature; fixtureSha256: string; at: string },
): EvalBaseline {
  if (!o.generation) throw new Error("eval: no content generation — a baseline is taken only over a named, valid build");
  return {
    format: 1, locus: o.locus, generation: o.generation, signature: o.signature, fixtureSha256: o.fixtureSha256,
    metrics: metricsOf(r), triples: triplesOf(r), at: o.at,
  };
}

/** Read a baseline file, refusing any field it cannot vouch for — a half-valid baseline compared as
 *  if whole would report an identity it never measured. */
export function parseBaseline(text: string): EvalBaseline {
  let b: Record<string, unknown>;
  try { b = JSON.parse(text); } catch { throw new Error("eval: the baseline file is not JSON"); }
  const bad = (field: string): never => { throw new Error(`eval: the baseline file's ${field} is missing or malformed`); };
  const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  const strOrNull = (v: unknown) => v === null || isStr(v);
  if (!b || typeof b !== "object" || b.format !== 1) bad("format (expected 1)");
  if (!isStr(b.locus)) bad("locus");
  if (!isStr(b.generation)) bad("generation");
  if (typeof b.fixtureSha256 !== "string" || !/^[0-9a-f]{64}$/.test(b.fixtureSha256)) bad("fixtureSha256");
  const s = b.signature as Record<string, unknown> | null;
  if (!s || typeof s !== "object" || !strOrNull(s.embedding) || !strOrNull(s.serving)) bad("signature");
  const m = (b.metrics ?? {}) as Record<string, unknown>;
  for (const k of ["pAtK", "mrr", "negativeRate", "unseenPAtK"]) if (typeof m[k] !== "number") bad(`metrics.${k}`);
  const t = b.triples as Record<string, unknown> | null;
  if (!t || typeof t !== "object" || Array.isArray(t)) bad("triples");
  for (const [id, rows] of Object.entries(t!)) {
    const ok = Array.isArray(rows) && rows.every((x) => Array.isArray(x) && x.length === 3 &&
      isStr(x[0]) && Number.isInteger(x[1]) && typeof x[2] === "number");
    if (!ok) bad(`triples.${id}`);
  }
  if (!isStr(b.at)) bad("at");
  return b as unknown as EvalBaseline;
}

export interface BaselineComparison {
  /** One fixture, one content generation, one signature — the only basis for claiming identity. */
  comparable: boolean;
  /** Comparable, the same (id, rank) for every case, and every score equal. */
  identical: boolean;
  /** Why not comparable, when not. */
  reasons: string[];
  /** Case ids whose (id, rank) list differs from the baseline's (or is missing on one side). */
  rankMismatches: string[];
  /** Max |Δscore| over the cases whose (id, rank) list is equal — reported, never gated at the edge. */
  maxScoreDelta: number;
  deltas: EvalMetrics;
}

export function compareBaseline(
  b: EvalBaseline,
  now: { generation: string | null; signature: EvalSignature; fixtureSha256: string; report: EvalReport },
): BaselineComparison {
  const reasons: string[] = [];
  if (b.fixtureSha256 !== now.fixtureSha256) reasons.push(`the fixture differs from the baseline's (sha256 ${b.fixtureSha256.slice(0, 12)}…)`);
  if (b.generation !== now.generation) reasons.push(`content generation ${now.generation} ≠ the baseline's ${b.generation}`);
  if (b.signature.embedding !== now.signature.embedding) reasons.push(`embedding signature ${now.signature.embedding} ≠ the baseline's ${b.signature.embedding}`);
  if (b.signature.serving !== now.signature.serving) reasons.push(`serving signature ${now.signature.serving} ≠ the baseline's ${b.signature.serving}`);
  const current = triplesOf(now.report);
  const rankMismatches: string[] = [];
  let maxScoreDelta = 0;
  for (const id of new Set([...Object.keys(b.triples), ...Object.keys(current)])) {
    const was = b.triples[id], is = current[id];
    if (!was || !is || was.length !== is.length || was.some((t, i) => t[0] !== is[i]![0] || t[1] !== is[i]![1])) {
      rankMismatches.push(id);
      continue;
    }
    for (let i = 0; i < was.length; i++) maxScoreDelta = Math.max(maxScoreDelta, Math.abs(was[i]![2] - is[i]![2]));
  }
  const m = metricsOf(now.report);
  const comparable = reasons.length === 0;
  return {
    comparable, reasons, rankMismatches, maxScoreDelta,
    identical: comparable && rankMismatches.length === 0 && maxScoreDelta === 0,
    deltas: { pAtK: m.pAtK - b.metrics.pAtK, mrr: m.mrr - b.metrics.mrr, negativeRate: m.negativeRate - b.metrics.negativeRate, unseenPAtK: m.unseenPAtK - b.metrics.unseenPAtK },
  };
}

export function formatComparison(path: string, c: BaselineComparison): string {
  const d = c.deltas;
  const fmt = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(3);
  const lines = [`  baseline ${path}`,
    `    Δ P@k ${fmt(d.pAtK)} · MRR ${fmt(d.mrr)} · negatives ${fmt(d.negativeRate)} · unseen P@k ${fmt(d.unseenPAtK)}`];
  if (!c.comparable) lines.push(`    NOT COMPARABLE — no identity claimed:\n${c.reasons.map((r) => `      ${r}`).join("\n")}`);
  else if (c.identical) lines.push("    IDENTICAL: one generation, one signature, the same (id, rank, score) triples for every case");
  else lines.push(`    NOT IDENTICAL: ${c.rankMismatches.length} case(s) with moved (id, rank)${c.rankMismatches.length ? ` [${c.rankMismatches.join(", ")}]` : ""}; max |Δscore| ${c.maxScoreDelta}`);
  return lines.join("\n");
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
