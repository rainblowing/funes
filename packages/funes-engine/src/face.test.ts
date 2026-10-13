import { test, expect, afterAll, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import type { Embedder } from "funes-core";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startFace, makeFaceDeps, resolveBrokerOps, resolveFaceOps, assertBindPolicy, assertRemoteBroker, isLoopbackBind, isTailscaleAddress, DEFAULT_BIND_ALLOW, DEFAULT_BROKER_OPS, DEFAULT_READ_OPS, MAX_FACE_BODY_BYTES, type FaceDeps, type RunningFace } from "./face.ts";
import { resolveWriteDesignation } from "./write-designation.ts";
import { operations } from "./ops.ts";
import { publishReindex, readGenerationManifest, withPublicationFence } from "./publication.ts";
import { FUNES_VERSION } from "./version.ts";
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
  await store.finalizeReindex({ contentGeneration: "v2:" + "a".repeat(64) });
  const funes = new FunesStore(store, { root: vault });
  const deps: FaceDeps = {
    withStore: (fn) => fn({ store, funes, generation: "v2:" + "a".repeat(64) }),
    // 0.3.0 item 9: `home` is where the broker's mutation fence is keyed. A temp dir per fixture, so
    // the lock these tests take is theirs alone and nothing reaches the real estate.
    home: mkdtempSync(join(tmpdir(), "funes-face-home-")),
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

/** A face client at a CHOSEN protocol era.
 *
 *  Default `"modern"` pins protocol revision 2026-07-28 with no probe and no fallback — anything
 *  else fails loudly. That is deliberate: on SDK v1 this face answered a 2026-07-28 client with
 *  HTTP 400, so every test below that uses the default is now also a regression test for the thing
 *  this migration existed to fix. `"legacy"` runs the plain 2025 `initialize` sequence, byte-
 *  identical to a pre-migration client, and pins the backward-compatibility guardrail. */
async function mcpClient(
  url: string,
  headers: Record<string, string> = {},
  era: "modern" | "legacy" = "modern",
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers } });
  const client = new Client(
    { name: "face-test", version: "0.0.0" },
    era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
  );
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

