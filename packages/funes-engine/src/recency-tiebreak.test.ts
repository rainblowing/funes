// Rev 7 freshness (a): recency tiebreak for volatile items — a VERSIONED RANKING CHANGE
// gated by the H5 golden fixtures. The RRF-ordered list is cut into HEAD-anchored runs of
// consecutive items whose fused scores sit within RRF_TIE_EPS of the run head (RRF produces
// frequent exact ties); a run containing at least one volatile item reorders by freshness desc
// (nulls last), every other run keeps deterministic RRF order. RRF scores are never altered.
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder, MemoryItem } from "funes-core";
import { RRF_TIE_EPS, recencyTiebreak } from "./store.ts";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";
import type { FreshnessFields } from "./store.ts";
import { indexDir } from "./reindex.ts";

type FreshItem = MemoryItem & FreshnessFields;

// Deterministic marker embedder: "magnet" texts sit ON the query vector, "zanzibar" texts at a
// fixed angle, everything else orthogonal — full control of the vec-arm order, no model download.
class TiebreakEmbedder implements Embedder {
  readonly dim = 4;
  readonly id = "tiebreak-fake";
  private vec(t: string): Float32Array {
    if (t.includes("magnet")) return Float32Array.from([1, 0, 0, 0]);
    if (t.includes("zanzibar")) return Float32Array.from([0.8, 0.6, 0, 0]);
    return Float32Array.from([0, 1, 0, 0]);
  }
  async embedQuery(_t: string) { return Float32Array.from([1, 0, 0, 0]); }
  async embedPassage(t: string) { return this.vec(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.vec(t)); }
}

const QUERY = "zanzibar protocol";

// An engineered EXACT RRF tie: `a` is FTS rank 1 (each query term twice) / vec rank 2
// (zanzibar vector); `b` is FTS rank 2 (terms once) / vec rank 1 (magnet vector). Both fuse to
// 1/61 + 1/62. Baseline merge order (Map insertion: FTS list first) puts `a` before `b`.
function tiePair(extraA: Partial<FreshItem>, extraB: Partial<FreshItem>): FreshItem[] {
  return [
    { id: "a", path: "a.md", title: "A", trust: "trusted",
      body: "zanzibar protocol zanzibar protocol", ...extraA },
    { id: "b", path: "b.md", title: "B", trust: "trusted",
      body: "magnet zanzibar protocol", ...extraB },
  ];
}

async function recallIds(items: FreshItem[]): Promise<string[]> {
  const s = await LibsqlStore.create(new TiebreakEmbedder());
  await s.remember(items);
  const res = await s.recall({ query: QUERY, k: 2 });
  await s.close();
  return res.map((r) => r.id);
}

test("tiebreak: volatile RRF tie orders by freshness desc — the newer page wins", async () => {
  expect(await recallIds(tiePair(
    { volatile: true, freshness: "2026-01-01" },
    { volatile: true, freshness: "2026-06-01" },
  ))).toEqual(["b", "a"]);
});

test("tiebreak: one volatile in the pair is enough to trigger the freshness order", async () => {
  expect(await recallIds(tiePair(
    { freshness: "2026-01-01" },
    { volatile: true, freshness: "2026-06-01" },
  ))).toEqual(["b", "a"]);
});

test("tiebreak: non-volatile ties keep the deterministic RRF order", async () => {
  expect(await recallIds(tiePair(
    { freshness: "2026-01-01" },
    { freshness: "2026-06-01" },
  ))).toEqual(["a", "b"]);
});

test("tiebreak: null freshness sorts last among volatile ties", async () => {
  expect(await recallIds(tiePair(
    { volatile: true }, // no as_of/updated -> null freshness
    { volatile: true, freshness: "2026-06-01" },
  ))).toEqual(["b", "a"]);
  // and the already-first fresh page stays first against a null
  expect(await recallIds(tiePair(
    { volatile: true, freshness: "2026-06-01" },
    { volatile: true },
  ))).toEqual(["a", "b"]);
});

test("tiebreak: non-tied scores never reorder — freshness only breaks ties", async () => {
  // `a` carries the magnet marker too: FTS rank 1 AND vec rank 1 -> strictly above `b`.
  const s = await LibsqlStore.create(new TiebreakEmbedder());
  const items: FreshItem[] = [
    { id: "a", path: "a.md", title: "A", trust: "trusted",
      body: "magnet zanzibar protocol zanzibar protocol", volatile: true, freshness: "2026-01-01" },
    { id: "b", path: "b.md", title: "B", trust: "trusted",
      body: "zanzibar protocol", volatile: true, freshness: "2026-06-01" },
  ];
  await s.remember(items);
  const res = await s.recall({ query: QUERY, k: 2 });
  await s.close();
  expect(res.map((r) => r.id)).toEqual(["a", "b"]);
});

