import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";
import { FunesStore } from "./funes-store.ts";
import { indexDir } from "./reindex.ts";

// Deterministic fake embedder with a configurable model id (for the H1 signature test).
class Fake implements Embedder {
  readonly dim = 16;
  constructor(readonly id = "fake-v1") {}
  private vec(t: string): Float32Array {
    const v = new Float32Array(this.dim);
    for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? [])
      v[[...w].reduce((a, c) => a + c.charCodeAt(0), 0) % this.dim]! += 1;
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i]! /= n;
    return v;
  }
  async embedQuery(t: string) { return this.vec(t); }
  async embedPassage(t: string) { return this.vec(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.vec(t)); }
}

// H1 (GBrain): the embedding-signature drift guard funes had dropped in the bun:sqlite port.
test("H1: a model swap at the same dim is refused on open; the same model reopens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "funes-h1-"));
  const data = join(dir, "index.db");
  const a = await LibsqlStore.create(new Fake("model-a"), data);
  await a.remember([{ id: "x", title: "T", body: "hello world" }]);
  await a.close();

  const reopen = await LibsqlStore.create(new Fake("model-a"), data); // same model -> fine
  await reopen.close();

  // different model, SAME dim = the silent-mis-recall case H1 exists to catch -> hard stop
  await expect(LibsqlStore.create(new Fake("model-b"), data)).rejects.toThrow(/embedding drift/);
  rmSync(dir, { recursive: true, force: true });
});

// H2 / D7 (GBrain): a full reindex prunes index rows whose canonical file is gone.
test("H2: full reindex prunes a deleted file from the index", async () => {
  const root = mkdtempSync(join(tmpdir(), "funes-h2-"));
  writeFileSync(join(root, "keep.md"), "---\ntitle: Keeper\n---\nrebuildable marker content");
  const goner = join(root, "goner.md");
  writeFileSync(goner, "---\ntitle: Goner\n---\nrebuildable marker content");
  const store = await LibsqlStore.create(new Fake());

  let r = await indexDir(store, root, root);
  expect(r.indexed).toBe(2);
  expect((await store.recall({ query: "marker content", k: 10 })).map((x) => x.id)).toContain("goner");

  rmSync(goner);                                  // delete the canonical file
  r = await indexDir(store, root, root);          // full reindex -> prune
  expect(r.pruned).toBeGreaterThanOrEqual(1);
  const ids = (await store.recall({ query: "marker content", k: 10 })).map((x) => x.id);
  expect(ids).toContain("keep");
  expect(ids).not.toContain("goner");

  await store.close();
  rmSync(root, { recursive: true, force: true });
});

// H3 (GBrain): mutations are scoped to out_memory/ — never a human page or a traversing path.
test("H3: supersede/forget refuse ids outside out_memory/", async () => {
  const root = mkdtempSync(join(tmpdir(), "funes-h3-"));
  const store = new FunesStore(await LibsqlStore.create(new Fake()), { root, now: () => "2026-06-09T00:00:00Z" });

  const { ids } = await store.remember([{ title: "Owned", body: "mine" }]);
  expect(ids[0]!.startsWith("out_memory/")).toBe(true);
  await store.forget(ids[0]!);                                            // owned -> ok

  await expect(store.forget("wiki/some-human-page")).rejects.toThrow(/only items under out_memory/);
  await expect(store.supersede("../escape", { title: "x", body: "y" })).rejects.toThrow(/only items under out_memory/);

  await store.close();
  rmSync(root, { recursive: true, force: true });
});

// ── S0 hardening batch (PLAN Rev 6) ─────────────────────────────────────────────

// C1: an explicit id on remember() must be owned — and supersede() can't smuggle next.id.
test("C1: remember/supersede refuse explicit ids outside out_memory/", async () => {
  const root = mkdtempSync(join(tmpdir(), "funes-c1-"));
  const store = new FunesStore(await LibsqlStore.create(new Fake()), { root, now: () => "2026-06-10T00:00:00Z" });

  await expect(store.remember([{ id: "wiki/human-page", title: "x", body: "y" }]))
    .rejects.toThrow(/only items under out_memory/);
  await expect(store.remember([{ id: "../escape", title: "x", body: "y" }]))
    .rejects.toThrow(/only items under out_memory/);

  const { ids } = await store.remember([{ title: "Legit", body: "content" }]);
  await expect(store.supersede(ids[0]!, { id: "wiki/human-page", title: "x", body: "y" }))
    .rejects.toThrow(/only items under out_memory/);

  // explicit ids INSIDE out_memory remain legal
  await store.remember([{ id: "out_memory/explicit-ok", title: "t", body: "b" }]);
  await store.close();
  rmSync(root, { recursive: true, force: true });
});

// NOTE: the C2 test (a failing edge write rolls back the whole item) was removed with PGLite
// 2026-07-20 — it forced the failure with a type-mismatched edge weight, which Postgres rejects but
// libSQL (dynamically typed) accepts, so the scenario can't arise on the default backend. libSQL's
// remember-batch atomicity would need a backend-specific failure injection to exercise.

// H2 dirty-epoch: an interrupted FULL reindex leaves the marker; normal opens refuse; a full
// reindex (opened with allowDirty) repairs and clears it.
test("H2: dirty marker blocks normal open until a full reindex completes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "funes-h2b-"));
  const data = join(dir, "index.db");
  const root = join(dir, "vault");
  writeFileSync(join(mkdtempLike(root), "page.md"), "---\ntitle: Page\n---\nsome content here");

  const s1 = await LibsqlStore.create(new Fake(), data);
  await s1.beginReindex(); // simulate a crash mid-full-reindex
  await s1.close();

  await expect(LibsqlStore.create(new Fake(), data)).rejects.toThrow(/dirty/);

  const s2 = await LibsqlStore.create(new Fake(), data, { allowDirty: true });
  const r = await indexDir(s2, root, root); // full run -> prune -> clears the marker
  expect(r.files).toBe(1);
  await s2.close();

  const s3 = await LibsqlStore.create(new Fake(), data); // clean open
  await s3.close();
  rmSync(dir, { recursive: true, force: true });
});

function mkdtempLike(p: string): string {
  // mkdir -p helper for the vault dir in the H2 test
  const { mkdirSync } = require("node:fs");
  mkdirSync(p, { recursive: true });
  return p;
}
