import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";
import { FunesStore } from "./funes-store.ts";
import { indexDir } from "./reindex.ts";
import { scopeHash } from "./scope.ts";
import { createRegistry, operations, buildToolDefs, dispatchToolCall, opCapabilities, type Operation, type OperationContext } from "./ops.ts";

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

/** Vault with one wiki page, one in_* page (same tokens — must be filtered), one nested page. */
async function fixture(): Promise<{ ctx: OperationContext; cleanup: () => Promise<void> }> {
  const vault = mkdtempSync(join(tmpdir(), "funes-ops-"));
  mkdirSync(join(vault, "in_chatgpt"));
  mkdirSync(join(vault, "yachts"));
  writeFileSync(join(vault, "fitness.md"), "---\ntitle: Fitness\n---\nprotein creatine goals\n");
  writeFileSync(join(vault, "in_chatgpt", "chat.md"), "---\ntitle: Chat dump\n---\nprotein creatine goals\n");
  writeFileSync(join(vault, "yachts", "cat.md"), "---\ntitle: Catamaran\n---\nhybrid sailing research\n");
  const store = await LibsqlStore.create(new FakeEmbedder());
  await store.remember([
    { id: "fitness", path: "fitness.md", title: "Fitness", body: "protein creatine goals", trust: "trusted" },
    { id: "in_chatgpt/chat", path: "in_chatgpt/chat.md", title: "Chat dump", body: "protein creatine goals", trust: "untrusted" },
    { id: "yachts/cat", path: "yachts/cat.md", title: "Catamaran", body: "hybrid sailing research", trust: "trusted", edges: [{ type: "related_to", target: "fitness" }] },
  ]);
  const funes = new FunesStore(store, { root: vault, now: () => "2026-06-10T00:00:00Z" });
  const ctx: OperationContext = { remote: true, trust: "untrusted", vault, store, funes };
  return { ctx, cleanup: async () => { await store.close(); rmSync(vault, { recursive: true, force: true }); } };
}

test("S3 registry invariants: trust argument unrepresentable; elevate unregistrable; dupes rejected", () => {
  const trusty = {
    name: "evil", description: "x",
    inputSchema: { type: "object", properties: { trust: { type: "string" } } },
    readonly: false, run: async () => null,
  } as unknown as Operation;
  expect(() => createRegistry([trusty])).toThrow(/server-stamped/);
  const elev = {
    name: "elevate", description: "x", inputSchema: { type: "object", properties: {} },
    readonly: false, run: async () => null,
  } as unknown as Operation;
  expect(() => createRegistry([elev])).toThrow(/human\/CLI act/);
  const a = { name: "dup", description: "x", inputSchema: { type: "object", properties: {} }, readonly: true, run: async () => null } as unknown as Operation;
  expect(() => createRegistry([a, { ...a }])).toThrow(/duplicate/);
});

test("recall (S3): unrestricted surface — in_* included but trust-labeled; provenance on every result", async () => {
  const { ctx, cleanup } = await fixture();
  try {
    const res = (await dispatchToolCall(operations, "recall", { query: "protein creatine goals", k: 5 }, ctx)) as
      Array<{ path: string; trust: string }>;
    expect(res.length).toBeGreaterThan(0);
    expect(res.every((r) => typeof r.path === "string" && r.path.length > 0)).toBe(true);
    expect(res.every((r) => r.trust === "trusted" || r.trust === "untrusted")).toBe(true);
    const byPath = new Map(res.map((r) => [r.path, r.trust]));
    expect(byPath.get("fitness.md")).toBe("trusted");
    expect(byPath.get("in_chatgpt/chat.md")).toBe("untrusted"); // tagged, not hidden (lone-local INGEST = trust-tag only)
  } finally { await cleanup(); }
});

// health has carried this flag since alpha.3, but health is a call an agent never makes on its way
// to an answer — so nothing told a model its citation came from an index older than the notes.
// Two vaults, not one: the verdict is memoized per vault for 30s (recall would otherwise pay a full
// mtime walk per query), so a single vault cannot show both states inside one test.
async function stalenessVault(nudge: (dir: string) => void) {
  const vault = mkdtempSync(join(tmpdir(), "funes-ops-stale-"));
  writeFileSync(join(vault, "fitness.md"), "---\ntitle: Fitness\n---\nprotein creatine goals\n");
  utimesSync(join(vault, "fitness.md"), 1000, 1000); // safely before the reindex stamp
  const store = await LibsqlStore.create(new FakeEmbedder(), join(vault, "i.db"));
  await indexDir(store, vault, vault, {}); // stamps last_reindex_at
  nudge(vault);
  const ctx: OperationContext = { remote: true, trust: "untrusted", vault, store, funes: new FunesStore(store, { root: vault }) };
  return { ctx, cleanup: async () => { await store.close(); rmSync(vault, { recursive: true, force: true }); } };
}

