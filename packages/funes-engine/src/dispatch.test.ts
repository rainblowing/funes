// The one dispatcher (PLAN-0.6.0 §Test-suite consequences, seam 1; ADR-0020, RAI-304, RAI-308): every
// op of the twelve, its arguments, its JSON and its refusals, once, through `dispatchToolCall` over a
// real folder vault and a real libSQL index. The adapters (MCP, CLI, HTTP) each keep one mapping test.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { funesHome } from "./funes-home.ts";
import { GENERATION_VERSION } from "funes-core/internal";
import { LibsqlStore } from "./libsql/store.ts";
import { folderContext, folderPart } from "./funes-store.ts";
import { indexDir } from "./reindex.ts";
import { scopeHash } from "funes-core";
import { ceiling, dispatchToolCall, type OperationContext } from "funes-core";
import { operations } from "funes-core/internal";

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

const STAR = "meta:\n  id: git://example/dispatch\nmemory:\n  index_scope:\n    exclude: [\"secret/**\"]\n";
let vault: string;
let store: LibsqlStore;
let ctx: OperationContext;

beforeAll(async () => {
  vault = mkdtempSync(join(tmpdir(), "funes-dispatch-"));
  mkdirSync(join(vault, "wiki"));
  mkdirSync(join(vault, "secret"));
  writeFileSync(join(vault, "star.yaml"), STAR);
  writeFileSync(join(vault, "wiki", "alpha.md"), "---\ntitle: Alpha\n---\nalpha body tokens [[wiki/beta]]\n");
  writeFileSync(join(vault, "wiki", "beta.md"), "---\ntitle: Beta\n---\nbeta body tokens\n");
  writeFileSync(join(vault, "secret", "raw.md"), "---\ntitle: Secret\n---\nsecret body\n");
  store = await LibsqlStore.create(new FakeEmbedder());
  await indexDir(store, vault, { exclude: (rel) => rel.startsWith("secret/") });
  await store.setScopeSignature({ hash: scopeHash(["secret/**"]), ignoreScope: false });
  ctx = { ...folderContext({ vault, store }), designation: { locus: null, authority: null } };
});
afterAll(async () => {
  await store.close();
  rmSync(vault, { recursive: true, force: true });
});

const call = (name: string, args: Record<string, unknown> = {}, over: Partial<OperationContext> = {}) =>
  dispatchToolCall(name, args, { ...ctx, ...over });
const refusedWith = async (p: Promise<unknown>): Promise<Error & { code?: string }> => {
  try { await p; } catch (e) { return e as Error & { code?: string }; }
  throw new Error("expected a refusal, got an answer");
};
const names = (ops: { name: string }[]) => ops.map((o) => o.name).sort();

// ── the table (ADR-0020) ───────────────────────────────────────────────────────────────────────

test("the registry holds the twelve ops of ADR-0020, with their flags", () => {
  const row = (o: (typeof operations)[number]) => [o.name, o.readonly ? "read" : "write", o.crossStar, o.scopeGuarded, [...o.tiers].join(",")];
  expect(operations.map(row)).toEqual([
    ["recall", "read", true, true, "home,org,edge"],
    ["page", "read", false, false, "home,org,edge"],
    ["indexed_page", "read", true, true, "home,org,edge"],
    ["health", "read", true, false, "home,org,edge"],
    ["tree", "read", false, false, "home"],
    ["neighbors", "read", false, true, "home"],
    ["graph", "read", false, true, "home"],
    ["hotlist", "read", true, true, "home"],
    ["remember", "write", false, false, "home,org"],
    ["supersede", "write", false, false, "home,org"],
    ["forget", "write", false, false, "home,org,edge"],
    ["put_page", "write", false, false, "edge"],
  ]);
});

