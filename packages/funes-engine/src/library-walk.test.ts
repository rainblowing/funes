// RAI-315 (Q5, Q6, Q9): the Library's node-host seams, through `funes-engine` "." only, on a scratch
// FUNES_HOME — the contract walk `reindex(vault, …)`, the scoped `buildReferenceMaps(root)`, and a
// read-only `folderContext` that refuses every mutation before it touches the vault.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { dispatchToolCall, scopeHash } from "funes-core";
import { buildReferenceMaps, folderContext, funesDbDir, makeStore, readIndexOwner, reindex } from "funes-engine";

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

const ID = "git://example.org/walk";
let home: string;
let vault: string;
const saved = process.env.FUNES_HOME;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "funes-walk-home-"));
  process.env.FUNES_HOME = home;
  vault = join(mkdtempSync(join(tmpdir(), "funes-walk-")), "walk");
  mkdirSync(join(vault, "wiki"), { recursive: true });
  mkdirSync(join(vault, "secret"));
  writeFileSync(join(vault, "star.yaml"), `meta:\n  id: ${ID}\nmemory:\n  index_scope:\n    exclude: ["secret/**"]\n`);
  writeFileSync(join(vault, "wiki", "alpha.md"), "---\ntitle: Alpha\naliases: [First]\n---\nalpha body [[beta]]\n");
  writeFileSync(join(vault, "wiki", "beta.md"), "---\ntitle: Beta\n---\nbeta body\n");
  writeFileSync(join(vault, "secret", "raw.md"), "---\ntitle: Secret\n---\nsecret body\n");
});
afterAll(() => {
  if (saved === undefined) delete process.env.FUNES_HOME;
  else process.env.FUNES_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

test("reindex(vault) builds the live index at funesDbDir(vault) over the star's scope, and stamps scope and owner", async () => {
  const seen: number[] = [];
  const r = await reindex(vault, { embedder: new FakeEmbedder(), onProgress: (p) => seen.push(p.files) });
  expect(r).toMatchObject({ files: 2, indexed: 2, pruned: 0, unparsed: [] });
  expect(seen.length).toBeGreaterThan(0);
  expect(funesDbDir(vault).startsWith(home)).toBe(true);
  expect(readIndexOwner(funesDbDir(vault))).toBe(ID);
  const store = await makeStore({ vault, embedder: new FakeEmbedder(), readonly: true });
  try {
    expect((await store.getScopeSignature())?.hash).toBe(scopeHash(["secret/**"]));
    expect(await store.indexedPage({ id: "secret/raw" })).toBeNull();
    expect((await store.indexedPage({ id: "wiki/alpha" }))?.title).toBe("Alpha");
  } finally {
    await store.close();
  }
  // a second run is incremental: nothing re-embeds
  expect(await reindex(vault, { embedder: new FakeEmbedder() })).toMatchObject({ files: 2, indexed: 0, skipped: 2 });
});

test("reindex(vault) refuses an invalid star.yaml scope before it opens a store", async () => {
  const bad = join(mkdtempSync(join(tmpdir(), "funes-walk-bad-")), "bad");
  mkdirSync(bad);
  writeFileSync(join(bad, "star.yaml"), "memory:\n  index_scope:\n    exclude: 7\n");
  await expect(reindex(bad, { embedder: new FakeEmbedder() })).rejects.toThrow(/index_scope is invalid/);
  expect(existsSync(funesDbDir(bad))).toBe(false);
});

test("buildReferenceMaps(root) sees the pages the walk indexes: the scope's excludes are out", async () => {
  const maps = await buildReferenceMaps(vault);
  expect([...maps.ids].sort()).toEqual(["wiki/alpha", "wiki/beta"]);
  expect(maps.byBase.get("beta")).toBe("wiki/beta");
  expect(maps.byAlias.get("First")).toBe("wiki/alpha");
  const bad = join(mkdtempSync(join(tmpdir(), "funes-maps-bad-")), "bad");
  mkdirSync(bad);
  writeFileSync(join(bad, "star.yaml"), "memory:\n  index_scope:\n    exclude: 7\n");
  await expect(buildReferenceMaps(bad)).rejects.toThrow(/index_scope is invalid/);
});

test("folderContext over a read-only store serves the reads and refuses every mutation before it touches the vault", async () => {
  const store = await makeStore({ vault, embedder: new FakeEmbedder(), readonly: true });
  try {
    const ctx = folderContext({ vault, store });
    const before = readdirSync(join(vault, "wiki")).sort();
    const alpha = readFileSync(join(vault, "wiki", "alpha.md"), "utf8");
    expect(((await dispatchToolCall("recall", { query: "alpha" }, ctx)) as { results: unknown[] }).results.length).toBeGreaterThan(0);
    await expect(dispatchToolCall("forget", { id: "wiki/alpha" }, ctx)).rejects.toThrow(/unknown operation: forget/);
    await expect(dispatchToolCall("remember", { title: "New", body: "x" }, ctx)).rejects.toThrow(/unknown operation: remember/);
    await expect(dispatchToolCall("supersede", { oldId: "wiki/alpha", title: "A2", body: "x" }, ctx)).rejects.toThrow(/unknown operation: supersede/);
    expect(readFileSync(join(vault, "wiki", "alpha.md"), "utf8")).toBe(alpha);
    expect(readdirSync(join(vault, "wiki")).sort()).toEqual(before);
    expect(existsSync(join(vault, "out_memory"))).toBe(false);
  } finally {
    await store.close();
  }
  // a read-write store over the same star keeps its writes
  const rw = await makeStore({ vault, embedder: new FakeEmbedder() });
  try {
    expect(folderContext({ vault, store: rw }).narrow).toBeUndefined();
  } finally {
    await rw.close();
  }
});

test("makeStore refuses a Turso star and names its funes serve URL", async () => {
  const org = join(mkdtempSync(join(tmpdir(), "funes-walk-org-")), "org");
  mkdirSync(org);
  writeFileSync(join(org, "star.yaml"), "meta:\n  id: rainblow.ing/org\n  write_locus: host-a\nmemory:\n  tier: org\n  substrate: turso\n");
  await expect(makeStore({ vault: org, embedder: new FakeEmbedder() })).rejects.toThrow(/http:\/\/host-a:8787\/mcp/);
});
