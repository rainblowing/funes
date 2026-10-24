import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FUNES_VERSION } from "funes-core/internal";

// ── the MCP boundary itself, exercised over real stdio ────────────────────────────────────
// mcp.ts's `--ops` allowlist is what a cross-star (sibling) recall connection relies on: a
// query-only wiring that can NEVER write into the other star's vault. ops.test.ts pins the op
// SUBSET is read-only; these tests pin the SERVER: spawn mcp.ts and speak real JSON-RPC 2.0 over
// stdin/stdout, asserting mutations are absent from tools/list AND refused on tools/call WITHOUT
// reaching the store. The spawned process stays
// light (the E5 model is lazy — tools/list and a refused mutation never embed).

const MCP = join(import.meta.dir, "mcp.ts");
const REPO = resolve(import.meta.dir, "..", "..", "..");
/** The protocol revision funes serves. Pinned here so a spec bump is a deliberate one-line edit. */
const MODERN_REVISION = "2026-07-28";

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

// RAI-310 D1, build probe 3: a flag 0.6.0 removed refuses at startup and names its replacement, so a
// config that still passes `--readonly` never gets the full home ceiling (RAI-298).
test("RAI-310 probe 3: --readonly, --actor, --actor-map, --capability and --db refuse to START and name the replacement", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-mcp-retired-"));
  try {
    for (const [args, replacement] of [
      [["--readonly"], "--ops"],
      [["--actor", "stdio:intruder"], "FUNES_ACTOR_MAP"],
      [["--actor-map", "/x.json"], "--access"],
      [["--capability", "/cap"], "--access"],
      [["--db", "/x/published.db"], "--published"],
    ] as const) {
      const proc = spawnMcp(["--vault", vault, ...args], { FUNES_HOME: vault });
      const err = await drain(proc.stderr as ReadableStream<Uint8Array>);
      expect(await proc.exited, args[0]).toBe(2); // exited before connecting stdio
      expect(err).toContain(`${args[0]} was removed in funes 0.6.0`);
      expect(err).toContain(replacement);
    }
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}, 45_000);

test("B5: mcp on a declared Turso star refuses to START and names the serve URL (ADR-0021)", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-mcp-turso-"));
  writeFileSync(join(vault, "star.yaml"), "meta:\n  id: rainblow.ing/org\n  write_locus: host-a\nmemory:\n  tier: org\n  substrate: turso\n");
  const proc = spawnMcp(["--vault", vault], { FUNES_HOME: vault });
  try {
    const err = await drain(proc.stderr as ReadableStream<Uint8Array>);
    expect(await proc.exited).toBe(2);
    expect(err).toContain("type: http");
    expect(err).toContain("http://host-a:8787/mcp");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}, 45_000);

