import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import type { ServingIndex } from "funes-core/internal";
import { LibsqlStore } from "./libsql/store.ts";
import { FunesStore } from "funes-core/internal";
import { folderContext, folderFunesStore } from "./funes-store.ts";
import { indexDir } from "./reindex.ts";
import { scopeHash } from "funes-core";
import { ceiling, dispatchToolCall, opCapabilities, type OpEntry, type OperationContext } from "funes-core";
import { createRegistry, operations, buildToolDefs } from "funes-core/internal";

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
  const funes = folderFunesStore(store, { root: vault, now: () => "2026-06-10T00:00:00Z" });
  const ctx: OperationContext = { ...folderContext({ vault, store }), funes };
  return { ctx, cleanup: async () => { await store.close(); rmSync(vault, { recursive: true, force: true }); } };
}

type Recalled = { results: Array<Record<string, unknown>>; contentGeneration: string | null; vaultChangedSinceReindex?: true };

// PLAN-0.5.0 item 12 (ADR-0011 "One dispatcher"): the context is {vault: Vault, star: () => StarConfig}
// plus an optional folder part. RAI-304: `page` serves through the port when there is no folder.
test("item 12: without the folder part the dispatcher serves through the port and the star thunk; tree refuses", async () => {
  const { ctx, cleanup } = await fixture();
  const { folder: _folder, ...portOnly } = ctx;
  try {
    expect(await dispatchToolCall("page", { path: "fitness.md" }, ctx)).toMatchObject({ frontmatter: { title: "Fitness" } });
    const hits = (await dispatchToolCall("recall", { query: "hybrid sailing" }, portOnly)) as Recalled;
    expect(hits.results.map((h) => h.id)).toContain("yachts/cat");
    expect(await dispatchToolCall("page", { path: "fitness.md" }, portOnly)).toMatchObject({ frontmatter: { title: "Fitness" } });
    await expect(dispatchToolCall("tree", {}, portOnly)).rejects.toThrow(/folder-only/);
  } finally { await cleanup(); }
});

test("S3 registry invariants: trust argument unrepresentable; elevate unregistrable; dupes rejected", () => {
  const trusty = {
    name: "evil", description: "x",
    inputSchema: { type: "object", properties: { trust: { type: "string" } } },
    readonly: false, run: async () => null,
  } as unknown as OpEntry;
  expect(() => createRegistry([trusty])).toThrow(/server-stamped/);
  const elev = {
    name: "elevate", description: "x", inputSchema: { type: "object", properties: {} },
    readonly: false, run: async () => null,
  } as unknown as OpEntry;
  expect(() => createRegistry([elev])).toThrow(/human\/CLI act/);
  const a = { name: "dup", description: "x", inputSchema: { type: "object", properties: {} }, readonly: true, run: async () => null } as unknown as OpEntry;
  expect(() => createRegistry([a, { ...a }])).toThrow(/duplicate/);
});

