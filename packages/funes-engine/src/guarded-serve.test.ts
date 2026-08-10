import { test, expect } from "bun:test";
import type { Embedder } from "funes-core";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";
import { scopeHash } from "./scope.ts";

// H9 — the ATOMIC cross-star serve guard at the store level. The scope check and the content
// retrieval must be ONE guarded read (check-retrieve-recheck), never check-then-use: a reindex that
// re-admits excluded rows between the guard and the dispatch must REFUSE, never serve the row.

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

const HASH = scopeHash(["raw/**"]);

async function seeded() {
  const store = await LibsqlStore.create(new FakeEmbedder());
  await store.remember([{ id: "wiki/keep", path: "wiki/keep.md", title: "Keep", body: "alpha kept tokens", trust: "trusted" }]);
  await store.setScopeSignature({ hash: HASH, ignoreScope: false });
  return store;
}

test("guardedRead: boundary holds (matching hash, not ignored, not dirty) -> serves the rows", async () => {
  const store = await seeded();
  try {
    const res = await store.guardedRead(HASH, () => store.recall({ query: "alpha kept tokens", k: 5 }));
    expect("ok" in res).toBe(true);
    if ("ok" in res) expect(res.ok.some((r) => r.id === "wiki/keep")).toBe(true);
  } finally { await store.close(); }
});

test("guardedRead: refuses on hash mismatch / --ignore-scope / missing signature at the FIRST check", async () => {
  const store = await seeded();
  try {
    const mm = await store.guardedRead(scopeHash(["other/**"]), () => store.recall({ query: "alpha", k: 5 }));
    expect((mm as { refusal: string }).refusal).toContain("scope-hash mismatch");

    await store.setScopeSignature({ hash: HASH, ignoreScope: true });
    const ig = await store.guardedRead(HASH, () => store.recall({ query: "alpha", k: 5 }));
    expect((ig as { refusal: string }).refusal).toContain("--ignore-scope");

    await store.clearScopeSignature();
    const missing = await store.guardedRead(HASH, () => store.recall({ query: "alpha", k: 5 }));
    expect((missing as { refusal: string }).refusal).toContain("no index_scope signature");
  } finally { await store.close(); }
});

test("guardedRead: refuses while a reindex is IN PROGRESS at the first check (reindexDirty)", async () => {
  const store = await seeded();
  try {
    await store.beginReindex(); // dirty=1
    const res = await store.guardedRead(HASH, () => store.recall({ query: "alpha", k: 5 }));
    expect((res as { refusal: string }).refusal).toContain("reindex is in progress");
    await store.endReindex();
  } finally { await store.close(); }
});

test("guardedRead BARRIER: a reindex that STARTS between the guard-read and the dispatch refuses (re-check catches it) — the re-admitted row is never served", async () => {
  const store = await seeded();
  try {
    // s1 passes (clean, matching). The retrieve fires beginReindex — modelling a reindex that starts
    // AFTER the guard-read but before/while the content is fetched — then recalls. The post-retrieval
    // re-check sees reindexDirty and REFUSES, so the row the retrieve returned is never served.
    let retrieved = false;
    const res = await store.guardedRead(HASH, async () => {
      await store.beginReindex();
      const rows = await store.recall({ query: "alpha kept tokens", k: 5 });
      retrieved = rows.length > 0; // the row WAS retrievable...
      return rows;
    });
    expect(retrieved).toBe(true);          // ...retrieval succeeded...
    expect("refusal" in res).toBe(true);   // ...but the guard refused rather than serve it
    expect((res as { refusal: string }).refusal).toContain("reindex is in progress");
    await store.endReindex();
  } finally { await store.close(); }
});

test("guardedRead BARRIER: a full reindex that COMPLETES during retrieval with a DIFFERENT scope refuses on the re-check", async () => {
  const store = await seeded();
  try {
    // The reindex runs to completion inside the retrieval window AND re-stamps a different scope
    // (widened policy). s1 matched HASH; s2 sees the moved hash and refuses — nothing stale served.
    const res = await store.guardedRead(HASH, async () => {
      await store.beginReindex();
      await store.setScopeSignature({ hash: scopeHash(["changed/**"]), ignoreScope: false });
      await store.endReindex();
      return store.recall({ query: "alpha", k: 5 });
    });
    expect("refusal" in res).toBe(true);
    expect((res as { refusal: string }).refusal).toContain("scope-hash mismatch");
  } finally { await store.close(); }
});
