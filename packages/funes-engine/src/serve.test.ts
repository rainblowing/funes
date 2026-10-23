// B5 (RAI-338; RAI-305, RAI-310; ADR-0021): `funes serve`, the one HTTP host. Its host checks and
// the off-loopback precondition refuse at startup, before a socket opens; on loopback it serves
// `mcpHandler` over the star's live index or, with --published, over published.db, and it reopens
// that file when a publish swaps it.
import { test, expect, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { GENERATION_VERSION } from "funes-core/internal";
import { LibsqlStore } from "./libsql/store.ts";
import { startServe, type RunningServe } from "./serve.ts";
import { scopeHash } from "funes-core";

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

const tmp: string[] = [];
const served: RunningServe[] = [];
afterAll(async () => {
  for (const s of served) await s.close();
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});
const dir = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d; };
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const TOK_CURATOR = "tok-curator";
const TOK_READER = "tok-reader";

/** A star with one page, and a v2 access file: a curator (every home op) and a reader (recall). */
function star(yaml = "meta:\n  id: rainblow.ing/serve-test\n"): { vault: string; access: string } {
  const vault = dir("funes-serve-vault-");
  mkdirSync(join(vault, "wiki"), { recursive: true });
  writeFileSync(join(vault, "wiki", "alpha.md"), "---\ntitle: Alpha\n---\nalpha sourdough loaf body\n");
  writeFileSync(join(vault, "star.yaml"), yaml);
  const access = join(vault, ".access.json");
  writeFileSync(access, JSON.stringify({
    version: 2,
    roles: { curator: { ops: ["recall", "health", "remember", "forget", "supersede", "page"] }, reader: { ops: ["recall", "health"] } },
    actors: {
      curator: { token_sha256: sha(TOK_CURATOR), role: "curator", stars: ["*"] },
      reader: { token_sha256: sha(TOK_READER), role: "reader", stars: ["*"] },
    },
  }));
  chmodSync(access, 0o600);
  return { vault, access };
}

async function liveStore(): Promise<LibsqlStore> {
  const store = await LibsqlStore.create(new FakeEmbedder());
  await store.remember([{ id: "wiki/alpha", path: "wiki/alpha.md", title: "Alpha", body: "alpha sourdough loaf body", trust: "trusted" }]);
  await store.finalizeReindex({ contentGeneration: `${GENERATION_VERSION}:` + "a".repeat(64), scope: { hash: scopeHash([]), ignoreScope: false } });
  return store;
}

/** Run `fn` with FUNES_LOCUS set, then put the old value back. */
async function withLocus<T>(locus: string, fn: () => Promise<T>): Promise<T> {
  const was = process.env.FUNES_LOCUS;
  process.env.FUNES_LOCUS = locus;
  try { return await fn(); } finally { if (was === undefined) delete process.env.FUNES_LOCUS; else process.env.FUNES_LOCUS = was; }
}

// ── startup: the host checks and the off-loopback precondition (ADR-0021, 4 checks, C13) ──────────
test("serve refuses a bind that is not an IP literal, and every wildcard", async () => {
  const { vault } = star();
  const store = await liveStore();
  for (const [bind, why] of [["", /--bind/], ["localhost", /not an IP literal/], ["0.0.0.0", /wildcard/], ["::", /wildcard/]] as const) {
    await expect(startServe({ vault, bind, port: 0, store }), bind).rejects.toThrow(why);
  }
  await store.close();
});