test("tiebreak: volatile/freshness sync to unchanged rows without a re-embed (trust-sync pattern)", async () => {
  const s = await LibsqlStore.create(new TiebreakEmbedder());
  await s.remember(tiePair(
    { volatile: true, freshness: "2026-06-01" },
    { volatile: true, freshness: "2026-01-01" },
  ));
  expect((await s.recall({ query: QUERY, k: 2 })).map((r) => r.id)).toEqual(["a", "b"]);
  // same content, flipped metadata: a -> null freshness, b -> newest. Hash-skip must still sync.
  const r = await s.remember(tiePair(
    { volatile: true },
    { volatile: true, freshness: "2026-06-01" },
  ));
  expect(r.indexed).toBe(0);
  expect(r.skipped).toBe(2);
  expect((await s.recall({ query: QUERY, k: 2 })).map((r2) => r2.id)).toEqual(["b", "a"]);
  await s.close();
});

// Regression for the comparator-sort bug: the old implementation handed an epsilon-equality
// comparator to Array.sort. Epsilon equality is NON-TRANSITIVE on chains (a≈b, b≈c, a≉c), so
// the sort contract was violated and chain order was implementation-defined — contradicting
// the H5 determinism pin. recencyTiebreak is a total run-grouping pass instead; this pins the
// HEAD-anchored cut on an epsilon-chain. (Unit-level on purpose: fused RRF scores are sums of
// 1/(60+rank), whose gaps are ~1e-3 — a live corpus cannot produce sub-EPS-but-nonzero gaps.)
test("tiebreak: epsilon-chain cuts at the run head — exact order, stable across repeats", () => {
  const s = 1 / 61 + 1 / 62; // a realistic fused RRF score magnitude
  const items = [
    { id: "x", score: s },
    { id: "y", score: s - 0.6e-9 },
    { id: "z", score: s - 1.2e-9 },
  ];
  // The chain precondition: adjacent pairs tie within EPS, the ends do NOT (non-transitivity).
  expect(Math.abs(items[0]!.score - items[1]!.score)).toBeLessThanOrEqual(RRF_TIE_EPS);
  expect(Math.abs(items[1]!.score - items[2]!.score)).toBeLessThanOrEqual(RRF_TIE_EPS);
  expect(Math.abs(items[0]!.score - items[2]!.score)).toBeGreaterThan(RRF_TIE_EPS);
  // Freshness ascends x -> z: if z chained into x's run, the output would be [z, y, x].
  const meta: Record<string, { volatile: boolean; fresh: number }> = {
    x: { volatile: true, fresh: Date.parse("2026-01-01") / 1000 },
    y: { volatile: true, fresh: Date.parse("2026-03-01") / 1000 },
    z: { volatile: true, fresh: Date.parse("2026-06-01") / 1000 },
  };
  // HEAD-anchored cut: run1 = {x, y} (both within EPS of head x; z is 1.2e-9 away -> its own
  // run). run1 reorders by freshness -> [y, x]; z stays third despite being the freshest.
  for (let i = 0; i < 100; i++) {
    expect(recencyTiebreak(items, (it) => meta[it.id]).map((r) => r.id)).toEqual(["y", "x", "z"]);
  }
});

test("tiebreak: tie order is stable across repeated recalls on the same store (e2e)", async () => {
  const s = await LibsqlStore.create(new TiebreakEmbedder());
  await s.remember(tiePair(
    { volatile: true, freshness: "2026-01-01" },
    { volatile: true, freshness: "2026-06-01" },
  ));
  for (let i = 0; i < 3; i++) {
    expect((await s.recall({ query: QUERY, k: 2 })).map((r) => r.id)).toEqual(["b", "a"]);
  }
  await s.close();
});

test("tiebreak: frontmatter derivation via reindex — `volatile:` + `as_of:` beats `updated:`", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-tiebreak-"));
  try {
    writeFileSync(join(vault, "a.md"), [
      "---", "title: A", "volatile: true", "updated: 2026-06-01", "---",
      "zanzibar protocol zanzibar protocol",
    ].join("\n"));
    // as_of (newer) must win over updated (older) — if `updated:` leaked through, `a` would win
    writeFileSync(join(vault, "b.md"), [
      "---", "title: B", "volatile: true", "as_of: 2026-07-01", "updated: 2026-01-01", "---",
      "magnet zanzibar protocol",
    ].join("\n"));
    const s = await LibsqlStore.create(new TiebreakEmbedder());
    await indexDir(s, vault, vault);
    const res = await s.recall({ query: QUERY, k: 2 });
    await s.close();
    expect(res.map((r) => r.id)).toEqual(["b", "a"]);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
