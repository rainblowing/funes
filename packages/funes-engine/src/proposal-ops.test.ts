import { test, expect, afterEach } from "bun:test";
import type { Embedder } from "funes-core";
import { LibsqlStore } from "./libsql/store.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FunesStore } from "funes-core/internal";
import { folderContext, folderFunesStore, folderStar } from "./funes-store.ts";
import { isItemPath } from "funes-core/internal";
import { operations } from "funes-core/internal";
import { dispatchToolCall, portContext, type OperationContext } from "funes-core";
import type { Receipt, Receipts } from "funes-core/internal";
import { FolderVault } from "./folder-vault.ts";

// PLAN-0.5.0 item 28 (ADR-0010 §The decision and §Revision; ADR-0016): the proposal ops at the engine
// seam — dispatchToolCall on a temp vault. The context is an edge-tier one with no folder part, as the
// edge writer's is: only the edge serves `put_page` (ADR-0020), and it requires a proposal id.

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
  // the edge writer injects its receipts port (RAI-316); the folder host has none
  const m = new Map<string, Receipt>();
  const receipts: Receipts = { get: async (id) => m.get(id) ?? null, put: async (r) => { m.set(r.proposalId, r); } };
  const ctx: OperationContext = {
    ...portContext({ index: store, vault: new FolderVault(vault), star: folderStar(vault), memoryDir: "out_memory", serialize: (fn) => fn(), receipts, tier: "edge", designation: { locus: null, authority: null } }),
  };
  const call = (name: string, args: Record<string, unknown>) => dispatchToolCall(name, args, ctx) as Promise<Record<string, unknown>>;
  return { vault, ctx, call, receipts };
}

const PAGE = "---\ntitle: Heat\ntype: film\n---\nA crime film.\n";

test("put_page create-once answers applied with writtenHash; page {raw} reads the same bytes back", async () => {
  const { vault, call } = await edge();
  const id = ulid();
  const r = await call("put_page", { path: "out_memory/heat.md", content: PAGE, proposalId: id });
  const written = readFileSync(join(vault, "out_memory/heat.md"));
  expect(r).toEqual({ proposalId: id, status: "applied", writtenHash: sha(written) });
  const v = await call("page", { path: "out_memory/heat.md", raw: true });
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
  const [a, b, c] = [ulid(), ulid(Date.now(), "0000000000000001"), ulid(Date.now(), "0000000000000002")];
  expect(await call("put_page", { path: "out_memory/heat.md", content: BASE, base: sha("other"), proposalId: a }))
    .toEqual({ proposalId: a, status: "refused", reason: "stale-base", currentHash: sha(BASE) });
  expect(await call("put_page", { path: "out_memory/gone.md", content: BASE, base: sha(BASE), proposalId: b }))
    .toEqual({ proposalId: b, status: "refused", reason: "not-found" });
  expect(await call("put_page", { path: "out_memory/heat.md", content: BASE.replace("trusted", "untrusted"), base: sha(BASE), proposalId: c }))
    .toEqual({ proposalId: c, status: "refused", reason: "protected-field" });
  expect(readFileSync(join(vault, "out_memory/heat.md"), "utf8")).toBe(BASE);
  expect(existsSync(join(vault, ".history"))).toBe(false);
});

test("a create-once refuses an existing page (stale-base) unless the bytes are equal (the byte-equal no-op); it carries no writer-owned field", async () => {
  const { vault, call } = await edge();
  const put = (path: string, content: string) => call("put_page", { path, content, proposalId: ulid(Date.now(), String(n++).padStart(16, "0")) })
    .then(({ proposalId: _, ...r }) => r);
  let n = 0;
  await put("out_memory/heat.md", PAGE);
  const onDisk = readFileSync(join(vault, "out_memory/heat.md"), "utf8");
  expect(onDisk).toContain("trust: untrusted"); // H4: a create is stamped untrusted
  expect(await put("out_memory/heat.md", PAGE)).toEqual({ status: "applied", writtenHash: sha(onDisk) });
  expect(await put("out_memory/heat.md", PAGE + "x\n")).toEqual({ status: "refused", reason: "stale-base", currentHash: sha(onDisk) });
  expect(await put("out_memory/new.md", "---\ntitle: N\ntrust: trusted\n---\nn\n")).toEqual({ status: "refused", reason: "protected-field" });
  expect(await put("wiki/heat.md", PAGE)).toEqual({ status: "refused", reason: "invalid" });
});

