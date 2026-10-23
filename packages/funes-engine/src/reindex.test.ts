import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import type { MemoryItem } from "funes-core/internal";
import { parseFrontmatter } from "funes-core";
import { fileToItem } from "./markdown.ts";
import { indexDir, referenceMapsOf, unparsedPages, walkMd, walkResolvedItems } from "./reindex.ts";
import { referenceMaps, resolveEdgeTargets } from "funes-core/internal";
import { resolveTarget } from "funes-core";
import { LibsqlStore } from "./libsql/store.ts";
import { buildScopeExclude } from "funes-core/internal";
import { scopeHash } from "funes-core";
import { scopeRefusalReason } from "funes-core/internal";

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
  writeFileSync(join(root, "wiki", "log.md"), "## 2026-10-13\n- ingest piano\n");          // skipped since fm-wikilinks/4
  const store = await LibsqlStore.create(new FakeEmbedder());
  const r = await indexDir(store, root);
  expect(r.files).toBe(2);     // index.md and log.md skipped (OKF §3.1 reserves both)
  expect(r.indexed).toBe(2);
  const res = await store.recall({ query: "protein", k: 2 });
  expect(res.map((x) => x.id)).toContain("wiki/fitness");

  // incremental: re-running skips unchanged files (no re-embed)
  const r2 = await indexDir(store, root);
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

test("I2: resolveEdgeTargets — nested resolves; ambiguous + path-qualified + unmatched untouched", () => {
  const root = makeI2Vault();
  const item: MemoryItem = fileToItem(join(root, "ai", "agents.md"), root);
  resolveEdgeTargets(item, referenceMapsOf(root));
  const targets = (item.edges ?? []).map((e) => e.target);
  expect(targets).toEqual(["ai/rag", "dup", "biz/dup", "ghost"]);
});

test("I2: an edge declared on a NESTED page reaches its target via recall", async () => {
  const root = makeI2Vault();
  const store = await LibsqlStore.create(new FakeEmbedder());
  await indexDir(store, root);
  // "agent body" matches ai/agents; ai/rag shares no tokens with the query — it is reachable
  // ONLY through the resolved edge ai/agents → ai/rag (pre-I2 this edge pointed at the dead
  // basename id "rag" and the edge arm was a no-op).
  const res = await store.recall({ query: "agent body", k: 5 });
  expect(res.map((x) => x.id)).toContain("ai/rag");
  await store.close();
});

// ── PLAN-0.4.0 item 11(c), RAI-127: ONE resolver for every target, slash or not ──
// The funes star's links are zone-relative (`[[entities/cognee]]`) and its ids are not
// (`wiki/entities/cognee`); until fm-wikilinks/3 a slash meant "authored path-id, leave it", and 726
// of its 739 edges dangled. Every case the plan names lives here, once. `null` means "keep the authored string".
test("resolveTarget: exact id, then segment-aligned suffix, then basename, then alias — a collision stops", () => {
  const maps = referenceMaps([
    { id: "wiki/entities/cognee" },
    { id: "wiki/xentities/cognee" },           // shares the string suffix `entities/cognee`, not the SEGMENT suffix
    { id: "wiki/sources/foo" },
    { id: "raw/foo" },                         // a second `foo`: the basename collides, the suffix does not
    { id: "a/sources/bar" }, { id: "b/sources/bar" },
    { id: "notes/only" },
    { id: "wiki/rag", aliases: ["retrieval"] },
  ]);
  const from = "wiki/synthesis/y";
  expect(resolveTarget("entities/cognee", from, maps)).toBe("wiki/entities/cognee");
  expect(maps.bySuffix.get("entities/cognee")).toBe("wiki/entities/cognee"); // `wiki/xentities/cognee` does not match
  expect(resolveTarget("cognee", from, maps)).toBeNull();                     // two basenames: never guessed
  expect(resolveTarget("sources/foo", from, maps)).toBe("wiki/sources/foo");  // two `foo` ids, one `…/sources/foo`
  expect(resolveTarget("sources/bar", from, maps)).toBeNull();                // two `…/sources/bar`: never guessed
  expect(resolveTarget(" wiki/entities/cognee.md ", from, maps)).toBe("wiki/entities/cognee"); // trim, one `.md`
  expect(resolveTarget("elsewhere/only", from, maps)).toBe("notes/only");     // no suffix hit: the basename, as the stem rule did
  expect(resolveTarget("retrieval", from, maps)).toBe("wiki/rag");            // alias, slash-less only
  expect(resolveTarget("x/retrieval", from, maps)).toBeNull();
  expect(resolveTarget("ghost", from, maps)).toBeNull();
  // A collision STOPS — observable only on a slash-less target with an alias (a slash target whose
  // suffix collides has a colliding basename too, and never reaches the alias stage).
  expect(resolveTarget("rag", from, referenceMaps([{ id: "wiki/rag" }, { id: "notes/rag" }, { id: "wiki/retrieval", aliases: ["rag"] }]))).toBeNull();
  // exact id beats a colliding suffix: `sources/bar` is not an id, but an id that IS its own string is
  expect(resolveTarget("a/sources/bar", from, referenceMaps([{ id: "a/sources/bar" }, { id: "x/a/sources/bar" }]))).toBe("a/sources/bar");
});

