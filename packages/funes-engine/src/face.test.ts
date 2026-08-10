import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import type { Embedder } from "funes-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startFace, resolveBrokerOps, resolveFaceOps, assertBindPolicy, DEFAULT_BROKER_OPS, DEFAULT_READ_OPS, type FaceDeps, type RunningFace } from "./face.ts";
import { operations } from "./ops.ts";
import { FunesStore } from "./funes-store.ts";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";

// The face test battery (re-homing plan R2#13/#14, R4#1/#3; conformance review major #6 + the
// bind minor): broker = capability-gated recall+remember EXACTLY; read = registry-generated
// negative allowlist, exact Host, browser rejection, zero CORS; bind policy explicit.

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

const CAP_TOKEN = "cap-token-for-tests";

async function makeFixture(): Promise<{ vault: string; deps: FaceDeps; capFile: string }> {
  const vault = mkdtempSync(join(tmpdir(), "funes-face-vault-"));
  mkdirSync(join(vault, "wiki"), { recursive: true });
  writeFileSync(join(vault, "wiki", "alpha.md"), "---\ntitle: Alpha\n---\nalpha sourdough loaf body\n");
  const capFile = join(vault, ".cap"); // dot-file: invisible to the indexer, fine for a fixture
  writeFileSync(capFile, CAP_TOKEN + "\n");
  const store = await LibsqlStore.create(new FakeEmbedder());
  await store.remember([
    { id: "wiki/alpha", path: "wiki/alpha.md", title: "Alpha", body: "alpha sourdough loaf body", trust: "trusted" },
  ]);
  await store.setGeneration("v1:" + "a".repeat(64));
  const funes = new FunesStore(store, { root: vault });
  const deps: FaceDeps = {
    withStore: (fn) => fn({ store, funes, generation: "v1:" + "a".repeat(64) }),
    close: () => store.close(),
  };
  return { vault, deps, capFile };
}

/** An OS-granted free port (the read face needs its exact expectedHost BEFORE listen). */
async function freePort(): Promise<number> {
  return new Promise((resolvePort) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolvePort(port));
    });
  });
}

/** Raw request with FULL header control (Host/Origin/Sec-Fetch — fetch would fight us). */
function raw(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolveReq, rejectReq) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path ?? "/health", headers: opts.headers ?? {} },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolveReq({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", rejectReq);
    req.end();
  });
}

const noCors = (headers: Record<string, string | string[] | undefined>): void => {
  expect(Object.keys(headers).filter((h) => h.toLowerCase().startsWith("access-control-"))).toEqual([]);
};

