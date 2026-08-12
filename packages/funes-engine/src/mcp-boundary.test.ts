import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Embedder } from "funes-core";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";
import { scopeHash } from "./scope.ts";
import { startDaemon } from "./daemon.ts";

// ── the MCP boundary itself, exercised over real stdio ────────────────────────────────────
// mcp.ts's `--readonly` filter is what a cross-star (sibling) recall connection relies on: a
// query-only wiring that can NEVER write into the other star's vault. ops.test.ts pins the op
// SUBSET is read-only; these tests pin the SERVER: spawn mcp.ts and speak real JSON-RPC 2.0 over
// stdin/stdout, asserting mutations are absent from tools/list AND refused on tools/call WITHOUT
// reaching the store (direct) or the daemon (proxy). FUNES_BACKEND=libsql keeps the spawned
// process light (no PGLite; the E5 model is lazy — tools/list and a refused mutation never embed).

const MCP = join(import.meta.dir, "mcp.ts");
const REPO = resolve(import.meta.dir, "..", "..", "..");

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
  /** initialize handshake — required before tools/list or tools/call are served. */
  async initialize() {
    await this.request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "boundary-test", version: "0" },
    });
    this.notify("notifications/initialized");
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
    expect(names).toEqual(["graph", "health", "hotlist", "indexed_page", "neighbors", "page", "recall", "tree"]);
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
  const store = await LibsqlStore.create(new FakeEmbedder()); // in-memory, owned by the in-process daemon
  const server = startDaemon({ vault, store, port: 0 });
  const proc = spawnMcp(["--vault", vault, "--readonly"], {
    FUNES_BACKEND: "libsql",
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
  // --cross-star: the scope guard is a cross-star concern (H8/H9) — an own-star --ops binding is not
  // scope-guarded, so the guard tests must declare the cross-star surface.
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

test("scope guard (--ops): scope DRIFT (hash mismatch) refuses cross-star recall, but a plain daemon recall still works", async () => {
  // index stamped for [built/**]; star.yaml now declares [current/**] -> the hashes differ.
  const f = await scopeDaemonFixture({ excludes: ["current/**"], persist: { hash: scopeHash(["built/**"]), ignoreScope: false }, content: true });
  try {
    // the index itself is fine — a plain daemon recall (NOT scope-guarded) returns results
    const direct = (await (await fetch(`http://127.0.0.1:${f.server.port}/api/recall`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "kept alpha tokens" }),
    })).json()) as { ok: boolean; result: unknown[] };
    expect(direct.ok).toBe(true);
    expect(direct.result.length).toBeGreaterThan(0);
    // but the cross-star --ops path refuses on the drift
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
    await f.store.endReindex();
  } finally { await f.cleanup(); }
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
