#!/usr/bin/env bun
// The memory service's HTTP faces (canon re-homing plan Rev 6, Phase R1 item 5 / Phase R2 items
// 8-9; conformance review majors #6 + the bind minor) — ONE module, TWO principals, launched as
// two processes by the composition:
//
//   --face broker   the LOCAL remember broker: homai's ONLY memory path (R3#7 — the agent holds no
//                   vault/index mount). Serves EXACTLY recall+remember (star.yaml binding:
//                   agent-own-brain — write authority is `remember` ONLY, R2#10; supersede/forget/
//                   link/elevate refuse at STARTUP, before a byte is served) behind a mounted
//                   capability file checked per request (401 without/wrong).
//   --face read     the TAILNET read face: read-only ops over the canon checkout + index, NO vault
//                   write, NO git credential, NO capability — a parser bug here escalates to
//                   nothing (R4#1). Browser-origin hardening per R2#13: exact expected Host
//                   (--host, the MagicDNS name — REQUIRED on this face), any Origin/Sec-Fetch-*
//                   request rejected, ZERO CORS headers ever emitted. The `page` op serves page
//                   bodies from canon — stated, not assumed (R5-cleanup).
//
// Cross-face smuggling (R4#3) is structural AND checked at dispatch: the faces are separate
// PROCESSES on separate ports with separate op allowlists, and every tools/call re-checks the
// face's allowlist BEFORE the registry — a tailnet request naming a broker verb dies at dispatch
// even if a listing/transport bug let it in. The negative test for this is GENERATED from the full
// op registry (face.test.ts) — registry growth can never reopen the surface.
//
// Bind policy (review minor): an EXPLICIT --bind is REQUIRED, and "0.0.0.0"/"::" is REFUSED unless
// FACE_PUBLISH_PINNED=1. That env var documents the compose-publish topology: the CONTAINER binds
// all interfaces (its netns has only lo + the bridge), and the HOST-side publish pins the
// tailscale IP (compose `ports: "100.x.y.z:8788:8788"`) — the pin is the composition's assertion,
// so it must be stated, never assumed.
//
// Generation-aware serving (R5#2, unified 2026-07-16): on the libsql backend the face is ALWAYS a
// publication-protocol consumer over ONE home — `--home` (the dir the sidecar's `funes publish
// --home` writes generation.json + gen-*.db into) or the default index dir. Manifest published ⇒
// serve that generation, re-checked per op; none yet ⇒ DIRECT fallback onto the static index path,
// with the first publish adopted on the next op (no restart). The chosen mode is logged LOUDLY at
// startup — a face homed away from its publisher shows "DIRECT" instead of silently never swapping
// (the split-home bug: broker homed at /index/star, sidecar publishing /index). The READ face opens
// every store read-only (mode=ro; libsql-only — crash-fix for RO index mounts + defense in depth
// under the op allowlist); the broker stays RW.
//
// Transport: MCP streamable-HTTP (POST /mcp, stateless JSON mode — a fresh Server+transport pair
// per request over the leased store), matching pydantic-ai/fastmcp's StreamableHttpTransport.
// Plus GET /health (JSON; capability-gated on the broker): {star, locus, role, generation, dirty}
// from LIVE index health (R1#16) — never a static string.
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Embedder } from "funes-core";
import type { FunesIndexStore } from "./store.ts";
import { FunesStore } from "./funes-store.ts";
import { funesBackend, funesDbDir, makeStore, readStarIdentity } from "./factory.ts";
import { operations, buildToolDefs, dispatchToolCall, type Operation, type OperationContext } from "./ops.ts";
import { resolveExposedOps } from "./mcp-config.ts";
import { hasPublishedGeneration, PublishedIndex, writePrincipalStatus } from "./publication.ts";
import { withCoordination } from "./coordination.ts";

export type FaceKind = "broker" | "read";

export const DEFAULT_BROKER_OPS = ["recall", "remember"] as const;
export const DEFAULT_READ_OPS = ["recall", "indexed_page", "page", "tree", "neighbors", "graph", "health", "hotlist"] as const;

// ── op allowlists, fail-closed at startup ────────────────────────────────────────────────────────
/** broker: the agent-own-brain surface — mirrors mcp-config.resolveExposedOps's fail-closed shape
 *  (empty/unknown/internal refuse) but admits ONE mutation: `remember`. resolveExposedOps itself
 *  refuses every mutation, which is right for cross-star/runtime surfaces and would refuse this
 *  face's whole reason to exist — so the broker resolver is separate and STRICTER about which
 *  mutation may appear, not looser about mutations in general. */