test("page {raw} refuses bytes that are not UTF-8 (invalid)", async () => {
  const { vault, call } = await edge();
  writeFileSync(join(vault, "out_memory/bad.md"), new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a]));
  await expect(call("page", { path: "out_memory/bad.md", raw: true })).rejects.toMatchObject({ code: "invalid" });
});

test("a mutation the grant does not hold answers not-granted with the proposal id; without one it stays a tool error", async () => {
  const { ctx } = await edge();
  const grant = { actor: "bot", ops: new Set(["recall"]), stars: null } as unknown as OperationContext["grant"];
  const id = ulid();
  expect(await dispatchToolCall("forget", { id: "out_memory/x", proposalId: id }, { ...ctx, grant }))
    .toEqual({ proposalId: id, status: "refused", reason: "not-granted" });
  await expect(dispatchToolCall("forget", { id: "out_memory/x" }, { ...ctx, grant })).rejects.toThrow(/not granted/);
});

test("forget with a proposal id answers in the proposal shape with its own fields, and a redelivery is already-applied", async () => {
  const { call } = await edge({ "out_memory/a.md": "---\ntitle: A\ntype: note\n---\na\n" });
  const id = ulid();
  expect(await call("forget", { id: "out_memory/a", proposalId: id })).toEqual({ proposalId: id, status: "applied", id: "out_memory/a", forgotten: true });
  expect(await call("forget", { id: "out_memory/a", proposalId: id })).toEqual({ proposalId: id, status: "already-applied" });
});

// PLAN-0.5.0 item 35 (ADR-0010 §Revision "The edge apply"; record 24 §6 steps 5 and 10): the taste
// star's writer rules, as the edge writer configures FunesStore — `memoryDir: items`, the page-id rule
// on, and a create stamped untrusted unless the caller is the outbox.
async function taste(createTrust: "untrusted" | "zone" = "untrusted", pages: Record<string, string> = {}) {
  const e = await edge(pages);
  mkdirSync(join(e.vault, "items"), { recursive: true });
  const funes = folderFunesStore(e.ctx.store as LibsqlStore, { root: e.vault, memoryDir: "items", itemPages: true, createTrust, receipts: e.receipts });
  const ctx: OperationContext = { ...e.ctx, funes };
  let n = 0;
  // put_page requires a proposal id at the edge; the answers below drop it to compare the rest
  const call = (name: string, args: Record<string, unknown>) =>
    (dispatchToolCall(name, name === "put_page" ? { ...args, proposalId: ulid(Date.now(), String(n++).padStart(16, "0")) } : args, ctx) as Promise<Record<string, unknown>>)
      .then(({ proposalId: _, ...r }) => r);
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
  // supersede and remember are home and org ops (ADR-0020): the writer rule is FunesStore's, at any tier
  const { ctx } = await taste("untrusted", { "items/movies/heat.md": ITEM });
  const home = (name: string, args: Record<string, unknown>) => dispatchToolCall(name, args, { ...ctx, tier: "home" }) as Promise<{ id: string }>;
  await expect(home("supersede", { oldId: "items/movies/heat", title: "Heat", body: "b" })).rejects.toMatchObject({ code: "invalid" });
  const note = await home("remember", { title: "n", body: "a note" });
  expect((await home("supersede", { oldId: note.id, title: "n2", body: "a later note" })).id).toBeString();
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

test("a host with no receipts port takes no proposal: put_page refuses invalid and writes nothing (RAI-313 Q12)", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-proposal-"));
  dirs.push(vault);
  const store = await LibsqlStore.create(new FakeEmbedder());
  stores.push(store);
  const ctx: OperationContext = { ...folderContext({ vault, store }), folder: undefined, tier: "edge" };
  const id = ulid();
  expect(await dispatchToolCall("put_page", { path: "out_memory/heat.md", content: PAGE, proposalId: id }, ctx)).toEqual({ proposalId: id, status: "refused", reason: "invalid" });
  expect(existsSync(join(vault, "out_memory/heat.md"))).toBe(false);
});
