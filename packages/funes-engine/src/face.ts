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
//                   bodies from canon — stated, not assumed (R5-cleanup). Since 0.3.0 item 22 the
//                   DEFAULT op set (which includes page/tree/neighbors/graph) is LOOPBACK-ONLY: a
//                   tailnet read face must name the index-served ops explicitly
//                   (--ops recall,indexed_page,health,hotlist) or it refuses at startup.
//
// Cross-face smuggling (R4#3) is structural AND checked at dispatch: the faces are separate
// PROCESSES on separate ports with separate op allowlists, and every tools/call re-checks the
// face's allowlist BEFORE the registry — a tailnet request naming a broker verb dies at dispatch
// even if a listing/transport bug let it in. The negative test for this is GENERATED from the full
// op registry (face.test.ts) — registry growth can never reopen the surface.
//
// Bind policy (0.3.0 items 21-22): an EXPLICIT --bind is REQUIRED, it must be an IP LITERAL, and it
// must be NAMED in this face's bind allowlist — `--bind-allow` over FUNES_FACE_BIND_ALLOW over the
// loopback default. Naming the address IS the approval; there is no other. Wildcards are refused
// wherever they appear, and a non-loopback face refuses every filesystem-served op at STARTUP.
// FACE_PUBLISH_PINNED is gone: it admitted 0.0.0.0 on an environment variable's word, and that word
// asserted an intention about a host-side publish pin while proving nothing about the binding.
//
// ## Deployment note
//
// Items 21-22 BREAK any face that binds a non-loopback address, and they break it at STARTUP: the
// process refuses to serve rather than degrading. Nothing in this estate runs such a face today —
// the live funes processes are stdio MCP servers and :7777 is twinkling's surface on loopback — so
// the break is LATENT, and it is written down here because a latent break with no note is an
// outage the next time someone deploys a tailnet face. An operator deploying one must change two
// things, and neither is optional:
//   - `--bind-allow <addr>` naming the exact address the face listens on — the tailnet address, as
//     an IP LITERAL (a MagicDNS name is refused; `--host` still takes the name). The default
//     allowlist is loopback only, and FACE_PUBLISH_PINNED, which used to admit a wildcard on an
//     environment variable's assertion, no longer exists. Without this the face REFUSES TO START.
//   - `--ops recall,indexed_page,health,hotlist` on a READ face. Its default op set includes
//     page/tree/neighbors/graph, which are filesystem-served, and item 22 refuses every fs-served
//     op on a non-loopback bind. There is no op set that rescues the BROKER: its whole reason to
//     exist, `remember`, is fs-served, so the broker is confined to loopback.
// Both refusals name their repair in the message, and both are startup-time — no request can reach
// them at runtime.
//
// Generation-aware serving (R5#2, unified 2026-07-16): on the libsql backend the face is ALWAYS a
// publication-protocol consumer over ONE home — `--home` (the dir the sidecar's `funes publish
// --home` writes generation.json + gen-*.db into) or the default index dir. Manifest published ⇒
// serve that generation, re-checked per op. Nothing published ⇒ REFUSE AT STARTUP (0.3.0 item 15):
// a served face serves published generations only. The DIRECT fallback onto the static index path
// that used to stand here was not a lesser mode, it was a broken one — `funes reindex` rebuilds
// index.db in place, and replacing that file does not move the SQLite handle the face already
// holds, so the "live" index a face served was frozen at boot for the process lifetime. The old
// split-home bug (broker homed at /index/star, sidecar publishing /index) that DIRECT made merely
// loud is now a refusal naming both paths. The READ face opens every store read-only (mode=ro;
// libsql-only — crash-fix for RO index mounts + defense in depth under the op allowlist); the
// broker stays RW.
//
// Transport: MCP streamable-HTTP (POST /mcp, stateless JSON mode — a fresh Server+transport pair
// per request over the leased store), matching pydantic-ai/fastmcp's StreamableHttpTransport.
// On SDK v2 / spec 2026-07-28 that per-request shape is no longer a workaround but the protocol's
// own model: there is no session and no handshake, so any instance can answer any request. The v1
// transport answered `MCP-Protocol-Version: 2026-07-28` with HTTP 400 — this face was the one funes
// surface a current-spec client could not reach at all.
// Plus GET /health (JSON; capability-gated on the broker): {star, locus, role, generation, dirty}
// from LIVE index health (R1#16) — never a static string.
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Server, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { Embedder } from "funes-core";
import type { FunesIndexStore } from "./store.ts";
import { FunesStore } from "./funes-store.ts";
import { funesBackend, funesDbDir, makeStore, readStarIdentity } from "./factory.ts";
import { operations, buildToolDefs, dispatchToolCall, type Operation, type OperationContext } from "./ops.ts";
import { resolveExposedOps } from "./mcp-config.ts";
import { resolveWriteActor, UNKNOWN_ACTOR } from "./actor.ts";
import { resolveWriteDesignation } from "./write-designation.ts";
import { hasPublishedGeneration, PublishedIndex, startPrincipalHeartbeat, withPublicationFence, writePrincipalStatus } from "./publication.ts";
import { FUNES_VERSION } from "./version.ts";

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

