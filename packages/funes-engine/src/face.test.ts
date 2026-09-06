import { test, expect, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import type { Embedder } from "funes-core";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startFace, makeFaceDeps, resolveBrokerOps, resolveFaceOps, assertBindPolicy, isLoopbackBind, DEFAULT_BIND_ALLOW, DEFAULT_BROKER_OPS, DEFAULT_READ_OPS, type FaceDeps, type RunningFace } from "./face.ts";
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
  // the broker is not exempt: `remember` writes canonical markdown, so a broker is loopback-only
  expect(() => resolveFaceOps("broker", undefined, remote)).toThrow(/filesystem-served/);
  expect(resolveFaceOps("broker", ["recall"], remote).map((o) => o.name)).toEqual(["recall"]);
});

test("face op resolution: broker admits remember ONLY among mutations; read allowlist is read-only + internal-free", () => {
  expect(resolveBrokerOps(operations, ["recall", "remember"]).map((o) => o.name)).toEqual(["recall", "remember"]);
  expect(() => resolveBrokerOps(operations, [])).toThrow(/fail-closed/);
  expect(() => resolveBrokerOps(operations, ["recall", "supersede"])).toThrow(/remember ONLY/);
  expect(() => resolveBrokerOps(operations, ["recall", "forget"])).toThrow(/remember ONLY/);
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
  await expect(startFace({ face: "broker", vault, bind: "127.0.0.1", port: 0, capabilityPath: capFile, actor: "not a name" }, deps))
    .rejects.toThrow(/not a usable actor name/);
  // item 25: `enforce` is refused at configuration, not offered as a flag this release honours
  await expect(startFace({ face: "broker", vault, bind: "127.0.0.1", port: 0, capabilityPath: capFile, writeDesignation: "enforce" }, deps))
    .rejects.toThrow(/not available in this release/);
  await deps.close();
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
