import { test, expect, afterEach } from "bun:test";
import type { Embedder } from "funes-core";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FunesStore, folderContext } from "./funes-store.ts";
import { isItemPath } from "./page-id.ts";
import { operations, folderOperations, dispatchToolCall, type OperationContext } from "./ops.ts";

// PLAN-0.5.0 item 28 (ADR-0010 §The decision and §Revision; ADR-0016): the proposal ops at the engine
// seam — dispatchToolCall on a temp vault. The context has no folder part, as the edge writer's has
// none: no folder host serves `put_page`.

class FakeEmbedder implements Embedder {
  readonly dim = 8;
  private vec(t: string): Float32Array {
    const v = new Float32Array(this.dim);
    for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) v[w.length % this.dim]! += 1;
    return v;
  }
  async embedQuery(t: string) { return this.vec(t); }
  async embedPassage(t: string) { return this.vec(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.vec(t)); }
}

const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const dirs: string[] = [];
const stores: LibsqlStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A ULID minted at `ms` (Crockford base32 time, then 16 random-ish characters). */
function ulid(ms = Date.now(), tail = "0000000000000000"): string {
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let t = "";
  for (let i = 0, n = ms; i < 10; i++, n = Math.floor(n / 32)) t = A[n % 32] + t;
  return t + tail;
}

async function edge(pages: Record<string, string> = {}) {
  const vault = mkdtempSync(join(tmpdir(), "funes-proposal-"));
  dirs.push(vault);
  mkdirSync(join(vault, "out_memory"));
  for (const [rel, text] of Object.entries(pages)) {
    mkdirSync(dirname(join(vault, rel)), { recursive: true });
    writeFileSync(join(vault, rel), text);
  }
  const store = await LibsqlStore.create(new FakeEmbedder());
  stores.push(store);
  const ctx: OperationContext = { ...folderContext({ vault, store, trust: "untrusted", remote: true }), folder: undefined };
  const call = (name: string, args: Record<string, unknown>) => dispatchToolCall(operations, name, args, ctx) as Promise<Record<string, unknown>>;
  return { vault, ctx, call };
}

const PAGE = "---\ntitle: Heat\ntype: film\n---\nA crime film.\n";

test("put_page create-once answers applied with writtenHash; vault_page reads the same bytes back", async () => {
  const { vault, call } = await edge();
  const id = ulid();
  const r = await call("put_page", { path: "out_memory/heat.md", content: PAGE, proposalId: id });
  const written = readFileSync(join(vault, "out_memory/heat.md"));
  expect(r).toEqual({ proposalId: id, status: "applied", writtenHash: sha(written) });
  const v = await call("vault_page", { path: "out_memory/heat.md" });
  expect(v.sha256).toBe(sha(written));
  expect(sha(new TextEncoder().encode(v.content as string))).toBe(v.sha256 as string);
});

test("a redelivered proposal answers already-applied with the stored writtenHash; a known id with another payload is invalid", async () => {
  const { call } = await edge();
  const id = ulid();
  const first = await call("put_page", { path: "out_memory/heat.md", content: PAGE, proposalId: id });
  expect(await call("put_page", { path: "out_memory/heat.md", content: PAGE, proposalId: id }))
    .toEqual({ proposalId: id, status: "already-applied", writtenHash: first.writtenHash });
  expect(await call("put_page", { path: "out_memory/heat.md", content: PAGE + "more\n", proposalId: id }))
    .toEqual({ proposalId: id, status: "refused", reason: "invalid" });
});

test("an id outside the writer's window (29 days back, 1 day ahead) is refused invalid", async () => {
  const { call } = await edge();
  for (const id of [ulid(Date.now() - 30 * 86_400_000), ulid(Date.now() + 2 * 86_400_000)]) {
    expect(await call("put_page", { path: "out_memory/heat.md", content: PAGE, proposalId: id }))
      .toEqual({ proposalId: id, status: "refused", reason: "invalid" });
  }
});

const BASE = "---\ntitle: Heat\ntype: film\ntrust: trusted\ncreated: 2026-01-01\n---\nA crime film.\n";

test("a replace on its base applies: the writer's own fields and the type come from the base, the overwritten bytes become a history object", async () => {
  const { vault, call } = await edge({ "out_memory/heat.md": BASE });
  const r = await call("put_page", { path: "out_memory/heat.md", content: "---\ntitle: Heat (1995)\n---\nA heist film.\n", base: sha(BASE), proposalId: ulid() });
  expect(r.status).toBe("applied");
  const now = readFileSync(join(vault, "out_memory/heat.md"), "utf8");
  expect(r.writtenHash).toBe(sha(now));
  expect(now).toContain("trust: trusted");
  expect(now).toContain("type: film");
  expect(now).toContain("A heist film.");
  expect(readFileSync(join(vault, ".history/out_memory/heat.md", sha(BASE)), "utf8")).toBe(BASE);
});