async function mcpClient(url: string, headers: Record<string, string> = {}): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers } });
  const client = new Client({ name: "face-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const textOf = (r: unknown): string =>
  (((r as { content?: unknown }).content as Array<{ type: string; text?: string }> | undefined) ?? [])
    .map((c) => c.text ?? "")
    .join("\n");

// ── startup policy: fail-closed BEFORE a socket opens ────────────────────────────────────────────

test("face startup: broker requires a capability; read refuses one; read requires an exact Host", async () => {
  const { vault, deps, capFile } = await makeFixture();
  await expect(startFace({ face: "broker", vault, bind: "127.0.0.1", port: 0 }, deps)).rejects.toThrow(/--capability .*required/);
  await expect(startFace({ face: "read", vault, bind: "127.0.0.1", port: 0, capabilityPath: capFile }, deps)).rejects.toThrow(/credential-free BY DESIGN/);
  await expect(startFace({ face: "read", vault, bind: "127.0.0.1", port: 0 }, deps)).rejects.toThrow(/--host .*required/);
  await deps.close();
});

test("face bind policy: explicit bind REQUIRED; 0.0.0.0/:: refused unless FACE_PUBLISH_PINNED=1 (compose-publish topology)", () => {
  expect(() => assertBindPolicy(undefined, {})).toThrow(/EXPLICIT --bind/);
  expect(() => assertBindPolicy("", {})).toThrow(/EXPLICIT --bind/);
  expect(() => assertBindPolicy("0.0.0.0", {})).toThrow(/FACE_PUBLISH_PINNED/);
  expect(() => assertBindPolicy("::", {})).toThrow(/FACE_PUBLISH_PINNED/);
  // the pinned-publish assertion: the CONTAINER binds all-ifaces, the HOST publish pins the
  // tailscale IP (compose `ports: "100.x.y.z:8788:8788"`) — stated via env, so it is legal here
  expect(assertBindPolicy("0.0.0.0", { FACE_PUBLISH_PINNED: "1" })).toBe("0.0.0.0");
  expect(assertBindPolicy("127.0.0.1", {})).toBe("127.0.0.1");
});

test("face op resolution: broker admits remember ONLY among mutations; read allowlist is read-only + internal-free", () => {
  expect(resolveBrokerOps(operations, ["recall", "remember"]).map((o) => o.name)).toEqual(["recall", "remember"]);
  expect(() => resolveBrokerOps(operations, [])).toThrow(/fail-closed/);
  expect(() => resolveBrokerOps(operations, ["recall", "supersede"])).toThrow(/remember ONLY/);
  expect(() => resolveBrokerOps(operations, ["recall", "forget"])).toThrow(/remember ONLY/);
  expect(() => resolveBrokerOps(operations, ["guarded_recall"])).toThrow(/unknown operation/); // internal ops un-allowlistable
  expect(() => resolveBrokerOps(operations, ["nope"])).toThrow(/unknown operation/);
  expect(resolveFaceOps("broker").map((o) => o.name)).toEqual([...DEFAULT_BROKER_OPS]);
  expect(resolveFaceOps("read").map((o) => o.name)).toEqual([...DEFAULT_READ_OPS]);
  for (const op of resolveFaceOps("read")) expect(op.readonly).toBe(true);
  expect(() => resolveFaceOps("read", ["recall", "remember"])).toThrow(/not read-only/);
});

// ── the BROKER face ───────────────────────────────────────────────────────────────────────────────

let broker: RunningFace;
let brokerDeps: FaceDeps;
{
  const { vault, deps, capFile } = await makeFixture();
  brokerDeps = deps;
  broker = await startFace(
    { face: "broker", vault, bind: "127.0.0.1", port: 0, capabilityPath: capFile, locus: "nas-1", role: "canon", star: "example" },
    deps,
  );
}
afterAll(async () => {
  await broker.close();
});

test("broker: 401 without the capability header, 401 with a wrong one — before ANY dispatch; zero CORS on both", async () => {
  const missing = await raw(broker.port, { path: "/health" });
  expect(missing.status).toBe(401);
  noCors(missing.headers);
  const wrong = await raw(broker.port, { path: "/health", headers: { "x-twinkling-capability": "guessed" } });
  expect(wrong.status).toBe(401);
  noCors(wrong.headers);
  const mcpNoCap = await raw(broker.port, { method: "POST", path: "/mcp" });
  expect(mcpNoCap.status).toBe(401);
});

test("broker health: {star, locus, role, generation, dirty} from LIVE index state", async () => {
  const ok = await raw(broker.port, { path: "/health", headers: { "x-twinkling-capability": CAP_TOKEN } });
  expect(ok.status).toBe(200);
  noCors(ok.headers);
  const body = JSON.parse(ok.body) as Record<string, unknown>;
  expect(body.star).toBe("example");
  expect(body.locus).toBe("nas-1");
  expect(body.role).toBe("canon");
  expect(body.generation).toBe("v1:" + "a".repeat(64));
  expect(body.dirty).toBe(false);
});

test("broker MCP: serves EXACTLY recall+remember; remember writes out_memory (server-stamped untrusted); recall answers", async () => {
  const client = await mcpClient(broker.url, { "x-twinkling-capability": CAP_TOKEN });
  try {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["recall", "remember"]);
    const rem = await client.callTool({ name: "remember", arguments: { title: "Face memory", body: "the broker remembered this via MCP" } });
    expect(rem.isError ?? false).toBe(false);
    const remOut = JSON.parse(textOf(rem)) as { id: string; trust: string };
    expect(remOut.id.startsWith("out_memory/")).toBe(true);
    expect(remOut.trust).toBe("untrusted");
    const rec = await client.callTool({ name: "recall", arguments: { query: "broker remembered MCP" } });
    expect(rec.isError ?? false).toBe(false);
    expect(textOf(rec)).toContain(remOut.id);
  } finally {
    await client.close();
  }
});

test("broker: GENERATED negative — every registry op OUTSIDE recall+remember is rejected AT DISPATCH (no hand lists)", async () => {
  const client = await mcpClient(broker.url, { "x-twinkling-capability": CAP_TOKEN });
  try {
    const allowed = new Set<string>(DEFAULT_BROKER_OPS);
    const denied = operations.filter((o) => !allowed.has(o.name)); // the FULL registry, internal ops included
    expect(denied.length).toBeGreaterThan(0); // registry growth grows THIS list automatically
    for (const op of denied) {
      const res = await client.callTool({ name: op.name, arguments: {} });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain(`operation ${op.name}: not on the broker face's allowlist`);
    }
  } finally {
    await client.close();
  }
});

test("broker: browser Origin / Sec-Fetch-Site rejected 403 (even WITH a valid capability); zero CORS", async () => {
  const origin = await raw(broker.port, { path: "/health", headers: { "x-twinkling-capability": CAP_TOKEN, origin: "https://evil.example" } });
  expect(origin.status).toBe(403);
  noCors(origin.headers);
  const fetchMeta = await raw(broker.port, { path: "/health", headers: { "x-twinkling-capability": CAP_TOKEN, "sec-fetch-site": "cross-site" } });
  expect(fetchMeta.status).toBe(403);
  noCors(fetchMeta.headers);
});

// ── the READ face ─────────────────────────────────────────────────────────────────────────────────

let read: RunningFace;
let readHost: string;
{
  const { vault, deps } = await makeFixture();
  const port = await freePort();
  readHost = `127.0.0.1:${port}`; // stands in for the exact MagicDNS host the composition passes
  read = await startFace(
    { face: "read", vault, bind: "127.0.0.1", port, expectedHost: readHost, locus: "nas-1", role: "canon", star: "example" },
    deps,
  );
}
afterAll(async () => {
  await read.close();
});

test("read face: credential-free health {star, locus, role, generation, dirty}; page serves canon bodies", async () => {
  const h = await raw(read.port, { path: "/health", headers: { host: readHost } });
  expect(h.status).toBe(200);
  noCors(h.headers);
  const body = JSON.parse(h.body) as Record<string, unknown>;
  expect(body.star).toBe("example");
  expect(body.locus).toBe("nas-1");
  expect(body.role).toBe("canon");
  expect(body.generation).toBe("v1:" + "a".repeat(64));
  expect(body.dirty).toBe(false);

  const client = await mcpClient(read.url);
  try {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([...DEFAULT_READ_OPS].sort());
    // `page` serves page bodies from canon — stated, not assumed (R5-cleanup)
    const page = await client.callTool({ name: "page", arguments: { path: "wiki/alpha.md" } });
    expect(page.isError ?? false).toBe(false);
    expect(textOf(page)).toContain("alpha sourdough loaf body");
  } finally {
    await client.close();
  }
});

test("read face: GENERATED negative — every non-allowlisted registry op (ALL mutations + internal) rejected at dispatch", async () => {
  const client = await mcpClient(read.url);
  try {
    const allowed = new Set<string>(DEFAULT_READ_OPS);
    const denied = operations.filter((o) => !allowed.has(o.name));
    // the registry's mutations MUST all be in the denied set — this pins remember/supersede/forget
    // without hand-listing them, and any future mutating op lands here automatically
    for (const op of operations.filter((o) => !o.readonly)) expect(denied.map((d) => d.name)).toContain(op.name);
    for (const op of denied) {
      const res = await client.callTool({ name: op.name, arguments: {} });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain(`operation ${op.name}: not on the read face's allowlist`);
    }
  } finally {
    await client.close();
  }
});

test("read face: exact expected-Host — a LAN-IP / rebound-DNS Host is 421 before dispatch", async () => {
  const evil = await raw(read.port, { path: "/health", headers: { host: "192.168.1.50:8788" } });
  expect(evil.status).toBe(421);
  noCors(evil.headers);
  const rebound = await raw(read.port, { method: "POST", path: "/mcp", headers: { host: "canon host.evil.example" } });
  expect(rebound.status).toBe(421);
});

test("read face: browser Origin/Sec-Fetch rejected; unknown paths 404; zero CORS on EVERY response", async () => {
  const origin = await raw(read.port, { path: "/health", headers: { host: readHost, origin: "https://hostile.page" } });
  expect(origin.status).toBe(403);
  noCors(origin.headers);
  const sf = await raw(read.port, { method: "POST", path: "/mcp", headers: { host: readHost, "sec-fetch-site": "same-origin" } });
  expect(sf.status).toBe(403);
  noCors(sf.headers);
  const notFound = await raw(read.port, { path: "/admin", headers: { host: readHost } });
  expect(notFound.status).toBe(404);
  noCors(notFound.headers);
  const health = await raw(read.port, { path: "/health", headers: { host: readHost } });
  noCors(health.headers); // the happy path emits none either
});
