// The recall eval gate (PLAN-0.2.1 step 8). These tests are about the SCORING, not about recall:
// a gate that mis-scores is worse than no gate, because it is believed.
import { test, expect } from "bun:test";
import type { RecallResult } from "funes-core";
import { formatReport, runEval, scoreAll, scoreCase, validateFixture, type EvalCase, type EvalFixture } from "./recall-eval.ts";

const CASE = (over: Partial<EvalCase> = {}): EvalCase => ({
  id: "c1", query: "sourdough hydration", relevant: ["wiki/bread"], split: "seen", ...over,
});

const FIXTURE = (over: Partial<EvalFixture> = {}): EvalFixture => ({
  vault: "/tmp/star", k: 5,
  thresholds: { pAtK: 0.8, mrr: 0.6, negativeRate: 0.1, unseenPAtK: 0.6 },
  cases: [CASE(), CASE({ id: "c2", split: "unseen" })],
  ...over,
});

test("a case is a relevant SET, and any member counts", () => {
  const c = CASE({ relevant: ["wiki/bread", "wiki/starter"] });
  expect(scoreCase(c, ["x", "wiki/starter", "y"]).rank).toBe(2);
  expect(scoreCase(c, ["wiki/bread"]).rank).toBe(1);
  expect(scoreCase(c, ["x", "y"]).hit).toBe(false);
});

test("a negative in the top-k is recorded BY NAME even when the case also hits", () => {
  const c = CASE({ negatives: ["raw/in_tg/noise"] });
  const r = scoreCase(c, ["wiki/bread", "raw/in_tg/noise"]);
  expect(r.hit).toBe(true);
  expect(r.negativesHit).toEqual(["raw/in_tg/noise"]);
});

test("MRR separates rank 1 from rank 5 where P@k cannot", () => {
  const f = FIXTURE();
  const at = (rank: number) => f.cases.map((c) => scoreCase(c, [...Array(rank - 1).fill("x"), c.relevant[0]!]));
  const first = scoreAll(f, at(1));
  const fifth = scoreAll(f, at(5));
  expect(first.pAtK).toBe(fifth.pAtK);      // identical by P@k …
  expect(first.mrr).toBe(1);
  expect(fifth.mrr).toBeCloseTo(0.2);       // … and clearly different by MRR
});

test("the unseen split has its own floor, so a strong seen half cannot hide a weak one", () => {
  const f = FIXTURE({
    cases: [CASE({ id: "s1" }), CASE({ id: "s2" }), CASE({ id: "u1", split: "unseen" }), CASE({ id: "u2", split: "unseen" })],
    thresholds: { pAtK: 0.4, mrr: 0.3, negativeRate: 0.1, unseenPAtK: 0.6 },
  });
  const results = f.cases.map((c) => scoreCase(c, c.split === "seen" ? [c.relevant[0]!] : ["nothing"]));
  const r = scoreAll(f, results);
  expect(r.pAtK).toBe(0.5);                 // the overall floor passes …
  expect(r.passed).toBe(false);             // … and the gate still fails
  expect(r.failures.join()).toContain("unseen P@5");
});

test("the fixture is refused when it cannot be scored honestly", () => {
  expect(validateFixture(FIXTURE())).toEqual([]);
  expect(validateFixture(FIXTURE({ cases: [] })).join()).toContain("no cases");
  expect(validateFixture(FIXTURE({ cases: [CASE(), CASE()] })).join()).toContain('duplicate case id "c1"');
  expect(validateFixture(FIXTURE({ cases: [CASE({ relevant: [] }), CASE({ id: "c2", split: "unseen" })] })).join())
    .toContain("no relevant ids — author them before running");
  // a fixture with no `unseen` case measures the corpus's own history
  expect(validateFixture(FIXTURE({ cases: [CASE()] })).join()).toContain("no `unseen` cases");
  // a page cannot be both the answer and a wrong answer
  expect(validateFixture(FIXTURE({ cases: [CASE({ negatives: ["wiki/bread"] }), CASE({ id: "c2", split: "unseen" })] })).join())
    .toContain("both relevant and a negative");
  expect(validateFixture(FIXTURE({ thresholds: { pAtK: 2, mrr: 0.6, negativeRate: 0.1, unseenPAtK: 0.6 } })).join())
    .toContain("commit it BEFORE the baseline run");
});

test("runEval refuses an unrunnable fixture instead of reporting a number", async () => {
  const recall = async (): Promise<RecallResult[]> => [];
  await expect(runEval(FIXTURE({ cases: [CASE({ relevant: [] })] }), recall)).rejects.toThrow(/not runnable/);
});

test("runEval scores through ONE code path, so the same fixture can score a hub group", async () => {
  const f = FIXTURE();
  const recall = async (query: string, k: number): Promise<RecallResult[]> => {
    expect(k).toBe(f.k);
    return [{ id: "wiki/bread", title: "Bread", score: 1 } as RecallResult];
  };
  const r = await runEval(f, recall);
  expect(r.passed).toBe(true);
  expect(r.pAtK).toBe(1);
  expect(formatReport(r)).toContain("GATE: pass");
});