test("recall flags a hit when the vault has moved past the index, and stays silent when it has not", async () => {
  const current = await stalenessVault(() => {});
  try {
    const res = (await dispatchToolCall(operations, "recall", { query: "protein creatine goals" }, current.ctx)) as Array<Record<string, unknown>>;
    expect(res.length).toBeGreaterThan(0);
    expect(res.some((r) => "vaultChangedSinceReindex" in r)).toBe(false); // additive: absent on a current index
  } finally { await current.cleanup(); }

  const moved = await stalenessVault((dir) => {
    writeFileSync(join(dir, "fitness.md"), "---\ntitle: Fitness\n---\nprotein creatine goals rewritten\n");
    utimesSync(join(dir, "fitness.md"), Date.now() / 1000 + 3600, Date.now() / 1000 + 3600);
  });
  try {
    const res = (await dispatchToolCall(operations, "recall", { query: "protein creatine goals" }, moved.ctx)) as Array<Record<string, unknown>>;
    expect(res.length).toBeGreaterThan(0);
    expect(res.every((r) => r.vaultChangedSinceReindex === true)).toBe(true);
  } finally { await moved.cleanup(); }
}, 30_000);

// ...and the guarded twin is the population it matters MOST for: a cross-star caller is reading
// someone else's star, so it cannot run `health` there — this key is its only way to learn the rows
// it is about to cite predate the notes. It shipped without one (shapeRecall's second argument was
// simply never passed) while the comment above shapeRecall asserted both paths returned the same
// shape. Needs a real manifest + matching signature: crossStarExpectedHash refuses without one.
test("guarded_recall carries the staleness flag too, so a cross-star caller is not the last to know", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-ops-xstale-"));
  writeFileSync(join(vault, "star.yaml"), 'version: 2\nmemory:\n  index_scope:\n    exclude:\n      - "raw/**"\n');
  writeFileSync(join(vault, "fitness.md"), "---\ntitle: Fitness\n---\nprotein creatine goals\n");
  utimesSync(join(vault, "fitness.md"), 1000, 1000); // safely before the reindex stamp
  const store = await LibsqlStore.create(new FakeEmbedder(), join(vault, "i.db"));
  await indexDir(store, vault, vault, { scopeSignature: { hash: scopeHash(["raw/**"]), ignoreScope: false } });
  const future = Date.now() / 1000 + 3600;
  writeFileSync(join(vault, "fitness.md"), "---\ntitle: Fitness\n---\nprotein creatine goals rewritten\n");
  utimesSync(join(vault, "fitness.md"), future, future); // the vault has moved past the index
  const ctx: OperationContext = { remote: true, trust: "untrusted", vault, store, funes: new FunesStore(store, { root: vault }) };
  try {
    const res = (await dispatchToolCall(operations, "guarded_recall", { query: "protein creatine goals" }, ctx)) as Array<Record<string, unknown>>;
    expect(res.length).toBeGreaterThan(0);
    expect(res.every((r) => r.vaultChangedSinceReindex === true)).toBe(true);
  } finally { await store.close(); rmSync(vault, { recursive: true, force: true }); }
}, 30_000);

// ── PLAN-0.3.0 item 16 — the own-star scope guard, at the dispatcher every surface routes through ─
async function driftVault(): Promise<{ ctx: OperationContext; cleanup: () => Promise<void> }> {
  const vault = mkdtempSync(join(tmpdir(), "funes-ops-drift-"));
  writeFileSync(join(vault, "star.yaml"), 'memory:\n  index_scope:\n    exclude:\n      - "raw/**"\n');
  writeFileSync(join(vault, "keep.md"), "---\ntitle: Keep\n---\nprotein creatine goals\n");
  const store = await LibsqlStore.create(new FakeEmbedder(), join(vault, "i.db"));
  await indexDir(store, vault, vault, { scopeSignature: { hash: scopeHash(["raw/**"]), ignoreScope: false } });
  // The operator narrows policy and has NOT reindexed. Before item 16 this state was enforced only
  // on the --cross-star path, so every local client went on being served the withdrawn rows.
  writeFileSync(join(vault, "star.yaml"), 'memory:\n  index_scope:\n    exclude:\n      - "raw/**"\n      - "secrets/**"\n');
  const ctx: OperationContext = { remote: true, trust: "untrusted", vault, store, funes: new FunesStore(store, { root: vault }) };
  return { ctx, cleanup: async () => { await store.close(); rmSync(vault, { recursive: true, force: true }); } };
}

