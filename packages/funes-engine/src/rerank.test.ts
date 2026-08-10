import { test, expect } from "bun:test";
import type { Embedder } from "funes-core";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";
import { CrossEncoderReranker, type Reranker } from "./rerank.ts";

// Deterministic fake embedder (no model download) — same as store.test.ts.
class FakeEmbedder implements Embedder {
  readonly dim = 16;
  private vec(t: string): Float32Array {
    const v = new Float32Array(this.dim);
    for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? [])
      v[[...w].reduce((a, c) => a + c.charCodeAt(0), 0) % this.dim]! += 1;
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < v.length; i++) v[i]! /= norm;
    return v;
  }
  async embedQuery(t: string) { return this.vec(t); }
  async embedPassage(t: string) { return this.vec(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.vec(t)); }
}

/** Fake reranker: reverses the candidate order and records its calls. */
class ReverseReranker implements Reranker {
  calls: Array<{ query: string; docs: Array<{ id: string; text: string }> }> = [];
  async rerank(query: string, docs: Array<{ id: string; text: string }>) {
    this.calls.push({ query, docs });
    return docs.map((d) => d.id).reverse();
  }
}

/** Fake reranker: docs whose TEXT contains the marker token come first (proves bodies are
 *  fetched and passed — the marker lives only in a body, never in a title). */
class MarkerReranker implements Reranker {
  constructor(private marker: string) {}
  async rerank(_query: string, docs: Array<{ id: string; text: string }>) {
    return [...docs].sort((a, b) => Number(b.text.includes(this.marker)) - Number(a.text.includes(this.marker))).map((d) => d.id);
  }
}

const ITEMS = [
  { id: "a", title: "fitness alpha", body: "fitness protein goals", path: "notes/a.md", trust: "trusted" as const },
  { id: "b", title: "fitness beta", body: "fitness protein goals zzz", path: "notes/b.md", trust: "untrusted" as const },
  { id: "c", title: "fitness gamma", body: "fitness protein goals MAGNET", path: "notes/c.md", trust: "derived" as const },
];
const Q = "fitness protein goals";

test("rerank: no reranker configured -> rerank:true is a no-op (pure RRF order)", async () => {
  const s = await LibsqlStore.create(new FakeEmbedder());
  await s.remember(ITEMS);
  const baseline = await s.recall({ query: Q, k: 3 });
  const flagged = await s.recall({ query: Q, k: 3, rerank: true });
  expect(flagged.map((r) => r.id)).toEqual(baseline.map((r) => r.id));
  expect(flagged).toEqual(baseline); // scores + trust + path identical too
  await s.close();
});

test("rerank: reranker configured but rerank:false/absent -> RRF order unchanged, reranker never called", async () => {
  const fake = new ReverseReranker();
  const s = await LibsqlStore.create(new FakeEmbedder(), undefined, { reranker: fake });
  await s.remember(ITEMS);
  const noFlag = await s.recall({ query: Q, k: 3 });
  const offFlag = await s.recall({ query: Q, k: 3, rerank: false });
  expect(offFlag).toEqual(noFlag);
  expect(fake.calls.length).toBe(0); // optional stage stays cold unless opted into
  await s.close();
});

test("rerank: rerank:true reorders RRF output per the injected reranker", async () => {
  const fake = new ReverseReranker();
  const s = await LibsqlStore.create(new FakeEmbedder(), undefined, { reranker: fake });
  await s.remember(ITEMS);
  const baseline = await s.recall({ query: Q, k: 3 });
  const reranked = await s.recall({ query: Q, k: 3, rerank: true });
  expect(reranked.map((r) => r.id)).toEqual(baseline.map((r) => r.id).reverse());
  expect(fake.calls.length).toBe(1);
  expect(fake.calls[0]!.query).toBe(Q);
  await s.close();
});

test("rerank: k respected (candidate pool widens to k*4, output slices back to k) + trust/path/score survive", async () => {
  const fake = new ReverseReranker();
  const s = await LibsqlStore.create(new FakeEmbedder(), undefined, { reranker: fake });
  await s.remember(ITEMS);
  const fullRrf = await s.recall({ query: Q, k: 3 }); // all 3 match -> full RRF order
  const reranked = await s.recall({ query: Q, k: 2, rerank: true });
  expect(reranked.length).toBe(2);
  // k=2 widens the pool to min(3, 8)=3 candidates; reverse, then slice to 2.
  const expected = fullRrf.map((r) => r.id).reverse().slice(0, 2);
  expect(reranked.map((r) => r.id)).toEqual(expected);
  // order changed, but each result keeps its own RRF score + trust + path fields
  const byId = new Map(fullRrf.map((r) => [r.id, r]));
  for (const r of reranked) {
    const orig = byId.get(r.id)!;
    expect(r.score).toBe(orig.score);
    expect(r.trust).toBe(orig.trust);
    expect(r.path).toBe(orig.path);
  }
  await s.close();
});

test("rerank: reranker sees fetched BODIES (marker token lives only in a body)", async () => {
  const s = await LibsqlStore.create(new FakeEmbedder(), undefined, { reranker: new MarkerReranker("MAGNET") });
  await s.remember(ITEMS);
  const reranked = await s.recall({ query: Q, k: 3, rerank: true });
  expect(reranked[0]!.id).toBe("c"); // only c's BODY carries MAGNET — proves the body fetch
  await s.close();
});

// Slow: downloads the ~23MB onnx cross-encoder on first run. Excluded by the root test
// script's pattern ("real cross-encoder"), same scheme as the E5 embedder test.
test("real cross-encoder: ms-marco MiniLM loads, scores pairs, ranks the relevant passage first", async () => {
  const r = new CrossEncoderReranker();
  const order = await r.rerank("How many people live in Berlin?", [
    { id: "pasta", text: "Cook the pasta in salted boiling water for nine minutes, then drain." },
    { id: "berlin", text: "Berlin has a population of 3,520,031 registered inhabitants in an area of 891.82 square kilometers." },
    { id: "piano", text: "Practice piano scales and arpeggios at least twice a week." },
  ]);
  expect(order[0]).toBe("berlin");
  expect(order.sort()).toEqual(["berlin", "pasta", "piano"]); // a permutation, nothing dropped
}, 300_000);