/** Resolve a face's exposed ops from its allowlist (defaults above), fail-closed before serving.
 *  `loopback` is the face's ACTUAL bind address classification, and it is required rather than
 *  defaulted: item 22's refusal is only worth anything if no caller can reach this function without
 *  having decided what it binds. */
export function resolveFaceOps(face: FaceKind, opNames: string[] | undefined, opts: { loopback: boolean }): Operation[] {
  const names = opNames && opNames.length ? opNames : [...(face === "broker" ? DEFAULT_BROKER_OPS : DEFAULT_READ_OPS)];
  const picked = face === "broker"
    ? resolveBrokerOps(operations, names)
    : resolveExposedOps(operations, { readonly: false, ops: names, crossStar: false });
  // 0.3.0 item 22: a filesystem-served op reads (page/tree/graph/neighbors) or writes (remember)
  // the vault DIRECTLY, so it bypasses index_scope and answers with bytes the index never saw. The
  // same refusal already existed keyed to the --cross-star MCP flag — a FLAG, which a face's bind
  // address does not consult. Re-keyed here to the address the socket actually listens on: a
  // remote filesystem surface is a later release with its own credential design, so until then it
  // does not exist, capability-gated or not. The broker's `remember` is fs-served too, and this
  // deliberately confines the broker to loopback.
  if (!opts.loopback) {
    const fsOp = picked.find((o) => o.served === "fs");
    if (fsOp) {
      throw new Error(
        `face ${face}: operation "${fsOp.name}" is filesystem-served (served: fs) and this face binds a NON-LOOPBACK address — ` +
        "a remote filesystem surface is refused unconditionally (fail-closed). Serve the index-served ops only " +
        "(--ops recall,indexed_page,health,hotlist), or bind loopback.",
      );
    }
  }
  return picked;
}

// ── bind allowlist (item 21): a named surface, a documented default, fail-closed parsing ─────────
/** The documented default: loopback only. Any other exposure is NAMED by an operator, never
 *  inferred — that naming is the entire approval mechanism. */
export const DEFAULT_BIND_ALLOW = ["127.0.0.1", "::1"] as const;

/** Refused wherever they appear — as an allowlist entry AND as a bind address. `isIP` calls both
 *  "0.0.0.0" and "::" valid literals, so the literal check alone lets them through, and they are
 *  precisely the addresses that name no interface: every one, including the ones the operator has
 *  not thought about. */
const BIND_WILDCARDS = new Set(["0.0.0.0", "::", "*", "0:0:0:0:0:0:0:0"]);

/** Parse one allowlist value. Fail-closed in every direction: an empty list, a DNS name, a CIDR
 *  range, a wildcard or any unparseable entry REFUSES rather than falling back to permissive.
 *  Entries are compared as exact lowercased strings — no DNS resolution and no IPv6 form folding,
 *  so `::1` and `0:0:0:0:0:0:0:1` are different entries and an operator spells the address the way
 *  the face binds it. */
export function parseBindAllowlist(raw: string, source: string): string[] {
  const entries = raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
  if (entries.length === 0) throw new Error(`${source}: empty bind allowlist — refusing to serve (fail-closed)`);
  for (const e of entries) {
    if (BIND_WILDCARDS.has(e)) {
      throw new Error(`${source}: "${e}" is a wildcard, not an address — an allowlist names exact IP literals (fail-closed)`);
    }
    if (isIP(e) === 0) {
      throw new Error(`${source}: "${e}" is not an IP literal — DNS names and CIDR ranges are ambiguous and refused (fail-closed)`);
    }
  }
  return entries;
}