test("recall (S3): unrestricted surface — in_* included but trust-labeled; provenance on every result", async () => {
  const { ctx, cleanup } = await fixture();
  try {
    const res = ((await dispatchToolCall("recall", { query: "protein creatine goals", k: 5 }, ctx)) as
      { results: Array<{ path: string; trust: string }> }).results;
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
  await indexDir(store, vault, {}); // stamps last_reindex_at
  nudge(vault);
  const ctx: OperationContext = folderContext({ vault, store });
  return { ctx, cleanup: async () => { await store.close(); rmSync(vault, { recursive: true, force: true }); } };
}

test("recall flags its answer when the vault has moved past the index, and stays silent when it has not", async () => {
  const current = await stalenessVault(() => {});
  try {
    const res = (await dispatchToolCall("recall", { query: "protein creatine goals" }, current.ctx)) as Recalled;
    expect(res.results.length).toBeGreaterThan(0);
    expect("vaultChangedSinceReindex" in res).toBe(false); // only when true: absent on a current index
  } finally { await current.cleanup(); }

  const moved = await stalenessVault((dir) => {
    writeFileSync(join(dir, "fitness.md"), "---\ntitle: Fitness\n---\nprotein creatine goals rewritten\n");
    utimesSync(join(dir, "fitness.md"), Date.now() / 1000 + 3600, Date.now() / 1000 + 3600);
  });
  try {
    const res = (await dispatchToolCall("recall", { query: "protein creatine goals" }, moved.ctx)) as Recalled;
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.vaultChangedSinceReindex).toBe(true); // RAI-308: once per answer, never per hit
    expect(res.results.some((r) => "vaultChangedSinceReindex" in r)).toBe(false);
  } finally { await moved.cleanup(); }
}, 30_000);

// ...and a cross-star caller is the population it matters MOST for: it is reading someone else's
// star, so this key is its only way to learn the rows it is about to cite predate the notes. Needs a
// real manifest + matching signature: the cross-star expectation refuses without one.
test("a cross-star recall carries the staleness flag too, so a cross-star caller is not the last to know", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-ops-xstale-"));
  writeFileSync(join(vault, "star.yaml"), 'version: 2\nmemory:\n  index_scope:\n    exclude:\n      - "raw/**"\n');
  writeFileSync(join(vault, "fitness.md"), "---\ntitle: Fitness\n---\nprotein creatine goals\n");
  utimesSync(join(vault, "fitness.md"), 1000, 1000); // safely before the reindex stamp
  const store = await LibsqlStore.create(new FakeEmbedder(), join(vault, "i.db"));
  await indexDir(store, vault, { scopeSignature: { hash: scopeHash(["raw/**"]), ignoreScope: false } });
  const future = Date.now() / 1000 + 3600;
  writeFileSync(join(vault, "fitness.md"), "---\ntitle: Fitness\n---\nprotein creatine goals rewritten\n");
  utimesSync(join(vault, "fitness.md"), future, future); // the vault has moved past the index
  const ctx: OperationContext = { ...folderContext({ vault, store }), crossStar: true };
  store.stats = () => { throw new Error("stats() is health's, never a recall's"); }; // RAI-206 review
  try {
    const res = (await dispatchToolCall("recall", { query: "protein creatine goals" }, ctx)) as Recalled;
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.vaultChangedSinceReindex).toBe(true);
  } finally { await store.close(); rmSync(vault, { recursive: true, force: true }); }
}, 30_000);

// RAI-206 review: stats() counts chunks, groups trust and walks every node id for health's zones;
// a recall reads only the reindex stamp and the content identity, so it never pays for the counts.
test("recall never calls stats()", async () => {
  const { ctx, cleanup } = await fixture();
  ctx.store.stats = () => { throw new Error("stats() is health's, never a recall's"); };
  try {
    const r = (await dispatchToolCall("recall", { query: "protein creatine goals" }, ctx)) as Recalled;
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.contentGeneration).toBeNull(); // remember() with no full build: no build names these rows
  } finally { await cleanup(); }
});

// PLAN-0.5.0 item 15 (record 31): recall reads the content generation immediately AFTER the ranking,
// so the generation it reports names the rows recall ranked — a write landing between the two
// can then only make the stamp stale-null, never name rows recall did not see.
test("item 15: recall reads the generation right after the ranking, on both the folder and the bare-index path", async () => {
  const { ctx, cleanup } = await fixture();
  const s = ctx.store;
  const calls: string[] = [];
  const serving: ServingIndex = {
    remember: (i) => s.remember(i), remove: (i) => s.remove(i), indexedPage: (r) => s.indexedPage(r),
    pageStats: () => s.pageStats(), guardedRead: (e, r) => s.guardedRead(e, r), servingSignature: () => s.servingSignature(), close: () => s.close(),
    recall: async (q) => { calls.push("recall"); return s.recall(q); },
    stats: async () => { calls.push("stats"); return s.stats(); },
  };
  const folderStore = ctx.folder!.store;
  const identity = folderStore.contentIdentity.bind(folderStore);
  folderStore.contentIdentity = async () => { calls.push("contentIdentity"); return identity(); };
  try {
    await dispatchToolCall("recall", { query: "protein creatine goals" }, { ...ctx, store: serving });
    expect(calls).toEqual(["recall", "contentIdentity"]);
    calls.length = 0;
    folderStore.contentIdentity = identity; // libSQL's stats() reads it internally; log the port only
    const { folder: _f, ...edge } = ctx;
    await dispatchToolCall("recall", { query: "protein creatine goals" }, { ...edge, store: serving });
    expect(calls).toEqual(["recall", "stats"]);
  } finally { await cleanup(); }
});

