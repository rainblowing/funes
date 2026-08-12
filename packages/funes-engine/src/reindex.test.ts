import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder, MemoryItem } from "funes-core";
import { parseFrontmatter, fileToItem } from "./markdown.ts";
import { indexDir, buildBasenameMap, resolveEdgeTargets, walkMd } from "./reindex.ts";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";
import { buildScopeExclude, scopeHash, scopeRefusalReason } from "./scope.ts";

class FakeEmbedder implements Embedder {
  readonly dim = 16;
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

test("parseFrontmatter: valid / malformed / none", () => {
  expect(parseFrontmatter("---\ntitle: X\ntype: note\n---\nbody").data).toEqual({ title: "X", type: "note" });
  expect(parseFrontmatter("---\nfoo: bar: baz\n---\nb").data).toEqual({});   // malformed -> {}
  expect(parseFrontmatter("# heading\ntext").data).toEqual({});
});

test("fileToItem: id from relative path, edges parsed", () => {
  const root = mkdtempSync(join(tmpdir(), "funes-md-"));
  mkdirSync(join(root, "ai"), { recursive: true });
  const f = join(root, "ai", "agents.md");
  writeFileSync(f, "---\ntitle: Agents\ntype: concept\nedges:\n  - { type: relates_to, target: rag }\n---\nAgent body");
  const it = fileToItem(f, root);
  expect(it.id).toBe("ai/agents");
  expect(it.title).toBe("Agents");
  expect(it.edges).toEqual([{ type: "relates_to", target: "rag", weight: undefined }]);
});

test("fileToItem: NUL bytes stripped at the read boundary (Postgres text rejects them)", async () => {
  // Real vaults contain binary-ish imports (PDF-extraction artifacts); one such file aborted a
  // whole-vault PGLite reindex with `invalid byte sequence for encoding "UTF8": 0x00`.
  const NUL = String.fromCharCode(0);
  const root = mkdtempSync(join(tmpdir(), "funes-nul-"));
  const f = join(root, "binary-ish.md");
  writeFileSync(f, `---\ntitle: Pdf artifact\n---\nbinary ${NUL}junk${NUL} extracted text`);
  const it = fileToItem(f, root);
  expect(it.body.includes(NUL)).toBe(false);
  expect(it.body).toContain("junk"); // content survives, only NULs dropped
  // end-to-end: the item inserts into PGLite without an encoding error
  const store = await LibsqlStore.create(new FakeEmbedder());
  await store.remember([it]);
  const res = await store.recall({ query: "binary junk extracted", k: 1 });
  expect(res.length).toBe(1);
  await store.close();
});

test("walkMd skips ingest .md.raw sidecars + .ingest-baselines.json (twinkling INGEST-hardening contract)", () => {
  // The twinkling .raw sidecar contract (Track A) preserves original ingest bytes in <name>.md.raw,
  // and SHA-256 baselines live in .ingest-baselines.json. Neither is a `.md`, so the indexer must
  // never read them. Pinned here so a future walkMd change can't silently start indexing raw bytes.
  const root = mkdtempSync(join(tmpdir(), "funes-raw-"));
  mkdirSync(join(root, "in_web"), { recursive: true });
  writeFileSync(join(root, "in_web", "doc.md"), "---\ntitle: Doc\n---\nclean body");
  writeFileSync(join(root, "in_web", "doc.md.raw"), "original <!-- injected --> bytes");
  writeFileSync(join(root, ".ingest-baselines.json"), '{"version":1,"files":{}}');
  const yielded = [...walkMd(root)].map((p) => p.replace(root + "/", ""));
  expect(yielded).toContain("in_web/doc.md");
  expect(yielded).not.toContain("in_web/doc.md.raw");
  expect(yielded.some((p) => p.endsWith(".raw"))).toBe(false);
  expect(yielded.some((p) => p.endsWith(".json"))).toBe(false);
});

test("indexDir: markdown tree -> store -> recall", async () => {
  const root = mkdtempSync(join(tmpdir(), "funes-idx-"));
  mkdirSync(join(root, "wiki"), { recursive: true });
  writeFileSync(join(root, "wiki", "fitness.md"), "---\ntitle: Fitness\n---\nprotein muscle fat goals");
  writeFileSync(join(root, "wiki", "piano.md"), "---\ntitle: Piano\n---\nscales arpeggios");
  writeFileSync(join(root, "wiki", "index.md"), "---\ntitle: wiki\nkind: index\n---\n");   // skipped
  const store = await LibsqlStore.create(new FakeEmbedder());
  const r = await indexDir(store, root, join(root, "wiki"));
  expect(r.files).toBe(2);     // index.md skipped
  expect(r.indexed).toBe(2);
  const res = await store.recall({ query: "protein", k: 2 });
  expect(res.map((x) => x.id)).toContain("wiki/fitness");

  // incremental: re-running skips unchanged files (no re-embed)
  const r2 = await indexDir(store, root, join(root, "wiki"));
  expect(r2.files).toBe(2);
  expect(r2.indexed).toBe(0);
  expect(r2.skipped).toBe(2);
  await store.close();
});

// ── I2: edge-target resolution (basenames → path-qualified ids at index time) ──

/** Vault for the resolution rules: a nested page, an ambiguous basename, a path-qualified target. */
function makeI2Vault(): string {
  const root = mkdtempSync(join(tmpdir(), "funes-i2-"));
  mkdirSync(join(root, "ai"), { recursive: true });
  mkdirSync(join(root, "biz"), { recursive: true });
  writeFileSync(join(root, "ai", "rag.md"), "---\ntitle: RAG\n---\nretrieval augmented generation");
  writeFileSync(join(root, "ai", "dup.md"), "---\ntitle: Dup A\n---\nfirst duplicate");
  writeFileSync(join(root, "biz", "dup.md"), "---\ntitle: Dup B\n---\nsecond duplicate");
  writeFileSync(
    join(root, "ai", "agents.md"),
    "---\ntitle: Agents\nedges:\n" +
      "  - { type: relates_to, target: rag }\n" +          // basename → must resolve to ai/rag
      "  - { type: relates_to, target: dup }\n" +          // ambiguous → must pass through
      "  - { type: relates_to, target: biz/dup }\n" +      // path-qualified → untouched
      "  - { type: relates_to, target: ghost }\n" +        // unmatched → untouched
      "---\nagent body",
  );
  return root;
}

test("I2: buildBasenameMap — unique ids, ambiguity marked null", () => {
  const root = makeI2Vault();
  const map = buildBasenameMap(root);
  expect(map.get("rag")).toBe("ai/rag");
  expect(map.get("agents")).toBe("ai/agents");
  expect(map.get("dup")).toBe(null); // same basename in 2 folders → ambiguous
  expect(map.has("ghost")).toBe(false);
});

test("I2: resolveEdgeTargets — nested resolves; ambiguous + path-qualified + unmatched untouched", () => {
  const root = makeI2Vault();
  const map = buildBasenameMap(root);
  const item: MemoryItem = fileToItem(join(root, "ai", "agents.md"), root);
  resolveEdgeTargets(item, map);
  const targets = (item.edges ?? []).map((e) => e.target);
  expect(targets).toEqual(["ai/rag", "dup", "biz/dup", "ghost"]);
});

test("I2: an edge declared on a NESTED page reaches its target via recall", async () => {
  const root = makeI2Vault();
  const store = await LibsqlStore.create(new FakeEmbedder());
  await indexDir(store, root, root);
  // "agent body" matches ai/agents; ai/rag shares no tokens with the query — it is reachable
  // ONLY through the resolved edge ai/agents → ai/rag (pre-I2 this edge pointed at the dead
  // basename id "rag" and the edge arm was a no-op).
  const res = await store.recall({ query: "agent body", k: 5 });
  expect(res.map((x) => x.id)).toContain("ai/rag");
  await store.close();
});

// ── reindex --fresh: only a FULL run may wipe (the stale-derived-column repair path, 2026-07-16) ──
// NOTE: the pglite-specific variant of this test (poking the tsvector `search_vector` column to prove
// --fresh recomputes derived columns a hash-skip preserves) was removed with PGLite 2026-07-20; the
// libSQL fts5 index has no equivalent inspectable column, and --fresh's wipe-and-rebuild is covered
// by the recall goldens + the bounded-run guard below.

test("indexDir fresh: ignored on a bounded/subdir run — only a FULL run may wipe", async () => {
  const root = mkdtempSync(join(tmpdir(), "funes-fresh-bounded-"));
  mkdirSync(join(root, "wiki"), { recursive: true });
  writeFileSync(join(root, "wiki", "a.md"), "---\ntitle: A\n---\nalpha body");
  writeFileSync(join(root, "wiki", "b.md"), "---\ntitle: B\n---\nbeta body");
  const store = await LibsqlStore.create(new FakeEmbedder());
  await indexDir(store, root, root);
  // a bounded fresh run must NOT wipe the other rows (the CLI rejects the combo; this pins the engine)
  await indexDir(store, root, root, { fresh: true, maxFiles: 1 });
  expect((await store.stats()).nodes).toBe(2);
  await store.close();
});

// ── closure sprint 3B: native index_scope + persisted scope signature (full-prune-only advance) ──

/** Vault with an indexable wiki page and an excluded secret/ file. */
function makeScopeVault(): string {
  const root = mkdtempSync(join(tmpdir(), "funes-scope-idx-"));
  mkdirSync(join(root, "wiki"), { recursive: true });
  mkdirSync(join(root, "secret"), { recursive: true });
  writeFileSync(join(root, "wiki", "keep.md"), "---\ntitle: Keep\n---\nkept tokens\n");
  writeFileSync(join(root, "secret", "s.md"), "---\ntitle: Secret\n---\nsecret tokens\n");
  return root;
}

test("indexDir: a full run applies the scope exclude AND stamps the scope signature", async () => {
  const root = makeScopeVault();
  const store = await LibsqlStore.create(new FakeEmbedder());
  await indexDir(store, root, root, {
    exclude: (rel) => rel.startsWith("secret/"),
    scopeSignature: { hash: "HASH1", ignoreScope: false },
  });
  // excluded file is invisible to the index; the kept page is present
  expect(await store.indexedPage({ id: "secret/s" })).toBeNull();
  expect((await store.indexedPage({ id: "wiki/keep" }))?.title).toBe("Keep");
  // a full run advanced the persisted signature
  expect(await store.getScopeSignature()).toEqual({ hash: "HASH1", ignoreScope: false });
  await store.close();
});

test("indexDir: a bounded --max run does NOT advance the scope signature (R5 #1 — partial run, no prune, no stamp)", async () => {
  const root = makeScopeVault();
  const store = await LibsqlStore.create(new FakeEmbedder());
  // full run stamps HASH1
  await indexDir(store, root, root, { scopeSignature: { hash: "HASH1", ignoreScope: false } });
  expect(await store.getScopeSignature()).toEqual({ hash: "HASH1", ignoreScope: false });
  // a bounded run carrying a DIFFERENT signature must leave the prior one untouched
  await indexDir(store, root, root, { maxFiles: 1, scopeSignature: { hash: "HASH2", ignoreScope: true } });
  expect(await store.getScopeSignature()).toEqual({ hash: "HASH1", ignoreScope: false });
  await store.close();
});

test("H2 invalidation: valid scoped rebuild -> delete manifest -> configless rebuild INVALIDATES -> restore-identical still refuses until a scoped reindex", async () => {
  // The exploit chain (Codex R4): a valid scoped rebuild stamps a clean H; delete star.yaml; a
  // configless full rebuild admits the excluded files (old H would linger); restore an IDENTICAL
  // star.yaml; the serve-time recompute would match the stale clean H and serve the excluded files.
  // Fix: a null-signature (absent-manifest) full rebuild CLEARS the signature, so it stays refused.
  const root = makeScopeVault();
  const secretGlob = "secret/**";
  const store = await LibsqlStore.create(new FakeEmbedder());
  // (1) valid scoped rebuild: excludes secret/, stamps the scoped signature
  await indexDir(store, root, root, {
    exclude: buildScopeExclude([secretGlob]),
    scopeSignature: { hash: scopeHash([secretGlob]), ignoreScope: false },
  });
  expect(await store.indexedPage({ id: "secret/s" })).toBeNull();      // excluded
  expect(await store.getScopeSignature()).toEqual({ hash: scopeHash([secretGlob]), ignoreScope: false });

  // (2) "delete star.yaml" -> a configless full rebuild: admits the secret file AND invalidates
  await indexDir(store, root, root, { scopeSignature: null });
  expect((await store.indexedPage({ id: "secret/s" }))?.title).toBe("Secret"); // re-admitted
  expect(await store.getScopeSignature()).toBeNull();                  // signature INVALIDATED

  // (3) "restore an identical star.yaml" -> the serve-time recompute must STILL refuse (no signature)
  const expected = scopeHash([secretGlob]);
  expect(scopeRefusalReason(await store.getScopeSignature(), expected)).toContain("no index_scope signature");

  // (4) only a fresh VALID scoped reindex re-establishes the boundary (re-excludes + re-stamps)
  await indexDir(store, root, root, {
    exclude: buildScopeExclude([secretGlob]),
    scopeSignature: { hash: expected, ignoreScope: false },
  });
  expect(await store.indexedPage({ id: "secret/s" })).toBeNull();      // excluded again
  expect(scopeRefusalReason(await store.getScopeSignature(), expected)).toBeNull(); // boundary holds
  await store.close();
});