test("item 16: a NARROWED star.yaml refuses every row-serving op on the ordinary (non-cross-star) surface", async () => {
  const { ctx, cleanup } = await driftVault();
  try {
    for (const name of ["recall", "recall_v2"]) {
      await expect(dispatchToolCall(operations, name, { query: "protein creatine goals" }, ctx)).rejects.toThrow(/scope-hash mismatch/);
    }
    await expect(dispatchToolCall(operations, "indexed_page", { id: "keep" }, ctx)).rejects.toThrow(/scope-hash mismatch/);
    await expect(dispatchToolCall(operations, "hotlist", {}, ctx)).rejects.toThrow(/scope-hash mismatch/);
    // neighbors and graph are marked served:"fs" to keep them OFF the cross-star surface, but they
    // answer entirely out of the store — deriving the guard from `served` would have left both
    // leaking every excluded page's title.
    await expect(dispatchToolCall(operations, "neighbors", { id: "keep" }, ctx)).rejects.toThrow(/scope-hash mismatch/);
    await expect(dispatchToolCall(operations, "graph", {}, ctx)).rejects.toThrow(/scope-hash mismatch/);
  } finally { await cleanup(); }
}, 30_000);

test("item 16: health stays answerable under the same drift — it REPORTS the disagreement it would otherwise hide", async () => {
  const { ctx, cleanup } = await driftVault();
  try {
    const h = (await dispatchToolCall(operations, "health", {}, ctx)) as
      { scopeMatches: boolean | null; builtScopeHash: string | null; desiredScopeHash: string | null };
    expect(h.scopeMatches).toBe(false);
    expect(h.builtScopeHash).toBe(scopeHash(["raw/**"]));
    expect(h.desiredScopeHash).toBe(scopeHash(["raw/**", "secrets/**"]));
  } finally { await cleanup(); }
}, 30_000);

test("item 16: a valid, UNCHANGED manifest still serves — the guard is not a blanket refusal", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-ops-agree-"));
  writeFileSync(join(vault, "star.yaml"), 'memory:\n  index_scope:\n    exclude:\n      - "raw/**"\n');
  writeFileSync(join(vault, "keep.md"), "---\ntitle: Keep\n---\nprotein creatine goals\n");
  const store = await LibsqlStore.create(new FakeEmbedder(), join(vault, "i.db"));
  await indexDir(store, vault, vault, { scopeSignature: { hash: scopeHash(["raw/**"]), ignoreScope: false } });
  const ctx: OperationContext = { remote: true, trust: "untrusted", vault, store, funes: new FunesStore(store, { root: vault }) };
  try {
    const res = (await dispatchToolCall(operations, "recall", { query: "protein creatine goals" }, ctx)) as unknown[];
    expect(res.length).toBeGreaterThan(0);
  } finally { await store.close(); rmSync(vault, { recursive: true, force: true }); }
}, 30_000);

test("item 16: a CONFIGLESS vault (no star.yaml) is unaffected — nothing declared, nothing enforced", async () => {
  const { ctx, cleanup } = await fixture(); // the shared fixture writes no star.yaml
  try {
    const res = (await dispatchToolCall(operations, "recall", { query: "protein creatine goals" }, ctx)) as unknown[];
    expect(res.length).toBeGreaterThan(0); // this store has no scope signature at all, and serves
  } finally { await cleanup(); }
});