// PLAN-0.5.0 item 13 (ADR-0015): the dispatcher's context and FunesStore take a ServingIndex — the
// nine members an edge index implements. Only folder-only ops reach for the full store, from the
// context's folder part; with none, they refuse rather than guess.
test("item 13: recall, health, indexed_page and remember serve over a bare ServingIndex; folder-only ops refuse", async () => {
  const { ctx, cleanup } = await fixture();
  const s = ctx.store;
  const serving: ServingIndex = {
    remember: (i) => s.remember(i), remove: (i) => s.remove(i), recall: (q) => s.recall(q),
    indexedPage: (r) => s.indexedPage(r), stats: () => s.stats(), pageStats: () => s.pageStats(),
    guardedRead: (e, r) => s.guardedRead(e, r), servingSignature: () => s.servingSignature(), close: () => s.close(),
  };
  const edge: OperationContext = { vault: ctx.vault, star: ctx.star, store: serving, funes: folderFunesStore(serving, { root: ctx.folder!.root }), tier: "home", designation: ctx.designation };
  try {
    expect(((await dispatchToolCall("recall", { query: "protein creatine goals" }, edge)) as Recalled).results.length).toBeGreaterThan(0);
    // RAI-308: health runs on every tier, from the serving index alone
    expect(await dispatchToolCall("health", {}, edge)).toMatchObject({ nodes: 3, servingSignature: s.servingSignature() });
    expect(((await dispatchToolCall("indexed_page", { id: "fitness" }, edge)) as { title: string }).title).toBe("Fitness");
    const { id } = (await dispatchToolCall("remember", { title: "Edge note", body: "written through a serving index" }, edge)) as { id: string };
    expect((await s.indexedPage({ id }))?.title).toBe("Edge note");
    for (const name of ["neighbors", "graph", "hotlist"]) {
      await expect(dispatchToolCall(name, name === "neighbors" ? { id: "fitness" } : {}, edge)).rejects.toThrow(/folder/);
    }
  } finally { await cleanup(); }
});

// ── PLAN-0.3.0 item 16 — the own-star scope guard, at the dispatcher every surface routes through ─
async function driftVault(): Promise<{ ctx: OperationContext; cleanup: () => Promise<void> }> {
  const vault = mkdtempSync(join(tmpdir(), "funes-ops-drift-"));
  writeFileSync(join(vault, "star.yaml"), 'memory:\n  index_scope:\n    exclude:\n      - "raw/**"\n');
  writeFileSync(join(vault, "keep.md"), "---\ntitle: Keep\n---\nprotein creatine goals\n");
  const store = await LibsqlStore.create(new FakeEmbedder(), join(vault, "i.db"));
  await indexDir(store, vault, { scopeSignature: { hash: scopeHash(["raw/**"]), ignoreScope: false } });
  // The operator narrows policy and has NOT reindexed. Before item 16 this state was enforced only
  // on the --cross-star path, so every local client went on being served the withdrawn rows.
  writeFileSync(join(vault, "star.yaml"), 'memory:\n  index_scope:\n    exclude:\n      - "raw/**"\n      - "secrets/**"\n');
  const ctx: OperationContext = folderContext({ vault, store });
  return { ctx, cleanup: async () => { await store.close(); rmSync(vault, { recursive: true, force: true }); } };
}