test("ceiling(): one function gives every host its ops", () => {
  expect(names(ceiling("home"))).toEqual(["forget", "graph", "health", "hotlist", "indexed_page", "neighbors", "page", "recall", "remember", "supersede", "tree"]);
  expect(names(ceiling("org"))).toEqual(["forget", "health", "indexed_page", "page", "recall", "remember", "supersede"]);
  expect(names(ceiling("edge"))).toEqual(["forget", "health", "indexed_page", "page", "put_page", "recall"]);
  expect(names(ceiling("home", { crossStar: true }))).toEqual(["health", "hotlist", "indexed_page", "recall"]);
  expect(names(ceiling("home", { loopback: false }))).toEqual(["health", "hotlist", "indexed_page", "recall", "remember"]);
  expect(names(ceiling("edge", { loopback: false }))).toEqual(names(ceiling("edge")));
});

test("an op outside the tier's ceiling answers unknown operation", async () => {
  expect((await refusedWith(call("tree", {}, { tier: "edge" }))).message).toBe("unknown operation: tree");
  expect((await refusedWith(call("page", { path: "wiki/alpha.md" }, { crossStar: true }))).message).toBe("unknown operation: page");
  for (const gone of ["recall_v2", "vault_page", "link", "guarded_recall", "guarded_health"]) {
    expect((await refusedWith(call(gone))).message).toBe(`unknown operation: ${gone}`);
  }
});

// ── recall ─────────────────────────────────────────────────────────────────────────────────────

const recallResult = operations.find((o) => o.name === "recall")!.result!;
const healthResult = operations.find((o) => o.name === "health")!.result!;

test("recall answers the envelope {contentGeneration, results}, and it parses strictly", async () => {
  const r = await call("recall", { query: "alpha body tokens" }) as Record<string, unknown>;
  expect(Object.keys(r).sort()).toEqual(["contentGeneration", "results"]);
  recallResult.parse(r);
  const hit = (r.results as Array<Record<string, unknown>>)[0]!;
  expect(hit).toMatchObject({ id: "wiki/alpha", title: "Alpha", path: "wiki/alpha.md", rank: 1 });
  expect(hit.vaultChangedSinceReindex).toBeUndefined(); // moved up to the envelope (RAI-308)
});

test("recall: a strict schema refuses a key nobody declared", () => {
  expect(() => recallResult.parse({ contentGeneration: null, results: [], locus: "x" })).toThrow();
  expect(() => recallResult.parse({ contentGeneration: null, results: [{ id: "a", title: "A", path: "a.md", rank: 1, score: 0, trust: "trusted", vaultChangedSinceReindex: true }] })).toThrow();
});

test("recall: a `where` with no declaration refuses; `k` clamps", async () => {
  expect((await refusedWith(call("recall", { query: "alpha", where: { domain: "x" } }))).message).toMatch(/declares no memory\.recall/);
  const r = await call("recall", { query: "body tokens", k: 999 }) as { results: unknown[] };
  expect(r.results.length).toBeLessThanOrEqual(50);
});

// ── page ───────────────────────────────────────────────────────────────────────────────────────

test("page answers {path, sha256, frontmatter, body}; raw adds the exact bytes as content", async () => {
  const bytes = readFileSync(join(vault, "wiki", "alpha.md"));
  const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  expect(await call("page", { path: "wiki/alpha.md" })).toEqual({ path: "wiki/alpha.md", sha256: sha, frontmatter: { title: "Alpha" }, body: "alpha body tokens [[wiki/beta]]\n" });
  expect(await call("page", { path: "wiki/alpha.md", raw: true })).toMatchObject({ sha256: sha, content: bytes.toString("utf8") });
  const missing = await refusedWith(call("page", { path: "wiki/none.md" }));
  expect(missing.code).toBe("not-found");
  expect(missing.message).not.toContain(vault);
});

test("page with no folder keeps the page-path predicate: star config and conflict copies are never pages", async () => {
  const noFolder: Partial<OperationContext> = { folder: undefined, tier: "edge" };
  for (const path of ["star.yaml", "x.sync-conflict-20260101-000000-ABCDEFG.md", "wiki/beta.sync-conflict-20260101-000000-ABCDEFG.md", ".history/a.md", "wiki/../star.yaml"]) {
    const e = await refusedWith(call("page", { path }, noFolder));
    expect(e.code).toBe("invalid");
  }
  expect(await call("page", { path: "wiki/beta.md" }, noFolder)).toMatchObject({ path: "wiki/beta.md", body: "beta body tokens\n" });
});