// ── PLAN-0.3.0 item 18 — DELETION visibility ────────────────────────────────────────────────────
// The measurable one. `vaultChangedSince` has always taken an `indexedIds` thunk and always had the
// receiving logic tested with a fake; ALL FIVE production callers passed two arguments, so the thunk
// was `undefined`, `?? []` made the id set empty, and a note DELETED since the last reindex was
// invisible — the index went on serving a row whose file was gone, reporting itself fresh forever.
// An mtime walk cannot see it: a deleted file leaves nothing behind to be newer, which is why this
// needs the index's own id set and cannot be recovered by walking harder.
test("item 18: a DELETED note makes recall and health report the vault changed (an mtime walk cannot see it)", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-ops-del-"));
  writeFileSync(join(vault, "keep.md"), "---\ntitle: Keep\n---\nprotein creatine goals\n");
  writeFileSync(join(vault, "gone.md"), "---\ntitle: Gone\n---\nprotein creatine elsewhere\n");
  utimesSync(join(vault, "keep.md"), 1000, 1000);
  utimesSync(join(vault, "gone.md"), 1000, 1000);
  const store = await LibsqlStore.create(new FakeEmbedder(), join(vault, "i.db"));
  await indexDir(store, vault, vault, {}); // both indexed, last_reindex_at stamped
  // Delete the file and touch NOTHING else: every surviving file stays older than the stamp, so
  // the mtime half of the answer is "unchanged". Only the id comparison can catch this.
  rmSync(join(vault, "gone.md"));
  const ctx: OperationContext = { remote: true, trust: "untrusted", vault, store, funes: new FunesStore(store, { root: vault }) };
  try {
    const res = (await dispatchToolCall(operations, "recall", { query: "protein creatine goals" }, ctx)) as Array<Record<string, unknown>>;
    expect(res.length).toBeGreaterThan(0);
    expect(res.every((r) => r.vaultChangedSinceReindex === true)).toBe(true);
    const h = (await dispatchToolCall(operations, "health", {}, ctx)) as { vaultChangedSinceReindex: boolean | null };
    expect(h.vaultChangedSinceReindex).toBe(true);
  } finally { await store.close(); rmSync(vault, { recursive: true, force: true }); }
}, 30_000);

test("item 18: no deletion, nothing touched -> still reported fresh (the id comparison adds no false alarm)", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-ops-nodel-"));
  writeFileSync(join(vault, "keep.md"), "---\ntitle: Keep\n---\nprotein creatine goals\n");
  utimesSync(join(vault, "keep.md"), 1000, 1000);
  const store = await LibsqlStore.create(new FakeEmbedder(), join(vault, "i.db"));
  await indexDir(store, vault, vault, {});
  const ctx: OperationContext = { remote: true, trust: "untrusted", vault, store, funes: new FunesStore(store, { root: vault }) };
  try {
    const res = (await dispatchToolCall(operations, "recall", { query: "protein creatine goals" }, ctx)) as Array<Record<string, unknown>>;
    expect(res.length).toBeGreaterThan(0);
    // The comparison is ONE-directional (an indexed id with no file) precisely so it stays quiet
    // here: a tombstoned or index_scope-excluded file on disk has no row and must not count.
    expect(res.some((r) => "vaultChangedSinceReindex" in r)).toBe(false);
  } finally { await store.close(); rmSync(vault, { recursive: true, force: true }); }
}, 30_000);

// ── PLAN-0.3.0 item 19 — recall_v2 ──────────────────────────────────────────────────────────────
test("item 19: recall_v2 returns the identity envelope, and `recall` is UNCHANGED beside it", async () => {
  const { ctx, cleanup } = await fixture();
  try {
    const v1 = (await dispatchToolCall(operations, "recall", { query: "protein creatine goals", k: 5 }, ctx)) as Array<Record<string, unknown>>;
    const v2 = (await dispatchToolCall(operations, "recall_v2", { query: "protein creatine goals", k: 5 }, ctx)) as {
      publicationId: string | null; contentGeneration: string | null; generationValid: boolean;
      servingSignature: string; results: Array<Record<string, unknown>>;
    };
    // The envelope's five keys, exactly as the item names them.
    expect(Object.keys(v2).sort()).toEqual(["contentGeneration", "generationValid", "publicationId", "results", "servingSignature"]);
    // `results` is the SAME projection `recall` returns — the migration is one key deeper, never a
    // reparse. This store was filled by remember() with no full build, so there is no content
    // generation to name and `generationValid` says so rather than inventing one.
    expect(v2.results.map((r) => r.id)).toEqual(v1.map((r) => r.id));
    expect(v2.contentGeneration).toBeNull();
    expect(v2.generationValid).toBe(false);
    expect(v2.publicationId).toBeNull();
    expect(v2.servingSignature.startsWith("sv1:")).toBe(true);
    // recall is RETAINED, not deprecated: retiring it is a twinkl.ing release gate.
    expect(operations.some((o) => o.name === "recall")).toBe(true);
  } finally { await cleanup(); }
});

