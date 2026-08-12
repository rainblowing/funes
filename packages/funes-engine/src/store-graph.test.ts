import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder, MemoryItem } from "funes-core";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";

// P1 graph-viz bake — store.graph() shape, family mapping, dangling-edge skip, zones, and caching.

class FakeEmbedder implements Embedder {
  readonly dim = 16;
  private vec(t: string): Float32Array {
    const v = new Float32Array(this.dim);
    for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) v[[...w].reduce((a, c) => a + c.charCodeAt(0), 0) % this.dim]! += 1;
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i]! /= n;
    return v;
  }
  async embedQuery(t: string) { return this.vec(t); }
  async embedPassage(t: string) { return this.vec(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.vec(t)); }
}

const ITEMS: MemoryItem[] = [
  { id: "a", path: "a.md", title: "Alpha", body: "alpha", trust: "trusted", type: "concept", edges: [{ type: "depends-on", target: "b" }, { type: "cites", target: "c" }] },
  { id: "b", path: "b.md", title: "Beta", body: "beta", trust: "trusted", type: "entity", edges: [{ type: "uses", target: "c" }] },
  { id: "c", path: "in_x/c.md", title: "Gamma", body: "gamma", trust: "untrusted", type: "source", edges: [{ type: "contains", target: "ghost" }] },
];

test("graph() bakes nodes with layout/community/degree/zone/type and family-tagged typed edges", async () => {
  const s = await LibsqlStore.create(new FakeEmbedder());
  await s.remember(ITEMS);
  const g = await s.graph({ iterations: 50 });

  expect(g.nodes.length).toBe(3);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const a = byId.get("a")!;
  expect(typeof a.x).toBe("number");
  expect(typeof a.y).toBe("number");
  expect(typeof a.community).toBe("number");
  expect(a.degree).toBe(2);          // a—b, a—c
  expect(a.zone).toBe("wiki");
  expect(a.type).toBe("concept");
  expect(a.trust).toBe("trusted");
  expect(byId.get("c")!.zone).toBe("incoming"); // path in_x/c.md → in_* segment
  expect(byId.get("c")!.type).toBe("source");

  // edges: a→b (depends-on/dependency), a→c (cites/epistemic), b→c (uses/dependency).
  // the dangling c→ghost edge is dropped (ghost isn't a node).
  expect(g.edges.length).toBe(3);
  const fam = new Map(g.edges.map((e) => [e.type, e.family]));
  expect(fam.get("depends-on")).toBe("dependency");
  expect(fam.get("cites")).toBe("epistemic");
  expect(fam.get("uses")).toBe("dependency");
  expect(g.edges.some((e) => e.target === "ghost")).toBe(false);
  // the three fixture vectors are orthogonal one-hots → no pair clears the 0.8 cutoff → 0 sim edges.
  expect(g.stats).toEqual({ nodes: 3, edges: 3, simEdges: 0, communities: g.stats.communities });
  expect(g.edges.every((e) => e.family !== "similarity")).toBe(true);
  await s.close();
});

test("graph() bakes thresholded similarity edges (family 'similarity'), de-duped + never doubling a typed edge", async () => {
  const s = await LibsqlStore.create(new FakeEmbedder());
  // p≡q and u≡v are each token-identical → cosine 1.0; cross-pairs share ≤1 token → well under 0.999.
  // u→v ALSO has a typed edge, so its similarity edge must be suppressed (no double draw).
  await s.remember([
    { id: "p", path: "p.md", title: "shared one", body: "alpha beta", type: "concept" },
    { id: "q", path: "q.md", title: "shared one", body: "alpha beta", type: "concept" },
    { id: "u", path: "u.md", title: "shared two", body: "gamma delta", type: "concept", edges: [{ type: "related-to", target: "v" }] },
    { id: "v", path: "v.md", title: "shared two", body: "gamma delta", type: "concept" },
  ]);
  const g = await s.graph({ iterations: 20, simTopK: 3, simCutoff: 0.999 });
  const sim = g.edges.filter((e) => e.family === "similarity");
  const pairs = sim.map((e) => [e.source, e.target].sort().join("-"));
  expect(pairs).toContain("p-q");                 // identical, no typed edge → one similarity edge
  expect(pairs.filter((x) => x === "p-q").length).toBe(1); // undirected de-dup (not p-q AND q-p)
  expect(pairs).not.toContain("u-v");             // identical BUT a typed edge already connects them
  expect(sim.every((e) => e.type === "similar-to" && e.family === "similarity")).toBe(true);
  expect(g.stats.simEdges).toBe(sim.length);
  await s.close();
});

test("graph() caches the artifact beside pgdata + serves it while the signature holds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "funes-graph-"));
  try {
    const s = await LibsqlStore.create(new FakeEmbedder(), join(dir, "pgdata"));
    await s.remember(ITEMS);
    const first = await s.graph({ iterations: 30 });
    expect(existsSync(join(dir, "graph.json"))).toBe(true); // baked beside pgdata
    const second = await s.graph({ iterations: 30 });
    expect(second.builtAt).toBe(first.builtAt);   // cache hit (same signature) → not rebuilt
    expect(second.signature).toBe(first.signature);
    await s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
