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
    // Since 0.4.0 item 6 the record compared against is the build's per-page stats, which cover
    // tombstones too — so a file the index deliberately does not serve still matches its record.
    expect(res.some((r) => "vaultChangedSinceReindex" in r)).toBe(false);
  } finally { await store.close(); rmSync(vault, { recursive: true, force: true }); }
}, 30_000);

// ── PLAN-0.4.0 item 6 — health says what its freshness answer stands on ─────────────────────────
// twinkl.ing renders a bare `null` as "the vault could not be read". With stat parity, `null` mostly
// means "no per-page stats yet" on a home built before the record existed — a different instruction
// (republish), so health names the basis beside the tri-state.
test("item 6: health carries freshnessBasis — \"stat\" over a recorded build, \"none\" before one exists", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-ops-basis-"));
  writeFileSync(join(vault, "keep.md"), "---\ntitle: Keep\n---\nprotein creatine goals\n");
  const store = await LibsqlStore.create(new FakeEmbedder(), join(vault, "i.db"));
  const ctx: OperationContext = { remote: true, trust: "untrusted", vault, store, funes: new FunesStore(store, { root: vault }) };
  type H = { vaultChangedSinceReindex: boolean | null; freshnessBasis: string };
  try {
    await store.remember([{ id: "keep", path: "keep.md", title: "Keep", body: "protein creatine goals", trust: "trusted" }]);
    const before = (await dispatchToolCall(operations, "health", {}, ctx)) as H; // rows, but no full build
    expect([before.vaultChangedSinceReindex, before.freshnessBasis]).toEqual([null, "none"]);
    await indexDir(store, vault, vault, {});
    const after = (await dispatchToolCall(operations, "health", {}, ctx)) as H;
    expect([after.vaultChangedSinceReindex, after.freshnessBasis]).toEqual([false, "stat"]);
  } finally { await store.close(); rmSync(vault, { recursive: true, force: true }); }
}, 30_000);