test("item 19: after a full build, recall_v2 names the content generation and calls it valid", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-ops-v2gen-"));
  writeFileSync(join(vault, "keep.md"), "---\ntitle: Keep\n---\nprotein creatine goals\n");
  const store = await LibsqlStore.create(new FakeEmbedder(), join(vault, "i.db"));
  await indexDir(store, vault, vault, {}); // finalizeReindex stamps the content generation
  const ctx: OperationContext = { remote: true, trust: "untrusted", vault, store, funes: new FunesStore(store, { root: vault }) };
  try {
    const v2 = (await dispatchToolCall(operations, "recall_v2", { query: "protein creatine goals" }, ctx)) as
      { contentGeneration: string | null; generationValid: boolean };
    expect(v2.contentGeneration).toMatch(/^v2:/);
    expect(v2.generationValid).toBe(true);
  } finally { await store.close(); rmSync(vault, { recursive: true, force: true }); }
}, 30_000);

test("S3 mutations: remember server-stamps untrusted + writes out_memory; supersede/forget guarded by assertOwned", async () => {
  const { ctx, cleanup } = await fixture();
  try {
    const r = (await dispatchToolCall(operations, "remember",
      { title: "Note from agent", body: "remembered via registry" }, ctx)) as { id: string; trust: string };
    expect(r.id.startsWith("out_memory/")).toBe(true);
    expect(r.trust).toBe("untrusted");
    const file = readFileSync(join(ctx.vault, r.id + ".md"), "utf8");
    expect(file).toContain("trust: untrusted"); // canonical frontmatter records it

    // foreign ids are not mutable through the registry (H3 assertOwned)
    await expect(dispatchToolCall(operations, "supersede",
      { oldId: "fitness", title: "x", body: "y" }, ctx)).rejects.toThrow(/refusing to mutate/);
    await expect(dispatchToolCall(operations, "forget", { id: "fitness" }, ctx)).rejects.toThrow(/refusing to mutate/);

    // soft forget on the owned item: off recall, file kept
    await dispatchToolCall(operations, "forget", { id: r.id }, ctx);
    expect(readFileSync(join(ctx.vault, r.id + ".md"), "utf8")).toContain("forgotten: true");
  } finally { await cleanup(); }
});

test("page: reads a vault page; rejects traversal, absolute, and dot-paths", async () => {
  const { ctx, cleanup } = await fixture();
  try {
    const ok = (await dispatchToolCall(operations, "page", { path: "yachts/cat.md" }, ctx)) as
      { frontmatter: Record<string, unknown>; body: string };
    expect(ok.frontmatter.title).toBe("Catamaran");
    expect(ok.body).toContain("hybrid sailing");
    await expect(dispatchToolCall(operations, "page", { path: "../outside.md" }, ctx)).rejects.toThrow(/invalid path|escapes/);
    await expect(dispatchToolCall(operations, "page", { path: "/etc/passwd" }, ctx)).rejects.toThrow(/invalid path/);
    await expect(dispatchToolCall(operations, "page", { path: ".funes/secret.md" }, ctx)).rejects.toThrow(/invalid path|escapes/);
    await expect(dispatchToolCall(operations, "page", { path: "yachts/../../x.md" }, ctx)).rejects.toThrow(/invalid path|escapes/);
  } finally { await cleanup(); }
});

test("tree: one level with zones; dot-dirs skipped", async () => {
  const { ctx, cleanup } = await fixture();
  try {
    mkdirSync(join(ctx.vault, ".hidden"));
    const root = (await dispatchToolCall(operations, "tree", {}, ctx)) as
      { dirs: Array<{ name: string; zone: string }>; files: string[] };
    expect(root.dirs).toContainEqual({ name: "in_chatgpt", zone: "incoming" });
    expect(root.dirs).toContainEqual({ name: "yachts", zone: "wiki" });
    expect(root.dirs.some((d) => d.name === ".hidden")).toBe(false);
    expect(root.files).toContain("fitness.md");
  } finally { await cleanup(); }
});