test("serve off loopback refuses to start until all four hold: an access file, an exact --host, the star's write_locus, a Tailscale bind", async () => {
  const declared = star("meta:\n  id: rainblow.ing/serve-test\n  write_locus: host-a\n");
  const undeclared = star();
  const store = await liveStore();
  const tail = "100.101.102.103";
  const host = "host-a.example.ts.net:8787";
  await withLocus("host-a", async () => {
    await expect(startServe({ vault: declared.vault, bind: tail, port: 0, host, store })).rejects.toThrow(/access file/);
    await expect(startServe({ vault: declared.vault, bind: tail, port: 0, access: declared.access, store })).rejects.toThrow(/--host/);
    await expect(startServe({ vault: undeclared.vault, bind: tail, port: 0, host, access: undeclared.access, store })).rejects.toThrow(/declares no write_locus/);
    await expect(startServe({ vault: declared.vault, bind: "192.168.1.5", port: 0, host, access: declared.access, store })).rejects.toThrow(/not a Tailscale address/);
  });
  await withLocus("host-b", async () => {
    await expect(startServe({ vault: declared.vault, bind: tail, port: 0, host, access: declared.access, store })).rejects.toThrow(/"host-b" is not the star's write_locus "host-a"/);
  });
  await store.close();
});

// ── on loopback: the handler over the live index ─────────────────────────────────────────────────
/** One JSON-RPC POST to /mcp; `headers` win, so a test can send any Host, Origin or token. */
async function rpc(s: RunningServe, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const r = await fetch(`${s.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}), ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method,
      params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "serve-test", version: "0" } } },
    }),
  });
  const text = await r.text();
  const body = text.startsWith("event:") ? JSON.parse(text.split("\n").find((l) => l.startsWith("data: "))!.slice(6)) : JSON.parse(text);
  return { status: r.status, headers: r.headers, body };
}
const toolNames = (b: { result?: { tools?: Array<{ name: string }> } }) => (b.result?.tools ?? []).map((t) => t.name).sort();
const toolText = (b: { result?: { content?: Array<{ text: string }> } }) => b.result?.content?.[0]?.text ?? "";
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

test("RAI-310 probe 4: loopback with no access file serves tokenless reads only; a write is 401; a presented token is 401", async () => {
  const { vault } = star();
  const s = await startServe({ vault, bind: "127.0.0.1", port: 0, store: await liveStore() });
  served.push(s);
  const list = await rpc(s, "tools/list");
  expect(list.status).toBe(200);
  expect(toolNames(list.body)).toEqual(["graph", "health", "hotlist", "indexed_page", "neighbors", "page", "recall", "tree"]);
  const write = await rpc(s, "tools/call", { name: "remember", arguments: { title: "T", body: "B" } });
  expect(write.body.result?.isError, JSON.stringify(write.body)).toBe(true);
  expect(JSON.parse(toolText(write.body))).toMatchObject({ status: 401, code: "unauthorized" });
  const read = await rpc(s, "tools/call", { name: "recall", arguments: { query: "sourdough" } });
  expect(toolText(read.body)).toContain("wiki/alpha");
  const token = await rpc(s, "tools/list", {}, bearer(TOK_CURATOR));
  expect(token.status).toBe(401);
  expect(token.headers.get("www-authenticate")).toBe("Bearer");
});

test("with --access every request presents Bearer: the role cuts the ceiling, the file is re-read per request, and a bad file refuses everyone", async () => {
  const { vault, access } = star();
  const s = await startServe({ vault, bind: "127.0.0.1", port: 0, access, store: await liveStore() });
  served.push(s);
  expect((await rpc(s, "tools/list")).status).toBe(401); // reads included
  expect(toolNames((await rpc(s, "tools/list", {}, bearer(TOK_CURATOR))).body)).toEqual(["forget", "health", "page", "recall", "remember", "supersede"]);
  expect(toolNames((await rpc(s, "tools/list", {}, bearer(TOK_READER))).body)).toEqual(["health", "recall"]);
  const written = await rpc(s, "tools/call", { name: "remember", arguments: { title: "Served", body: "a served memory" } }, bearer(TOK_CURATOR));
  expect(JSON.parse(toolText(written.body)).trust).toBe("untrusted");
  const refused = await rpc(s, "tools/call", { name: "remember", arguments: { title: "T", body: "B" } }, bearer(TOK_READER));
  expect(JSON.parse(toolText(refused.body))).toMatchObject({ status: 403, code: "not-granted" });
  // revoke the reader: its next request is 401, with no restart
  const policy = JSON.parse(await Bun.file(access).text());
  delete policy.actors.reader;
  writeFileSync(access, JSON.stringify(policy));
  expect((await rpc(s, "tools/list", {}, bearer(TOK_READER))).status).toBe(401);
  writeFileSync(access, "{ not json");
  const broken = await rpc(s, "tools/list", {}, bearer(TOK_CURATOR));
  expect(broken.status).toBe(401);
  expect(broken.body.message).toContain("does not validate");
});

test("the Host is exact, a browser origin is refused, and only /mcp is served", async () => {
  const { vault } = star();
  const s = await startServe({ vault, bind: "127.0.0.1", port: 0, store: await liveStore() });
  served.push(s);
  expect((await rpc(s, "tools/list", {}, { host: "rebound.example:80" })).status).toBe(421);
  expect((await rpc(s, "tools/list", {}, { origin: "https://evil.example" })).status).toBe(403);
  const other = await fetch(`${s.url}/health`);
  expect(other.status).toBe(404);
  expect([...other.headers.keys()].filter((h) => h.startsWith("access-control-"))).toEqual([]);
});

test("--ops narrows the ceiling (C14): only the named reads are listed or served; a mutation in --ops refuses startup", async () => {
  const { vault } = star();
  const store = await liveStore();
  await expect(startServe({ vault, bind: "127.0.0.1", port: 0, ops: ["recall", "remember"], store })).rejects.toThrow(/not read-only/);
  const s = await startServe({ vault, bind: "127.0.0.1", port: 0, ops: ["recall", "health"], store });
  served.push(s);
  expect(toolNames((await rpc(s, "tools/list")).body)).toEqual(["health", "recall"]);
  expect(toolText((await rpc(s, "tools/call", { name: "page", arguments: { id: "wiki/alpha" } })).body)).toContain("unknown operation: page");
});

test("the tier comes from memory.tier: an unknown tier refuses, and an org star refuses a folder index", async () => {
  const store = await liveStore();
  await expect(startServe({ vault: star("meta:\n  id: rainblow.ing/e\nmemory:\n  tier: edge\n").vault, bind: "127.0.0.1", port: 0, store }))
    .rejects.toThrow(/memory.tier must be "home" or "org"/);
  await expect(startServe({ vault: star("meta:\n  id: rainblow.ing/o\n  write_locus: host-a\nmemory:\n  tier: org\n  substrate: turso\n").vault, bind: "127.0.0.1", port: 0, store }))
    .rejects.toThrow(/memory.tier: org.*never a folder index/);
  await store.close();
});

// B8b (RAI-344; RAI-312, RAI-314; ADR-0021): a home star on `memory.substrate: turso` opens under its
// own `funes serve`, over the Turso adapter; `funes reindex` builds it while no serve holds it.
test("a home Turso star: reindex builds it on Turso, and its funes serve opens it and serves recall", async () => {
  const { reindex } = await import("./reindex.ts");
  const was = process.env.FUNES_HOME;
  process.env.FUNES_HOME = dir("funes-serve-turso-home-");
  try {
    const { vault, access } = star("meta:\n  id: rainblow.ing/turso-home\nmemory:\n  substrate: turso\n");
    const built = await reindex(vault, { embedder: new FakeEmbedder() });
    expect(built.files).toBe(1);
    expect((await reindex(vault, { embedder: new FakeEmbedder(), fresh: true })).files).toBe(1); // --fresh rebuilds it in place, on Turso
    await expect(startServe({ vault, bind: "127.0.0.1", port: 0, published: true, embedder: new FakeEmbedder() })).rejects.toThrow(/Turso.*published/);
    const s = await startServe({ vault, bind: "127.0.0.1", port: 0, access, embedder: new FakeEmbedder() });
    served.push(s);
    expect(toolText((await rpc(s, "tools/call", { name: "recall", arguments: { query: "sourdough" } }, bearer(TOK_READER))).body)).toContain("wiki/alpha");
    const health = JSON.parse(toolText((await rpc(s, "tools/call", { name: "health", arguments: {} }, bearer(TOK_READER))).body));
    expect(health.servingSignature).toStartWith("turso:");
    expect(health.contentGeneration).not.toBeNull();
    // a write through the server lands in the Turso index
    const w = await rpc(s, "tools/call", { name: "remember", arguments: { title: "Rye", body: "rye crumb starter" } }, bearer(TOK_CURATOR));
    expect(w.body.result?.isError).not.toBe(true);
    expect(toolText((await rpc(s, "tools/call", { name: "recall", arguments: { query: "rye crumb" } }, bearer(TOK_READER))).body)).toContain("Rye");
  } finally {
    if (was === undefined) delete process.env.FUNES_HOME; else process.env.FUNES_HOME = was;
  }
}, 30_000);

// ── published mode (ADR-0018, ADR-0021) ───────────────────────────────────────────────────────────
test("--published serves published.db read-only and survives a swap: a publish lands without a restart", async () => {
  const { E5Embedder, E5_DIM } = await import("./embedder.ts");
  const { publishReindex } = await import("./publication.ts");
  const { publishedPathOf } = await import("./published-store.ts");
  /** E5's identity (the signature the published build pins) with deterministic vectors: no model. */
  class SpoofedE5 extends E5Embedder {
    private fakeVec(t: string): Float32Array {
      const v = new Float32Array(E5_DIM);
      for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) v[[...w].reduce((a, c) => a + c.charCodeAt(0), 0) % E5_DIM]! += 1;
      return v;
    }
    override async embedQuery(t: string) { return this.fakeVec(t); }
    override async embedPassage(t: string) { return this.fakeVec(t); }
    override async embedPassages(ts: string[]) { return ts.map((t) => this.fakeVec(t)); }
  }
  const was = process.env.FUNES_HOME;
  process.env.FUNES_HOME = dir("funes-serve-home-");
  try {
    const vault = dir("funes-serve-pub-");
    writeFileSync(join(vault, "alpha.md"), "---\ntitle: Alpha\n---\nalpha sourdough loaf body\n");
    const home = join(publishedPathOf(vault), "..");
    mkdirSync(home, { recursive: true });
    await expect(startServe({ vault, bind: "127.0.0.1", port: 0, published: true, embedder: new SpoofedE5() })).rejects.toThrow(/nothing is published/);
    await publishReindex({ vault, home, embedder: new SpoofedE5() });
    const s = await startServe({ vault, bind: "127.0.0.1", port: 0, published: true, embedder: new SpoofedE5() });
    served.push(s);
    expect(toolNames((await rpc(s, "tools/list")).body)).toEqual(["graph", "health", "hotlist", "indexed_page", "neighbors", "page", "recall", "tree"]);
    expect(toolText((await rpc(s, "tools/call", { name: "recall", arguments: { query: "sourdough" } })).body)).toContain("alpha");
    writeFileSync(join(vault, "beta.md"), "---\ntitle: Beta\n---\nbeta rye crumb body\n");
    await publishReindex({ vault, home, embedder: new SpoofedE5() });
    expect(toolText((await rpc(s, "tools/call", { name: "recall", arguments: { query: "rye crumb" } })).body)).toContain("beta");
  } finally {
    if (was === undefined) delete process.env.FUNES_HOME; else process.env.FUNES_HOME = was;
  }
}, 30_000);

// ── the verb: retired flags refuse with their replacement (RAI-310 D1) ───────────────────────────
test("funes serve refuses a retired flag at startup, exit 2, naming its replacement", async () => {
  const { vault } = star();
  const cli = join(import.meta.dir, "cli.ts");
  for (const [args, says] of [
    [["--readonly"], "--ops"],
    [["--capability", "/cap"], "--access"],
    [["--actor-map", "/x.json"], "--access"],
    [["--actor", "a"], "the grant names the actor"],
    [["--db", "/x"], "--published"],
    [["--face", "broker"], "one server, one star"],
    [["--bind-allow", "127.0.0.1"], "replace the allowlist"],
    [["--locus", "host-a"], "FUNES_LOCUS"],
  ] as const) {
    const proc = Bun.spawn(["bun", cli, "serve", "--vault", vault, "--bind", "127.0.0.1", "--port", "0", ...args], { env: { ...process.env, FUNES_HOME: vault }, stdout: "pipe", stderr: "pipe" });
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited, args[0]).toBe(2);
    expect(err).toContain(`${args[0]} was removed in funes 0.6.0`);
    expect(err).toContain(says);
  }
}, 60_000);