export function resolveBrokerOps(all: Operation[], names: string[]): Operation[] {
  if (names.length === 0) throw new Error("broker ops: empty allowlist — refusing to serve (fail-closed)");
  const byName = new Map(all.map((o) => [o.name, o]));
  const picked: Operation[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const op = byName.get(name);
    if (!op || op.internal) throw new Error(`broker ops: unknown operation "${name}" — refusing to serve (fail-closed)`);
    if (!op.readonly && op.name !== "remember") {
      throw new Error(`broker ops: mutating operation "${name}" — an agent-own-brain surface's write authority is remember ONLY (R2#10); refusing to serve`);
    }
    if (!seen.has(name)) { seen.add(name); picked.push(op); }
  }
  return picked;
}

/** Resolve a face's exposed ops from its allowlist (defaults above), fail-closed before serving. */
export function resolveFaceOps(face: FaceKind, opNames?: string[]): Operation[] {
  const names = opNames && opNames.length ? opNames : [...(face === "broker" ? DEFAULT_BROKER_OPS : DEFAULT_READ_OPS)];
  return face === "broker"
    ? resolveBrokerOps(operations, names)
    : resolveExposedOps(operations, { readonly: false, ops: names, crossStar: false });
}

/** Bind policy (review minor): explicit bind required; all-interfaces refused unless the
 *  composition ASSERTS the host-side publish pins a specific IP (FACE_PUBLISH_PINNED=1). */
export function assertBindPolicy(bind: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (!bind || !bind.trim()) {
    throw new Error("face: an EXPLICIT --bind address is required — this face never guesses its exposure");
  }
  const b = bind.trim();
  if ((b === "0.0.0.0" || b === "::" || b === "*") && env.FACE_PUBLISH_PINNED !== "1") {
    throw new Error(
      `face: refusing to bind ${b} — all-interfaces is only legal when the composition pins the host publish ` +
      "to a specific IP and asserts it with FACE_PUBLISH_PINNED=1 (compose: `ports: \"<tailscale-ip>:port:port\"`)",
    );
  }
  return b;
}

/** One leased serving context: the store (possibly a freshly swapped generation), its write-through
 *  wrapper, and the generation actually served (null = unpublished/static index). */
export interface ServeContext {
  store: FunesIndexStore;
  funes: FunesStore;
  generation: string | null;
}