test("health: counts + signature + dirty flag", async () => {
  const { ctx, cleanup } = await fixture();
  try {
    const h = (await dispatchToolCall(operations, "health", {}, ctx)) as
      { nodes: number; edges: number; embeddingSignature: string | null; reindexDirty: boolean };
    expect(h.nodes).toBe(3);
    expect(h.reindexDirty).toBe(false);
    expect(h.embeddingSignature).toContain(":16");
  } finally { await cleanup(); }
});

test("health: `generation` survives as a DEPRECATED alias of `contentGeneration` — both faces, one name per value", async () => {
  // This op spreads `stats()`, so item 8's field rename renamed the op's key with it while the HTTP
  // face `/health` (which names its keys) kept `generation` — one logical value under two names on
  // two faces, and twinkl.ing's memory block reads `generation` off one of them. Both keys are
  // present on both faces until the twinkl.ing cutover release drops them together.
  const { ctx, cleanup } = await fixture();
  try {
    const h = (await dispatchToolCall(operations, "health", {}, ctx)) as
      { generation: string | null; contentGeneration: string | null };
    expect("generation" in h).toBe(true);
    expect(h.generation).toBe(h.contentGeneration);
  } finally { await cleanup(); }
});

test("item 20: health carries the WHOLE operator state contract, and keeps every key it already had", async () => {
  const { ctx, cleanup } = await fixture();
  try {
    const h = (await dispatchToolCall(operations, "health", {}, ctx)) as Record<string, unknown>;
    // The item's field list, in one assertion so a field cannot quietly go missing.
    for (const k of [
      "schemaVersion", "publicationId", "contentGeneration", "generationValid", "invalidatedAt",
      "invalidatedReason", "servingSignature", "builtScopeHash", "desiredScopeHash", "scopeMatches",
      "ignoreScope", "buildState", "machineState", "overrides",
    ]) expect(h).toHaveProperty(k);
    // …and the pre-existing keys survive untouched, including the deprecated `generation` alias the
    // twinkl.ing cutover (item 19) is the only thing allowed to remove.
    for (const k of ["vault", "nodes", "edges", "embeddingSignature", "reindexDirty", "lastReindexAt", "scopeHash", "generation", "vaultChangedSinceReindex"]) {
      expect(h).toHaveProperty(k);
    }
    expect(h.generation).toBe(h.contentGeneration);
  } finally { await cleanup(); }
});

test("dispatch: unknown op and missing required arg both throw; tool defs project all ops", async () => {
  const { ctx, cleanup } = await fixture();
  try {
    await expect(dispatchToolCall(operations, "nope", {}, ctx)).rejects.toThrow(/unknown operation/);
    await expect(dispatchToolCall(operations, "recall", {}, ctx)).rejects.toThrow(/missing required/);
    const defs = buildToolDefs(operations);
    expect(defs.map((d) => d.name).sort()).toEqual(["forget", "graph", "health", "hotlist", "indexed_page", "neighbors", "page", "recall", "recall_v2", "remember", "supersede", "tree"]);
    expect(defs.every((d) => d.description.length > 0)).toBe(true);
  } finally { await cleanup(); }
});

test("readonly subset (--readonly cross-star query): exposes reads only, never a mutation", () => {
  // The MCP server's `--readonly` filter is `operations.filter(o => o.readonly)`. This asserts that
  // subset never leaks a write op (remember/supersede/forget) — the guarantee a sibling query-only
  // connection relies on. If a new mutation is added and mislabeled `readonly: true`, this fails.
  const readOnly = buildToolDefs(operations.filter((o) => o.readonly)).map((d) => d.name).sort();
  const writes = operations.filter((o) => !o.readonly).map((o) => o.name).sort();
  expect(writes).toEqual(["forget", "remember", "supersede"]);
  for (const w of writes) expect(readOnly).not.toContain(w);
  // 0.3.0 item 19: `recall_v2` ships ALONGSIDE `recall`, never replacing it — retiring `recall`
  // needs a twinkl.ing release, which the plan names as an external release gate.
  expect(readOnly).toEqual(["graph", "health", "hotlist", "indexed_page", "neighbors", "page", "recall", "recall_v2", "tree"]);
});

