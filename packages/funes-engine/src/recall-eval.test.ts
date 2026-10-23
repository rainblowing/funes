// The recall eval gate (PLAN-0.2.1 step 8). These tests are about the SCORING, not about recall:
// a gate that mis-scores is worse than no gate, because it is believed.
import { test, expect } from "bun:test";
import type { RecallResult } from "funes-core/internal";
import { GENERATION_VERSION } from "funes-core/internal";
import { attributeArm, baselinePath, compareBaseline, evalJson, formatReport, makeBaseline, parseBaseline, runEval, scoreAll, scoreCase, validateFixture, type EvalCase, type EvalFixture } from "./recall-eval.ts";

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

// The --json line names the content generation it measured and the fixture bytes it read, so the gate
// can bind eval to doctor per locus and refuse two different fixtures across loci. No publication id
// (RAI-306 Q9), even when the manifest handed in still carries one.
test("the --json document names the generation and the fixture's sha256, never a publication id", async () => {
  const r = await runEval(FIXTURE(), async () => []);
  const bytes = new TextEncoder().encode("abc");
  const manifest = { generation: `${GENERATION_VERSION}:g`, publicationId: "pub:1" };
  const doc = evalJson(r, manifest, bytes, `${GENERATION_VERSION}:v`);
  expect(doc).toMatchObject({ generation: `${GENERATION_VERSION}:g`, vaultGeneration: `${GENERATION_VERSION}:v`, passed: r.passed, cases: r.cases });
  expect(doc).not.toHaveProperty("publicationId");
  expect(doc.fixtureSha256).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"); // sha256("abc")
});

// PLAN-0.5.0 item 25: a case may carry a recall `where` (ADR-0013); the runner hands it to the
// recall verbatim and never to a case without one, and the fixture refuses a `where` that is no object.
test("a case's `where` reaches the recall; a case without one sends none", async () => {
  const seen: Array<unknown> = [];
  const f = FIXTURE({ cases: [CASE({ where: { type: "Music Artist" } }), CASE({ id: "c2", split: "unseen" })] });
  await runEval(f, async (_q, _k, where) => { seen.push(where); return []; });
  expect(seen).toEqual([{ type: "Music Artist" }, undefined]);
  expect(validateFixture(FIXTURE({ cases: [CASE({ where: ["taste"] as never }), CASE({ id: "c2", split: "unseen" })] })).join())
    .toContain('case "c1": `where` must be an object');
});

// Record 35's attribution rule: the fused score exposes no per-arm rank, so a hit is claimed for the
// vector arm only when FTS could not have found it (no shared unicode61 token of ≥2 characters with
// its indexed text) and the graph arm could not have dragged it in (no edge to another hit).
test("arm attribution: `vector` only with no shared ≥2-char token and no edge to another hit", () => {
  expect(attributeArm("чужой фильм", "Alien (ЧУЖОЙ) · Film", false)).toBe("unattributed"); // case-folded, as unicode61
  expect(attributeArm("фильмы про космос", "Alien (Чужой) · Film · Ridley Scott", false)).toBe("vector");
  expect(attributeArm("a film", "A Heat", false)).toBe("vector");                      // a 1-char token is no FTS term
  expect(attributeArm("cafe", "Café Society", false)).toBe("unattributed");             // diacritics fold, as unicode61
  expect(attributeArm("фильмы про космос", "Alien", true)).toBe("unattributed");      // linked to another hit
  expect(attributeArm("фильмы про космос", "Alien", null)).toBe("unattributed");      // links unknown: never claimed
});

test("runEval attributes each hit when given a page lookup, and carries no field without one", async () => {
  const f = FIXTURE({ cases: [CASE({ query: "чужой" }), CASE({ id: "c2", split: "unseen", query: "космос" })] });
  const hit = (id: string, score: number) => ({ id, title: id, score }) as RecallResult;
  const recall = async (q: string): Promise<RecallResult[]> => q === "чужой"
    ? [hit("items/alien", 0.03), hit("items/heat", 0.02), hit("items/gone", 0.01)]
    : [hit("items/alien", 0.03), hit("items/solaris", 0.02), hit("items/unknown", 0.01)];
  const pages: Record<string, { text: string; links: string[] | null }> = {
    "items/alien": { text: "Alien (Чужой) · Film", links: [] },
    "items/heat": { text: "Heat · Film", links: ["items/alien"] },
    "items/solaris": { text: "Solaris · Film", links: [] },
    "items/unknown": { text: "Stalker · Film", links: null },
  };
  const r = await runEval(f, recall, { page: async (id) => pages[id] ?? null });
  expect(r.cases[0]!.arms).toEqual(["unattributed", "unattributed", "unattributed"]); // a token; an edge; no page
  expect(r.cases[1]!.arms).toEqual(["vector", "vector", "unattributed"]);             // unknown links: never claimed
  expect((await runEval(f, recall)).cases[0]!.arms).toBeUndefined();
});

// PLAN-0.5.0 item 25 (record 35 Handed on): one baseline FILE per locus beside the frozen fixture,
// replacing the in-fixture `--baseline` write — the fixture's sha256 no longer moves when it is taken.
const SIG = { embedding: "Xenova/multilingual-e5-small:384:rev=x", serving: "libsql:rank/2" };
const GEN = `${GENERATION_VERSION}:` + "a".repeat(64);
const REPORT = () => runEval(FIXTURE(), async () =>
  [{ id: "wiki/bread", title: "Bread", score: 0.0325 }, { id: "wiki/starter", title: "Starter", score: 0.0161 }] as RecallResult[]);