test("a replace refuses a stale base (with currentHash), a missing page (not-found) and a change to a writer-owned field", async () => {
  const { vault, call } = await edge({ "out_memory/heat.md": BASE });
  expect(await call("put_page", { path: "out_memory/heat.md", content: BASE, base: sha("other") }))
    .toEqual({ status: "refused", reason: "stale-base", currentHash: sha(BASE) });
  expect(await call("put_page", { path: "out_memory/gone.md", content: BASE, base: sha(BASE) }))
    .toEqual({ status: "refused", reason: "not-found" });
  expect(await call("put_page", { path: "out_memory/heat.md", content: BASE.replace("trusted", "untrusted"), base: sha(BASE) }))
    .toEqual({ status: "refused", reason: "protected-field" });
  expect(readFileSync(join(vault, "out_memory/heat.md"), "utf8")).toBe(BASE);
  expect(existsSync(join(vault, ".history"))).toBe(false);
});

test("a create-once refuses an existing page (stale-base) unless the bytes are equal (the byte-equal no-op); it carries no writer-owned field", async () => {
  const { vault, call } = await edge();
  await call("put_page", { path: "out_memory/heat.md", content: PAGE });
  const onDisk = readFileSync(join(vault, "out_memory/heat.md"), "utf8");
  expect(onDisk).toContain("trust: untrusted"); // H4: a create is stamped untrusted
  expect(await call("put_page", { path: "out_memory/heat.md", content: PAGE })).toEqual({ status: "applied", writtenHash: sha(onDisk) });
  expect(await call("put_page", { path: "out_memory/heat.md", content: PAGE + "x\n" }))
    .toEqual({ status: "refused", reason: "stale-base", currentHash: sha(onDisk) });
  expect(await call("put_page", { path: "out_memory/new.md", content: "---\ntitle: N\ntrust: trusted\n---\nn\n" }))
    .toEqual({ status: "refused", reason: "protected-field" });
  expect(await call("put_page", { path: "wiki/heat.md", content: PAGE })).toEqual({ status: "refused", reason: "invalid" });
});

test("link adds and removes one edge; a link to a forgotten page is not-found", async () => {
  const { vault, call } = await edge({
    "out_memory/a.md": "---\ntitle: A\ntype: note\n---\na\n",
    "out_memory/b.md": "---\ntitle: B\ntype: note\n---\nb\n",
    "out_memory/c.md": "---\ntitle: C\ntype: note\nforgotten: true\n---\nc\n",
  });
  expect((await call("link", { from: "out_memory/a", to: "out_memory/b", proposalId: ulid() })).status).toBe("applied");
  expect(readFileSync(join(vault, "out_memory/a.md"), "utf8")).toContain("target: out_memory/b");
  const removed = await call("link", { from: "out_memory/a", to: "out_memory/b", remove: true });
  expect(removed.status).toBe("applied");
  expect(readFileSync(join(vault, "out_memory/a.md"), "utf8")).not.toContain("out_memory/b");
  expect(removed.writtenHash).toBe(sha(readFileSync(join(vault, "out_memory/a.md"))));
  expect(await call("link", { from: "out_memory/a", to: "out_memory/c" })).toEqual({ status: "refused", reason: "not-found" });
});

test("vault_page refuses bytes that are not UTF-8 (invalid)", async () => {
  const { vault, call } = await edge();
  writeFileSync(join(vault, "out_memory/bad.md"), new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a]));
  await expect(call("vault_page", { path: "out_memory/bad.md" })).rejects.toMatchObject({ code: "invalid" });
});

test("a mutation the grant does not hold answers not-granted with the proposal id; without one it stays a tool error", async () => {
  const { ctx } = await edge();
  const grant = { actor: "bot", ops: new Set(["recall_v2"]), stars: null } as unknown as OperationContext["grant"];
  const id = ulid();
  expect(await dispatchToolCall(operations, "remember", { title: "t", body: "b", proposalId: id }, { ...ctx, grant }))
    .toEqual({ proposalId: id, status: "refused", reason: "not-granted" });
  await expect(dispatchToolCall(operations, "remember", { title: "t", body: "b" }, { ...ctx, grant })).rejects.toThrow(/not granted/);
});

test("remember with a proposal id answers in the proposal shape with its own fields; a proposal's forget is never hard", async () => {
  const { call } = await edge();
  const id = ulid();
  const r = await call("remember", { title: "t", body: "b", proposalId: id });
  expect(r).toMatchObject({ proposalId: id, status: "applied", trust: "untrusted" });
  expect(await call("remember", { title: "t", body: "b", proposalId: id })).toEqual({ proposalId: id, status: "already-applied" });
  expect(await call("forget", { id: r.id, hard: true, proposalId: ulid() })).toMatchObject({ status: "refused", reason: "invalid" });
});