test("resolveTarget: relative and rooted targets match an exact id or nothing, and never escape the root", () => {
  const withX = referenceMaps([{ id: "wiki/entities/x" }, { id: "notes/beta" }, { id: "entities/x" }, { id: "wiki/y/entities/x" }]);
  const noX = referenceMaps([{ id: "other/entities/x" }, { id: "notes/beta" }, { id: "x" }]);
  // relative: joined to dirname(fromId), exact id only — a miss never falls to suffix or basename
  expect(resolveTarget("../entities/x", "wiki/synthesis/y", withX)).toBe("wiki/entities/x");
  expect(resolveTarget("../entities/x", "wiki/synthesis/y", noX)).toBeNull();
  expect(resolveTarget("./beta", "notes/alpha", withX)).toBe("notes/beta");
  expect(resolveTarget("./beta", "wiki/alpha", withX)).toBeNull(); // no `wiki/beta`: a `.` segment never falls to the unique basename
  // a unique `beta` exists; the relative path names another page, or escapes the root — stays authored
  expect(resolveTarget("../../secret/beta", "wiki/synthesis/y", withX)).toBeNull();
  expect(resolveTarget("../../secret/beta", "wiki/y", withX)).toBeNull();
  // rooted: from the vault root, NEVER joined to the linking page's dir — `wiki/y/entities/x` exists
  expect(resolveTarget("/entities/x", "wiki/y", withX)).toBe("entities/x");
  expect(resolveTarget("/entities/x", "wiki/y", noX)).toBeNull();
  expect(resolveTarget("/entities/x", "wiki/y", referenceMaps([{ id: "wiki/y/entities/x" }]))).toBeNull();
  expect(resolveTarget("/../secret/beta", "wiki/y", withX)).toBeNull();
});

test("resolveEdgeTargets resolves EVERY edge target — explicit rooted, zone-relative and relative alike", () => {
  const root = mkdtempSync(join(tmpdir(), "funes-suffix-"));
  mkdirSync(join(root, "wiki", "entities"), { recursive: true });
  mkdirSync(join(root, "wiki", "synthesis"), { recursive: true });
  writeFileSync(join(root, "wiki", "entities", "cognee.md"), "---\ntitle: Cognee\n---\nknowledge graph engine");
  writeFileSync(join(root, "wiki", "synthesis", "survey.md"), "---\ntitle: Survey\nedges:\n  - { type: cites, target: /wiki/entities/cognee }\n---\nsee [[entities/cognee]] and [[../entities/cognee]]");
  const item = fileToItem(join(root, "wiki", "synthesis", "survey.md"), root);
  resolveEdgeTargets(item, referenceMapsOf(root));
  expect(item.edges!.map((e) => e.target)).toEqual(["wiki/entities/cognee", "wiki/entities/cognee", "wiki/entities/cognee"]);
});