test("the baseline file sits beside the fixture, named by the locus", () => {
  expect(baselinePath("/v/out/out_eval/taste-core.json", "funes-taste")).toBe("/v/out/out_eval/taste-core.baseline.funes-taste.json");
  expect(baselinePath("/v/recall-eval.json", "host-a")).toBe("/v/recall-eval.baseline.host-a.json");
  expect(() => baselinePath("/v/f.json", "a/b")).toThrow(/locus/); // a locus is a name, never a path
});

test("a baseline holds generation, signature, fixtureSha256, metrics and (id, rank, score) triples — and round-trips", async () => {
  const r = await REPORT();
  const b = makeBaseline(r, { locus: "host-a", generation: GEN, signature: SIG, fixtureSha256: "f".repeat(64), at: "2026-10-13T00:00:00.000Z" });
  expect(b).toEqual({
    format: 1, locus: "host-a", generation: GEN, signature: SIG, fixtureSha256: "f".repeat(64),
    metrics: { pAtK: 1, mrr: 1, negativeRate: 0, unseenPAtK: 1 },
    triples: { c1: [["wiki/bread", 1, 0.0325], ["wiki/starter", 2, 0.0161]], c2: [["wiki/bread", 1, 0.0325], ["wiki/starter", 2, 0.0161]] },
    at: "2026-10-13T00:00:00.000Z",
  });
  expect(parseBaseline(JSON.stringify(b, null, 2))).toEqual(b);
});

test("a baseline is refused when it cannot name what it measured", async () => {
  const r = await REPORT();
  const ok = makeBaseline(r, { locus: "host-a", generation: GEN, signature: SIG, fixtureSha256: "f".repeat(64), at: "t" });
  const bad = (over: Record<string, unknown>) => () => parseBaseline(JSON.stringify({ ...ok, ...over }));
  expect(bad({ format: 2 })).toThrow(/format/);
  expect(bad({ generation: null })).toThrow(/generation/); // a null content generation names no build
  expect(bad({ fixtureSha256: "abc" })).toThrow(/fixtureSha256/);
  expect(bad({ signature: { embedding: "e" } })).toThrow(/signature/);
  expect(bad({ metrics: { pAtK: 1, mrr: 1, negativeRate: 0 } })).toThrow(/metrics\.unseenPAtK/);
  expect(bad({ triples: { c1: [["wiki/bread", 1]] } })).toThrow(/triples\.c1/);
  expect(() => parseBaseline("{")).toThrow(/not JSON/);
  expect(() => makeBaseline(r, { locus: "host-a", generation: null, signature: SIG, fixtureSha256: "f".repeat(64), at: "t" })).toThrow(/generation/);
});

test("re-read against a run: identical, ranks moved, scores moved, or not comparable", async () => {
  const r = await REPORT();
  const now = { generation: GEN, signature: SIG, fixtureSha256: "f".repeat(64) };
  const b = makeBaseline(r, { locus: "host-a", ...now, at: "t" });
  expect(compareBaseline(b, { ...now, report: r })).toMatchObject({ comparable: true, identical: true, rankMismatches: [], maxScoreDelta: 0 });

  const moved = await runEval(FIXTURE(), async () =>
    [{ id: "wiki/starter", title: "S", score: 0.0325 }, { id: "wiki/bread", title: "B", score: 0.0161 }] as RecallResult[]);
  const c = compareBaseline(b, { ...now, report: moved });
  expect(c.identical).toBe(false);
  expect(c.rankMismatches).toEqual(["c1", "c2"]);

  const drift = await runEval(FIXTURE(), async () =>
    [{ id: "wiki/bread", title: "B", score: 0.0330 }, { id: "wiki/starter", title: "S", score: 0.0161 }] as RecallResult[]);
  const d = compareBaseline(b, { ...now, report: drift });
  expect(d).toMatchObject({ identical: false, rankMismatches: [] }); // the edge rule: (id, rank) equal, scores reported
  expect(d.maxScoreDelta).toBeCloseTo(0.0005);

  // another generation or signature: deltas only, no identity claimed (ADR-0003)
  expect(compareBaseline(b, { ...now, generation: `${GENERATION_VERSION}:` + "b".repeat(64), report: r })).toMatchObject({ comparable: false, identical: false });
  expect(compareBaseline(b, { ...now, signature: { ...SIG, serving: "libsql:rank/3" }, report: r }).comparable).toBe(false);
  // another fixture: equal triples over two fixtures prove nothing
  expect(compareBaseline(b, { ...now, fixtureSha256: "e".repeat(64), report: r }).reasons.join()).toContain("fixture");
  // RAI-307: a null serving signature on either side is NOT COMPARABLE — null === null proves nothing
  const unsigned = { ...now, signature: { ...SIG, serving: null } };
  const nb = { ...makeBaseline(r, { locus: "host-a", ...now, at: "t" }), signature: { ...SIG, serving: null } };
  expect(compareBaseline(nb, { ...unsigned, report: r })).toMatchObject({ comparable: false, identical: false });
  expect(compareBaseline(b, { ...unsigned, report: r }).reasons.join()).toContain("serving signature");
});

// A star whose recall telemetry was never on (it is opt-in, `--stats`) has no `recall_stats` table.
// The draft must read that as "nothing recorded yet" — every page `unseen` — not crash on the join.
test("eval --draft on a store with no recall telemetry: every candidate is unseen, no crash", async () => {
  const { LibsqlStore } = await import("./libsql/store.ts");
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