test("no folder host serves put_page: a folder context refuses it, and folderOperations leaves it out", async () => {
  const { vault, ctx } = await edge();
  const folder = folderContext({ vault, store: ctx.store as LibsqlStore, trust: "untrusted", remote: true });
  await expect(dispatchToolCall(operations, "put_page", { path: "out_memory/heat.md", content: PAGE }, folder)).rejects.toThrow(/no folder host/);
  expect(folderOperations.map((o) => o.name)).not.toContain("put_page");
  expect(folderOperations.map((o) => o.name)).toContain("link");
});

// A folder host's ceiling has no put_page: at a locus that may write, it is an unknown operation —
// no audit line, no proposal-shaped answer to a malformed payload. Only a locus the designation
// refuses names the write locus (record 35 C6), still before any audit or argument gate.
test("a folder host's ceiling: put_page is unknown where writes are allowed, refused naming the writer where they are not", async () => {
  const { vault, ctx } = await edge();
  const folder = folderContext({ vault, store: ctx.store as LibsqlStore, trust: "untrusted", remote: true });
  const audit: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => (audit.push(String(s)), true)) as typeof process.stderr.write;
  try {
    folder.designation = { mode: "audit", locus: "host-a", authority: null, proposerFor: null }; // undeclared: allowed
    await expect(dispatchToolCall(folderOperations, "put_page", { path: 7 }, folder)).rejects.toThrow("unknown operation: put_page");
    folder.designation = { mode: "audit", locus: "reader-container", authority: "funes-taste", proposerFor: null };
    await expect(dispatchToolCall(folderOperations, "put_page", { path: 7 }, folder)).rejects.toThrow('the star\'s writer is "funes-taste"');
  } finally {
    process.stderr.write = write;
  }
  expect(audit.filter((l) => l.includes("write-designation"))).toEqual([]);
});

// PLAN-0.5.0 item 35 (ADR-0010 §Revision "The edge apply"; record 24 §6 steps 5 and 10): the taste
// star's writer rules, as the edge writer configures FunesStore — `memoryDir: items`, the page-id rule
// on, and a create stamped untrusted unless the caller is the outbox.
async function taste(createTrust: "untrusted" | "zone" = "untrusted", pages: Record<string, string> = {}) {
  const e = await edge(pages);
  mkdirSync(join(e.vault, "items"), { recursive: true });
  const funes = new FunesStore(e.ctx.store as LibsqlStore, { root: e.vault, memoryDir: "items", itemPages: true, createTrust });
  const ctx: OperationContext = { ...e.ctx, funes };
  const call = (name: string, args: Record<string, unknown>) => dispatchToolCall(operations, name, args, ctx) as Promise<Record<string, unknown>>;
  return { ...e, ctx, call };
}

const ITEM = "---\ntitle: Heat\ntype: Film\ndomain: movies\n---\nA crime film.\n";

test("taste: a create-once names an item path — items/<domain>/<name>.md, lowercase ASCII, at most 900 bytes", async () => {
  const { call } = await taste();
  for (const path of ["items/heat.md", "items/Movies/heat.md", "items/movies/Heat.md", "items/movies/жара.md", "items/movies/a/heat.md",
    "items/movies/heat-.md", "items/movies/heat---x.md", `items/movies/${"a".repeat(900 - "items/movies/.md".length + 1)}.md`]) {
    expect(await call("put_page", { path, content: ITEM })).toEqual({ status: "refused", reason: "invalid" });
  }
  expect((await call("put_page", { path: "items/movies/heat--michael-mann.md", content: ITEM })).status).toBe("applied");
  // 900 bytes is a legal item path, but no folder holds a 884-byte name: the edge writer's tests apply it
  expect(isItemPath(`items/movies/${"a".repeat(900 - "items/movies/.md".length)}.md`, "items")).toBe(true);
});

test("taste: supersede refuses an item page (an item changes only by a put_page replace); a note at items/ still supersedes", async () => {
  const { call } = await taste("untrusted", { "items/movies/heat.md": ITEM });
  expect(await call("supersede", { oldId: "items/movies/heat", title: "Heat", body: "b", proposalId: ulid() }))
    .toEqual(expect.objectContaining({ status: "refused", reason: "invalid" }));
  const note = await call("remember", { title: "n", body: "a note" });
  expect((await call("supersede", { oldId: note.id, title: "n2", body: "a later note", proposalId: ulid() })).status).toBe("applied");
});

test("taste: a create is stamped untrusted unless the writer keeps the zone's trust (the outbox's creates)", async () => {
  const bot = await taste("untrusted");
  await bot.call("put_page", { path: "items/movies/heat.md", content: ITEM });
  expect(readFileSync(join(bot.vault, "items/movies/heat.md"), "utf8")).toContain("trust: untrusted");
  const outbox = await taste("zone");
  const r = await outbox.call("put_page", { path: "items/movies/heat.md", content: ITEM });
  const onDisk = readFileSync(join(outbox.vault, "items/movies/heat.md"), "utf8");
  expect(onDisk).not.toContain("trust:");
  expect(r).toEqual({ status: "applied", writtenHash: sha(onDisk) });
});