// PLAN-0.4.0 item 11(a): the parse error rides a THIRD field through walkResolvedItems into
// IndexResult.unparsed — a page the retry recovers is not unparsed, and meta never carries it.
test("indexDir reports the pages whose frontmatter does not parse; a recovered page is not one of them", async () => {
  const root = mkdtempSync(join(tmpdir(), "funes-unparsed-"));
  mkdirSync(join(root, "wiki"), { recursive: true });
  writeFileSync(join(root, "wiki", "ok.md"), "---\ntitle: OK\n---\nplain page");
  writeFileSync(join(root, "wiki", "obsidian.md"), "---\ntitle: Obs\ntags: [#a, #b]\nrelated: [[ok]], [[broken]]\n---\nrecovered page");
  writeFileSync(join(root, "wiki", "broken.md"), "---\ntitle: x: y\n---\nbroken page");
  writeFileSync(join(root, "wiki", "open.md"), "---\ntitle: never closed\nopen page");
  writeFileSync(join(root, "wiki", "latin1.md"), Buffer.from([...Buffer.from("---\ntitle: caf"), 0xe9, ...Buffer.from("\n---\nbody")]));
  const store = await LibsqlStore.create(new FakeEmbedder());
  const r = await indexDir(store, root);
  expect(r.files).toBe(5);
  expect(r.unparsed).toEqual(["wiki/broken", "wiki/latin1", "wiki/open"]); // walk order; non-UTF-8 is malformed too
  // 0.5.0 item 20 (ADR-0012): skipped fail-closed — its trust and tombstone are unknowable — and
  // still stat-recorded, so freshness sees the page and an edit that repairs it.
  expect(r.indexed).toBe(2);
  expect((await store.stats()).nodes).toBe(2);
  for (const id of ["wiki/obsidian", "wiki/ok"]) expect(await store.indexedPage({ id })).not.toBeNull();
  expect((await store.pageStats())!.rows.map((s) => s.id).sort()).toEqual(["wiki/broken", "wiki/latin1", "wiki/obsidian", "wiki/ok", "wiki/open"]);
  await store.close();
});

/** A vault over every OKF case the full build counts (ADR-0012 §What keeps it true). */
function makeOkfVault(): string {
  const root = mkdtempSync(join(tmpdir(), "funes-okf-"));
  mkdirSync(join(root, "wiki", "sub"), { recursive: true });
  mkdirSync(join(root, "raw"));
  writeFileSync(join(root, "wiki", "ok.md"), "---\ntype: note\n---\nconforms");
  writeFileSync(join(root, "wiki", "notype.md"), "---\ntitle: N\n---\nno type");        // insert-type
  writeFileSync(join(root, "wiki", "plain.md"), "no frontmatter at all");               // prepend
  writeFileSync(join(root, "wiki", "broken.md"), "---\ntitle: x: y\n---\nbroken");     // malformed
  writeFileSync(join(root, "wiki", "index.md"), "---\nkind: index\n---\n# Wiki\n");    // reserved, out of shape
  writeFileSync(join(root, "wiki", "sub", "index.md"), "# Sub\n");                      // reserved, in shape
  writeFileSync(join(root, "log.md"), "## 2026-10-13\n- b\n\n## 2026-10-12\n- a\n");    // reserved, in shape
  writeFileSync(join(root, "raw", "imported.md"), "an import, never normalized");      // incoming: outside the OKF scope
  writeFileSync(join(root, "excluded.md"), "outside the index scope");                 // excluded below
  return root;
}