test("item 16: a NARROWED star.yaml refuses every row-serving op on the ordinary (non-cross-star) surface", async () => {
  const { ctx, cleanup } = await driftVault();
  try {
    await expect(dispatchToolCall("recall", { query: "protein creatine goals" }, ctx)).rejects.toThrow(/scope-hash mismatch/);
    await expect(dispatchToolCall("indexed_page", { id: "keep" }, ctx)).rejects.toThrow(/scope-hash mismatch/);
    await expect(dispatchToolCall("hotlist", {}, ctx)).rejects.toThrow(/scope-hash mismatch/);
    // neighbors and graph are not cross-star reads, but they answer entirely out of the store —
    // deriving the guard from `crossStar` would have left both leaking every excluded page's title.
    await expect(dispatchToolCall("neighbors", { id: "keep" }, ctx)).rejects.toThrow(/scope-hash mismatch/);
    await expect(dispatchToolCall("graph", {}, ctx)).rejects.toThrow(/scope-hash mismatch/);
  } finally { await cleanup(); }
}, 30_000);

test("item 16: health stays answerable under the same drift — it REPORTS the disagreement it would otherwise hide", async () => {
  const { ctx, cleanup } = await driftVault();
  try {
    // the verdict is data on health; the two hashes are doctor's (`doctor --json` state, RAI-308)
    const h = (await dispatchToolCall("health", {}, ctx)) as { scopeMatches: boolean | null };
    expect(h.scopeMatches).toBe(false);
  } finally { await cleanup(); }
}, 30_000);

test("item 16: a valid, UNCHANGED manifest still serves — the guard is not a blanket refusal", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-ops-agree-"));
  writeFileSync(join(vault, "star.yaml"), 'memory:\n  index_scope:\n    exclude:\n      - "raw/**"\n');
  writeFileSync(join(vault, "keep.md"), "---\ntitle: Keep\n---\nprotein creatine goals\n");
  const store = await LibsqlStore.create(new FakeEmbedder(), join(vault, "i.db"));
  await indexDir(store, vault, { scopeSignature: { hash: scopeHash(["raw/**"]), ignoreScope: false } });
  const ctx: OperationContext = folderContext({ vault, store });
  try {
    const res = (await dispatchToolCall("recall", { query: "protein creatine goals" }, ctx)) as Recalled;
    expect(res.results.length).toBeGreaterThan(0);
  } finally { await store.close(); rmSync(vault, { recursive: true, force: true }); }
}, 30_000);

test("item 16: a CONFIGLESS vault (no star.yaml) is unaffected — nothing declared, nothing enforced", async () => {
  const { ctx, cleanup } = await fixture(); // the shared fixture writes no star.yaml
  try {
    const res = (await dispatchToolCall("recall", { query: "protein creatine goals" }, ctx)) as Recalled;
    expect(res.results.length).toBeGreaterThan(0); // this store has no scope signature at all, and serves
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
  await indexDir(store, vault, {}); // both indexed, last_reindex_at stamped
  // Delete the file and touch NOTHING else: every surviving file stays older than the stamp, so
  // the mtime half of the answer is "unchanged". Only the id comparison can catch this.
  rmSync(join(vault, "gone.md"));
  const ctx: OperationContext = folderContext({ vault, store });
  try {
    const res = (await dispatchToolCall("recall", { query: "protein creatine goals" }, ctx)) as Recalled;
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.vaultChangedSinceReindex).toBe(true);
    const h = (await dispatchToolCall("health", {}, ctx)) as { vaultChangedSinceReindex: boolean | null };
    expect(h.vaultChangedSinceReindex).toBe(true);
  } finally { await store.close(); rmSync(vault, { recursive: true, force: true }); }
}, 30_000);