// ── indexed_page, tree, neighbors, graph, hotlist ──────────────────────────────────────────────

test("indexed_page serves the indexed snapshot; an excluded page is not in it", async () => {
  expect(await call("indexed_page", { id: "wiki/beta" })).toMatchObject({ id: "wiki/beta", title: "Beta" });
  expect((await refusedWith(call("indexed_page", { path: "secret/raw.md" }))).message).toMatch(/not in the index/);
  expect((await refusedWith(call("indexed_page", {}))).message).toMatch(/provide an `id` or a `path`/);
});

test("the four UI ops answer at home", async () => {
  expect(await call("tree", { dir: "wiki" })).toEqual({ dir: "wiki", dirs: [], files: ["alpha.md", "beta.md"] });
  expect(await call("neighbors", { id: "wiki/alpha", k: 3 })).toMatchObject({ node: { id: "wiki/alpha" } });
  expect(await call("graph")).toHaveProperty("nodes");
  expect(await call("hotlist")).toEqual({ tracking: false, items: [] });
});

// ── health ─────────────────────────────────────────────────────────────────────────────────────

test("health answers the twelve contract fields plus vault on loopback, and parses strictly", async () => {
  const h = await call("health") as Record<string, unknown>;
  expect(Object.keys(h).sort()).toEqual([
    "contentGeneration", "edges", "embeddingSignature", "freshnessBasis", "ignoreScope", "lastReindexAt", "locus",
    "nodes", "reindexDirty", "scopeMatches", "servingSignature", "vault", "vaultChangedSinceReindex",
  ]);
  healthResult.parse(h);
  expect(h.vault).toBe(vault);
  expect(await call("health", {}, { loopback: false })).not.toHaveProperty("vault");
});

test("health is strict: a spread of stats or an operator field fails the schema", async () => {
  const h = await call("health") as Record<string, unknown>;
  for (const extra of ["generation", "chunks", "schemaVersion", "generationValid", "invalidatedAt", "publicationId"]) {
    expect(() => healthResult.parse({ ...h, [extra]: 1 })).toThrow();
  }
});

// ── the cross-star boundary (RAI-304 probes, RAI-308 path probe) ───────────────────────────────

test("cross-star health answers while the index is dirty, with no vault", async () => {
  await store.beginReindex();
  try {
    const h = await call("health", {}, { crossStar: true }) as Record<string, unknown>;
    expect(h.reindexDirty).toBe(true);
    expect(h).not.toHaveProperty("vault");
    healthResult.parse(h);
    expect((await refusedWith(call("recall", { query: "alpha" }, { crossStar: true }))).code).toBe("out-of-scope");
  } finally {
    await store.finalizeReindex({ contentGeneration: `${GENERATION_VERSION}:` + "d".repeat(64) });
  }
});

test("a cross-star call serves while the scope matches", async () => {
  const r = await call("recall", { query: "alpha body tokens" }, { crossStar: true }) as { results: Array<{ id: string }> };
  expect(r.results[0]!.id).toBe("wiki/alpha");
  expect(await call("health", {}, { crossStar: true })).toMatchObject({ scopeMatches: true, reindexDirty: false });
});

test("no absolute root crosses a cross-star call, in an answer or a refusal", async () => {
  const roots = [vault, funesHome()];
  const probe = async (dir: string): Promise<string[]> => {
    const c: Partial<OperationContext> = { ...folderContext({ vault: dir, store }), designation: { locus: null, authority: null }, crossStar: true };
    const texts: string[] = [];
    for (const [op, args] of [["recall", { query: "alpha" }], ["indexed_page", { id: "wiki/alpha" }], ["health", {}]] as const) {
      let text: string;
      try { text = JSON.stringify(await call(op, args, c)); } catch (e) { text = (e as Error).message; }
      for (const r of roots) expect(text).not.toContain(r);
      texts.push(text);
    }
    return texts;
  };
  const bare = mkdtempSync(join(tmpdir(), "funes-dispatch-bare-"));
  const locked = mkdtempSync(join(tmpdir(), "funes-dispatch-locked-"));
  writeFileSync(join(locked, "star.yaml"), STAR);
  chmodSync(join(locked, "star.yaml"), 0o000);
  try {
    await probe(bare); // no star.yaml
    const [recalled] = await probe(locked); // an unreadable star.yaml: scope.ts reports the errno only
    expect(recalled).toContain("star.yaml is unreadable (EACCES)");
  } finally {
    chmodSync(join(locked, "star.yaml"), 0o644);
    rmSync(bare, { recursive: true, force: true });
    rmSync(locked, { recursive: true, force: true });
  }
});