// ── PLAN-0.3.0 item 19 — recall_v2 ──────────────────────────────────────────────────────────────
test("item 19: recall_v2 returns the identity envelope, and `recall` is UNCHANGED beside it", async () => {
  const { ctx, cleanup } = await fixture();
  try {
    const v1 = (await dispatchToolCall(operations, "recall", { query: "protein creatine goals", k: 5 }, ctx)) as Array<Record<string, unknown>>;
    const v2 = (await dispatchToolCall(operations, "recall_v2", { query: "protein creatine goals", k: 5 }, ctx)) as {
      publicationId: string | null; contentGeneration: string | null; generationValid: boolean;
      servingSignature: string; locus: string | null; results: Array<Record<string, unknown>>;
    };
    // The envelope's keys, exactly as the items name them: five from 0.3.0 item 19, and `locus` from
    // PLAN-0.4.0 item 10 (its value is the item-10 tests' business: it follows FUNES_LOCUS here).
    expect(Object.keys(v2).sort()).toEqual(["contentGeneration", "generationValid", "locus", "publicationId", "results", "servingSignature"]);
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

// PLAN-0.4.0 item 10: one value, carried. The locus a surface resolved at startup rides its
// designation, and recall_v2 and health name that value — never a re-read of the environment. The
// environment below says something else on purpose.
test("item 10: recall_v2 and health name the locus the serving context resolved, and only that", async () => {
  const { ctx, cleanup } = await fixture();
  const saved = process.env.FUNES_LOCUS;
  process.env.FUNES_LOCUS = "host-b";
  try {
    const at = { ...ctx, designation: { mode: "audit" as const, locus: "host-a", authority: null } };
    const v2 = (await dispatchToolCall(operations, "recall_v2", { query: "protein creatine goals" }, at)) as { locus: string | null };
    const h = (await dispatchToolCall(operations, "health", {}, at)) as { locus: string | null };
    expect(v2.locus).toBe("host-a");
    expect(h.locus).toBe("host-a");
    // `recall` v1 is untouched: an array of hits, no envelope, no locus anywhere
    const v1 = (await dispatchToolCall(operations, "recall", { query: "protein creatine goals" }, at)) as Array<Record<string, unknown>>;
    expect(Array.isArray(v1)).toBe(true);
    expect(v1.some((r) => "locus" in r)).toBe(false);
  } finally {
    if (saved === undefined) delete process.env.FUNES_LOCUS;
    else process.env.FUNES_LOCUS = saved;
    await cleanup();
  }
});

// …and a host that builds its own context and passes NO designation — twinkling's unified surface
// calls createApi → dispatchToolCall directly, never buildApp — still reports the locus its process
// was born with. dispatchToolCall resolves the designation once on first dispatch and caches it on
// the context, so health, recall_v2 and the mutation audit read one value, not two.
test("item 10: a context with no designation resolves FUNES_LOCUS once, and health and recall_v2 name it", async () => {
  const { ctx, cleanup } = await fixture();
  const saved = process.env.FUNES_LOCUS;
  try {
    process.env.FUNES_LOCUS = " Host-B ";
    const h = (await dispatchToolCall(operations, "health", {}, ctx)) as { locus: string | null };
    const v2 = (await dispatchToolCall(operations, "recall_v2", { query: "protein creatine goals" }, ctx)) as { locus: string | null };
    expect(h.locus).toBe("host-b");
    expect(v2.locus).toBe("host-b");
    expect(ctx.designation?.locus).toBe("host-b"); // the value the mutation audit reads
    process.env.FUNES_LOCUS = "host-c"; // resolved once per context: a later environment is not re-read
    expect(((await dispatchToolCall(operations, "health", {}, ctx)) as { locus: string | null }).locus).toBe("host-b");
    delete process.env.FUNES_LOCUS; // a fresh context with nothing set says so as null — never a hostname
    const bare = { ...ctx, designation: undefined };
    expect(((await dispatchToolCall(operations, "health", {}, bare)) as { locus: string | null }).locus).toBeNull();
  } finally {
    if (saved === undefined) delete process.env.FUNES_LOCUS;
    else process.env.FUNES_LOCUS = saved;
    await cleanup();
  }
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
      "ignoreScope", "buildState", "machineState", "overrides", "locus", // locus: PLAN-0.4.0 item 10
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

// ── RAI-158 (PLAN-0.4.0 item 21): the per-caller check in dispatchToolCall ──────────────────────
// GENERATED from the registry, so an op added later is covered without editing this test: for every
// op, a grant that names it (or its public twin) passes the check, and a grant that does not is
// refused BEFORE the argument gate — with empty args, the refusal must be the grant's, never a
// "missing required argument".
import { assertGranted, publicOpNames, NOT_GRANTED } from "./ops.ts";
import type { Grant } from "./actor.ts";

const grantOf = (ops: string[], stars: string[] = ["*"]): Grant => ({ actor: "tester@here", ops: new Set(ops), stars });

test("RAI-158: every registry op is refused to a grant that does not name it, before its arguments are read", async () => {
  const { ctx, cleanup } = await fixture();
  try {
    const all = [...publicOpNames()];
    for (const op of operations) {
      const twin = op.internal ? op.name.replace(/^guarded_/, "") : op.name;
      expect(all).toContain(twin); // every internal op has a public twin a role can name
      const without = grantOf(all.filter((n) => n !== twin));
      await expect(dispatchToolCall(operations, op.name, {}, { ...ctx, grant: without })).rejects.toThrow(`operation ${op.name}: not granted to actor "tester@here"`);
      expect(() => assertGranted(grantOf([twin]), op, ctx.vault)).not.toThrow();
    }
  } finally { await cleanup(); }
});

test("RAI-158: a grant reaches only the stars it names — by canonical key, and '*' reaches a star with no id", async () => {
  const { ctx, cleanup } = await fixture();
  try {
    const recall = operations.find((o) => o.name === "recall")!;
    expect(() => assertGranted(grantOf(["recall"], ["rainblow.ing/funes"]), recall, ctx.vault)).toThrow(/holds no grant for star "\(no id\)"/);
    expect(() => assertGranted(grantOf(["recall"]), recall, ctx.vault)).not.toThrow();
    writeFileSync(join(ctx.vault, "star.yaml"), "meta:\n  id: git://rainblow.ing/funes\n");
    expect(() => assertGranted(grantOf(["recall"], ["rainblow.ing/funes"]), recall, ctx.vault)).not.toThrow();
    expect(() => assertGranted(grantOf(["recall"], ["mcp://rainblow.ing/funes"]), recall, ctx.vault)).not.toThrow();
    expect(() => assertGranted(grantOf(["recall"], ["rainblow.ing/personal"]), recall, ctx.vault)).toThrow(/holds no grant for star "git:\/\/rainblow\.ing\/funes"/);
    // both refusals carry the wire code the HTTP spine answers 403 (RAI-159)
    for (const g of [grantOf(["recall"], ["rainblow.ing/personal"]), grantOf(["health"])]) {
      let code: unknown;
      try { assertGranted(g, recall, ctx.vault); } catch (e) { code = (e as { code?: unknown }).code; }
      expect(code).toBe(NOT_GRANTED);
    }
    // and through the dispatch point itself, with empty args: the star refusal comes before the argument gate
    await expect(dispatchToolCall(operations, "recall", {}, { ...ctx, grant: grantOf(["recall"], ["rainblow.ing/personal"]) }))
      .rejects.toThrow(/holds no grant for star "git:\/\/rainblow\.ing\/funes"/);
  } finally { await cleanup(); }
});

test("RAI-159: the engine's NOT_GRANTED is funes-api's wire code — a copy (the CLI bundle must not load Hono), pinned equal", async () => {
  const { NOT_GRANTED: engine } = await import("./ops.ts");
  const { NOT_GRANTED: wire } = await import("funes-api");
  expect(engine).toBe(wire);
});

// ── RAI-160 (PLAN-0.4.0 item 23): a served write refuses what the sanitizer would cut ────────────
import { MAX_BODY_CHARS, MAX_TITLE_CHARS } from "./ops.ts";

test("RAI-160: remember stores a body at the cap WHOLE, and refuses one character more instead of cutting its tail", async () => {
  const { ctx, cleanup } = await fixture();
  try {
    const body = "word ".repeat(MAX_BODY_CHARS / 5).slice(0, MAX_BODY_CHARS - 4) + "TAIL";
    const { id } = (await dispatchToolCall(operations, "remember", { title: "At the cap", body }, ctx)) as { id: string };
    expect(readFileSync(join(ctx.vault, `${id}.md`), "utf8")).toContain("TAIL"); // before RAI-160 a longer body lost this silently
    await expect(dispatchToolCall(operations, "remember", { title: "Over", body: body + "x" }, ctx)).rejects.toThrow(/body/);
    await expect(dispatchToolCall(operations, "remember", { title: "t".repeat(MAX_TITLE_CHARS + 1), body: "b" }, ctx)).rejects.toThrow(/title/);
    await expect(dispatchToolCall(operations, "supersede", { oldId: id, title: "Over", body: body + "x" }, ctx)).rejects.toThrow(/body/);
  } finally { await cleanup(); }
});