test("item 18: no deletion, nothing touched -> still reported fresh (the id comparison adds no false alarm)", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-ops-nodel-"));
  writeFileSync(join(vault, "keep.md"), "---\ntitle: Keep\n---\nprotein creatine goals\n");
  utimesSync(join(vault, "keep.md"), 1000, 1000);
  const store = await LibsqlStore.create(new FakeEmbedder(), join(vault, "i.db"));
  await indexDir(store, vault, {});
  const ctx: OperationContext = folderContext({ vault, store });
  try {
    const res = (await dispatchToolCall("recall", { query: "protein creatine goals" }, ctx)) as Recalled;
    expect(res.results.length).toBeGreaterThan(0);
    // Since 0.4.0 item 6 the record compared against is the build's per-page stats, which cover
    // tombstones too — so a file the index deliberately does not serve still matches its record.
    expect("vaultChangedSinceReindex" in res).toBe(false);
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
  const ctx: OperationContext = folderContext({ vault, store });
  type H = { vaultChangedSinceReindex: boolean | null; freshnessBasis: string };
  try {
    await store.remember([{ id: "keep", path: "keep.md", title: "Keep", body: "protein creatine goals", trust: "trusted" }]);
    const before = (await dispatchToolCall("health", {}, ctx)) as H; // rows, but no full build
    expect([before.vaultChangedSinceReindex, before.freshnessBasis]).toEqual([null, "none"]);
    await indexDir(store, vault, {});
    const after = (await dispatchToolCall("health", {}, ctx)) as H;
    expect([after.vaultChangedSinceReindex, after.freshnessBasis]).toEqual([false, "stat"]);
  } finally { await store.close(); rmSync(vault, { recursive: true, force: true }); }
}, 30_000);

// PLAN-0.4.0 item 10: one value, carried. The locus a surface resolved at startup rides its
// designation, and health names that value — never a re-read of the environment. The environment
// below says something else on purpose. RAI-308: the locus left recall; health carries it.
test("item 10: health names the locus the serving context resolved, and only that; recall names none", async () => {
  const { ctx, cleanup } = await fixture();
  const saved = process.env.FUNES_LOCUS;
  process.env.FUNES_LOCUS = "host-b";
  try {
    const at = { ...ctx, designation: { locus: "host-a", authority: null } };
    const h = (await dispatchToolCall("health", {}, at)) as { locus: string | null };
    expect(h.locus).toBe("host-a");
    expect(await dispatchToolCall("recall", { query: "protein creatine goals" }, at)).not.toHaveProperty("locus");
  } finally {
    if (saved === undefined) delete process.env.FUNES_LOCUS;
    else process.env.FUNES_LOCUS = saved;
    await cleanup();
  }
});

// …and a host that builds its own context — twinkling's unified surface calls folderContext, then
// createApi → dispatchToolCall — reports the locus its process resolved. RAI-313: folderContext
// resolves it once, at construction (the kernel reads no environment), so health and the write rule
// read one value, not two; a context with no designation has no locus.
test("item 10: folderContext resolves FUNES_LOCUS once, and health names it; no designation is no locus", async () => {
  const { ctx, cleanup } = await fixture();
  const saved = process.env.FUNES_LOCUS;
  try {
    process.env.FUNES_LOCUS = " Host-B ";
    const own = folderContext({ vault: ctx.folder!.root, store: ctx.folder!.store });
    const h = (await dispatchToolCall("health", {}, own)) as { locus: string | null };
    expect(h.locus).toBe("host-b");
    expect(own.designation?.locus).toBe("host-b"); // the value the write rule reads
    process.env.FUNES_LOCUS = "host-c"; // resolved once per context: a later environment is not re-read
    expect(((await dispatchToolCall("health", {}, own)) as { locus: string | null }).locus).toBe("host-b");
    const bare = { ...ctx, designation: { locus: null, authority: null } }; // the kernel never resolves a locus itself
    expect(((await dispatchToolCall("health", {}, bare)) as { locus: string | null }).locus).toBeNull();
  } finally {
    if (saved === undefined) delete process.env.FUNES_LOCUS;
    else process.env.FUNES_LOCUS = saved;
    await cleanup();
  }
});

test("item 19: after a full build, recall names the content generation", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-ops-v2gen-"));
  writeFileSync(join(vault, "keep.md"), "---\ntitle: Keep\n---\nprotein creatine goals\n");
  const store = await LibsqlStore.create(new FakeEmbedder(), join(vault, "i.db"));
  await indexDir(store, vault, {}); // finalizeReindex stamps the content generation
  const ctx: OperationContext = folderContext({ vault, store });
  try {
    expect(((await dispatchToolCall("recall", { query: "protein creatine goals" }, ctx)) as Recalled).contentGeneration).toMatch(/^v3:/);
  } finally { await store.close(); rmSync(vault, { recursive: true, force: true }); }
}, 30_000);

