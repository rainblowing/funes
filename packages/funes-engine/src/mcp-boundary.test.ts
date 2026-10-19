import { test, expect, spyOn } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Embedder } from "funes-core";
import { GENERATION_VERSION } from "funes-shared";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";
import { scopeHash } from "./scope.ts";
import { startDaemon } from "./daemon.ts";
import { FUNES_VERSION } from "./version.ts";

// ── the MCP boundary itself, exercised over real stdio ────────────────────────────────────
// mcp.ts's `--readonly` filter is what a cross-star (sibling) recall connection relies on: a
// query-only wiring that can NEVER write into the other star's vault. ops.test.ts pins the op
// SUBSET is read-only; these tests pin the SERVER: spawn mcp.ts and speak real JSON-RPC 2.0 over
// stdin/stdout, asserting mutations are absent from tools/list AND refused on tools/call WITHOUT
// reaching the store (direct) or the daemon (proxy). FUNES_BACKEND=libsql keeps the spawned
// process light (no PGLite; the E5 model is lazy — tools/list and a refused mutation never embed).

const MCP = join(import.meta.dir, "mcp.ts");
const REPO = resolve(import.meta.dir, "..", "..", "..");
/** The protocol revision funes serves. Pinned here so a spec bump is a deliberate one-line edit. */
const MODERN_REVISION = "2026-07-28";

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

/** A minimal MCP stdio client: newline-delimited JSON-RPC over the spawned process's stdin/stdout
 *  (the @modelcontextprotocol StdioServerTransport framing). Matches responses by id; stderr (the
 *  server's startup banner) is ignored. */
class McpClient {
  private buf = "";
  private pending = new Map<number, (m: Record<string, unknown>) => void>();
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private dec = new TextDecoder();
  constructor(private proc: ReturnType<typeof Bun.spawn>) {
    this.reader = (proc.stdout as ReadableStream<Uint8Array>).getReader() as unknown as ReadableStreamDefaultReader<Uint8Array>;
    void this.pump();
  }
  private async pump() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.buf += this.dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (!line) continue;
          let msg: Record<string, unknown>;
          try { msg = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
          const id = msg.id as number | undefined;
          if (id != null && this.pending.has(id)) { this.pending.get(id)!(msg); this.pending.delete(id); }
        }
      }
    } catch { /* stream closed on kill */ }
  }
  private send(obj: Record<string, unknown>) {
    const sink = this.proc.stdin as { write(s: string): void; flush?(): void };
    sink.write(JSON.stringify(obj) + "\n");
    sink.flush?.();
  }
  async request(id: number, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const p = new Promise<Record<string, unknown>>((res, rej) => {
      this.pending.set(id, res);
      // Generous: a spawned `bun mcp.ts` cold start (PGLite WASM + MCP SDK) under full-suite
      // parallel CPU contention can be slow; the per-test timeout is the real backstop.
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`mcp request ${method} timed out`)); }, 25_000);
    });
    this.send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    return p;
  }
  notify(method: string, params?: Record<string, unknown>) { this.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }); }
  /** initialize handshake — the 2025-era opening. Still served on SDK v2 (`serveStdio`'s default
   *  `legacy: 'serve'`), which is why every test below this line needed no change when funes moved
   *  to protocol revision 2026-07-28. */
  async initialize() {
    await this.request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "boundary-test", version: "0" },
    });
    this.notify("notifications/initialized");
  }
  /** A 2026-07-28 request: NO handshake at all — the protocol version and the client's capabilities
   *  ride in a per-request `_meta` envelope. A connection pins to the era of its first accepted
   *  message, so a client uses this OR `initialize()`, never both. */
  async modern(id: number, method: string, params: Record<string, unknown> = {}) {
    return this.request(id, method, {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN_REVISION,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "boundary-test", version: "0" },
      },
    });
  }
  async close() {
    try { await this.reader.cancel(); } catch { /* already closed */ }
    this.proc.kill();
    await this.proc.exited;
  }
}

