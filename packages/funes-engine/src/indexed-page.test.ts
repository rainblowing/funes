import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";
import { FunesStore } from "./funes-store.ts";
import { indexDir } from "./reindex.ts";
import { operations, dispatchToolCall, type OperationContext } from "./ops.ts";
import { startDaemon } from "./daemon.ts";

// indexed_page — the cross-star read that serves the INDEX SNAPSHOT, never the vault filesystem, so
// index_scope is the capability boundary (a deleted-but-indexed file still answers; an on-disk-but-
// excluded file does not) with no TOCTOU. Exercised at the store, op, and daemon-HTTP (proxy) levels.

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

/** A vault with an indexed wiki page, an indexed page we later delete from disk, and an EXCLUDED
 *  page (present on disk, never indexed). Returns an opened LibsqlStore over the indexed rows. */
async function indexedVault() {
  const vault = mkdtempSync(join(tmpdir(), "funes-idxpage-"));
  mkdirSync(join(vault, "wiki"));
  mkdirSync(join(vault, "secret"));
  writeFileSync(join(vault, "wiki", "keep.md"), "---\ntitle: Keep\ntype: note\n---\nkept body tokens\n");
  writeFileSync(join(vault, "wiki", "gone.md"), "---\ntitle: Gone\n---\ndoomed body tokens\n");
  writeFileSync(join(vault, "secret", "raw.md"), "---\ntitle: Secret\n---\nsecret body never indexed\n");
  const store = await LibsqlStore.create(new FakeEmbedder());
  await indexDir(store, vault, vault, { exclude: (rel) => rel.startsWith("secret/") });
  return { vault, store, cleanup: async () => { await store.close(); rmSync(vault, { recursive: true, force: true }); } };
}

test("indexedPage (store): serves the DB snapshot by id and by path; a deleted-on-disk file still answers", async () => {
  const v = await indexedVault();
  try {
    const byId = await v.store.indexedPage({ id: "wiki/keep" });
    expect(byId?.title).toBe("Keep");
    expect(byId?.type).toBe("note");
    expect(byId?.body).toContain("kept body tokens");

    // path lookup accepts the stored path (with .md) too
    expect((await v.store.indexedPage({ path: "wiki/keep.md" }))?.id).toBe("wiki/keep");

    // DELETE the source file — indexed_page reads the `nodes` row, so it STILL serves the body
    // (proving it never touched the filesystem).
    unlinkSync(join(v.vault, "wiki", "gone.md"));
    const gone = await v.store.indexedPage({ path: "wiki/gone.md" });
    expect(gone?.body).toContain("doomed body tokens");
  } finally { await v.cleanup(); }
});

test("indexedPage (store): an on-disk-but-EXCLUDED path is not-found — the index is the capability boundary", async () => {
  const v = await indexedVault();
  try {
    // secret/raw.md exists on disk but was excluded from the index — it must NOT be readable.
    expect(await v.store.indexedPage({ path: "secret/raw.md" })).toBeNull();
    expect(await v.store.indexedPage({ id: "secret/raw" })).toBeNull();
    expect(await v.store.indexedPage({ id: "does/not/exist" })).toBeNull();
    expect(await v.store.indexedPage({})).toBeNull();
  } finally { await v.cleanup(); }
});

test("indexed_page (op): returns the snapshot; missing id/path and unindexed refs error", async () => {
  const v = await indexedVault();
  const ctx: OperationContext = { remote: true, trust: "untrusted", vault: v.vault, store: v.store, funes: new FunesStore(v.store, { root: v.vault }) };
  try {
    const page = (await dispatchToolCall(operations, "indexed_page", { id: "wiki/keep" }, ctx)) as { body: string };
    expect(page.body).toContain("kept body tokens");
    await expect(dispatchToolCall(operations, "indexed_page", {}, ctx)).rejects.toThrow(/provide an `id` or a `path`/);
    await expect(dispatchToolCall(operations, "indexed_page", { path: "secret/raw.md" }, ctx)).rejects.toThrow(/not in the index/);
  } finally { await v.cleanup(); }
});

test("indexed_page over the daemon HTTP spine (the proxy route): /api/indexed_page serves the snapshot", async () => {
  const v = await indexedVault();
  const server = startDaemon({ vault: v.vault, store: v.store, port: 0 });
  try {
    const r = (await (await fetch(`http://127.0.0.1:${server.port}/api/indexed_page`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "wiki/keep" }),
    })).json()) as { ok: boolean; result: { title: string; body: string } };
    expect(r.ok).toBe(true);
    expect(r.result.title).toBe("Keep");
    expect(r.result.body).toContain("kept body tokens");

    const nf = (await (await fetch(`http://127.0.0.1:${server.port}/api/indexed_page`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "secret/raw.md" }),
    })).json()) as { ok: boolean; error?: string };
    expect(nf.ok).toBe(false);
    expect(nf.error).toContain("not in the index");
  } finally {
    server.stop(true);
    await v.cleanup();
  }
});