test("hotlist op (R8): tracking off -> {tracking:false, items:[]}; on -> trusted-only counters", async () => {
  // fixture's store is constructed WITHOUT trackRecalls — the registry must say so and return [].
  const { ctx, cleanup } = await fixture();
  try {
    await dispatchToolCall(operations, "recall", { query: "protein creatine goals", k: 5 }, ctx);
    const off = (await dispatchToolCall(operations, "hotlist", {}, ctx)) as { tracking: boolean; items: unknown[] };
    expect(off.tracking).toBe(false);
    expect(off.items).toEqual([]);
  } finally { await cleanup(); }

  // tracked store: recalls land in recall_stats; hotlist surfaces TRUSTED rows only.
  const vault = mkdtempSync(join(tmpdir(), "funes-ops-hot-"));
  const store = await LibsqlStore.create(new FakeEmbedder(), undefined, { trackRecalls: true });
  try {
    await store.remember([
      { id: "fitness", path: "fitness.md", title: "Fitness", body: "protein creatine goals", trust: "trusted" },
      { id: "in_chatgpt/chat", path: "in_chatgpt/chat.md", title: "Chat dump", body: "protein creatine goals", trust: "untrusted" },
    ]);
    const funes = new FunesStore(store, { root: vault });
    const ctx2: OperationContext = { remote: true, trust: "untrusted", vault, store, funes };
    await dispatchToolCall(operations, "recall", { query: "protein creatine goals", k: 5 }, ctx2);
    await dispatchToolCall(operations, "recall", { query: "protein creatine goals", k: 5 }, ctx2);
    const on = (await dispatchToolCall(operations, "hotlist", { n: 10 }, ctx2)) as
      { tracking: boolean; items: Array<{ id: string; hit_count: number; trust: string }> };
    expect(on.tracking).toBe(true);
    expect(on.items.map((i) => i.id)).toEqual(["fitness"]); // untrusted counted but NEVER surfaced
    expect(on.items[0]!.hit_count).toBe(2);
    expect(on.items[0]!.trust).toBe("trusted");
  } finally { await store.close(); rmSync(vault, { recursive: true, force: true }); }
});

test("neighbors: k-NN + typed edges both directions; unknown id -> null node", async () => {
  const { ctx, cleanup } = await fixture();
  try {
    const n = (await dispatchToolCall(operations, "neighbors", { id: "yachts/cat", k: 3 }, ctx)) as {
      node: { id: string; trust?: string } | null;
      similar: Array<{ id: string; score: number; trust?: string }>;
      edgesOut: Array<{ type: string; id: string; title: string | null; trust?: string }>;
      edgesIn: Array<{ type: string; id: string }>;
    };
    expect(n.node?.id).toBe("yachts/cat");
    expect(n.similar.length).toBeGreaterThan(0);
    expect(n.similar.every((x) => typeof x.score === "number" && x.trust !== undefined)).toBe(true);
    expect(n.edgesOut).toContainEqual({ type: "related_to", id: "fitness", title: "Fitness", trust: "trusted" });

    const fromFitness = (await dispatchToolCall(operations, "neighbors", { id: "fitness" }, ctx)) as { edgesIn: Array<{ id: string }> };
    expect(fromFitness.edgesIn.map((e) => e.id)).toContain("yachts/cat"); // reverse direction

    const missing = (await dispatchToolCall(operations, "neighbors", { id: "nope/nothing" }, ctx)) as { node: unknown };
    expect(missing.node).toBe(null);
  } finally { await cleanup(); }
});

test("opCapabilities (P1.8): sorted projection marking mutations, fs-served, and internal ops", () => {
  const caps = opCapabilities();
  // deterministic: sorted by name
  expect(caps.map((c) => c.name)).toEqual([...caps.map((c) => c.name)].sort());
  const by = new Map(caps.map((c) => [c.name, c]));
  // mutations (readonly:false) are exactly remember/supersede/forget — no phantoms
  expect(caps.filter((c) => !c.readonly).map((c) => c.name).sort()).toEqual(["forget", "remember", "supersede"]);
  // guarded_* are internal (un-allowlistable); recall/health are not
  expect(by.get("guarded_recall")?.internal).toBe(true);
  expect(by.get("recall")?.internal).toBe(false);
  // served taxonomy: recall/health/indexed_page are index-served; page/tree are fs-served
  expect(by.get("recall")?.served).toBe("index");
  expect(by.get("page")?.served).toBe("fs");
  // elevate is banned from the registry, so it never appears in the projection
  expect(by.has("elevate")).toBe(false);
});