test("mcp --ops allowlist (real spawned stdio): tools/list equals the allowlist; an allowlisted call works; an off-list read is refused", async () => {
  const libsqlBase = mkdtempSync(join(tmpdir(), "funes-mcpops-idx-"));
  const vault = mkdtempSync(join(tmpdir(), "funes-mcpops-vault-"));
  const proc = spawnMcp(["--vault", vault, "--ops", "recall,health"], {
    FUNES_HOME: libsqlBase,
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
    FUNES_HOME: vault,
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
    FUNES_HOME: vault,
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
    FUNES_HOME: vault,
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
    FUNES_HOME: libsqlBase,
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
    FUNES_HOME: libsqlBase,
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
    FUNES_HOME: libsqlBase,
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

// PLAN-0.4.0 item 10: the per-star stdio server resolves its locus once at startup (FUNES_LOCUS over
// the short hostname, normalized) and carries that one value on its context — the value `health`
// reports. `--locus` is retired (RAI-305): it refuses (cli.test.ts).
test("the stdio server's health names the locus it resolved: FUNES_LOCUS, normalized", async () => {
  const libsqlBase = mkdtempSync(join(tmpdir(), "funes-locus-idx-"));
  const vault = mkdtempSync(join(tmpdir(), "funes-locus-vault-"));
  const proc = spawnMcp(["--vault", vault, "--ops", "recall,health"], {
    FUNES_HOME: libsqlBase, FUNES_LOCUS: "Host-A",
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
    FUNES_HOME: libsqlBase,
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

// The serve-time index_scope guard runs in dispatch (guarded-serve.test.ts). Over stdio it is the
// direct path only: funes 0.6.0 has no daemon to proxy to (RAI-305).

// PLAN-0.5.0 item 17 (RAI-218), ADR-0020: no guarded twins — the client's plain `recall` reaches
// dispatchToolCall on a cross-star context, so an absent manifest refuses.
async function crossStarRecall(env: Record<string, string>, vault: string) {
  const proc = spawnMcp(["--vault", vault, "--ops", "recall,health", "--cross-star"], { ...env });
  const client = new McpClient(proc);
  try {
    await client.initialize();
    return (await client.request(2, "tools/call", { name: "recall", arguments: { query: "kept alpha tokens" } })) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
  } finally { await client.close(); }
}

test("item 17 (direct): recall on a cross-star surface refuses when the manifest is absent", async () => {
  const libsqlBase = mkdtempSync(join(tmpdir(), "funes-xs-v2-idx-"));
  const vault = mkdtempSync(join(tmpdir(), "funes-xs-v2-vault-"));
  try {
    const r = await crossStarRecall({ FUNES_HOME: libsqlBase }, vault);
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
      env: { ...process.env, FUNES_HOME: join(dir, "idx") },
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
      reader: { ops: ["recall", "indexed_page", "health"] },
      agent: { ops: ["recall", "indexed_page", "health", "remember"] },
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
    FUNES_HOME: libsqlBase,
    FUNES_ACTOR_MAP: f.map, FUNES_CAPABILITY_FILE: f.agent,
  });
  const client = new McpClient(proc);
  try {
    await client.initialize();
    const list = (await client.request(2, "tools/list")) as { result?: { tools: Array<{ name: string }> } };
    expect((list.result?.tools ?? []).map((t) => t.name).sort()).toEqual(["health", "indexed_page", "recall", "remember"]);
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

test("RAI-159 (direct): the grant rides on every dispatch — a star.yaml that moves after startup refuses the next call; restriction flags keep their own refusal", async () => {
  const f = sessionFiles(["rainblow.ing/funes"]);
  const libsqlBase = mkdtempSync(join(tmpdir(), "funes-mcpgrant-idx-"));
  const vault = mkdtempSync(join(tmpdir(), "funes-mcpgrant-vault-"));
  writeFileSync(join(vault, "star.yaml"), "meta:\n  id: git://rainblow.ing/funes\n");
  const env = { FUNES_HOME: libsqlBase, FUNES_ACTOR_MAP: f.map, FUNES_CAPABILITY_FILE: f.agent };
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
    for (const [args, why] of [[["--ops", "recall,health"], "--ops allowlist"]] as const) {
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
  const base = { FUNES_HOME: vault, FUNES_ACTOR_MAP: f.map };
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

// ADR-0018, ADR-0021 (C18): published.db is 0444 and no process holds it read-write, so
// `funes mcp --published` opens the star's `<home>/published.db` READ-ONLY and serves the read set —
// no mutation is listed, a mutation call is refused before the store, and no -wal/-shm/-journal
// appears beside it.
test("mcp --published serves the star's published.db read-only: mutations dropped, the file untouched", async () => {
  const { E5Embedder, E5_DIM } = await import("./embedder.ts");
  const { publishReindex } = await import("./publication.ts");
  const { publishedPathOf } = await import("./published-store.ts");
  /** E5's identity (the signature the spawned server enforces) with deterministic vectors: no model. */
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
  const funesHome = mkdtempSync(join(tmpdir(), "funes-mcppub-home-"));
  const vault = mkdtempSync(join(tmpdir(), "funes-mcppub-vault-"));
  writeFileSync(join(vault, "alpha.md"), "---\ntitle: Alpha\n---\nalpha sourdough loaf body\n");
  const env = { FUNES_HOME: funesHome };
  const was = process.env.FUNES_HOME;
  process.env.FUNES_HOME = funesHome;
  const db = publishedPathOf(vault);
  if (was === undefined) delete process.env.FUNES_HOME; else process.env.FUNES_HOME = was;
  try {
    // nothing published yet: a startup refusal that names the repair
    const none = spawnMcp(["--vault", vault, "--published"], env);
    const err = await drain(none.stderr as ReadableStream<Uint8Array>);
    expect(await none.exited).toBe(2);
    expect(err).toContain("nothing is published");
    mkdirSync(dirname(db), { recursive: true });
    await publishReindex({ vault, home: dirname(db), embedder: new SpoofedE5() });
    const before = statSync(db);
    const client = new McpClient(spawnMcp(["--vault", vault, "--published"], env));
    try {
      await client.initialize();
      const list = (await client.request(2, "tools/list")) as { result?: { tools: Array<{ name: string }> } };
      const names = (list.result?.tools ?? []).map((t) => t.name);
      expect(names).toContain("health");
      for (const w of WRITES) expect(names).not.toContain(w);
      const call = (await client.request(3, "tools/call", { name: "remember", arguments: { title: "no", body: "x" } })) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
      expect(call.result?.isError).toBe(true);
      expect(call.result?.content?.[0]?.text ?? "").toContain("--published funes server");
      const health = (await client.request(4, "tools/call", { name: "health", arguments: {} })) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
      expect(health.result?.isError ?? false).toBe(false);
      expect(health.result?.content?.[0]?.text ?? "").toContain("contentGeneration");
    } finally {
      await client.close();
    }
    const after = statSync(db);
    expect([after.ino, after.size, after.mtimeMs, after.mode & 0o777]).toEqual([before.ino, before.size, before.mtimeMs, 0o444]);
    for (const x of ["-wal", "-shm", "-journal"]) expect(existsSync(db + x)).toBe(false);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(funesHome, { recursive: true, force: true });
  }
}, 45_000);