// 0.3.0 item 21. This test REPLACES the FACE_PUBLISH_PINNED assertions, and deliberately: that env
// var admitted 0.0.0.0 on the composition's word that a host-side publish pinned an IP, which is an
// assertion of intention that verifies nothing about the binding and checks no peer. The allowlist
// is the replacement — the operator NAMES the address, and naming it is the whole approval.
test("face bind policy (item 21): an IP literal, NAMED in the allowlist; wildcards, DNS and an unparseable list refuse", () => {
  expect(() => assertBindPolicy(undefined, { env: {} })).toThrow(/EXPLICIT --bind/);
  expect(() => assertBindPolicy("", { env: {} })).toThrow(/EXPLICIT --bind/);
  // the documented default is loopback, and it is the ONLY thing that serves without configuration
  expect(assertBindPolicy("127.0.0.1", { env: {} })).toBe("127.0.0.1");
  expect(assertBindPolicy("::1", { env: {} })).toBe("::1");
  expect(() => assertBindPolicy("100.64.0.7", { env: {} })).toThrow(/not in this face's bind allowlist/);
  // wildcards refuse as a BIND and as an ENTRY — the old FACE_PUBLISH_PINNED escape is gone
  expect(() => assertBindPolicy("0.0.0.0", { env: { FACE_PUBLISH_PINNED: "1" } })).toThrow(/wildcard names no interface/);
  expect(() => assertBindPolicy("::", { env: {} })).toThrow(/wildcard names no interface/);
  expect(() => assertBindPolicy("*", { env: {} })).toThrow(/wildcard names no interface/);
  expect(() => assertBindPolicy("100.64.0.7", { allow: "0.0.0.0" })).toThrow(/is a wildcard/);
  // DNS names and CIDR are ambiguous, on either side
  expect(() => assertBindPolicy("nas-1.tailnet.ts.net", { env: {} })).toThrow(/not an IP literal/);
  expect(() => assertBindPolicy("100.64.0.7", { allow: "nas-1.tailnet.ts.net" })).toThrow(/not an IP literal/);
  expect(() => assertBindPolicy("100.64.0.7", { allow: "100.64.0.0/10" })).toThrow(/not an IP literal/);
  // fail-closed parsing: an allowlist that was configured and is empty REFUSES; it does not fall
  // back to the default, and it certainly does not fall back to permissive
  expect(() => assertBindPolicy("127.0.0.1", { allow: "" })).toThrow(/empty bind allowlist/);
  expect(() => assertBindPolicy("127.0.0.1", { env: { FUNES_FACE_BIND_ALLOW: " , " } })).toThrow(/empty bind allowlist/);
  // precedence: flag over environment over default
  expect(assertBindPolicy("100.64.0.7", { allow: "100.64.0.7", env: { FUNES_FACE_BIND_ALLOW: "127.0.0.1" } })).toBe("100.64.0.7");
  expect(assertBindPolicy("100.64.0.7", { env: { FUNES_FACE_BIND_ALLOW: "10.0.0.1,100.64.0.7" } })).toBe("100.64.0.7");
  expect(() => assertBindPolicy("127.0.0.1", { env: { FUNES_FACE_BIND_ALLOW: "100.64.0.7" } })).toThrow(/not in this face's bind allowlist/);
  expect(DEFAULT_BIND_ALLOW).toEqual(["127.0.0.1", "::1"]);
});

test("face bind policy: loopback classification is the key item 22 turns on", () => {
  for (const b of ["127.0.0.1", "127.1.2.3", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"]) expect(isLoopbackBind(b)).toBe(true);
  for (const b of ["100.64.0.7", "10.0.0.1", "192.168.1.2", "fd00::1"]) expect(isLoopbackBind(b)).toBe(false);
});

// 0.3.0 item 22 — the refusal already existed keyed to the --cross-star MCP FLAG; here it is keyed
// to the address the socket listens on. Generated from the registry, so a new fs-served op cannot
// quietly reopen the surface.
test("face op resolution (item 22): a NON-LOOPBACK face refuses every filesystem-served op, unconditionally", () => {
  const remote = { loopback: false };
  expect(() => resolveFaceOps("read", undefined, remote)).toThrow(/filesystem-served/); // the DEFAULT read set carries page/tree
  for (const op of operations.filter((o) => o.served === "fs" && o.readonly && !o.internal)) {
    expect(() => resolveFaceOps("read", [op.name], remote)).toThrow(/refused unconditionally/);
  }
  // the index-served read surface is what remains, and it serves
  expect(resolveFaceOps("read", ["recall", "indexed_page", "health", "hotlist"], remote).map((o) => o.name))
    .toEqual(["recall", "indexed_page", "health", "hotlist"]);
  // the broker is not exempt: without RAI-160's five conditions (`remoteRemember`), `remember` —
  // which writes canonical markdown — keeps a broker on loopback
  expect(() => resolveFaceOps("broker", undefined, remote)).toThrow(/filesystem-served/);
  expect(resolveFaceOps("broker", ["recall"], remote).map((o) => o.name)).toEqual(["recall"]);
});

// RAI-160 splits the pin above, it does not delete it: WITH the five conditions a remote broker
// serves remember — and still no filesystem read, and never supersede/forget.
test("face op resolution (RAI-160): a remote broker that passed the five conditions serves remember; fs reads and curator ops still refuse", () => {
  const remote = { loopback: false, remoteRemember: true };
  expect(resolveFaceOps("broker", ["recall", "remember"], remote).map((o) => o.name)).toEqual(["recall", "remember"]);
  for (const op of operations.filter((o) => o.served === "fs" && o.readonly && !o.internal)) {
    expect(() => resolveFaceOps("broker", ["recall", "remember", op.name], remote)).toThrow(/refused unconditionally/);
  }
  for (const op of ["supersede", "forget"]) {
    expect(() => resolveFaceOps("broker", ["recall", "remember", op], remote)).toThrow(/LOOPBACK broker only/);
    expect(resolveFaceOps("broker", ["recall", "remember", op], { loopback: true }).map((o) => o.name)).toEqual(["recall", "remember", op]);
  }
  // the read face gains nothing from the flag
  expect(() => resolveFaceOps("read", undefined, remote)).toThrow(/filesystem-served/);
});

test("face op resolution: broker admits remember ONLY among mutations; read allowlist is read-only + internal-free", () => {
  expect(resolveBrokerOps(operations, ["recall", "remember"]).map((o) => o.name)).toEqual(["recall", "remember"]);
  expect(() => resolveBrokerOps(operations, [])).toThrow(/fail-closed/);
  expect(() => resolveBrokerOps(operations, ["recall", "supersede"])).toThrow(/remember ONLY/);
  expect(() => resolveBrokerOps(operations, ["recall", "forget"])).toThrow(/remember ONLY/);
  // RAI-160: a LOOPBACK broker admits the curator's two when --ops names them; nothing else widens
  expect(resolveBrokerOps(operations, ["recall", "supersede", "forget"], { loopback: true }).map((o) => o.name)).toEqual(["recall", "supersede", "forget"]);
  expect(() => resolveBrokerOps(operations, ["recall", "supersede"], { loopback: false })).toThrow(/LOOPBACK broker only/);
  expect(() => resolveBrokerOps(operations, ["guarded_recall"])).toThrow(/unknown operation/); // internal ops un-allowlistable
  expect(() => resolveBrokerOps(operations, ["nope"])).toThrow(/unknown operation/);
  const local = { loopback: true };
  expect(resolveFaceOps("broker", undefined, local).map((o) => o.name)).toEqual([...DEFAULT_BROKER_OPS]);
  expect(resolveFaceOps("read", undefined, local).map((o) => o.name)).toEqual([...DEFAULT_READ_OPS]);
  for (const op of resolveFaceOps("read", undefined, local)) expect(op.readonly).toBe(true);
  expect(() => resolveFaceOps("read", ["recall", "remember"], local)).toThrow(/not read-only/);
});

// 0.3.0 items 21-22 end to end: both refusals happen BEFORE a socket opens, which is why these can
// name an address this machine cannot bind — nothing ever listens.
test("face startup: the allowlist and the fs refusal both fire before listen", async () => {
  const { vault, deps, capFile } = await makeFixture();
  const host = "example.test:8788";
  await expect(startFace({ face: "read", vault, bind: "100.64.0.7", port: 0, expectedHost: host }, deps))
    .rejects.toThrow(/not in this face's bind allowlist/);
  // allowlisted, and now the DEFAULT read set (page/tree/neighbors/graph) is what refuses
  await expect(startFace({ face: "read", vault, bind: "100.64.0.7", bindAllow: "100.64.0.7", port: 0, expectedHost: host }, deps))
    .rejects.toThrow(/refused unconditionally/);
  // the index-served surface is what a remote read face may serve
  const remote = await startFace(
    { face: "read", vault, bind: "127.0.0.1", bindAllow: "127.0.0.1", port: 0, expectedHost: host, opNames: ["recall", "indexed_page", "health"] },
    deps,
  );
  await remote.close();
  // item 24: a broken actor mapping refuses startup too — it is a security input, not a hint.
  // The capability file itself is 0644 here, which is exactly the first thing the mapping refuses.
  await expect(startFace({ face: "broker", vault, bind: "127.0.0.1", port: 0, capabilityPath: capFile, actorMapPath: capFile }, deps))
    .rejects.toThrow(/group\/world readable/);
  const badMap = join(vault, ".actors.json");
  writeFileSync(badMap, "{not json");
  chmodSync(badMap, 0o600);
  await expect(startFace({ face: "broker", vault, bind: "127.0.0.1", port: 0, capabilityPath: capFile, actorMapPath: badMap }, deps))
    .rejects.toThrow(/malformed JSON/);
  // and a GOOD one names the actor the face will stamp, from the capability it serves behind
  const goodMap = join(vault, ".actors-ok.json");
  writeFileSync(goodMap, JSON.stringify({ [CAP_TOKEN]: "homai" }));
  chmodSync(goodMap, 0o600);
  const mapped = await startFace({ face: "broker", vault, bind: "127.0.0.1", port: 0, capabilityPath: capFile, actorMapPath: goodMap }, deps);
  await mapped.close();
  // RAI-158: a mounted map is opened at startup to learn its version, so `--actor` no longer lets a
  // loose token file through unread (before, `--actor` won the precedence and the map went unopened)
  await expect(startFace({ face: "broker", vault, bind: "127.0.0.1", port: 0, capabilityPath: capFile, actorMapPath: capFile, actor: "broker@host-a" }, deps))
    .rejects.toThrow(/group\/world readable/);
  await expect(startFace({ face: "broker", vault, bind: "127.0.0.1", port: 0, capabilityPath: capFile, actor: "not a name" }, deps))
    .rejects.toThrow(/not a usable actor name/);
  // item 25: `enforce` is refused at configuration, not offered as a flag this release honours
  await expect(startFace({ face: "broker", vault, bind: "127.0.0.1", port: 0, capabilityPath: capFile, writeDesignation: "enforce" }, deps))
    .rejects.toThrow(/not available in this release/);
  await deps.close();
});

// PLAN-0.4.0 item 10: /health names the locus the designation resolved — FUNES_LOCUS when no --locus
// is given, null (never "unknown") when neither is — and a refused name refuses before a socket opens.
test("face health: the locus is resolveLocus's — env when no flag, null when none; a refused one never binds", async () => {
  const { vault, deps, capFile } = await makeFixture();
  const saved = process.env.FUNES_LOCUS;
  const healthLocus = async (): Promise<unknown> => {
    const face = await startFace({ face: "broker", vault, bind: "127.0.0.1", port: 0, capabilityPath: capFile }, { ...deps, close: async () => {} });
    try {
      return (JSON.parse((await raw(face.port, { path: "/health", headers: { "x-twinkling-capability": CAP_TOKEN } })).body) as Record<string, unknown>).locus;
    } finally { await face.close(); }
  };
  try {
    delete process.env.FUNES_LOCUS;
    expect(await healthLocus()).toBeNull();
    process.env.FUNES_LOCUS = " Host-B ";
    expect(await healthLocus()).toBe("host-b");
    await expect(startFace({ face: "broker", vault, bind: "127.0.0.1", port: 0, capabilityPath: capFile, locus: "a@b" }, deps))
      .rejects.toThrow(/--locus "a@b" carries "@"/);
    process.env.FUNES_LOCUS = "host/b";
    await expect(startFace({ face: "broker", vault, bind: "127.0.0.1", port: 0, capabilityPath: capFile }, deps))
      .rejects.toThrow(/FUNES_LOCUS "host\/b"/);
  } finally {
    if (saved === undefined) delete process.env.FUNES_LOCUS;
    else process.env.FUNES_LOCUS = saved;
    await deps.close();
  }
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
  expect(body.generation).toBe("v2:" + "a".repeat(64));
  expect(body.dirty).toBe(false);
  // item 8's rename must not leave one value with two names across the two faces: `generation` is
  // the DEPRECATED alias, `contentGeneration` the name both faces now carry, and they agree here.
  // (ops.test.ts pins the same pair on the MCP `health` op.) Removed together at the twinkl.ing
  // cutover — see the comment on this key in face.ts.
  expect(body.contentGeneration).toBe(body.generation);
});

// ── protocol revision coverage ────────────────────────────────────────────────────────────
// Every other MCP test in this file connects with the 2026-07-28 pin (see `mcpClient`), so they
// collectively prove the face now serves the current spec — on SDK v1 it answered such a client
// with HTTP 400. These two pin the other end: the legacy era still works, and the version the
// face reports is the real one.

test("2026-07-28: server/discover over HTTP offers the revision the pinned clients negotiate", async () => {
  const res = await fetch(`${read.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      // SEP-2243: the routing header is MANDATORY on streamable HTTP, and the SDK enforces that it
      // agrees with the body (omit it and the request is refused before dispatch). funes needs no
      // code of its own for this — asserted here so that stays true.
      "mcp-method": "server/discover",
      // Since SDK 2.3 the version header is mandatory too when the body names 2026-07-28 (omit it:
      // 400 version-header-missing). Real 2026-07-28 clients send both.
      "mcp-protocol-version": "2026-07-28",
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "face-test", version: "0" },
        },
      },
    }),
  });
  expect(res.status).toBe(200); // the v1 transport answered a 2026-07-28 request with 400
  const body = (await res.json()) as { result?: { supportedVersions?: string[] }; error?: unknown };
  expect(body.error).toBeUndefined();
  expect(body.result?.supportedVersions ?? []).toContain("2026-07-28");
});

test("GUARDRAIL: a 2025-era client (plain initialize handshake) still reaches the read face unchanged", async () => {
  const client = await mcpClient(read.url, {}, "legacy");
  try {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("recall");
    const page = await client.callTool({ name: "page", arguments: { path: "wiki/alpha.md" } });
    expect(page.isError ?? false).toBe(false);
    // and it reports the REAL version, not the hardcoded "0.1.0" the face used to send
    expect(client.getServerVersion()?.version).toBe(FUNES_VERSION);
    expect(client.getServerVersion()?.version).not.toBe("0.1.0");
  } finally {
    await client.close();
  }
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

test("item 9: a broker MUTATION takes the publication-home fence; a READ does not", async () => {
  // The half of item 9 that lives on this face. Before it, the broker's wrapper was
  // `withCoordination`, a PASS-THROUGH unless FUNES_COORDINATION_DIR was set — so on the default
  // deployment a broker write and a publish into the same home were serialized by nothing at all.
  const client = await mcpClient(broker.url, { "x-twinkling-capability": CAP_TOKEN });
  const events: string[] = [];
  const gate = Promise.withResolvers<void>();
  const held = withPublicationFence(brokerDeps.home, async () => {
    events.push("fence:acquired");
    await gate.promise;
    events.push("fence:released");
  });
  try {
    await Bun.sleep(10); // let the holder actually take it
    // A READ is not fenced — the per-op lease alone makes a torn read impossible — so it answers
    // while the fence is held. This is the control: it proves the block below is the FENCE and not
    // the face being wedged.
    const rec = await client.callTool({ name: "recall", arguments: { query: "sourdough" } });
    expect(rec.isError ?? false).toBe(false);

    const rem = client.callTool({ name: "remember", arguments: { title: "Fenced", body: "written under the fence" } })
      .then((r) => { events.push("remember:done"); return r; });
    await Bun.sleep(300);
    gate.resolve();
    const [, out] = await Promise.all([held, rem]);
    expect(out.isError ?? false).toBe(false);
    expect(events).toEqual(["fence:acquired", "fence:released", "remember:done"]);
  } finally {
    gate.resolve(); // never leave the fence held if an assertion threw above
    await held.catch(() => {});
    await client.close();
  }
});

// RAI-144 at the FACE. face-deps.test.ts pins that `refreshStatus` re-stamps the status file when it
// is CALLED; nothing pinned that the broker calls it — the one line in face.ts after a mutating
// tools/call. Without that line the file keeps its boot-time stamp (a non-null content generation)
// until the 60 s heartbeat, which is how this was confirmed to fail with the line deleted: the read
// below happens milliseconds after the write, well inside the first beat. Real deps rather than the
// fixture's static store, because the status file is written by the production resolution.
test("broker over HTTP: a remember re-stamps .status/broker.json before the heartbeat; a recall does not", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-face-status-vault-"));
  mkdirSync(join(vault, "wiki"), { recursive: true });
  writeFileSync(join(vault, "wiki", "alpha.md"), "---\ntitle: Alpha\n---\nalpha sourdough loaf body\n");
  const capFile = join(vault, ".cap");
  writeFileSync(capFile, CAP_TOKEN + "\n");
  const home = mkdtempSync(join(tmpdir(), "funes-face-status-home-"));
  const embedder = new FakeEmbedder();
  await publishReindex({ vault, home, embedder, open: (p) => LibsqlStore.create(embedder, p) });
  const id = readGenerationManifest(home)!.publicationId!;
  const face = await startFace(
    { face: "broker", vault, bind: "127.0.0.1", port: 0, capabilityPath: capFile },
    await makeFaceDeps(vault, { face: "broker", home, embedder }),
  );
  const readStatus = () =>
    JSON.parse(readFileSync(join(home, ".status", "broker.json"), "utf8")) as { publicationId: string; contentGeneration: string | null; at: number };
  try {
    const booted = readStatus(); // the eager first open acked, via onServe
    expect(booted.publicationId).toBe(id);
    expect(booted.contentGeneration).not.toBeNull();
    const client = await mcpClient(face.url, { "x-twinkling-capability": CAP_TOKEN });
    try {
      // The control: a READ is not a mutation, and must not re-stamp (only the timer does that).
      const rec = await client.callTool({ name: "recall", arguments: { query: "sourdough" } });
      expect(rec.isError ?? false).toBe(false);
      expect(readStatus().contentGeneration).toBe(booted.contentGeneration);
      const rem = await client.callTool({ name: "remember", arguments: { title: "Stamped", body: "a write the status must follow" } });
      expect(rem.isError ?? false).toBe(false);
    } finally {
      await client.close();
    }
    const after = readStatus();
    expect(after.publicationId).toBe(id);     // immutable: the write did not move the artefact...
    expect(after.contentGeneration).toBeNull(); // ...but it invalidated the content generation, and the status says so NOW
    expect(after.at).toBeGreaterThanOrEqual(booted.at);
  } finally {
    await face.close();
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
    // PLAN-0.4.0 item 10: an un-normalized --locus; /health reports the normalized value
    { face: "read", vault, bind: "127.0.0.1", port, expectedHost: readHost, locus: " NAS-1 ", role: "canon", star: "example" },
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
  expect(body.generation).toBe("v2:" + "a".repeat(64));
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

// ── RAI-158 (PLAN-0.4.0 item 21): many actors on one loopback broker ────────────────────────────
// A version-2 access file names each caller: a presented token picks an actor, the actor's role
// picks its ops, and its `stars` pick the stars it may touch. These run over real HTTP, so they also
// prove the grant reaches the per-request MCP server (face.ts carries it through AsyncLocalStorage;
// nothing else hands the SDK's server factory the request).

const TOK_AGENT = "tok-agent-for-tests";
const TOK_READER = "tok-reader-for-tests";
const TOK_ELSEWHERE = "tok-elsewhere-for-tests";
const sha256hex = (t: string) => createHash("sha256").update(t).digest("hex");

function accessFileV2(actors: Record<string, { token: string; role: string; stars: string[] }>): string {
  return JSON.stringify({
    version: 2,
    roles: {
      reader: { ops: ["recall", "recall_v2", "indexed_page", "health"] },
      agent: { ops: ["recall", "recall_v2", "indexed_page", "health", "remember"] },
    },
    actors: Object.fromEntries(Object.entries(actors).map(([name, a]) => [name, { token_sha256: sha256hex(a.token), role: a.role, stars: a.stars }])),
  });
}

async function multiActorBroker(): Promise<{ face: RunningFace; deps: FaceDeps; vault: string; mapPath: string }> {
  const { vault, deps } = await makeFixture();
  writeFileSync(join(vault, "star.yaml"), "meta:\n  id: git://rainblow.ing/funes\n");
  const mapPath = join(vault, ".access.json");
  writeFileSync(mapPath, accessFileV2({
    "claude@host-b": { token: TOK_AGENT, role: "agent", stars: ["rainblow.ing/funes"] },
    "sibling@host-a": { token: TOK_READER, role: "reader", stars: ["*"] },
    "other@host-a": { token: TOK_ELSEWHERE, role: "agent", stars: ["rainblow.ing/personal"] },
  }));
  chmodSync(mapPath, 0o600);
  // `health` rides in the ceiling so a reader has a granted op that the own-star scope guard does not
  // gate (the fixture's index carries no scope stamp, and this star.yaml makes recall ask for one).
  const face = await startFace({ face: "broker", vault, bind: "127.0.0.1", port: 0, actorMapPath: mapPath, opNames: ["recall", "remember", "health"] }, deps);
  return { face, deps, vault, mapPath };
}

test("RAI-158: a v2 access file and --capability together refuse startup; a v2 file alone serves", async () => {
  const { vault, deps, capFile } = await makeFixture();
  const mapPath = join(vault, ".access.json");
  writeFileSync(mapPath, accessFileV2({ "claude@host-b": { token: TOK_AGENT, role: "agent", stars: ["*"] } }));
  chmodSync(mapPath, 0o600);
  await expect(startFace({ face: "broker", vault, bind: "127.0.0.1", port: 0, capabilityPath: capFile, actorMapPath: mapPath }, deps))
    .rejects.toThrow(/drop --capability/);
  // a v2 file that does not validate refuses startup, as a v1 map always did
  writeFileSync(mapPath, JSON.stringify({ version: 2, roles: { agent: { ops: ["remember", "link"] } }, actors: {} }));
  await expect(startFace({ face: "broker", vault, bind: "127.0.0.1", port: 0, actorMapPath: mapPath }, deps))
    .rejects.toThrow(/unknown or internal operation "link"/);
  await deps.close();
});

test("RAI-158: two actors on one broker — tools/list is the ceiling ∩ the role; agent remembers, reader is refused naming actor and op", async () => {
  const { face, vault } = await multiActorBroker();
  try {
    const agent = await mcpClient(face.url, { "x-twinkling-capability": TOK_AGENT });
    const reader = await mcpClient(face.url, { "x-twinkling-capability": TOK_READER });
    try {
      expect((await agent.listTools()).tools.map((t) => t.name).sort()).toEqual(["health", "recall", "remember"]);
      expect((await reader.listTools()).tools.map((t) => t.name).sort()).toEqual(["health", "recall"]);
      const rem = await agent.callTool({ name: "remember", arguments: { title: "Agent memory", body: "written by the agent actor" } });
      expect(rem.isError ?? false).toBe(false);
      const denied = await reader.callTool({ name: "remember", arguments: { title: "Reader memory", body: "must never land" } });
      expect(denied.isError).toBe(true);
      expect(textOf(denied)).toContain('operation remember: not granted to actor "sibling@host-a"');
      const h = await reader.callTool({ name: "health", arguments: {} });
      expect(h.isError ?? false).toBe(false); // a granted op passes the same check
      expect(existsSync(join(vault, "out_memory"))).toBe(true);
      expect(readdirSync(join(vault, "out_memory")).map((f) => readFileSync(join(vault, "out_memory", f), "utf8")).join("\n")).not.toContain("must never land");
    } finally {
      await agent.close();
      await reader.close();
    }
  } finally {
    await face.close();
  }
});

test("RAI-158: the ADR-0005 audit line names the CALLING actor, not the process", async () => {
  const { face } = await multiActorBroker();
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    lines.push(String(chunk));
    return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    const agent = await mcpClient(face.url, { "x-twinkling-capability": TOK_AGENT });
    try {
      const rem = await agent.callTool({ name: "remember", arguments: { title: "Audited", body: "the audit line names me" } });
      expect(rem.isError ?? false).toBe(false);
    } finally {
      await agent.close();
    }
  } finally {
    process.stderr.write = write;
    await face.close();
  }
  expect(lines.some((l) => l.includes("funes write-designation") && l.includes("op=remember") && l.includes("actor=claude@host-b"))).toBe(true);
});

test("RAI-158: no token or an unknown token is 401; a grant for another star is 403 — before any dispatch", async () => {
  const { face } = await multiActorBroker();
  try {
    expect((await raw(face.port, { path: "/health" })).status).toBe(401);
    expect((await raw(face.port, { method: "POST", path: "/mcp" })).status).toBe(401);
    expect((await raw(face.port, { path: "/health", headers: { "x-twinkling-capability": "guessed" } })).status).toBe(401);
    const elsewhere = await raw(face.port, { method: "POST", path: "/mcp", headers: { "x-twinkling-capability": TOK_ELSEWHERE } });
    expect(elsewhere.status).toBe(403);
    expect((JSON.parse(elsewhere.body) as { error: string }).error).toBe('actor "other@host-a" holds no grant for this star');
    expect((await raw(face.port, { path: "/health", headers: { "x-twinkling-capability": TOK_ELSEWHERE } })).status).toBe(403); // /health bypasses dispatch
    expect((await raw(face.port, { path: "/health", headers: { "x-twinkling-capability": TOK_AGENT } })).status).toBe(200);
  } finally {
    await face.close();
  }
});

test("RAI-158: the file is re-read per request — a same-size hash swap under a restored mtime revokes; a malformed rewrite refuses everyone", async () => {
  const { face, mapPath } = await multiActorBroker();
  const health = (tok: string) => raw(face.port, { path: "/health", headers: { "x-twinkling-capability": tok } }).then((r) => r.status);
  try {
    // a whole-second mtime, so the restore below round-trips to the NANOSECOND: utimes takes a Date,
    // which drops the sub-millisecond part, and a fractional original would move and give the swap away
    const t0 = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    utimesSync(mapPath, t0, t0);
    expect(await health(TOK_AGENT)).toBe(200);
    const before = statSync(mapPath);
    const swapped = readFileSync(mapPath, "utf8").replace(sha256hex(TOK_AGENT), sha256hex("tok-rotated-for-tests"));
    expect(swapped.length).toBe(before.size); // same size: an (mtime, size) cache key could not see this
    writeFileSync(mapPath, swapped);
    utimesSync(mapPath, before.atime, before.mtime);
    expect(statSync(mapPath, { bigint: true }).mtimeNs).toBe(BigInt(t0.getTime()) * 1_000_000n); // an (mtime, size) key sees nothing
    expect(await health(TOK_AGENT)).toBe(401);                 // revoked on the very next request
    expect(await health("tok-rotated-for-tests")).toBe(200);   // and the new token is in
    const good = readFileSync(mapPath, "utf8");
    writeFileSync(mapPath, good.replace('"version":2', '"version":"2"')); // no longer version 2
    expect(await health("tok-rotated-for-tests")).toBe(401);
    expect(await health(TOK_READER)).toBe(401);
    writeFileSync(mapPath, good.replace(sha256hex(TOK_READER), sha256hex(TOK_READER).toUpperCase())); // an uppercase hash
    expect(await health("tok-rotated-for-tests")).toBe(401);
    writeFileSync(mapPath, good);
    expect(await health("tok-rotated-for-tests")).toBe(200);
    writeFileSync(mapPath, '{ "version": 2, "actors": ');      // a half-written file
    expect(await health("tok-rotated-for-tests")).toBe(401);
    expect(await health(TOK_READER)).toBe(401);
  } finally {
    await face.close();
  }
});

test("RAI-158: an actor that may not write is refused BEFORE the publication fence — it never queues on the writer's lock", async () => {
  const { face, deps } = await multiActorBroker();
  const reader = await mcpClient(face.url, { "x-twinkling-capability": TOK_READER });
  const gate = Promise.withResolvers<void>();
  const held = withPublicationFence(deps.home, () => gate.promise);
  try {
    await Bun.sleep(10); // let the holder take it
    const t = performance.now();
    const denied = await reader.callTool({ name: "remember", arguments: { title: "Queued", body: "must not wait" } });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain('operation remember: not granted to actor "sibling@host-a"');
    expect(performance.now() - t).toBeLessThan(2_000); // the fence is still held: a fenced refusal would wait for it
  } finally {
    gate.resolve();
    await held;
    await reader.close();
    await face.close();
  }
});

test("RAI-158: a v1 map keeps today's meaning at REQUEST time — one capability, one actor, named in the audit line", async () => {
  const { vault, deps, capFile } = await makeFixture();
  const goodMap = join(vault, ".actors-ok.json");
  writeFileSync(goodMap, JSON.stringify({ [CAP_TOKEN]: "homai" }));
  chmodSync(goodMap, 0o600);
  const mapped = await startFace({ face: "broker", vault, bind: "127.0.0.1", port: 0, capabilityPath: capFile, actorMapPath: goodMap }, deps);
  try {
    expect((await raw(mapped.port, { path: "/health", headers: { "x-twinkling-capability": CAP_TOKEN } })).status).toBe(200);
    expect((await raw(mapped.port, { path: "/health", headers: { "x-twinkling-capability": "guessed" } })).status).toBe(401);
    const stderr = spyOn(process.stderr, "write");
    try {
      const client = await mcpClient(mapped.url, { "x-twinkling-capability": CAP_TOKEN });
      try {
        const rem = await client.callTool({ name: "remember", arguments: { title: "Mapped", body: "a v1 map names this actor" } });
        expect(rem.isError ?? false).toBe(false);
      } finally { await client.close(); }
      expect(stderr.mock.calls.map((c) => String(c[0])).some((l) => l.includes("op=remember") && l.includes("actor=homai"))).toBe(true);
    } finally { stderr.mockRestore(); }
  } finally {
    await mapped.close();
  }
});

// ── RAI-160 (PLAN-0.4.0 item 23): remember over the tailnet — the five conditions ───────────────
test("RAI-160: Tailscale's ranges, and nothing else", () => {
  for (const a of ["100.64.0.1", "100.127.255.254", "fd7a:115c:a1e0::1", "fd7a:115c:a1e0:ab12::7"]) expect(isTailscaleAddress(a)).toBe(true);
  for (const a of ["100.63.255.255", "100.128.0.1", "192.168.1.5", "10.0.0.7", "127.0.0.1", "fd7a:115c:a1e1::1", "fd00::1", "::1"]) expect(isTailscaleAddress(a)).toBe(false);
});

/** A vault whose star.yaml declares its writer, a v2 access file, and the five conditions all met. */
function remoteBrokerFixture(vault: string) {
  writeFileSync(join(vault, "star.yaml"), "meta:\n  id: git://rainblow.ing/funes\n  write_authority: member-local\n  write_locus: host-a\n");
  const mapPath = join(vault, ".access.json");
  writeFileSync(mapPath, accessFileV2({ "claude@host-b": { token: TOK_AGENT, role: "agent", stars: ["rainblow.ing/funes"] } }));
  chmodSync(mapPath, 0o600);
  const bind = "100.100.201.202"; // a Tailscale address this host does not own — never the host's real one
  return {
    mapPath, bind,
    opts: { face: "broker" as const, vault, bind, bindAllow: bind, port: 0, actorMapPath: mapPath, expectedHost: "host-a.example.ts.net:8787", locus: "host-a", writeDesignation: "audit", opNames: ["recall", "remember"] },
  };
}

test("RAI-160: assertRemoteBroker — each of the five conditions refuses on its own, naming its repair", () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-face-remote-"));
  writeFileSync(join(vault, "star.yaml"), "meta:\n  id: git://rainblow.ing/funes\n  write_authority: member-local\n  write_locus: host-a\n");
  const ok = {
    multiActor: true, expectedHost: "host-a.example.ts.net:8787", vault, bind: "100.100.201.202", env: {},
    designation: resolveWriteDesignation(vault, { locus: "host-a", mode: "audit", env: {} }),
  };
  expect(() => assertRemoteBroker(ok)).not.toThrow();
  expect(() => assertRemoteBroker({ ...ok, multiActor: false })).toThrow(/no version-2 access file is loaded.*--actor-map/);
  expect(() => assertRemoteBroker({ ...ok, expectedHost: undefined })).toThrow(/--host is required/);
  expect(() => assertRemoteBroker({ ...ok, designation: resolveWriteDesignation(vault, { locus: "host-b", mode: "audit", env: {} }) }))
    .toThrow(/verdict is "mismatch".*pass that machine.s own name as --locus/);
  expect(() => assertRemoteBroker({ ...ok, designation: resolveWriteDesignation(vault, { locus: "host-a", mode: "off", env: {} }) }))
    .toThrow(/verdict is "off"/);
  expect(() => assertRemoteBroker({ ...ok, designation: resolveWriteDesignation(vault, { mode: "audit", env: {} }) })).toThrow(/verdict is "unidentified"/);
  const undeclared = mkdtempSync(join(tmpdir(), "funes-face-remote-"));
  writeFileSync(join(undeclared, "star.yaml"), "meta:\n  id: git://rainblow.ing/funes\n");
  expect(() => assertRemoteBroker({ ...ok, vault: undeclared, designation: resolveWriteDesignation(undeclared, { locus: "host-a", mode: "audit", env: {} }) }))
    .toThrow(/verdict is "undeclared"/);
  // Before RAI-130 the authority was read from write_authority — twinkling's POLICY value, claimable
  // by any process with `--locus member-local`. PLAN-0.4.0 item 10 reads write_locus: the policy
  // value beside it (the fixture above carries it, as every estate star.yaml does) names nobody, so
  // claiming it is an ordinary mismatch, and a star that declares only the policy declares no writer.
  expect(() => assertRemoteBroker({ ...ok, designation: resolveWriteDesignation(vault, { locus: "member-local", mode: "audit", env: {} }) }))
    .toThrow(/verdict is "mismatch"/);
  const policy = mkdtempSync(join(tmpdir(), "funes-face-remote-"));
  writeFileSync(join(policy, "star.yaml"), "meta:\n  id: git://rainblow.ing/funes\n  write_authority: member-local\n");
  expect(() => assertRemoteBroker({ ...ok, vault: policy, designation: resolveWriteDesignation(policy, { locus: "member-local", mode: "audit", env: {} }) }))
    .toThrow(/verdict is "undeclared"/);
  // The belt: a policy value written INTO write_locus is still never a writer.
  const misplaced = mkdtempSync(join(tmpdir(), "funes-face-remote-"));
  writeFileSync(join(misplaced, "star.yaml"), "meta:\n  id: git://rainblow.ing/funes\n  write_locus: member-local\n");
  expect(() => assertRemoteBroker({ ...ok, vault: misplaced, designation: resolveWriteDesignation(misplaced, { locus: "member-local", mode: "audit", env: {} }) }))
    .toThrow(/write_locus names a write POLICY \("member-local"\), not a writer machine/);
  expect(() => assertRemoteBroker({ ...ok, bind: "192.168.1.5" })).toThrow(/not a Tailscale address.*never listens on a LAN interface/);
  expect(() => assertRemoteBroker({ ...ok, env: { FUNES_COORDINATION_DIR: "/tmp/x" } })).toThrow(/FUNES_COORDINATION_DIR is set.*Unset it/);
});

test("RAI-160: startFace off loopback — a LAN address the allowlist names still refuses; with all five, only the kernel's bind can fail", async () => {
  const { vault, deps } = await makeFixture();
  const f = remoteBrokerFixture(vault);
  try {
    await expect(startFace({ ...f.opts, bind: "192.168.1.5", bindAllow: "192.168.1.5" }, deps)).rejects.toThrow(/not a Tailscale address/);
    // each of the five, through startFace's own wiring (not only the unit)
    await expect(startFace({ ...f.opts, actorMapPath: undefined, capabilityPath: join(vault, ".cap") }, deps)).rejects.toThrow(/no version-2 access file/);
    await expect(startFace({ ...f.opts, expectedHost: undefined }, deps)).rejects.toThrow(/--host is required/);
    await expect(startFace({ ...f.opts, locus: "host-b" }, deps)).rejects.toThrow(/verdict is "mismatch"/);
    process.env.FUNES_COORDINATION_DIR = join(vault, ".coord");
    try {
      await expect(startFace(f.opts, deps)).rejects.toThrow(/FUNES_COORDINATION_DIR is set/);
    } finally {
      delete process.env.FUNES_COORDINATION_DIR;
    }
    await expect(startFace({ ...f.opts, opNames: ["recall", "remember", "page"] }, deps)).rejects.toThrow(/refused unconditionally/);
    await expect(startFace({ ...f.opts, opNames: ["recall", "remember", "forget"] }, deps)).rejects.toThrow(/LOOPBACK broker only/);
    // a remote broker that serves no write needs none of the five (the read surface of 0.3.0 item 22)
    let listened: RunningFace | null = null;
    try {
      listened = await startFace({ ...f.opts, opNames: ["recall"], actorMapPath: undefined, capabilityPath: join(vault, ".cap") }, deps);
    } catch (e) {
      expect((e as Error).message).toMatch(/Failed to start server|EADDR/); // the kernel's bind, not a refusal
    }
    await listened?.close();
    // all five hold: every startup check passes, and the only thing left to fail is the bind itself
    let face: RunningFace | null = null;
    try {
      face = await startFace(f.opts, deps);
    } catch (e) {
      expect((e as Error).message).toMatch(/Failed to start server|EADDR/); // this host does not own the address
    }
    await face?.close();
  } finally {
    await deps.close();
  }
});

// ── RAI-160: the byte counter in front of the MCP parser, on both faces ─────────────────────────
/** A POST /mcp with full control over the body's framing. `status: 0` = the server reset the
 *  connection, which the plan accepts for an undeclared body past the cap. */
function post(port: number, headers: Record<string, string>, chunks: Array<string | Buffer>, declare: boolean): Promise<{ status: number; body: string }> {
  return new Promise((resolveReq) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/mcp", headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream", ...headers,
      ...(declare ? { "content-length": String(chunks.reduce((n, c) => n + Buffer.byteLength(c), 0)) } : {}),
    } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolveReq({ status: res.statusCode ?? 0, body }));
      res.on("error", () => resolveReq({ status: 0, body }));
    });
    req.on("error", () => resolveReq({ status: 0, body: "" }));
    for (const c of chunks) req.write(c);
    req.end();
  });
}
const rememberCall = (body: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "remember", arguments: { title: "Big", body } } });

test("RAI-160: an over-cap body — declared, chunked, or multibyte — is refused before dispatch and writes no page", async () => {
  const { vault, deps, capFile } = await makeFixture();
  const face = await startFace({ face: "broker", vault, bind: "127.0.0.1", port: 0, capabilityPath: capFile }, deps);
  const cap = { "x-twinkling-capability": CAP_TOKEN };
  try {
    const big = rememberCall("a".repeat(MAX_FACE_BODY_BYTES));
    const declared = await post(face.port, cap, [big], true);
    expect(declared.status).toBe(413);
    for (const r of [
      await post(face.port, cap, [big.slice(0, 600_000), big.slice(600_000)], false), // chunked, undeclared
      await post(face.port, cap, [rememberCall("é".repeat(600_000))], false), // 600k CHARACTERS, 1.2 MB of bytes
    ]) expect([413, 0]).toContain(r.status);
    expect(existsSync(join(vault, "out_memory"))).toBe(false);
    // and under the cap, the same framing still reaches the MCP handler
    const client = await mcpClient(face.url, cap);
    try {
      const ok = await client.callTool({ name: "remember", arguments: { title: "Small", body: "é".repeat(1_000) } });
      expect(ok.isError ?? false).toBe(false);
    } finally { await client.close(); }
  } finally {
    await face.close();
  }
});

test("RAI-160: malformed JSON is answered as JSON-RPC's parse error (400, -32700) on both faces, before the SDK", async () => {
  const { vault, deps, capFile } = await makeFixture();
  const face = await startFace({ face: "broker", vault, bind: "127.0.0.1", port: 0, capabilityPath: capFile }, deps);
  try {
    for (const [port, headers] of [[face.port, { "x-twinkling-capability": CAP_TOKEN }], [read.port, { host: readHost }]] as const) {
      const r = await post(port, headers, ['{"jsonrpc":"2.0", nope'], true);
      expect(r.status).toBe(400);
      expect(JSON.parse(r.body)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    // an unauthenticated body is never read: the credential check answers first
    expect((await post(face.port, {}, ['{"jsonrpc":"2.0", nope'], true)).status).toBe(401);
  } finally {
    await face.close();
  }
});

test("RAI-160: a LOOPBACK broker with --ops …,supersede,forget serves them to a curator and refuses them to an agent", async () => {
  const { vault, deps } = await makeFixture();
  writeFileSync(join(vault, "star.yaml"), "meta:\n  id: git://rainblow.ing/funes\n");
  const mapPath = join(vault, ".access.json");
  writeFileSync(mapPath, JSON.stringify({
    version: 2,
    roles: {
      agent: { ops: ["recall", "remember"] },
      curator: { ops: ["recall", "remember", "supersede", "forget"] },
    },
    actors: {
      "claude@host-b": { token_sha256: sha256hex(TOK_AGENT), role: "agent", stars: ["*"] },
      "operator@host-a": { token_sha256: sha256hex(TOK_READER), role: "curator", stars: ["*"] },
    },
  }));
  chmodSync(mapPath, 0o600);
  const face = await startFace({ face: "broker", vault, bind: "127.0.0.1", port: 0, actorMapPath: mapPath, opNames: ["recall", "remember", "supersede", "forget"] }, deps);
  const agent = await mcpClient(face.url, { "x-twinkling-capability": TOK_AGENT });
  const curator = await mcpClient(face.url, { "x-twinkling-capability": TOK_READER });
  try {
    expect((await agent.listTools()).tools.map((t) => t.name).sort()).toEqual(["recall", "remember"]);
    expect((await curator.listTools()).tools.map((t) => t.name).sort()).toEqual(["forget", "recall", "remember", "supersede"]);
    const rem = await agent.callTool({ name: "remember", arguments: { title: "Draft", body: "an agent's first take" } });
    const { id } = JSON.parse(textOf(rem)) as { id: string };
    const denied = await agent.callTool({ name: "supersede", arguments: { oldId: id, title: "Better", body: "the agent may not" } });
    expect(textOf(denied)).toContain('operation supersede: not granted to actor "claude@host-b"');
    const sup = await curator.callTool({ name: "supersede", arguments: { oldId: id, title: "Better", body: "the curator's correction" } });
    expect(sup.isError ?? false).toBe(false);
    const succ = JSON.parse(textOf(sup)) as { id: string; supersedes: string };
    expect(succ.supersedes).toBe(id);
    const forget = await curator.callTool({ name: "forget", arguments: { id: succ.id } });
    expect(forget.isError ?? false).toBe(false);
  } finally {
    await agent.close();
    await curator.close();
    await face.close();
  }
});

/** Raw socket: send the request head and `body`, never end, and report the first status line seen
 *  within `ms` — proving the face answered WITHOUT waiting for (or reading) the rest of the body. */
async function firstStatus(port: number, head: string, body: string, ms = 1_500): Promise<string> {
  const { connect } = await import("node:net");
  return new Promise((resolveLine) => {
    const sock = connect(port, "127.0.0.1", () => sock.write(head + "\r\n\r\n" + body));
    let got = "";
    const done = (line: string) => { clearTimeout(timer); sock.destroy(); resolveLine(line); };
    const timer = setTimeout(() => done("TIMEOUT"), ms);
    sock.on("data", (c) => { got += c.toString(); const nl = got.indexOf("\r\n"); if (nl >= 0) done(got.slice(0, nl)); });
    sock.on("error", () => done(got.slice(0, got.indexOf("\r\n")) || "RESET"));
  });
}

test("RAI-160: the cap is not POST-only — any other method with a body is refused unread (405), and a declared over-cap POST is 413 before its body", async () => {
  const host = `host: ${readHost}`;
  // the credential-free read face: a DELETE declaring 4 MiB, and a chunked PUT that never ends
  expect(await firstStatus(read.port, `DELETE /mcp HTTP/1.1\r\n${host}\r\ncontent-length: ${4 << 20}`, "0123456789")).toMatch(/^HTTP\/1\.1 405/);
  expect(await firstStatus(read.port, `PUT /mcp HTTP/1.1\r\n${host}\r\ntransfer-encoding: chunked`, "a\r\n0123456789\r\n")).toMatch(/^HTTP\/1\.1 405/);
  // a POST that DECLARES more than the cap is answered before a byte past the head is needed
  expect(await firstStatus(read.port, `POST /mcp HTTP/1.1\r\n${host}\r\ncontent-type: application/json\r\ncontent-length: ${MAX_FACE_BODY_BYTES + 1}`, "{")).toMatch(/^HTTP\/1\.1 413/);
  // GET still reaches the SDK (its own answer, not the face's 405)
  const get = await raw(read.port, { method: "GET", path: "/mcp", headers: { host: readHost, accept: "text/event-stream" } });
  expect(get.body).not.toContain("method not allowed on /mcp");
});

test("RAI-160: a leading UTF-8 BOM is dropped, as the SDK's own decoding did", async () => {
  const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bom", version: "0" } } });
  const r = await post(read.port, { host: readHost }, [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(init)])], true);
  expect(r.status).toBe(200);
});

test("RAI-160: a curator's supersede and forget on a loopback broker take the publication fence, like remember", async () => {
  const { vault, deps } = await makeFixture();
  const mapPath = join(vault, ".access.json");
  writeFileSync(mapPath, JSON.stringify({
    version: 2,
    roles: { curator: { ops: ["recall", "remember", "supersede", "forget"] } },
    actors: { "operator@host-a": { token_sha256: sha256hex(TOK_READER), role: "curator", stars: ["*"] } },
  }));
  chmodSync(mapPath, 0o600);
  const face = await startFace({ face: "broker", vault, bind: "127.0.0.1", port: 0, actorMapPath: mapPath, opNames: ["recall", "remember", "supersede", "forget"] }, deps);
  const curator = await mcpClient(face.url, { "x-twinkling-capability": TOK_READER });
  try {
    const { id } = JSON.parse(textOf(await curator.callTool({ name: "remember", arguments: { title: "Draft", body: "first take" } }))) as { id: string };
    let target = id;
    for (const [op, args] of [["supersede", () => ({ oldId: target, title: "Better", body: "the correction" })], ["forget", () => ({ id: target })]] as const) {
      const events: string[] = [];
      const gate = Promise.withResolvers<void>();
      const held = withPublicationFence(deps.home, async () => { events.push("fence:acquired"); await gate.promise; events.push("fence:released"); });
      await Bun.sleep(10);
      const call = curator.callTool({ name: op, arguments: args() }).then((r) => { events.push(`${op}:done`); return r; });
      await Bun.sleep(300);
      gate.resolve();
      const [, out] = await Promise.all([held, call]);
      expect(out.isError ?? false).toBe(false);
      expect(events).toEqual(["fence:acquired", "fence:released", `${op}:done`]);
      if (op === "supersede") target = (JSON.parse(textOf(out)) as { id: string }).id;
    }
  } finally {
    await curator.close();
    await face.close();
  }
});
