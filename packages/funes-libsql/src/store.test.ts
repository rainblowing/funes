import { test, expect } from "bun:test";
import type { Embedder, MemoryItem } from "funes-core";
import { LibsqlStore } from "./store.ts";

// LibsqlStore round-trip: index/recall (EN FTS+vector, RU via FTS5 unicode61 + vector), incremental
// skip, trust-sync, remove, prune. Fake embedder tokenizes Unicode (\p{L}\p{N}) so RU rides the
// vector arm — and FTS5 unicode61 carries RU on the FTS arm too (the libSQL win over pglite ASCII).

class FakeEmbedder implements Embedder {
  readonly dim = 64;
  private vec(t: string): Float32Array {
    const v = new Float32Array(this.dim);
    for (const w of t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      let h = 0;
      for (const c of w) h = (h * 31 + c.codePointAt(0)!) % 1_000_003;
      v[h % this.dim]! += 1;
    }
    let norm = 0; for (const x of v) norm += x * x; norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < v.length; i++) v[i]! /= norm;
    return v;
  }
  async embedQuery(t: string) { return this.vec(t); }
  async embedPassage(t: string) { return this.vec(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.vec(t)); }
}

const ITEMS: MemoryItem[] = [
  { id: "sourdough", path: "sourdough.md", title: "Sourdough", body: "rye loaf starter eighty percent hydration ferment overnight bake stone", trust: "trusted", edges: [{ type: "related-to", target: "telescope" }] },
  { id: "борщ", path: "борщ.md", title: "Борщ", body: "классический борщ свёкла капуста говядина сметана варить два часа", trust: "untrusted" },
  { id: "telescope", path: "wiki/telescope.md", title: "Telescope", body: "dobsonian collimation primary mirror laser tool session", trust: "trusted" },
];

test("libsql: index + recall (EN, RU, nested), stats, edges", async () => {
  const s = await LibsqlStore.create(new FakeEmbedder());
  const r = await s.remember(ITEMS);
  expect(r.indexed).toBe(3);

  const st = await s.stats();
  expect(st.nodes).toBe(3);
  expect(st.edges).toBe(1); // sourdough -> telescope

  const en = await s.recall({ query: "rye starter hydration ferment", k: 3 });
  expect(en[0]!.id).toBe("sourdough");

  // RU rides FTS5 (unicode61) AND the vector arm — borscht recalled
  const ru = await s.recall({ query: "борщ свёкла сметана", k: 3 });
  expect(ru.map((x) => x.id)).toContain("борщ");

  const deep = await s.recall({ query: "dobsonian collimation primary mirror", k: 3 });
  expect(deep.map((x) => x.id)).toContain("telescope");

  await s.close();
});

test("libsql: indexedPage — DB snapshot by id and by path (parity with pglite); unknown ref -> null", async () => {
  const s = await LibsqlStore.create(new FakeEmbedder());
  await s.remember(ITEMS);
  const byId = await s.indexedPage({ id: "telescope" });
  expect(byId?.title).toBe("Telescope");
  expect(byId?.trust).toBe("trusted");
  expect(byId?.body).toContain("dobsonian collimation");
  // stored path is nested (wiki/telescope.md) — lookup by path resolves the same row
  expect((await s.indexedPage({ path: "wiki/telescope.md" }))?.id).toBe("telescope");
  expect(await s.indexedPage({ id: "nope" })).toBeNull();
  expect(await s.indexedPage({})).toBeNull();
  await s.close();
});

test("libsql: scope signature roundtrip (parity with pglite) + surfaced in stats()", async () => {
  const s = await LibsqlStore.create(new FakeEmbedder());
  expect(await s.getScopeSignature()).toBeNull(); // never stamped
  expect((await s.stats()).scopeHash).toBeNull();
  await s.setScopeSignature({ hash: "abc123", ignoreScope: true });
  expect(await s.getScopeSignature()).toEqual({ hash: "abc123", ignoreScope: true });
  const st = await s.stats();
  expect(st.scopeHash).toBe("abc123");
  expect(st.ignoreScope).toBe(true);
  await s.close();
});

test("libsql: guardedRead H9 parity — holds on a matching sig, refuses on mismatch/ignore/missing/dirty, and re-checks after retrieval", async () => {
  const s = await LibsqlStore.create(new FakeEmbedder());
  await s.remember(ITEMS);
  const { scopeHash } = await import("funes-shared");
  const HASH = scopeHash(["raw/**"]);
  await s.setScopeSignature({ hash: HASH, ignoreScope: false });

  const ok = await s.guardedRead(HASH, () => s.recall({ query: "rye starter hydration", k: 3 }));
  expect("ok" in ok).toBe(true);

  const mm = await s.guardedRead(scopeHash(["other/**"]), () => s.recall({ query: "rye", k: 3 }));
  expect((mm as { refusal: string }).refusal).toContain("scope-hash mismatch");

  await s.setScopeSignature({ hash: HASH, ignoreScope: true });
  const ig = await s.guardedRead(HASH, () => s.recall({ query: "rye", k: 3 }));
  expect((ig as { refusal: string }).refusal).toContain("--ignore-scope");

  await s.clearScopeSignature();
  const missing = await s.guardedRead(HASH, () => s.recall({ query: "rye", k: 3 }));
  expect((missing as { refusal: string }).refusal).toContain("no index_scope signature");

  // BARRIER: re-stamp a valid sig, then a reindex STARTS during retrieval -> the re-check refuses.
  await s.setScopeSignature({ hash: HASH, ignoreScope: false });
  const barrier = await s.guardedRead(HASH, async () => {
    await s.beginReindex();
    return s.recall({ query: "rye", k: 3 });
  });
  expect((barrier as { refusal: string }).refusal).toContain("reindex is in progress");
  await s.endReindex();
  await s.close();
});