function spawnMcp(args: string[], env: Record<string, string>) {
  return Bun.spawn(["bun", MCP, ...args], {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

const WRITES = ["remember", "supersede", "forget"];

/** Drain a spawned process stream to a string (used for the startup-failure stderr check). */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const dec = new TextDecoder();
  const reader = stream.getReader() as unknown as ReadableStreamDefaultReader<Uint8Array>;
  let out = "";
  for (;;) { const { value, done } = await reader.read(); if (done) break; out += dec.decode(value, { stream: true }); }
  return out;
}

test("mcp --readonly (real spawned stdio): tools/list drops every mutation; a mutation tools/call is refused before the store", async () => {
  const libsqlBase = mkdtempSync(join(tmpdir(), "funes-mcpbound-idx-"));
  const vault = mkdtempSync(join(tmpdir(), "funes-mcpbound-vault-"));
  const proc = spawnMcp(["--vault", vault, "--readonly"], {
    FUNES_BACKEND: "libsql",
    FUNES_LIBSQL_DIR: libsqlBase,
    FUNES_DAEMON_PORT: "1", // nothing listens on :1 -> direct store, never a stray real daemon
  });
  const client = new McpClient(proc);
  try {
    await client.initialize();

    const list = (await client.request(2, "tools/list")) as { result?: { tools: Array<{ name: string }> } };
    const names = (list.result?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(["graph", "health", "hotlist", "indexed_page", "neighbors", "page", "recall", "recall_v2", "tree", "vault_page"]);
    for (const w of WRITES) expect(names).not.toContain(w);

    // a mutation is refused on tools/call — and the message proves the mcp.ts guard fired, i.e. the
    // call never reached dispatch/the store (a real dispatch would say "unknown operation").
    const call = (await client.request(3, "tools/call", {
      name: "remember",
      arguments: { title: "should not land", body: "x" },
    })) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    expect(call.result?.isError).toBe(true);
    expect(call.result?.content?.[0]?.text ?? "").toContain("refused on a --readonly funes server");
  } finally {
    await client.close();
    rmSync(libsqlBase, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
}, 45_000);

test("mcp --readonly over the daemon PROXY: the mutation guard runs before daemon.call — nothing reaches the daemon store", async () => {
  // A daemon owns the vault's store; mcp.ts detects it and PROXIES. The daemon exposes the FULL
  // registry (remember included), so if the --readonly guard did NOT run on the proxy path, the
  // mutation would proxy through and write. We prove it is refused AND the daemon store is untouched.
  const vault = mkdtempSync(join(tmpdir(), "funes-mcpproxy-vault-"));
  // Isolated like every other spawn in this file, even though a proxied server opens no store of
  // its own: when the probe misses the in-process daemon (a cold start under full-suite CPU
  // contention is enough), mcp.ts falls back to a DIRECT open, and that open lands at
  // `$FUNES_LIBSQL_DIR/<vault basename>/`. Without this line that base was the real
  // ~/.twinkling/libsql — two orphaned `funes-mcpproxy-vault-*` homes there are the evidence.
  const libsqlBase = mkdtempSync(join(tmpdir(), "funes-mcpproxy-idx-"));
  const store = await LibsqlStore.create(new FakeEmbedder()); // in-memory, owned by the in-process daemon
  const server = startDaemon({ vault, store, port: 0 });
  const proc = spawnMcp(["--vault", vault, "--readonly"], {
    FUNES_BACKEND: "libsql",
    FUNES_LIBSQL_DIR: libsqlBase,
    FUNES_DAEMON_PORT: String(server.port),
  });
  const client = new McpClient(proc);
  try {
    await client.initialize();
    const call = (await client.request(2, "tools/call", {
      name: "remember",
      arguments: { title: "should not land", body: "x" },
    })) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    expect(call.result?.isError).toBe(true);
    expect(call.result?.content?.[0]?.text ?? "").toContain("refused on a --readonly funes server");
    // the guard ran before daemon.call — the daemon's store never saw a write
    expect((await store.stats()).nodes).toBe(0);
  } finally {
    await client.close();
    server.stop(true);
    await store.close();
    rmSync(vault, { recursive: true, force: true });
    rmSync(libsqlBase, { recursive: true, force: true });
  }
}, 45_000);

// ── 0.3.0 item 24 over the PROXY (RAI-148) ────────────────────────────────────────────────────
// A proxied write carries the DAEMON's own actor: the stdio process's `--actor` applies only when
// it opens the store directly, and tool arguments never carry one (actor.test.ts). Both halves of
// "the audit log and the stamped row agree" are asserted — the row through the daemon's store, the
// audit line through the daemon's stderr, which is THIS process's because the daemon is in-process.
test("item 24 (PROXY): a proxied remember stamps the daemon's actor, never the stdio --actor, and the audit line names it", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-mcpproxy-vault-"));
  const store = await LibsqlStore.create(new FakeEmbedder(), undefined, { writeActor: "daemon:ops" });
  const server = startDaemon({ vault, store, port: 0, actor: "daemon:ops" });
  const proc = spawnMcp(["--vault", vault, "--actor", "stdio:intruder"], {
    FUNES_BACKEND: "libsql",
    FUNES_DAEMON_PORT: String(server.port),
  });
  const client = new McpClient(proc);
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await client.initialize();
    const call = (await client.request(2, "tools/call", {
      name: "remember",
      arguments: { title: "Proxied", body: "written through the daemon" },
    })) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    expect(call.result?.isError).toBeFalsy();
    const { id } = JSON.parse(call.result?.content?.[0]?.text ?? "{}") as { id: string };
    expect((await store.indexedPage({ id }))!.writeActor).toBe("daemon:ops");
    const written = stderr.mock.calls.map((c) => String(c[0]));
    const audit = written.find((l) => l.includes("write-designation"));
    expect(audit).toContain("op=remember");
    expect(audit).toContain("actor=daemon:ops");
    expect(written.join("")).not.toContain("stdio:intruder"); // the proxy's actor reaches nothing
  } finally {
    stderr.mockRestore();
    await client.close();
    server.stop(true);
    await store.close();
    rmSync(vault, { recursive: true, force: true });
  }
}, 45_000);

test("mcp --actor with an unusable name refuses to START (item 24: resolved at startup, fail-closed, before the daemon probe)", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-mcp-actor-bad-"));
  const proc = spawnMcp(["--vault", vault, "--actor", "bad name"], {
    FUNES_BACKEND: "libsql",
    FUNES_LIBSQL_DIR: vault,
    FUNES_DAEMON_PORT: "1",
  });
  try {
    const err = await drain(proc.stderr as ReadableStream<Uint8Array>);
    const code = await proc.exited;
    expect(code).not.toBe(0); // exited before connecting stdio
    expect(err).toContain("not a usable actor name");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}, 45_000);

test("mcp --ops allowlist (real spawned stdio): tools/list equals the allowlist; an allowlisted call works; an off-list read is refused", async () => {
  const libsqlBase = mkdtempSync(join(tmpdir(), "funes-mcpops-idx-"));
  const vault = mkdtempSync(join(tmpdir(), "funes-mcpops-vault-"));
  const proc = spawnMcp(["--vault", vault, "--ops", "recall,health"], {
    FUNES_BACKEND: "libsql",
    FUNES_LIBSQL_DIR: libsqlBase,
    FUNES_DAEMON_PORT: "1",
  });
  const client = new McpClient(proc);
  try {
    await client.initialize();

    const list = (await client.request(2, "tools/list")) as { result?: { tools: Array<{ name: string }> } };
    expect((list.result?.tools ?? []).map((t) => t.name)).toEqual(["recall", "health"]); // EXACTLY the allowlist, in order

    // an allowlisted op works (health needs no embedding — the empty index answers immediately)
    const health = (await client.request(3, "tools/call", { name: "health", arguments: {} })) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    expect(health.result?.isError).toBeFalsy();
    expect(JSON.parse(health.result?.content?.[0]?.text ?? "{}").nodes).toBe(0);

    // a read that is NOT on the allowlist (page reads the vault filesystem) is refused on tools/call
    const page = (await client.request(4, "tools/call", { name: "page", arguments: { path: "anything.md" } })) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    expect(page.result?.isError).toBe(true);
    expect(page.result?.content?.[0]?.text ?? "").toContain("--ops allowlist");
  } finally {
    await client.close();
    rmSync(libsqlBase, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
}, 45_000);

test("mcp --ops with a mutation in the list refuses to START (fail-closed: non-zero exit, nothing served)", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-mcpops-bad-"));
  const proc = spawnMcp(["--vault", vault, "--ops", "recall,remember"], {
    FUNES_BACKEND: "libsql",
    FUNES_LIBSQL_DIR: vault,
    FUNES_DAEMON_PORT: "1",
  });
  try {
    const err = await drain(proc.stderr as ReadableStream<Uint8Array>);
    const code = await proc.exited;
    expect(code).not.toBe(0); // exited before connecting stdio
    expect(err).toContain("not read-only");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}, 45_000);

test("mcp --cross-star bans fs-served ops at startup: --ops recall,page --cross-star exits non-zero, nothing served", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-crossstar-fsban-"));
  const proc = spawnMcp(["--vault", vault, "--ops", "recall,page", "--cross-star"], {
    FUNES_BACKEND: "libsql",
    FUNES_LIBSQL_DIR: vault,
    FUNES_DAEMON_PORT: "1",
  });
  try {
    const err = await drain(proc.stderr as ReadableStream<Uint8Array>);
    const code = await proc.exited;
    expect(code).not.toBe(0); // exited before connecting stdio
    expect(err).toContain("reads the vault filesystem"); // page (served: fs) refused on a cross-star surface
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}, 45_000);

test("mcp --cross-star without --ops refuses to START (the cross-star surface is an explicit allowlist)", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-crossstar-noops-"));
  const proc = spawnMcp(["--vault", vault, "--cross-star"], {
    FUNES_BACKEND: "libsql",
    FUNES_LIBSQL_DIR: vault,
    FUNES_DAEMON_PORT: "1",
  });
  try {
    const err = await drain(proc.stderr as ReadableStream<Uint8Array>);
    const code = await proc.exited;
    expect(code).not.toBe(0);
    expect(err).toContain("--cross-star requires --ops");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}, 45_000);

test("mcp --ops WITHOUT --cross-star (own-star): an fs op like page IS admitted, and no scope guard fires", async () => {
  // Personal's own-brain runtime legitimately uses `page` (no boundary crossed). Without --cross-star
  // the fs-ban + scope guard do not apply — tools/list carries page, and a health call serves even
  // though the vault has no star.yaml (which WOULD refuse a cross-star surface).
  const libsqlBase = mkdtempSync(join(tmpdir(), "funes-ownstar-idx-"));
  const vault = mkdtempSync(join(tmpdir(), "funes-ownstar-vault-"));
  const proc = spawnMcp(["--vault", vault, "--ops", "recall,page,health"], {
    FUNES_BACKEND: "libsql",
    FUNES_LIBSQL_DIR: libsqlBase,
    FUNES_DAEMON_PORT: "1",
  });
  const client = new McpClient(proc);
  try {
    await client.initialize();
    const list = (await client.request(2, "tools/list")) as { result?: { tools: Array<{ name: string }> } };
    expect((list.result?.tools ?? []).map((t) => t.name)).toEqual(["recall", "page", "health"]); // page admitted
    const health = (await client.request(3, "tools/call", { name: "health", arguments: {} })) as { result?: { isError?: boolean } };
    expect(health.result?.isError).toBeFalsy(); // no scope guard on an own-star --ops surface
  } finally {
    await client.close();
    rmSync(libsqlBase, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
}, 45_000);

// ── protocol revision 2026-07-28 (the stateless core) ─────────────────────────────────────
// funes served 2025-11-25 until this migration. The tests above pin that the LEGACY opening still
// works; these pin the modern one. Both matter: dropping either is a breaking change for somebody.

test("2026-07-28: tools/list with NO handshake — the protocol version rides in the per-request _meta envelope", async () => {
  const libsqlBase = mkdtempSync(join(tmpdir(), "funes-modern-idx-"));
  const vault = mkdtempSync(join(tmpdir(), "funes-modern-vault-"));
  const proc = spawnMcp(["--vault", vault, "--ops", "recall,health"], {
    FUNES_BACKEND: "libsql", FUNES_LIBSQL_DIR: libsqlBase, FUNES_DAEMON_PORT: "1",
  });
  const client = new McpClient(proc);
  try {
    // No initialize(), no notifications/initialized — under 2026-07-28 there is no handshake at all.
    const list = (await client.modern(2, "tools/list")) as { result?: { tools: Array<{ name: string }> } };
    expect((list.result?.tools ?? []).map((t) => t.name)).toEqual(["recall", "health"]);

    // and the --ops allowlist refusal still fires on the modern era, with the funes wording
    const page = (await client.modern(3, "tools/call", { name: "page", arguments: { path: "x.md" } })) as
      { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    expect(page.result?.isError).toBe(true);
    expect(page.result?.content?.[0]?.text ?? "").toContain("--ops allowlist");
  } finally {
    await client.close();
    rmSync(libsqlBase, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
}, 45_000);

test("2026-07-28: server/discover answers in ONE request with the supported revisions (it returned -32601 on SDK v1)", async () => {
  const libsqlBase = mkdtempSync(join(tmpdir(), "funes-disc-idx-"));
  const vault = mkdtempSync(join(tmpdir(), "funes-disc-vault-"));
  const proc = spawnMcp(["--vault", vault, "--ops", "recall,health"], {
    FUNES_BACKEND: "libsql", FUNES_LIBSQL_DIR: libsqlBase, FUNES_DAEMON_PORT: "1",
  });
  const client = new McpClient(proc);
  try {
    const d = (await client.modern(2, "server/discover")) as {
      error?: { code: number }; result?: { supportedVersions?: string[]; capabilities?: Record<string, unknown> };
    };
    expect(d.error).toBeUndefined();                                  // -32601 was the v1 behaviour
    expect(d.result?.supportedVersions ?? []).toContain(MODERN_REVISION);
    expect(d.result?.capabilities).toHaveProperty("tools");           // funes declares tools and nothing else
  } finally {
    await client.close();
    rmSync(libsqlBase, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
}, 45_000);

// PLAN-0.4.0 item 10: the per-star stdio server resolves its locus once at startup (--locus over
// FUNES_LOCUS, normalized) and carries that one value on its direct-store context — the value
// `health` reports. The environment says something else on purpose.
test("the stdio server's health names the locus it resolved: --locus over FUNES_LOCUS, normalized", async () => {
  const libsqlBase = mkdtempSync(join(tmpdir(), "funes-locus-idx-"));
  const vault = mkdtempSync(join(tmpdir(), "funes-locus-vault-"));
  const proc = spawnMcp(["--vault", vault, "--ops", "recall,health", "--locus", "Host-A"], {
    FUNES_BACKEND: "libsql", FUNES_LIBSQL_DIR: libsqlBase, FUNES_DAEMON_PORT: "1", FUNES_LOCUS: "host-b",
  });
  const client = new McpClient(proc);
  try {
    const h = (await client.modern(2, "tools/call", { name: "health", arguments: {} })) as
      { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    expect(h.result?.isError).toBeFalsy();
    expect((JSON.parse(h.result?.content?.[0]?.text ?? "{}") as { locus?: string | null }).locus).toBe("host-a");
  } finally {
    await client.close();
    rmSync(libsqlBase, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
}, 45_000);

test("the stdio server reports the REAL funes version (the face hardcoded 0.1.0; the two transports must agree)", async () => {
  const libsqlBase = mkdtempSync(join(tmpdir(), "funes-ver-idx-"));
  const vault = mkdtempSync(join(tmpdir(), "funes-ver-vault-"));
  const proc = spawnMcp(["--vault", vault, "--ops", "health"], {
    FUNES_BACKEND: "libsql", FUNES_LIBSQL_DIR: libsqlBase, FUNES_DAEMON_PORT: "1",
  });
  const client = new McpClient(proc);
  try {
    const init = (await client.request(1, "initialize", {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" },
    })) as { result?: { serverInfo?: { name: string; version: string } } };
    expect(init.result?.serverInfo?.name).toBe("funes");
    expect(init.result?.serverInfo?.version).toBe(FUNES_VERSION);
    expect(init.result?.serverInfo?.version).not.toBe("0.1.0");
  } finally {
    await client.close();
    rmSync(libsqlBase, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
}, 45_000);

// ── serve-time index_scope guard (--ops cross-star mode) ──────────────────────────────────
// The index_scope boundary must hold at SERVE time, not just at build: scope can drift after a
// build (star.yaml edited without reindex; an --ignore-scope build). These drive mcp.ts over the
// daemon PROXY path (an in-process FakeEmbedder daemon — so no E5, and a refused recall's guard
// fires before any embed) with a star.yaml + a persisted scope signature we control.

/** An in-process daemon over a FakeEmbedder libsql store for a vault whose star.yaml declares
 *  `excludes`; optionally seed content + stamp a persisted scope signature. mcp.ts proxies to it. */
async function scopeDaemonFixture(opts: { excludes: string[]; persist?: { hash: string; ignoreScope: boolean }; content?: boolean }) {
  const vault = mkdtempSync(join(tmpdir(), "funes-scopeproxy-"));
  writeFileSync(
    join(vault, "star.yaml"),
    `memory:\n  index_scope:\n    exclude:\n${opts.excludes.map((g) => `      - "${g}"`).join("\n")}\n`,
  );
  const store = await LibsqlStore.create(new FakeEmbedder());
  if (opts.content) await store.remember([{ id: "wiki/keep", path: "wiki/keep.md", title: "Keep", body: "kept alpha tokens", trust: "trusted" }]);
  if (opts.persist) await store.setScopeSignature(opts.persist);
  const server = startDaemon({ vault, store, port: 0 });
  return { vault, store, server, cleanup: async () => { server.stop(true); await store.close(); rmSync(vault, { recursive: true, force: true }); } };
}

async function opsRecall(port: number, vault: string, query: string) {
  // --cross-star: these cases exercise the CROSS-STAR expectation specifically (an absent/invalid
  // manifest refuses, and a rebuild in progress refuses), which is stricter than the own-star one
  // that 0.3.0 item 16 now applies everywhere — so they declare the cross-star surface.
  const proc = spawnMcp(["--vault", vault, "--ops", "recall,indexed_page,health", "--cross-star"], { FUNES_BACKEND: "libsql", FUNES_DAEMON_PORT: String(port) });
  const client = new McpClient(proc);
  await client.initialize();
  const recall = (await client.request(2, "tools/call", { name: "recall", arguments: { query } })) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
  const health = (await client.request(3, "tools/call", { name: "health", arguments: {} })) as { result?: { isError?: boolean } };
  await client.close();
  return { recall, health };
}

test("scope guard (--ops): a MISSING scope signature refuses cross-star recall; health still answers", async () => {
  const f = await scopeDaemonFixture({ excludes: ["raw/**"] }); // no persisted signature
  try {
    const { recall, health } = await opsRecall(f.server.port!, f.vault, "anything");
    expect(recall.result?.isError).toBe(true);
    expect(recall.result?.content?.[0]?.text ?? "").toContain("no index_scope signature");
    expect(health.result?.isError).toBeFalsy(); // health is exempt so the operator can diagnose
  } finally { await f.cleanup(); }
}, 45_000);

test("scope guard (0.3.0 item 16): scope DRIFT (hash mismatch) refuses the PLAIN daemon recall as well as the cross-star one", async () => {
  // index stamped for [built/**]; star.yaml now declares [current/**] -> the hashes differ.
  const f = await scopeDaemonFixture({ excludes: ["current/**"], persist: { hash: scopeHash(["built/**"]), ignoreScope: false }, content: true });
  try {
    // INVERTED BY PLAN-0.3.0 item 16, and the inversion is the point of the item. This case used to
    // assert that "a plain daemon recall (NOT scope-guarded) returns results" — i.e. that an
    // operator who narrowed star.yaml and had not yet reindexed went on serving the pages they had
    // just withdrawn, to every local client, forever, with the guard running only for FOREIGN
    // callers. The old assertion documented the hole rather than a property worth keeping.
    const direct = (await (await fetch(`http://127.0.0.1:${f.server.port}/api/recall`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "kept alpha tokens" }),
    })).json()) as { ok: boolean; error?: string; result?: unknown[] };
    expect(direct.ok).toBe(false);
    expect(direct.error ?? "").toContain("scope-hash mismatch");
    // and the cross-star --ops path refuses on the same drift, as it always did
    const { recall } = await opsRecall(f.server.port!, f.vault, "kept alpha tokens");
    expect(recall.result?.isError).toBe(true);
    expect(recall.result?.content?.[0]?.text ?? "").toContain("scope-hash mismatch");
  } finally { await f.cleanup(); }
}, 45_000);

test("scope guard (--ops): an --ignore-scope build refuses cross-star recall even when the hash matches", async () => {
  const f = await scopeDaemonFixture({ excludes: ["raw/**"], persist: { hash: scopeHash(["raw/**"]), ignoreScope: true } });
  try {
    const { recall } = await opsRecall(f.server.port!, f.vault, "x");
    expect(recall.result?.isError).toBe(true);
    expect(recall.result?.content?.[0]?.text ?? "").toContain("--ignore-scope");
  } finally { await f.cleanup(); }
}, 45_000);

test("scope guard (--ops): when the boundary HOLDS (hash matches, not ignored) cross-star recall is served", async () => {
  const f = await scopeDaemonFixture({ excludes: ["raw/**"], persist: { hash: scopeHash(["raw/**"]), ignoreScope: false }, content: true });
  try {
    const { recall } = await opsRecall(f.server.port!, f.vault, "kept alpha tokens");
    expect(recall.result?.isError).toBeFalsy();
    const rows = JSON.parse(recall.result?.content?.[0]?.text ?? "[]") as Array<{ id: string }>;
    expect(rows.some((r) => r.id === "wiki/keep")).toBe(true); // proxied through to the daemon's index
  } finally { await f.cleanup(); }
}, 45_000);

test("H9 barrier (PROXY): a reindex in progress on the daemon store refuses the proxied cross-star recall — the guard reads LIVE server-side state, not a stale startup value", async () => {
  // The guarded op runs server-side (the client can't span two RPCs atomically). Marking the daemon's
  // own store reindexDirty AFTER the process would have computed any startup value proves the guard is
  // re-evaluated per call, on the live index: an in-progress reindex (which may have re-admitted
  // excluded rows, not yet re-stamped) refuses through the proxy, never serving a re-admitted row.
  const f = await scopeDaemonFixture({ excludes: ["raw/**"], persist: { hash: scopeHash(["raw/**"]), ignoreScope: false }, content: true });
  try {
    await f.store.beginReindex(); // reindex in progress on the daemon's store (dirty=1)
    const { recall, health } = await opsRecall(f.server.port!, f.vault, "kept alpha tokens");
    expect(recall.result?.isError).toBe(true);
    expect(recall.result?.content?.[0]?.text ?? "").toContain("reindex is in progress");
    expect(health.result?.isError).toBeFalsy(); // health stays exempt so the operator can diagnose
    await f.store.finalizeReindex({ contentGeneration: `${GENERATION_VERSION}:` + "f".repeat(64) });
  } finally { await f.cleanup(); }
}, 45_000);

// PLAN-0.5.0 item 17 (RAI-218): recall_v2 listed on a --cross-star surface. Only recall and
// indexed_page are translated to guarded_* ops, so recall_v2 used to run under the OWN-STAR
// expectation — direct AND over the proxy — which serves a configless vault and serves through a
// rebuild. Both paths now carry the cross-star context into dispatchToolCall.
async function crossStarRecallV2(env: Record<string, string>, vault: string) {
  const proc = spawnMcp(["--vault", vault, "--ops", "recall_v2,health", "--cross-star"], { FUNES_BACKEND: "libsql", ...env });
  const client = new McpClient(proc);
  try {
    await client.initialize();
    return (await client.request(2, "tools/call", { name: "recall_v2", arguments: { query: "kept alpha tokens" } })) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
  } finally { await client.close(); }
}

test("item 17 (PROXY): recall_v2 on a cross-star surface refuses when the manifest is absent", async () => {
  const f = await scopeDaemonFixture({ excludes: ["raw/**"], persist: { hash: scopeHash(["raw/**"]), ignoreScope: false }, content: true });
  try {
    rmSync(join(f.vault, "star.yaml"));
    const r = await crossStarRecallV2({ FUNES_DAEMON_PORT: String(f.server.port) }, f.vault);
    expect(r.result?.isError).toBe(true);
    expect(r.result?.content?.[0]?.text ?? "").toContain("no star.yaml manifest");
  } finally { await f.cleanup(); }
}, 45_000);

test("item 17 (PROXY): recall_v2 on a cross-star surface refuses during a reindex in progress", async () => {
  const f = await scopeDaemonFixture({ excludes: ["raw/**"], persist: { hash: scopeHash(["raw/**"]), ignoreScope: false }, content: true });
  try {
    await f.store.beginReindex();
    const r = await crossStarRecallV2({ FUNES_DAEMON_PORT: String(f.server.port) }, f.vault);
    expect(r.result?.isError).toBe(true);
    expect(r.result?.content?.[0]?.text ?? "").toContain("reindex is in progress");
    await f.store.finalizeReindex({ contentGeneration: `${GENERATION_VERSION}:` + "f".repeat(64) });
    const served = await crossStarRecallV2({ FUNES_DAEMON_PORT: String(f.server.port) }, f.vault);
    expect(served.result?.isError).toBeFalsy(); // the boundary holds once the rebuild re-stamps
  } finally { await f.cleanup(); }
}, 60_000);

test("item 17 (direct): recall_v2 on a cross-star surface refuses when the manifest is absent", async () => {
  const libsqlBase = mkdtempSync(join(tmpdir(), "funes-xs-v2-idx-"));
  const vault = mkdtempSync(join(tmpdir(), "funes-xs-v2-vault-"));
  try {
    const r = await crossStarRecallV2({ FUNES_LIBSQL_DIR: libsqlBase, FUNES_DAEMON_PORT: "1" }, vault);
    expect(r.result?.isError).toBe(true);
    expect(r.result?.content?.[0]?.text ?? "").toContain("no star.yaml manifest");
  } finally {
    rmSync(libsqlBase, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
}, 45_000);

// Pins EXISTING behaviour: the server answers what it read and then exits when stdin closes, so it
// never leaks a process holding an open index handle. Added after I claimed the opposite — that
// `funes mcp < file` hung — on the strength of a local smoke that slept a fixed 9s and killed the
// child, i.e. never tested the thing it appeared to show. Measured both ways afterwards: 0.14s and
// a complete response either way. The release gate's CI failure was purely the `grep -q` SIGPIPE
// race; the transport was never at fault. This test exists so the property stays true.
test("mcp exits once its client closes stdin, after answering what it read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "funes-mcp-eof-"));
  try {
    const inFile = join(dir, "in.jsonl");
    writeFileSync(inFile, [
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
      "",
    ].join("\n"));
    const p = Bun.spawn(["bun", MCP, "--vault", dir], {
      stdin: Bun.file(inFile), stdout: "pipe", stderr: "ignore",
      env: { ...process.env, FUNES_LIBSQL_DIR: join(dir, "idx") },
    });
    // If the fix regresses this never settles, so bound it rather than hanging the suite.
    const exited = await Promise.race([p.exited, Bun.sleep(15_000).then(() => "timeout" as const)]);
    const out = await new Response(p.stdout).text();
    p.kill();
    expect(exited).not.toBe("timeout");
    expect(out).toContain('"tools"'); // answered BEFORE exiting, not killed mid-flight
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

// ── RAI-159 (PLAN-0.4.0 item 22): a session's own token carries its role over stdio ─────────────
const sha256hex = (t: string) => createHash("sha256").update(t).digest("hex");
function sessionFiles(stars: string[] = ["*"]) {
  const dir = mkdtempSync(join(tmpdir(), "funes-mcp-grant-"));
  const map = join(dir, "access.json");
  writeFileSync(map, JSON.stringify({
    version: 2,
    roles: {
      reader: { ops: ["recall", "recall_v2", "indexed_page", "health"] },
      agent: { ops: ["recall", "recall_v2", "indexed_page", "health", "remember"] },
    },
    actors: {
      "reader@host-a": { token_sha256: sha256hex("tok-reader"), role: "reader", stars },
      "agent@host-b": { token_sha256: sha256hex("tok-agent"), role: "agent", stars },
    },
  }));
  chmodSync(map, 0o600);
  const cap = (tok: string) => { const p = join(dir, `cap-${tok}`); writeFileSync(p, tok + "\n"); return p; };
  return { dir, map, reader: cap("tok-reader"), agent: cap("tok-agent") };
}
/** spawnMcp, minus an inherited FUNES_CAPABILITY_FILE — these tests decide whether one is set. */
function spawnSession(args: string[], env: Record<string, string>) {
  const base: Record<string, string | undefined> = { ...process.env };
  delete base.FUNES_CAPABILITY_FILE;
  delete base.FUNES_ACTOR_MAP;
  return Bun.spawn(["bun", MCP, ...args], { cwd: REPO, env: { ...base, ...env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
}

test("RAI-159 (direct): an `agent` session exposes recall + remember, and forget is refused naming the actor", async () => {
  const f = sessionFiles();
  const libsqlBase = mkdtempSync(join(tmpdir(), "funes-mcpgrant-idx-"));
  const vault = mkdtempSync(join(tmpdir(), "funes-mcpgrant-vault-"));
  const proc = spawnSession(["--vault", vault], {
    FUNES_BACKEND: "libsql", FUNES_LIBSQL_DIR: libsqlBase, FUNES_DAEMON_PORT: "1",
    FUNES_ACTOR_MAP: f.map, FUNES_CAPABILITY_FILE: f.agent,
  });
  const client = new McpClient(proc);
  try {
    await client.initialize();
    const list = (await client.request(2, "tools/list")) as { result?: { tools: Array<{ name: string }> } };
    expect((list.result?.tools ?? []).map((t) => t.name).sort()).toEqual(["health", "indexed_page", "recall", "recall_v2", "remember"]);
    for (const [i, op] of ["forget", "supersede", "page"].entries()) {
      const call = (await client.request(3 + i, "tools/call", { name: op, arguments: {} })) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
      expect(call.result?.isError).toBe(true);
      expect(call.result?.content?.[0]?.text ?? "").toContain(`operation ${op}: not granted to actor "agent@host-b"`);
    }
  } finally {
    await client.close();
    for (const d of [libsqlBase, vault, f.dir]) rmSync(d, { recursive: true, force: true });
  }
}, 45_000);

test("RAI-159 (PROXY): a `reader` session cannot remember through the daemon; an `agent` session can, and the daemon's audit line names it", async () => {
  const f = sessionFiles();
  const vault = mkdtempSync(join(tmpdir(), "funes-mcpproxy-vault-"));
  const libsqlBase = mkdtempSync(join(tmpdir(), "funes-mcpproxy-idx-"));
  const store = await LibsqlStore.create(new FakeEmbedder());
  const server = startDaemon({ vault, store, port: 0, actorMapPath: f.map });
  const env = { FUNES_BACKEND: "libsql", FUNES_LIBSQL_DIR: libsqlBase, FUNES_DAEMON_PORT: String(server.port), FUNES_ACTOR_MAP: f.map };
  const reader = new McpClient(spawnSession(["--vault", vault], { ...env, FUNES_CAPABILITY_FILE: f.reader }));
  const agent = new McpClient(spawnSession(["--vault", vault], { ...env, FUNES_CAPABILITY_FILE: f.agent }));
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await reader.initialize();
    await agent.initialize();
    const denied = (await reader.request(2, "tools/call", { name: "remember", arguments: { title: "Reader", body: "must never land" } })) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    expect(denied.result?.isError).toBe(true);
    expect(denied.result?.content?.[0]?.text ?? "").toContain('operation remember: not granted to actor "reader@host-a"');
    expect((await store.stats()).nodes).toBe(0);
    const ok = (await agent.request(2, "tools/call", { name: "remember", arguments: { title: "Agent", body: "proxied with a role" } })) as { result?: { isError?: boolean } };
    expect(ok.result?.isError).toBeFalsy();
    expect((await store.stats()).nodes).toBe(1);
    const audit = stderr.mock.calls.map((c) => String(c[0])).find((l) => l.includes("write-designation") && l.includes("op=remember"));
    expect(audit).toContain("actor=agent@host-b");
  } finally {
    stderr.mockRestore();
    await reader.close();
    await agent.close();
    server.stop(true);
    await store.close();
    for (const d of [vault, libsqlBase, f.dir]) rmSync(d, { recursive: true, force: true });
  }
}, 45_000);

test("RAI-159 (PROXY, the session gate alone): with a daemon that has NO access file, a `reader` session still cannot remember", async () => {
  const f = sessionFiles();
  const vault = mkdtempSync(join(tmpdir(), "funes-mcpproxy-vault-"));
  const libsqlBase = mkdtempSync(join(tmpdir(), "funes-mcpproxy-idx-"));
  const store = await LibsqlStore.create(new FakeEmbedder());
  const server = startDaemon({ vault, store, port: 0 }); // ungated: only the session's own gate stands
  const reader = new McpClient(spawnSession(["--vault", vault], {
    FUNES_BACKEND: "libsql", FUNES_LIBSQL_DIR: libsqlBase, FUNES_DAEMON_PORT: String(server.port),
    FUNES_ACTOR_MAP: f.map, FUNES_CAPABILITY_FILE: f.reader,
  }));
  try {
    await reader.initialize();
    const denied = (await reader.request(2, "tools/call", { name: "remember", arguments: { title: "Reader", body: "must never land" } })) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    expect(denied.result?.isError).toBe(true);
    expect(denied.result?.content?.[0]?.text ?? "").toContain('operation remember: not granted to actor "reader@host-a"');
    expect((await store.stats()).nodes).toBe(0);
  } finally {
    await reader.close();
    server.stop(true);
    await store.close();
    for (const d of [vault, libsqlBase, f.dir]) rmSync(d, { recursive: true, force: true });
  }
}, 45_000);

test("RAI-159 (direct): the grant rides on every dispatch — a star.yaml that moves after startup refuses the next call; restriction flags keep their own refusal", async () => {
  const f = sessionFiles(["rainblow.ing/funes"]);
  const libsqlBase = mkdtempSync(join(tmpdir(), "funes-mcpgrant-idx-"));
  const vault = mkdtempSync(join(tmpdir(), "funes-mcpgrant-vault-"));
  writeFileSync(join(vault, "star.yaml"), "meta:\n  id: git://rainblow.ing/funes\n");
  const env = { FUNES_BACKEND: "libsql", FUNES_LIBSQL_DIR: libsqlBase, FUNES_DAEMON_PORT: "1", FUNES_ACTOR_MAP: f.map, FUNES_CAPABILITY_FILE: f.agent };
  const text = (r: Record<string, unknown>) => ((r as { result?: { content?: Array<{ text: string }> } }).result?.content?.[0]?.text ?? "");
  const client = new McpClient(spawnSession(["--vault", vault], env));
  try {
    await client.initialize();
    expect(text(await client.request(2, "tools/call", { name: "health", arguments: {} }))).not.toContain("error:");
    writeFileSync(join(vault, "star.yaml"), "meta:\n  id: git://rainblow.ing/personal\n");
    expect(text(await client.request(3, "tools/call", { name: "health", arguments: {} })))
      .toContain('actor "agent@host-b" holds no grant for star "git://rainblow.ing/personal"');
    expect(text(await client.request(4, "tools/call", { name: "teleport", arguments: {} }))).toContain("unknown operation: teleport");
  } finally {
    await client.close();
  }
  writeFileSync(join(vault, "star.yaml"), "meta:\n  id: git://rainblow.ing/funes\n");
  try {
    for (const [args, why] of [[["--readonly"], "refused on a --readonly funes server"], [["--ops", "recall,health"], "--ops allowlist"]] as const) {
      const c = new McpClient(spawnSession(["--vault", vault, ...args], env));
      try {
        await c.initialize();
        const t = text(await c.request(2, "tools/call", { name: "remember", arguments: { title: "T", body: "B" } }));
        expect(t).toContain(why); // the ceiling's refusal, not the grant's
        expect(t).not.toContain("not granted");
      } finally {
        await c.close();
      }
    }
  } finally {
    for (const d of [libsqlBase, vault, f.dir]) rmSync(d, { recursive: true, force: true });
  }
}, 60_000);

test("RAI-159: with FUNES_ACTOR_MAP set, no FUNES_CAPABILITY_FILE — or a grant for another star — refuses to START", async () => {
  const f = sessionFiles(["rainblow.ing/personal"]);
  const vault = mkdtempSync(join(tmpdir(), "funes-mcpgrant-start-"));
  writeFileSync(join(vault, "star.yaml"), "meta:\n  id: git://rainblow.ing/funes\n");
  const base = { FUNES_BACKEND: "libsql", FUNES_LIBSQL_DIR: vault, FUNES_DAEMON_PORT: "1", FUNES_ACTOR_MAP: f.map };
  try {
    for (const [env, why] of [
      [base, "FUNES_CAPABILITY_FILE must name this session's own token file"],
      [{ ...base, FUNES_CAPABILITY_FILE: f.agent }, 'actor "agent@host-b" holds no grant for star "git://rainblow.ing/funes"'],
    ] as const) {
      const proc = spawnSession(["--vault", vault], env);
      const err = await drain(proc.stderr as ReadableStream<Uint8Array>);
      expect(await proc.exited).not.toBe(0); // exited before connecting stdio
      expect(err).toContain(why);
    }
  } finally {
    for (const d of [vault, f.dir]) rmSync(d, { recursive: true, force: true });
  }
}, 45_000);