test("S3 mutations: remember server-stamps untrusted + writes out_memory; supersede/forget guarded by assertOwned", async () => {
  const { ctx, cleanup } = await fixture();
  try {
    const r = (await dispatchToolCall("remember",
      { title: "Note from agent", body: "remembered via registry" }, ctx)) as { id: string; trust: string };
    expect(r.id.startsWith("out_memory/")).toBe(true);
    expect(r.trust).toBe("untrusted");
    const file = readFileSync(join(ctx.folder!.root, r.id + ".md"), "utf8");
    expect(file).toContain("trust: untrusted"); // canonical frontmatter records it

    // foreign ids are not mutable through the registry (H3 assertOwned)
    await expect(dispatchToolCall("supersede",
      { oldId: "fitness", title: "x", body: "y" }, ctx)).rejects.toThrow(/refusing to mutate/);
    await expect(dispatchToolCall("forget", { id: "fitness" }, ctx)).rejects.toThrow(/refusing to mutate/);

    // soft forget on the owned item: off recall, file kept
    await dispatchToolCall("forget", { id: r.id }, ctx);
    expect(readFileSync(join(ctx.folder!.root, r.id + ".md"), "utf8")).toContain("forgotten: true");
  } finally { await cleanup(); }
});

test("page: reads a vault page; rejects traversal, absolute, and dot-paths", async () => {
  const { ctx, cleanup } = await fixture();
  try {
    const ok = (await dispatchToolCall("page", { path: "yachts/cat.md" }, ctx)) as
      { frontmatter: Record<string, unknown>; body: string };
    expect(ok.frontmatter.title).toBe("Catamaran");
    expect(ok.body).toContain("hybrid sailing");
    await expect(dispatchToolCall("page", { path: "../outside.md" }, ctx)).rejects.toThrow(/invalid path|escapes/);
    await expect(dispatchToolCall("page", { path: "/etc/passwd" }, ctx)).rejects.toThrow(/invalid path/);
    await expect(dispatchToolCall("page", { path: ".funes/secret.md" }, ctx)).rejects.toThrow(/invalid path|escapes/);
    await expect(dispatchToolCall("page", { path: "yachts/../../x.md" }, ctx)).rejects.toThrow(/invalid path|escapes/);
  } finally { await cleanup(); }
});

test("tree: one level with zones; dot-dirs skipped", async () => {
  const { ctx, cleanup } = await fixture();
  try {
    mkdirSync(join(ctx.folder!.root, ".hidden"));
    const root = (await dispatchToolCall("tree", {}, ctx)) as
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
    const h = (await dispatchToolCall("health", {}, ctx)) as
      { nodes: number; edges: number; embeddingSignature: string | null; reindexDirty: boolean };
    expect(h.nodes).toBe(3);
    expect(h.reindexDirty).toBe(false);
    expect(h.embeddingSignature).toContain(":16");
  } finally { await cleanup(); }
});

test("dispatch: unknown op and missing required arg both throw; tool defs project all ops", async () => {
  const { ctx, cleanup } = await fixture();
  try {
    await expect(dispatchToolCall("nope", {}, ctx)).rejects.toThrow(/unknown operation/);
    await expect(dispatchToolCall("recall", {}, ctx)).rejects.toThrow(/missing required/);
    const defs = buildToolDefs(operations);
    expect(defs.map((d) => d.name).sort()).toEqual(["forget", "graph", "health", "hotlist", "indexed_page", "neighbors", "page", "put_page", "recall", "remember", "supersede", "tree"]);
    expect(defs.every((d) => d.description.length > 0)).toBe(true);
  } finally { await cleanup(); }
});

test("readonly subset (--published, --ops): exposes reads only, never a mutation", () => {
  // A read-only store's narrow is `operations.filter(o => o.readonly)` (C14). This asserts that
  // subset never leaks a write op (remember/supersede/forget) — the guarantee a published index and a
  // query-only connection rely on. If a new mutation is added and mislabeled `readonly: true`, this fails.
  const readOnly = buildToolDefs(operations.filter((o) => o.readonly)).map((d) => d.name).sort();
  const writes = operations.filter((o) => !o.readonly).map((o) => o.name).sort();
  expect(writes).toEqual(["forget", "put_page", "remember", "supersede"]);
  for (const w of writes) expect(readOnly).not.toContain(w);
  expect(readOnly).toEqual(["graph", "health", "hotlist", "indexed_page", "neighbors", "page", "recall", "tree"]);
});