test("libsql: incremental skip (re-remember re-embeds nothing) + trust-sync", async () => {
  const s = await LibsqlStore.create(new FakeEmbedder());
  await s.remember(ITEMS);
  const second = await s.remember(ITEMS);
  expect(second.indexed).toBe(0);
  expect(second.skipped).toBe(3);

  // flip trust only (hash excludes trust) → skipped re-index, trust synced
  const flipped = await s.remember([{ ...ITEMS[1]!, trust: "trusted" }]);
  expect(flipped.indexed).toBe(0);
  const ru = await s.recall({ query: "борщ свёкла", k: 1 });
  expect(ru[0]!.trust).toBe("trusted");
  await s.close();
});

test("libsql: remove + prune drop rows from every table", async () => {
  const s = await LibsqlStore.create(new FakeEmbedder());
  await s.remember(ITEMS);
  expect(await s.remove(["sourdough"])).toBe(1);
  expect((await s.stats()).nodes).toBe(2);
  // sourdough's edge is gone too → no edges left
  expect((await s.stats()).edges).toBe(0);

  const removed = await s.prune(["борщ"]); // keep only борщ
  expect(removed).toBe(1); // telescope pruned
  expect((await s.stats()).nodes).toBe(1);
  const left = await s.recall({ query: "dobsonian mirror", k: 3 });
  expect(left.map((x) => x.id)).not.toContain("telescope");
  await s.close();
});

test("libsql: neighbors (exact kNN + typed edges both ways) + hotlist (trusted-only)", async () => {
  const s = await LibsqlStore.create(new FakeEmbedder(), undefined, { trackRecalls: true });
  await s.remember(ITEMS);
  const nb = await s.neighbors("sourdough", 5);
  expect(nb.node?.id).toBe("sourdough");
  expect(nb.edgesOut.map((e) => `${e.type} ${e.id}`)).toContain("related-to telescope");
  expect(nb.similar.length).toBeGreaterThan(0);
  expect(nb.similar.every((x) => typeof x.score === "number")).toBe(true);
  // telescope is the inbound side of the edge
  const tn = await s.neighbors("telescope", 5);
  expect(tn.edgesIn.map((e) => e.id)).toContain("sourdough");

  // hotlist: trusted-only, after recalls (sourdough trusted; борщ untrusted → never surfaces)
  await s.recall({ query: "rye starter hydration", k: 3 });
  await s.recall({ query: "борщ свёкла", k: 3 });
  const hot = await s.hotlist(10);
  expect(hot.some((h) => h.id === "sourdough")).toBe(true);
  expect(hot.every((h) => h.trust === "trusted")).toBe(true);
  expect(hot.some((h) => h.id === "борщ")).toBe(false);
  await s.close();
});

test("libsql: graph() bake — typed edges, layout, community, degree (similarity deferred)", async () => {
  const s = await LibsqlStore.create(new FakeEmbedder());
  await s.remember(ITEMS);
  const g = await s.graph({ iterations: 30 });
  expect(g.nodes.length).toBe(3);
  expect(g.edges.length).toBe(1); // sourdough -> telescope (typed); борщ isolated (no sim edges yet)
  expect(g.stats).toMatchObject({ nodes: 3, edges: 1, simEdges: 0 });
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const sd = byId.get("sourdough")!;
  expect(sd.degree).toBe(1);
  expect(typeof sd.x).toBe("number");
  expect(typeof sd.community).toBe("number");
  expect(sd.trust).toBe("trusted");
  expect(byId.get("борщ")!.degree).toBe(0);
  await s.close();
});

test("libsql: graph() bakes thresholded similarity edges (P1b parity) connecting near nodes", async () => {
  const s = await LibsqlStore.create(new FakeEmbedder());
  await s.remember([
    { id: "p", path: "p.md", title: "shared one", body: "alpha beta", type: "concept" },
    { id: "q", path: "q.md", title: "shared one", body: "alpha beta", type: "concept" }, // ≡ p → cosine 1
    { id: "r", path: "r.md", title: "other thing", body: "zeta gamma", type: "concept" },
  ]);
  const g = await s.graph({ iterations: 20, simTopK: 3, simCutoff: 0.999 });
  const sim = g.edges.filter((e) => e.family === "similarity");
  const pairs = sim.map((e) => [e.source, e.target].sort().join("-"));
  expect(pairs).toContain("p-q");
  expect(g.stats.simEdges).toBe(sim.length);
  expect(sim.every((e) => e.type === "similar-to")).toBe(true);
  await s.close();
});

test("libsql: dirty-marker refuses normal open", async () => {
  const s = await LibsqlStore.create(new FakeEmbedder());
  await s.beginReindex();
  expect((await s.stats()).reindexDirty).toBe(true);
  await s.endReindex();
  expect((await s.stats()).reindexDirty).toBe(false);
  await s.close();
});
