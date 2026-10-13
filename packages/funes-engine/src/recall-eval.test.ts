// The recall eval gate (PLAN-0.2.1 step 8). These tests are about the SCORING, not about recall:
// a gate that mis-scores is worse than no gate, because it is believed.
import { test, expect } from "bun:test";
import type { RecallResult } from "funes-core";
import { evalJson, formatReport, runEval, scoreAll, scoreCase, validateFixture, type EvalCase, type EvalFixture } from "./recall-eval.ts";

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

// PLAN-0.4.0 item 17 (RAI-128): the release gate compares (id, rank, score) triples across loci —
// an id-only gate passed RAI-123 with the defect present — so every case carries the fused score of
// each returned id, in rank order, beside `returned`.
test("runEval carries each hit's score beside its id, in rank order", async () => {
  const recall = async (): Promise<RecallResult[]> =>
    [{ id: "wiki/bread", title: "Bread", score: 0.0325 }, { id: "wiki/starter", title: "Starter", score: 0.0161 }] as RecallResult[];
  const r = await runEval(FIXTURE(), recall);
  expect(r.cases[0]!.returned).toEqual(["wiki/bread", "wiki/starter"]);
  expect(r.cases[0]!.scores).toEqual([0.0325, 0.0161]);
});

// The --json line names the publication it measured and the fixture bytes it read, so the gate can
// bind eval to doctor per locus and refuse two different fixtures across loci.
test("the --json document names the publication and the fixture's sha256", async () => {
  const r = await runEval(FIXTURE(), async () => []);
  const bytes = new TextEncoder().encode("abc");
  const doc = evalJson(r, { generation: "v2:g", publicationId: "pub:1" }, bytes, "v2:v");
  expect(doc).toMatchObject({ generation: "v2:g", publicationId: "pub:1", vaultGeneration: "v2:v", passed: r.passed, cases: r.cases });
  expect(doc.fixtureSha256).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"); // sha256("abc")
  expect(evalJson(r, { generation: "v2:g" }, bytes, null).publicationId).toBeNull(); // a legacy manifest names none
});

// A star whose recall telemetry was never on (it is opt-in, `--stats`) has no `recall_stats` table.
// The draft must read that as "nothing recorded yet" — every page `unseen` — not crash on the join.
test("eval --draft on a store with no recall telemetry: every candidate is unseen, no crash", async () => {
  const { LibsqlStore } = await import("../../funes-libsql/src/index.ts");
  const { draftFixture } = await import("./recall-eval-draft.ts");
  const fake = { dim: 4, embedQuery: async () => new Float32Array(4), embedPassage: async () => new Float32Array(4), embedPassages: async (ts: string[]) => ts.map(() => new Float32Array(4)) };
  const store = await LibsqlStore.create(fake);
  try {
    await store.remember([
      { id: "wiki/a", path: "wiki/a.md", title: "A", body: "alpha", trust: "trusted" },
      { id: "wiki/b", path: "wiki/b.md", title: "B", body: "beta", trust: "trusted" },
      { id: "out_memory/c", path: "out_memory/c.md", title: "C", body: "gamma", trust: "trusted" },
    ]);
    const db = (store as unknown as { db: { prepare(s: string): { get(): unknown } } }).db;
    expect(db.prepare("select name from sqlite_master where type='table' and name='recall_stats'").get() ?? null).toBeNull();
    const f = draftFixture(store, { vault: "/v", seen: 20, unseen: 10 });
    expect(f.cases.map((c) => [c.split, c.note])).toEqual([["unseen", "drafted from wiki/a.md"], ["unseen", "drafted from wiki/b.md"]]);
  } finally {
    await store.close();
  }
});