test("hotlist op (R8): tracking off -> {tracking:false, items:[]}; on -> trusted-only counters", async () => {
  // fixture's store is constructed WITHOUT trackRecalls — the registry must say so and return [].
  const { ctx, cleanup } = await fixture();
  try {
    await dispatchToolCall("recall", { query: "protein creatine goals", k: 5 }, ctx);
    const off = (await dispatchToolCall("hotlist", {}, ctx)) as { tracking: boolean; items: unknown[] };
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
    const funes = folderFunesStore(store, { root: vault });
    const ctx2: OperationContext = { ...folderContext({ vault, store }), funes };
    await dispatchToolCall("recall", { query: "protein creatine goals", k: 5 }, ctx2);
    await dispatchToolCall("recall", { query: "protein creatine goals", k: 5 }, ctx2);
    const on = (await dispatchToolCall("hotlist", { n: 10 }, ctx2)) as
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
    const n = (await dispatchToolCall("neighbors", { id: "yachts/cat", k: 3 }, ctx)) as {
      node: { id: string; trust?: string } | null;
      similar: Array<{ id: string; score: number; trust?: string }>;
      edgesOut: Array<{ type: string; id: string; title: string | null; trust?: string }>;
      edgesIn: Array<{ type: string; id: string }>;
    };
    expect(n.node?.id).toBe("yachts/cat");
    expect(n.similar.length).toBeGreaterThan(0);
    expect(n.similar.every((x) => typeof x.score === "number" && x.trust !== undefined)).toBe(true);
    expect(n.edgesOut).toContainEqual({ type: "related_to", id: "fitness", title: "Fitness", trust: "trusted" });

    const fromFitness = (await dispatchToolCall("neighbors", { id: "fitness" }, ctx)) as { edgesIn: Array<{ id: string }> };
    expect(fromFitness.edgesIn.map((e) => e.id)).toContain("yachts/cat"); // reverse direction

    const missing = (await dispatchToolCall("neighbors", { id: "nope/nothing" }, ctx)) as { node: unknown };
    expect(missing.node).toBe(null);
  } finally { await cleanup(); }
});

test("opCapabilities (P1.8): sorted projection marking mutations, cross-star reads and tiers", () => {
  const caps = opCapabilities();
  // deterministic: sorted by name
  expect(caps.map((c) => c.name)).toEqual([...caps.map((c) => c.name)].sort());
  const by = new Map(caps.map((c) => [c.name, c]));
  // mutations (readonly:false) are exactly these — no phantoms (put_page and link: ADR-0010)
  expect(caps.filter((c) => !c.readonly).map((c) => c.name).sort()).toEqual(["forget", "put_page", "remember", "supersede"]);
  // ADR-0020: crossStar replaces served; recall is a cross-star read, page is not
  expect(by.get("recall")?.crossStar).toBe(true);
  expect(by.get("page")?.crossStar).toBe(false);
  expect(by.get("put_page")?.tiers).toEqual(["edge"]);
  // elevate is banned from the registry, so it never appears in the projection
  expect(by.has("elevate")).toBe(false);
});

// ── RAI-158 (PLAN-0.4.0 item 21): the per-caller check in dispatchToolCall ──────────────────────
// GENERATED from the registry, so an op added later is covered without editing this test: for every
// op, a grant that names it passes the check, and a grant that does not is
// refused BEFORE the argument gate — with empty args, the refusal must be the grant's, never a
// "missing required argument".
import { assertGrantedStar } from "funes-core/internal";
import { readStarIdentity } from "./factory.ts";
const assertGranted = (g: Grant, op: { name: string }, root: string) => assertGrantedStar(g, op, readStarIdentity(root).id);
import { publicOpNames } from "funes-core";
import { NOT_GRANTED } from "funes-core/internal";
import type { Grant } from "funes-core";