/** Precedence: `--bind-allow` flag, then FUNES_FACE_BIND_ALLOW, then the loopback default.
 *  PRESENCE selects, not truthiness: `--bind-allow ""` is an operator who meant to configure
 *  something and got it wrong, and it refuses instead of silently becoming the default. */
export function resolveBindAllowlist(allow: string | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  if (allow != null) return parseBindAllowlist(allow, "--bind-allow");
  if (env.FUNES_FACE_BIND_ALLOW != null) return parseBindAllowlist(env.FUNES_FACE_BIND_ALLOW, "FUNES_FACE_BIND_ALLOW");
  return [...DEFAULT_BIND_ALLOW];
}

/** Bind policy (item 21): an explicit IP literal, named in the allowlist. Returns the normalized
 *  (trimmed, lowercased) address the socket will use. */
export function assertBindPolicy(bind: string | undefined, opts: { allow?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const allow = resolveBindAllowlist(opts.allow, opts.env ?? process.env);
  if (!bind || !bind.trim()) {
    throw new Error("face: an EXPLICIT --bind address is required — this face never guesses its exposure");
  }
  const b = bind.trim().toLowerCase();
  if (BIND_WILDCARDS.has(b)) {
    throw new Error(
      `face: refusing to bind ${b} — a wildcard names no interface. Bind the exact address this face is reached on ` +
      "and name it in --bind-allow (a container binds its own address; FACE_PUBLISH_PINNED asserted a host publish pin and proved nothing).",
    );
  }
  if (isIP(b) === 0) {
    throw new Error(`face: --bind "${bind}" is not an IP literal — a face binds an address, never a name (fail-closed)`);
  }
  if (!allow.includes(b)) {
    throw new Error(
      `face: --bind ${b} is not in this face's bind allowlist [${allow.join(", ")}] — an address is served only when it is ` +
      "NAMED (--bind-allow, or FUNES_FACE_BIND_ALLOW; the default is loopback)",
    );
  }
  return b;
}

/** Loopback classification of an already-validated bind address — the key item 22's refusal turns
 *  on. The whole 127.0.0.0/8 block counts; `isIP` has already proven the shape. */
export function isLoopbackBind(bind: string): boolean {
  const b = bind.trim().toLowerCase();
  return b.startsWith("127.") || b === "::1" || b === "0:0:0:0:0:0:0:1" || b === "::ffff:127.0.0.1";
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
  /** The publication HOME this face is a principal of. REQUIRED, not optional: item 9's fence is
   *  keyed on it, and a fence a caller could omit is a fence that is absent exactly where someone
   *  forgot it. */
  home: string;
  /** DEFECT RAI-144: re-stamp this principal's status file NOW. Called after every broker mutation
   *  — a write invalidates the content generation in the very database this face is serving, so the
   *  diagnostic half of the status must follow the mutation, not wait for the next swap. */
  refreshStatus?(): Promise<void>;
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
  /** The bind allowlist (item 21): a comma-separated list of IP LITERALS. Wins over
   *  FUNES_FACE_BIND_ALLOW; the default is loopback. */
  bindAllow?: string;
  /** item 24: this process's declared actor (`--actor`), stamped on every write it performs. */
  actor?: string;
  /** item 24: the capability-to-actor mapping file (`--actor-map`), owner-readable-only. */
  actorMapPath?: string;
  /** item 25: the writer-designation mode (`--write-designation`) — off|audit. 0.3.0 ships audit. */
  writeDesignation?: string;
  /** Self-description metadata for /health — the composition states them (machine-local
   *  materialization metadata, R3#3), the face only reports. Also item 25's HALF of the designation
   *  check: `--locus` is the deployment's declared identity, compared against the star's declared
   *  `write_authority`. */
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
  /** item 24: the actor this face stamps on the writes it performs, resolved from TRUSTED sources
   *  at startup (actor.ts) and handed to the store's constructor — the seam that already refused to
   *  take an actor from a payload. */
  writeActor?: string;
}

/** Production store resolution, and libsql ONLY. ALWAYS the publication consumer over ONE home —
 *  published manifest ⇒ that generation (re-checked per op), nothing published ⇒ refuse at startup
 *  (item 15). The READ face opens every store read-only (mode=ro): crash-fix for RO index mounts +
 *  defense in depth under the op allowlist.
 *
 *  F8: the pre-2026-07-16 signature was `makeFaceDeps(vault, dbDir?: string)` — a READ-WRITE open,
 *  which is exactly what face:'broker' is now. The string overload keeps that call shape compiling
 *  (broker semantics, the given --db path), but since item 15 it no longer opens a live index: like
 *  every other served face it requires a published generation in the home holding that path. */
export async function makeFaceDeps(vault: string, dbDir?: string): Promise<FaceDeps>;
export async function makeFaceDeps(vault: string, opts: FaceStoreOpts): Promise<FaceDeps>;
export async function makeFaceDeps(vault: string, arg?: string | FaceStoreOpts): Promise<FaceDeps> {
  const opts: FaceStoreOpts = arg == null || typeof arg === "string" ? { face: "broker", dbDir: arg } : arg;
  const backend = funesBackend();
  const readonly = opts.face === "read";
  // 0.3.0 item 15, on BOTH faces. Until now this refusal covered the READ face only — which also has
  // no read-only open path off libsql — and the broker fell through to a live `makeStore` announcing
  // "mode DIRECT": precisely the mode item 15 removed, still reachable as
  // `FUNES_BACKEND=postgres FUNES_PG_UNSAFE=1 funes face`. So the guard moves up to cover both.
  if (backend !== "libsql") {
    throw new Error(
      `funes: refusing to serve a ${opts.face} face on the ${backend} backend — served faces are libsql-only.\n` +
      "  A face may serve a PUBLISHED generation and nothing else (0.3.0 item 15), and libsql is the only backend with a publication " +
      "protocol. A live index is not a substitute: replacing it does not move a handle this face already holds open, so the face would " +
      "answer boot-time bytes for its whole lifetime while reporting no generation.\n" +
      `  Run the face on libsql — set FUNES_BACKEND=libsql (or leave it unset), publish into the home first — funes publish --home ${opts.home ?? "<the dir holding generation.json>"} — then start it.\n` +
      "  The postgres tier is PARKED for 0.3.0 (item 4: PostgresStore neither persists nor validates schema_version), so nothing legitimate " +
      "needs this path; FUNES_PG_UNSAFE=1 opens a store for the smoke test, it does not make one servable. There is no override.",
    );
  }
  const dbPath = opts.dbDir ?? (opts.home != null ? join(opts.home, "index.db") : funesDbDir(vault, backend));
  const home = opts.home ?? dirname(dbPath);
  // R2-4: a WeakMap so retired-generation store wrappers are collectable — a long-lived face swaps
  // generations for the process lifetime; a strong Map would retain every retired store forever.
  const funesFor = new WeakMap<FunesIndexStore, FunesStore>();
  const wrap = (store: FunesIndexStore): FunesStore => {
    let f = funesFor.get(store);
    if (!f) { f = new FunesStore(store, { root: vault }); funesFor.set(store, f); }
    return f;
  };
  // 0.3.0 item 15: a served face serves PUBLISHED generations only. PublishedIndex's eager open
  // below would refuse too, but only the face knows both halves of the split-home bug — the home
  // it was pointed at AND the live index sitting next to it that the operator assumed was being
  // served — so the refusal is raised here, where both paths are in hand. (This also subsumes the
  // old R2-3 WAL check: an unpublished live index refuses now whatever its journal mode, so
  // sniffing the SQLite header for a WAL-specific message no longer buys anything.)
  if (!hasPublishedGeneration(home)) {
    throw new Error(
      `face ${opts.face}: no published generation in ${home}, and a served face serves published generations only.\n` +
      `  The live index at ${dbPath} is not a substitute: 'funes reindex' rebuilds that file in place, and replacing it ` +
      "does not move a handle this face already holds open — so the face would serve boot-time bytes forever while reporting no generation.\n" +
      `  Publish into this home — funes publish --home ${home} [--force] — then start the face. There is no fallback and no override.\n` +
      `  If ${home} is not where your publisher writes, the face is homed away from it: pass --home <the dir holding generation.json>.`,
    );
  }
  const open = (p: string) =>
    readonly
      ? makeStore({ dbDir: p, backend, readonly: true, embedder: opts.embedder }) // no vault: the owner-marker guard WRITES, and the mount may be RO
      : makeStore({ vault, dbDir: p, backend, embedder: opts.embedder, writeActor: opts.writeActor }); // collision/identity guard runs; dirty index → loud error
  // P1.6d: this face is a principal in the publication home — it records the publication it serves
  // to a status file (keyed by face kind) on every swap, so the publisher's retain-until-ack GC
  // keeps a retired generation until this principal has moved off it.
  const published = new PublishedIndex(home, open, {
    onServe: (publicationId, generation) => writePrincipalStatus(home, opts.face, publicationId, generation),
  });
  await published.with(async () => {}); // eager first open: an absent/invalid index fails STARTUP, loudly
  // DEFECT RAI-144 — the heartbeat. Before it, `writePrincipalStatus` fired ONLY on a swap, so a
  // face that swapped once at boot and then served quietly crossed DEFAULT_STALE_ACK_MS (15 min),
  // read as DEAD to the publisher's GC, stopped blocking collection, and had the artefact it was
  // still holding open retired underneath it. The sample is taken live rather than snapshotted:
  // `publicationId` moves on a swap, and `contentGeneration` moves on every incremental write.
  // Both halves come from ONE lease (`sampleIdentity`, never a literal pairing the getter with an
  // awaited read) — see its docblock: the split form pairs the pre-swap id with post-swap content.
  const heartbeat = startPrincipalHeartbeat(home, opts.face, () => published.sampleIdentity());
  process.stderr.write(
    `face ${opts.face}: generation ${published.generation} from ${home} (manifest re-checked per op)\n`,
  );
  return {
    withStore: (fn) => published.with((store, generation) => fn({ store, funes: wrap(store), generation })),
    home,
    refreshStatus: () => heartbeat.refresh(),
    close: async () => { heartbeat.stop(); await published.close(); },
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
  const bind = assertBindPolicy(opts.bind, { allow: opts.bindAllow });
  // fail-closed BEFORE a socket opens, and keyed to the address just approved (item 22)
  const exposed = resolveFaceOps(opts.face, opts.opNames, { loopback: isLoopbackBind(bind) });
  const vault = resolve(opts.vault);
  const starName = opts.star ?? readStarIdentity(vault).name ?? basename(vault);
  const locus = opts.locus ?? "unknown";
  const role = opts.role ?? "unknown";
  // item 24: resolved ONCE, here, from trusted sources only — the flag, the environment, or the
  // mapping keyed by the capability this face serves behind. A broken mapping refuses startup.
  const actor = resolveWriteActor({ actor: opts.actor, mapPath: opts.actorMapPath, capabilityPath: opts.capabilityPath });
  // item 25: resolved once too, and passed into every dispatch so the audit reports THIS face's
  // --locus rather than an environment the face was configured past.
  const designation = resolveWriteDesignation(vault, { locus: opts.locus, mode: opts.writeDesignation });
  const resolved = deps ?? (await makeFaceDeps(vault, { face: opts.face, dbDir: opts.dbDir, home: opts.home, writeActor: actor }));

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
    // FUNES_VERSION, not a hardcoded string: this reported "0.1.0" for every release while stdio
    // reported the real version, so the two transports disagreed about what software was answering.
    const server = new Server({ name: `funes-${opts.face}`, version: FUNES_VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", async () => ({ tools: buildToolDefs(exposed) }));
    server.setRequestHandler("tools/call", async (req) => {
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
            remote: true, trust: "untrusted", vault, store: sctx.store, funes: sctx.funes, actor, designation,
          } as OperationContext);
        // Codex R1#1: a broker MUTATION must lease its generation AND write UNDER the fence,
        // re-reading the manifest inside it (withStore's maybeSwap), so a concurrent publisher
        // can't atomically swap + POSIX-unlink the generation between the lease and the write — a
        // write into a retired, unlinked db is a SILENT loss.
        //
        // 0.3.0 item 9: the fence is `withPublicationFence(home)`, NOT `withCoordination`. The old
        // call was a PASS-THROUGH unless a composition set FUNES_COORDINATION_DIR — so on every
        // deployment that did not (the default), a broker write and a publish into the same home
        // were serialized by absolutely nothing, and the publisher's own `<home>/.publish-lock`
        // serialized publishers only. Same primitive, one key, both sides. Still reentrant with
        // funes.remember's own coordination frame (same async owner, P1.6c) and still deferring to
        // FUNES_COORDINATION_DIR when a composition configures the coarser shared lock.
        //
        // Reads never fence: the per-op lease alone keeps a torn read impossible while a publish
        // swaps the pointer.
        const mutating = opts.face === "broker" && !op.readonly;
        const result = mutating
          ? await withPublicationFence(resolved.home, () => resolved.withStore(run))
          : await resolved.withStore(run);
        // RAI-144 / item 8: a mutation just invalidated the content generation in the database this
        // principal is serving. Re-stamp the status now rather than at the next swap — the rollout
        // gate reads that field, and a diagnostic that only ever tells the truth immediately after a
        // publication swap is a diagnostic for the one moment nobody is asking.
        if (mutating) await resolved.refreshStatus?.();
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
        // DEPRECATED ALIAS of `contentGeneration` below, kept so the two faces name one value one
        // way: `stats()` renamed the field in item 8, the MCP `health` op spreads stats and so
        // renamed with it, and this face did not — while twinkl.ing's memory block reads
        // `generation` (MEMORY_SAFE_KEYS, gateway-proxy.ts). REMOVE it here AND in ops.ts `health`
        // together, in the release that drops `recall` for `recall_v2` — the twinkl.ing cutover the
        // plan names as an external release gate (item 19). This one prefers the SERVED generation
        // (R1#16) and falls back to the store's stamp; null = honestly-unknown (never stamped, a
        // legacy v1 stamp, or invalidated).
        generation: sctx.generation ?? stats.contentGeneration,
        // PLAN-0.3.0 items 8 + 13 — the identity split, and what an operator needs when it is null.
        // Recovery is MANUAL in this release (`funes publish --force`), so `invalidatedReason` is
        // the whole diagnosis: without it "generation: null" says nothing about what to do.
        publicationId: stats.publicationId,
        contentGeneration: stats.contentGeneration,
        invalidatedAt: stats.invalidatedAt,
        invalidatedReason: stats.invalidatedReason,
        dirty: stats.reindexDirty,
        nodes: stats.nodes,
        edges: stats.edges,
        scopeHash: stats.scopeHash,
      };
    });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  };

  // SDK v2 HTTP entry. `createMcpHandler` — NOT a bare transport — is what answers the mandatory
  // `server/discover` RPC and classifies each request's era, so a bare transport leaves a
  // 2026-07-28 client unable to negotiate at all. It calls the factory PER REQUEST, which is the
  // same stateless shape this face already had.
  //   legacy: "stateless"  keep serving 2025-era clients, one fresh instance per request (today's
  //                        behaviour; "reject" would make this face modern-only)
  //   responseMode: "json" the old enableJsonResponse — funes emits no mid-call notifications, so
  //                        there is nothing for the never-stream mode to drop
  const mcpNodeHandler = toNodeHandler(
    createMcpHandler(buildMcpServer, {
      legacy: "stateless",
      responseMode: "json",
      onerror: (e) => process.stderr.write(`face ${opts.face}: mcp: ${e.message}\n`),
    }),
    { onerror: (e) => process.stderr.write(`face ${opts.face}: mcp adapter: ${e.message}\n`) },
  );

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
      await mcpNodeHandler(req, res);
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
      `${opts.expectedHost ? ` [host: ${opts.expectedHost}]` : ""}${opts.capabilityPath ? " [capability-gated]" : ""}` +
      // the actor is stated at startup because "unknown" is a legitimate and otherwise SILENT
      // outcome, and an operator who mounted a mapping file wants to see whether it took
      ` [actor: ${actor}]${actor === UNKNOWN_ACTOR ? " (no trusted source — writes stamp unknown)" : ""}` +
      ` [designation: ${designation.mode}]\n`,
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
      bindAllow: flag("--bind-allow"), // IP literals, comma-separated; default loopback (item 21)
      dbDir: flag("--db"),
      home: flag("--home"), // the publication home — pass the SAME dir the sidecar's `publish --home` gets
      actor: flag("--actor"),            // item 24: trusted process configuration
      actorMapPath: flag("--actor-map"), // item 24: capability -> actor, owner-readable-only
      writeDesignation: flag("--write-designation"), // item 25: off|audit (0.3.0 ships audit)
      locus: flag("--locus") ?? process.env.FACE_LOCUS,
      role: flag("--role") ?? process.env.FACE_ROLE,
    });
  } catch (e) {
    process.stderr.write(`face ${face ?? "?"}: ${(e as Error).message}\n`);
    process.exit(2);
  }
}