test("the scrub's private paths hold the real path of a symlinked funes home", () => {
  const real = mkdtempSync(join(tmpdir(), "funes-dispatch-home-"));
  const link = `${real}-link`;
  symlinkSync(real, link);
  const saved = process.env.FUNES_HOME;
  process.env.FUNES_HOME = link;
  try {
    expect(folderPart(vault, store).privatePaths()).toContain(realpathSync(link));
  } finally {
    if (saved === undefined) delete process.env.FUNES_HOME; else process.env.FUNES_HOME = saved;
    rmSync(link, { force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

test("cross-star health does no walk when the scope does not match: freshnessBasis scope", async () => {
  const bad = mkdtempSync(join(tmpdir(), "funes-dispatch-bad-"));
  writeFileSync(join(bad, "star.yaml"), "meta:\n  id: git://example/bad\nmemory:\n  index_scope:\n    exclude: secret\n");
  try {
    const c = { ...folderContext({ vault: bad, store }), designation: { locus: null, authority: null }, crossStar: true };
    const h = await call("health", {}, c) as Record<string, unknown>;
    expect(h).toMatchObject({ scopeMatches: false, vaultChangedSinceReindex: null, freshnessBasis: "scope" });
  } finally { rmSync(bad, { recursive: true, force: true }); }
});

// ── the writes ─────────────────────────────────────────────────────────────────────────────────

test("remember carries sources; a proposalId off the edge refuses", async () => {
  const r = await call("remember", { title: "Sourced", body: "with a source", sources: ["[[wiki/alpha]]"], tags: "a,b" }) as { id: string };
  expect(readFileSync(join(vault, `${r.id}.md`), "utf8")).toContain("[[wiki/alpha]]");
  const e = await refusedWith(call("remember", { title: "P", body: "b", proposalId: "01J00000000000000000000000" }));
  expect(e.code).toBe("invalid");
  expect(e.message).toMatch(/proposalId.*edge/);
});

test("supersede takes tags and sources; forget is soft only", async () => {
  const { id } = await call("remember", { title: "Old", body: "old body" }) as { id: string };
  const s = await call("supersede", { oldId: id, title: "New", body: "new body", tags: "x", sources: ["[[wiki/beta]]"] }) as { id: string };
  const text = readFileSync(join(vault, `${s.id}.md`), "utf8");
  expect(text).toContain("[[wiki/beta]]");
  expect(text).toMatch(/tags:/);
  expect(await call("forget", { id: s.id, hard: true })).toEqual({ id: s.id, forgotten: true });
  expect(existsSync(join(vault, `${s.id}.md`))).toBe(true); // `hard` is gone: funes purge is the only hard delete
});

test("an unserved put_page names the write locus first", async () => {
  writeFileSync(join(vault, "star.yaml"), `${STAR.replace("meta:\n", "meta:\n  write_locus: host-a\n")}`);
  try {
    const e = await refusedWith(call("put_page", { path: "out_memory/x.md", content: "x", proposalId: "01J00000000000000000000000" }, { designation: { locus: "host-b", authority: "host-a" } }));
    expect(e.code).toBe("not-write-locus");
  } finally { writeFileSync(join(vault, "star.yaml"), STAR); }
  expect((await refusedWith(call("put_page", { path: "out_memory/x.md", content: "x", proposalId: "01J00000000000000000000000" }))).message).toBe("unknown operation: put_page");
});

test("put_page at the edge requires a proposalId", async () => {
  const e = await refusedWith(call("put_page", { path: "out_memory/x.md", content: "x" }, { tier: "edge", folder: undefined }));
  expect(e.message).toMatch(/missing required argument "proposalId"/);
});