export interface FaceDeps {
  /** Lease a serving context for ONE request (the publication-protocol consumer seam — swap
   *  detection happens here). Tests inject a static store through this. */
  withStore<T>(fn: (ctx: ServeContext) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface FaceOpts {
  face: FaceKind;
  vault: string;
  /** EXPLICIT bind address (assertBindPolicy). */
  bind: string;
  /** 0 = ephemeral (tests). */
  port: number;
  /** broker: REQUIRED capability token file. read: FORBIDDEN (credential-free by design). */
  capabilityPath?: string;
  /** read: REQUIRED exact host[:port] clients must present (R2#13). broker: optional. */
  expectedHost?: string;
  opNames?: string[];
  /** Explicit index db path (--db). libsql: the index FILE; pglite: the pgdata dir. */
  dbDir?: string;
  /** The publication HOME (--home): the dir the sidecar's `funes publish --home` writes
   *  generation.json + gen-*.db into. MUST match the publisher's home, or the face never sees a
   *  swap (the split-home bug). Defaults to the dir the index db resolves into. */
  home?: string;
  /** Self-description metadata for /health — the composition states them (machine-local
   *  materialization metadata, R3#3), the face only reports. */
  locus?: string;
  role?: string;
  star?: string;
}

export interface FaceStoreOpts {
  face: FaceKind;
  /** Explicit index db path (--db). */
  dbDir?: string;
  /** Explicit publication home (--home) — see FaceOpts.home. */
  home?: string;
  /** Test seam (matches makeStore's opts.embedder) — production leaves it for the E5 default. */
  embedder?: Embedder;
}

/** R2-3: is this a WAL-mode SQLite db (header byte 18 == 2)? Zero-write; false for absent/unreadable
 *  (the RO open reports those). Used only to give the read face a clear WAL-specific startup refusal. */
function isWalHeader(dbPath: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(dbPath, "r");
    const head = Buffer.alloc(20);
    if (readSync(fd, head, 0, 20, 0) < 20) return false;
    return head.toString("latin1", 0, 16) === "SQLite format 3\0" && head[18] === 2;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Production store resolution. libsql: ALWAYS the publication consumer over ONE home — published
 *  manifest ⇒ that generation (re-checked per op), none ⇒ DIRECT fallback onto the static index
 *  path with late adoption of the first publish. The READ face opens every store read-only
 *  (mode=ro): crash-fix for RO index mounts + defense in depth under the op allowlist. pglite/
 *  postgres: static direct open (no publication protocol; read-only faces refuse — no RO path).
 *
 *  F8: the pre-2026-07-16 signature was `makeFaceDeps(vault, dbDir?: string)` — a READ-WRITE open,
 *  which is exactly what face:'broker' is now. The string overload keeps that call shape compiling
 *  and behaving as before (broker semantics, the given --db path). */
export async function makeFaceDeps(vault: string, dbDir?: string): Promise<FaceDeps>;
export async function makeFaceDeps(vault: string, opts: FaceStoreOpts): Promise<FaceDeps>;
export async function makeFaceDeps(vault: string, arg?: string | FaceStoreOpts): Promise<FaceDeps> {
  const opts: FaceStoreOpts = arg == null || typeof arg === "string" ? { face: "broker", dbDir: arg } : arg;
  const backend = funesBackend();
  const readonly = opts.face === "read";
  if (readonly && backend !== "libsql") {
    throw new Error(`face read: read-only faces are libsql-only today (FUNES_BACKEND=${backend}) — the pglite/postgres backends have no RO open path`);
  }
  const dbPath = opts.dbDir ?? (opts.home != null && backend === "libsql" ? join(opts.home, "index.db") : funesDbDir(vault, backend));
  const home = opts.home ?? (backend === "libsql" ? dirname(dbPath) : dbPath);
  // R2-4: a WeakMap so retired-generation store wrappers are collectable — a long-lived face swaps
  // generations for the process lifetime; a strong Map would retain every retired store forever.
  const funesFor = new WeakMap<FunesIndexStore, FunesStore>();
  const wrap = (store: FunesIndexStore): FunesStore => {
    let f = funesFor.get(store);
    if (!f) { f = new FunesStore(store, { root: vault }); funesFor.set(store, f); }
    return f;
  };
  if (backend === "libsql") {
    // R2-3: the READ face opens mode=ro, which cannot map WAL's -shm. A pre-2026-07-16 DIRECT live
    // index (no manifest published) is typically WAL-mode — refuse at STARTUP with the repair,
    // rather than let the eager RO open below fail with a cryptic "cannot open index read-only".
    if (readonly && !hasPublishedGeneration(home) && isWalHeader(dbPath)) {
      throw new Error(
        `face read: the DIRECT live index at ${dbPath} is WAL-mode and cannot be served read-only — ` +
        "publish a finalized generation first (funes publish [--force]), then serve the read face from its home.",
      );
    }
    const open = (p: string) =>
      readonly
        ? makeStore({ dbDir: p, backend, readonly: true, embedder: opts.embedder }) // no vault: the owner-marker guard WRITES, and the mount may be RO
        : makeStore({ vault, dbDir: p, backend, embedder: opts.embedder }); // collision/identity guard runs; dirty index → loud error
    // P1.6d: this face is a principal in the publication home — it records the generation it serves
    // to a status file (keyed by face kind) on every swap, so the publisher's retain-until-ack GC
    // keeps a retired generation until this principal has moved off it.
    const published = new PublishedIndex(home, open, {
      fallbackDbPath: dbPath,
      onServe: (generation) => writePrincipalStatus(home, opts.face, generation),
    });
    await published.with(async () => {}); // eager first open: an absent/invalid index fails STARTUP, loudly
    process.stderr.write(
      published.generation
        ? `face ${opts.face}: mode PUBLISHED — generation ${published.generation} from ${home} (manifest re-checked per op)\n`
        : `face ${opts.face}: mode DIRECT — live index at ${dbPath}; no generation.json in ${home} yet (a publish there is adopted without restart)\n`,
    );
    return {
      withStore: (fn) => published.with((store, generation) => fn({ store, funes: wrap(store), generation })),
      close: () => published.close(),
    };
  }
  const store = await makeStore({ vault, dbDir: dbPath, backend, embedder: opts.embedder }); // dirty index → loud error
  process.stderr.write(`face ${opts.face}: mode DIRECT — live ${backend} index at ${dbPath} (no publication protocol on this backend)\n`);
  return {
    withStore: async (fn) => fn({ store, funes: wrap(store), generation: await store.getGeneration() }),
    close: () => store.close(),
  };
}

export interface RunningFace {
  server: HttpServer;
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function startFace(opts: FaceOpts, deps?: FaceDeps): Promise<RunningFace> {
  if (opts.face !== "broker" && opts.face !== "read") {
    throw new Error("face: --face broker|read is required (two principals, never one)");
  }
  if (opts.face === "broker" && !opts.capabilityPath) {
    throw new Error("face broker: --capability <mounted token file> is required — the broker never serves ambiently");
  }
  if (opts.face === "read" && opts.capabilityPath) {
    throw new Error("face read: --capability is not accepted — the tailnet reader is credential-free BY DESIGN (R4#1: nothing to steal)");
  }
  if (opts.face === "read" && !opts.expectedHost) {
    throw new Error("face read: --host <magicdns-host[:port]> is required — exact-Host enforcement is not optional on the tailnet face (R2#13)");
  }
  const bind = assertBindPolicy(opts.bind);
  const exposed = resolveFaceOps(opts.face, opts.opNames); // fail-closed BEFORE a socket opens
  const vault = resolve(opts.vault);
  const starName = opts.star ?? readStarIdentity(vault).name ?? basename(vault);
  const locus = opts.locus ?? "unknown";
  const role = opts.role ?? "unknown";
  const resolved = deps ?? (await makeFaceDeps(vault, { face: opts.face, dbDir: opts.dbDir, home: opts.home }));

  // ── capability check (broker) — constant-time, fail-closed, re-read per request (rotation) ────
  const capabilityOk = (presented: string): boolean => {
    let expected: string;
    try {
      expected = readFileSync(opts.capabilityPath!, "utf8").trim();
    } catch {
      return false; // unreadable/missing capability file ⇒ NOBODY is authorized, never everybody
    }
    if (!expected || !presented) return false;
    // hash both sides to equal length — timingSafeEqual demands it, and it keeps the comparison
    // constant-time without leaking the expected token's length
    const a = createHash("sha256").update(presented).digest();
    const b = createHash("sha256").update(expected).digest();
    return timingSafeEqual(a, b);
  };

  const refuse = (res: ServerResponse, status: number, message: string): void => {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: message }));
  };

  // ── per-request MCP server (stateless streamable-HTTP; the SDK pattern for sessionless serving) ─
  // The store is leased PER CALL (not per request): a read leases just long enough to answer; a
  // broker mutation leases + writes UNDER the coordination lock (below), so the two need different
  // wrapping and the lease can't span both.
  const buildMcpServer = (): Server => {
    const server = new Server({ name: `funes-${opts.face}`, version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: buildToolDefs(exposed) }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args = {} } = req.params;
      try {
        // dispatch-time allowlist recheck (belt over the exposed-set braces): an op this face does
        // not serve must never reach the registry, whatever a client lists or guesses (R4#3)
        const op = exposed.find((o) => o.name === name);
        if (!op) {
          throw new Error(`operation ${name}: not on the ${opts.face} face's allowlist`);
        }
        const run = (sctx: ServeContext) =>
          dispatchToolCall(exposed, name, args as Record<string, unknown>, {
            remote: true, trust: "untrusted", vault, store: sctx.store, funes: sctx.funes,
          } as OperationContext);
        // Codex R1#1: a broker MUTATION must lease its generation AND write UNDER the coordination
        // lock, re-reading the manifest inside it (withStore's maybeSwap), so a concurrent publisher
        // can't atomically swap + POSIX-unlink the generation between the lease and the write — a
        // write into a retired, unlinked db is a SILENT loss. Reads never lock: the per-op lease
        // alone keeps a torn read impossible while a publish swaps the pointer. withCoordination is
        // pass-through unless FUNES_COORDINATION_DIR is set (Mac single-process unchanged), and it is
        // reentrant with funes.remember's own coordination frame (same async owner, P1.6c).
        const result = opts.face === "broker" && !op.readonly
          ? await withCoordination(() => resolved.withStore(run))
          : await resolved.withStore(run);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `error: ${(e as Error).message}` }], isError: true };
      }
    });
    return server;
  };

  const health = async (res: ServerResponse): Promise<void> => {
    const body = await resolved.withStore(async (sctx) => {
      const stats = await sctx.store.stats();
      return {
        star: starName,
        locus,                                        // stated by the composition (R3#3), reported live
        role,                                         // canon | follower — never inferred from the repo
        face: opts.face,
        // the LIVE content generation homai's memory block reports (R1#16): the published/stamped
        // generation-v1 value; null = honestly-unknown (an index that predates stamping)
        generation: sctx.generation ?? stats.generation,
        dirty: stats.reindexDirty,
        nodes: stats.nodes,
        edges: stats.edges,
        scopeHash: stats.scopeHash,
      };
    });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  };

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // Guards run BEFORE any dispatch, deny-biased (R2#13):
      // 1) browser-origin rejection, BOTH faces — a webpage on an authorized device gets nothing;
      //    no CORS headers are ever emitted, so even a same-Host page cannot read a response.
      if (req.headers.origin != null || req.headers["sec-fetch-site"] != null) {
        return refuse(res, 403, "browser-origin requests are rejected on this face (no CORS, ever)");
      }
      // 2) exact-Host enforcement (required on the read face; DNS-rebind defense) — clients present
      //    the MagicDNS name, or nothing. A LAN-IP or rebound-DNS Host is refused before dispatch.
      if (opts.expectedHost && req.headers.host !== opts.expectedHost) {
        return refuse(res, 421, `Host mismatch — this face serves ${opts.expectedHost} exactly`);
      }
      // 3) capability (broker only): missing/invalid ⇒ 401 before the body is even read.
      if (opts.face === "broker" && !capabilityOk(String(req.headers["x-twinkling-capability"] ?? ""))) {
        return refuse(res, 401, "missing or invalid capability (x-twinkling-capability)");
      }
      const url = new URL(req.url ?? "/", "http://face.local");
      if (req.method === "GET" && url.pathname === "/health") return void (await health(res));
      if (url.pathname !== "/mcp") return refuse(res, 404, "unknown path (POST /mcp, GET /health)");
      // The store is leased PER CALL inside the MCP handler (buildMcpServer), not for the whole
      // request: a concurrent republish swaps the face's pointer but never closes a leased store
      // mid-op (no torn read, R5#2), and a broker mutation additionally holds the coordination lock
      // across its lease+write (Codex R1#1).
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const mcp = buildMcpServer();
      res.on("close", () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      process.stderr.write(`face ${opts.face}: request failed: ${(e as Error).message}\n`);
      if (!res.headersSent) refuse(res, 500, "internal error");
      else res.end();
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once("error", rejectListen);
    httpServer.listen(opts.port, bind, () => resolveListen());
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  process.stderr.write(
    `funes face ${opts.face}: serving ${vault} on ${bind}:${port} [ops: ${exposed.map((o) => o.name).join(",")}]` +
      `${opts.expectedHost ? ` [host: ${opts.expectedHost}]` : ""}${opts.capabilityPath ? " [capability-gated]" : ""}\n`,
  );
  return {
    server: httpServer,
    port,
    url: `http://${bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind}:${port}`,
    async close() {
      await new Promise<void>((r) => httpServer.close(() => r()));
      await resolved.close();
    },
  };
}

// ── CLI entrypoint (the composition runs `bun .../src/face.ts --face … --bind …`) ────────────────
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string, def?: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
  };
  const face = flag("--face") as FaceKind | undefined;
  const vault = resolve(flag("--vault", "/star")!);
  try {
    await startFace({
      face: face!,
      vault,
      bind: flag("--bind")!, // REQUIRED — assertBindPolicy refuses absence and unpinned 0.0.0.0
      port: Number(flag("--port", face === "broker" ? "8787" : "8788")),
      capabilityPath: flag("--capability"),
      expectedHost: flag("--host"),
      opNames: flag("--ops")?.split(",").map((s) => s.trim()).filter(Boolean),
      dbDir: flag("--db"),
      home: flag("--home"), // the publication home — pass the SAME dir the sidecar's `publish --home` gets
      locus: flag("--locus") ?? process.env.FACE_LOCUS,
      role: flag("--role") ?? process.env.FACE_ROLE,
    });
  } catch (e) {
    process.stderr.write(`face ${face ?? "?"}: ${(e as Error).message}\n`);
    process.exit(2);
  }
}