const grantOf = (ops: string[], stars: string[] = ["*"]): Grant => ({ actor: "tester@here", ops: new Set(ops), stars });

test("RAI-158: every registry op is refused to a grant that does not name it, before its arguments are read", async () => {
  const { ctx, cleanup } = await fixture();
  try {
    const all = [...publicOpNames()];
    for (const op of ceiling("home")) { // an op outside the ceiling answers unknown before the grant (record 35 A13)
      expect(all).toContain(op.name);
      const without = grantOf(all.filter((n) => n !== op.name));
      await expect(dispatchToolCall(op.name, {}, { ...ctx, grant: without })).rejects.toThrow(`operation ${op.name}: not granted to actor "tester@here"`);
      expect(() => assertGranted(grantOf([op.name]), op, ctx.folder!.root)).not.toThrow();
    }
  } finally { await cleanup(); }
});

test("RAI-158: a grant reaches only the stars it names — by canonical key, and '*' reaches a star with no id", async () => {
  const { ctx, cleanup } = await fixture();
  try {
    const recall = operations.find((o) => o.name === "recall")!;
    expect(() => assertGranted(grantOf(["recall"], ["rainblow.ing/funes"]), recall, ctx.folder!.root)).toThrow(/holds no grant for star "\(no id\)"/);
    expect(() => assertGranted(grantOf(["recall"]), recall, ctx.folder!.root)).not.toThrow();
    writeFileSync(join(ctx.folder!.root, "star.yaml"), "meta:\n  id: git://rainblow.ing/funes\n");
    expect(() => assertGranted(grantOf(["recall"], ["rainblow.ing/funes"]), recall, ctx.folder!.root)).not.toThrow();
    expect(() => assertGranted(grantOf(["recall"], ["mcp://rainblow.ing/funes"]), recall, ctx.folder!.root)).not.toThrow();
    expect(() => assertGranted(grantOf(["recall"], ["rainblow.ing/personal"]), recall, ctx.folder!.root)).toThrow(/holds no grant for star "git:\/\/rainblow\.ing\/funes"/);
    // both refusals carry the wire code the HTTP spine answers 403 (RAI-159)
    for (const g of [grantOf(["recall"], ["rainblow.ing/personal"]), grantOf(["health"])]) {
      let code: unknown;
      try { assertGranted(g, recall, ctx.folder!.root); } catch (e) { code = (e as { code?: unknown }).code; }
      expect(code).toBe(NOT_GRANTED);
    }
    // and through the dispatch point itself, with empty args: the star refusal comes before the argument gate
    await expect(dispatchToolCall("recall", {}, { ...ctx, grant: grantOf(["recall"], ["rainblow.ing/personal"]) }))
      .rejects.toThrow(/holds no grant for star "git:\/\/rainblow\.ing\/funes"/);
  } finally { await cleanup(); }
});

// ── RAI-160 (PLAN-0.4.0 item 23): a served write refuses what the sanitizer would cut ────────────
import { MAX_BODY_CHARS, MAX_TITLE_CHARS } from "funes-core/internal";

test("RAI-160: remember stores a body at the cap WHOLE, and refuses one character more instead of cutting its tail", async () => {
  const { ctx, cleanup } = await fixture();
  try {
    const body = "word ".repeat(MAX_BODY_CHARS / 5).slice(0, MAX_BODY_CHARS - 4) + "TAIL";
    const { id } = (await dispatchToolCall("remember", { title: "At the cap", body }, ctx)) as { id: string };
    expect(readFileSync(join(ctx.folder!.root, `${id}.md`), "utf8")).toContain("TAIL"); // before RAI-160 a longer body lost this silently
    await expect(dispatchToolCall("remember", { title: "Over", body: body + "x" }, ctx)).rejects.toThrow(/body/);
    await expect(dispatchToolCall("remember", { title: "t".repeat(MAX_TITLE_CHARS + 1), body: "b" }, ctx)).rejects.toThrow(/title/);
    await expect(dispatchToolCall("supersede", { oldId: id, title: "Over", body: body + "x" }, ctx)).rejects.toThrow(/body/);
  } finally { await cleanup(); }
});