test("a FULL build stamps okf_nonconformant and okf_malformed over the OKF scope, reserved files included", async () => {
  const root = makeOkfVault();
  const store = await LibsqlStore.create(new FakeEmbedder());
  try {
    expect((await store.stats()).okf).toBeNull(); // never built: not counted, never a zero
    await indexDir(store, root, { exclude: (rel) => rel === "excluded.md" });
    expect((await store.stats()).okf).toEqual({ nonconformant: 4, malformed: 1 });
    // `memory.okf: false` turns the counters off: a full build clears them
    await indexDir(store, root, { okf: false });
    expect((await store.stats()).okf).toBeNull();
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// A recovered page's `aliases:` feed the resolver: referenceMapsOf reads them through the same
// tolerant parse, so `tags: [#a]` on the page does not cost it its alias.
test("an alias on a page the tolerant retry recovers resolves a link", () => {
  const root = mkdtempSync(join(tmpdir(), "funes-alias-recovered-"));
  try {
    mkdirSync(join(root, "wiki"));
    writeFileSync(join(root, "wiki", "theory-of-mind.md"), "---\ntitle: T\ntags: [#a]\naliases: [ToM]\n---\nx");
    writeFileSync(join(root, "wiki", "b.md"), "---\ntitle: B\n---\nsee [[ToM]]");
    const b = [...walkResolvedItems(root, root)].find((r) => r.item.id === "wiki/b")!;
    expect(b.item.edges).toEqual([{ type: "related-to", target: "wiki/theory-of-mind" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// doctor must print its report on a vault in an odd state: a directory it cannot list (or a file a
// sync client removes mid-walk) stops the walk, and the finding says so instead of costing the report.
test("unparsedPages survives a walk error: the pages read before it, and the error named", () => {
  const root = mkdtempSync(join(tmpdir(), "funes-unparsed-walk-"));
  writeFileSync(join(root, "a.md"), "---\ntitle: x: y\n---\nbroken page");
  mkdirSync(join(root, "locked"));
  chmodSync(join(root, "locked"), 0o000);
  try {
    const r = unparsedPages(root);
    expect(r.ids).toEqual(["a"]);
    expect(r.walkError).toContain("EACCES");
  } finally {
    chmodSync(join(root, "locked"), 0o755);
    rmSync(root, { recursive: true, force: true });
  }
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
  await indexDir(store, root, {
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

test("H2 invalidation: valid scoped rebuild -> delete manifest -> configless rebuild INVALIDATES -> restore-identical still refuses until a scoped reindex", async () => {
  // The exploit chain (Codex R4): a valid scoped rebuild stamps a clean H; delete star.yaml; a
  // configless full rebuild admits the excluded files (old H would linger); restore an IDENTICAL
  // star.yaml; the serve-time recompute would match the stale clean H and serve the excluded files.
  // Fix: a null-signature (absent-manifest) full rebuild CLEARS the signature, so it stays refused.
  const root = makeScopeVault();
  const secretGlob = "secret/**";
  const store = await LibsqlStore.create(new FakeEmbedder());
  // (1) valid scoped rebuild: excludes secret/, stamps the scoped signature
  await indexDir(store, root, {
    exclude: buildScopeExclude([secretGlob]),
    scopeSignature: { hash: scopeHash([secretGlob]), ignoreScope: false },
  });
  expect(await store.indexedPage({ id: "secret/s" })).toBeNull();      // excluded
  expect(await store.getScopeSignature()).toEqual({ hash: scopeHash([secretGlob]), ignoreScope: false });

  // (2) "delete star.yaml" -> a configless full rebuild: admits the secret file AND invalidates
  await indexDir(store, root, { scopeSignature: null });
  expect((await store.indexedPage({ id: "secret/s" }))?.title).toBe("Secret"); // re-admitted
  expect(await store.getScopeSignature()).toBeNull();                  // signature INVALIDATED

  // (3) "restore an identical star.yaml" -> the serve-time recompute must STILL refuse (no signature)
  const expected = scopeHash([secretGlob]);
  expect(scopeRefusalReason(await store.getScopeSignature(), expected)).toContain("no index_scope signature");

  // (4) only a fresh VALID scoped reindex re-establishes the boundary (re-excludes + re-stamps)
  await indexDir(store, root, {
    exclude: buildScopeExclude([secretGlob]),
    scopeSignature: { hash: expected, ignoreScope: false },
  });
  expect(await store.indexedPage({ id: "secret/s" })).toBeNull();      // excluded again
  expect(scopeRefusalReason(await store.getScopeSignature(), expected)).toBeNull(); // boundary holds
  await store.close();
});

// RAI-157 (PLAN-0.4.0 item 20; Turso spike hazard F5). The owner stamp was an unconditional upsert,
// written at the END of a full run — after the run had already remembered and pruned. Two stars
// pointed at one index each re-stamped it and each pruned the other's rows. The claim is now checked
// BEFORE the run touches a row, and the stamp itself is a compare-and-set.
test("RAI-157: a reindex of another star refuses before it changes a row, naming both ids", async () => {
  const mk = (name: string, body: string) => {
    const root = mkdtempSync(join(tmpdir(), `funes-own-${name}-`));
    writeFileSync(join(root, `${name}.md`), `---\ntitle: ${name}\n---\n${body}`);
    return root;
  };
  const a = mk("alpha", "alpha star page");
  const b = mk("beta", "beta star page");
  const store = await LibsqlStore.create(new FakeEmbedder());
  await indexDir(store, a, { starId: "git://example.org/alpha" });
  const before = await store.stats();

  await expect(indexDir(store, b, { starId: "git://example.org/beta" })).rejects.toThrow(/example\.org\/alpha.*example\.org\/beta|example\.org\/beta.*example\.org\/alpha/);
  const after = await store.stats();
  expect(after.nodes).toBe(before.nodes);
  expect((await store.recall({ query: "alpha star page", k: 3 })).map((r) => r.id)).toContain("alpha");
  expect(await store.getOwnerStarId()).toBe("git://example.org/alpha");

  // The same star under another access method, or its declared previous id, may claim it.
  await indexDir(store, a, { starId: "dropbox://example.org/alpha" });
  expect(await store.getOwnerStarId()).toBe("dropbox://example.org/alpha");
  await indexDir(store, a, { starId: "git://example.org/alpha-renamed", starIdWas: "dropbox://example.org/alpha" });
  expect(await store.getOwnerStarId()).toBe("git://example.org/alpha-renamed");
  await expect(store.setOwnerStarId("git://example.org/beta")).rejects.toThrow(/alpha-renamed/);
  await store.close();
});
