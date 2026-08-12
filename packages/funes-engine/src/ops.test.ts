import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";
import { FunesStore } from "./funes-store.ts";
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

test("dispatch: unknown op and missing required arg both throw; tool defs project all ops", async () => {
  const { ctx, cleanup } = await fixture();
  try {
    await expect(dispatchToolCall(operations, "nope", {}, ctx)).rejects.toThrow(/unknown operation/);
    await expect(dispatchToolCall(operations, "recall", {}, ctx)).rejects.toThrow(/missing required/);
    const defs = buildToolDefs(operations);
    expect(defs.map((d) => d.name).sort()).toEqual(["forget", "graph", "health", "hotlist", "indexed_page", "neighbors", "page", "recall", "remember", "supersede", "tree"]);
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
  expect(readOnly).toEqual(["graph", "health", "hotlist", "indexed_page", "neighbors", "page", "recall", "tree"]);
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
