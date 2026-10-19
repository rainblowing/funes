#!/usr/bin/env bun
// funes daemon (S2) — the ONE process that owns a star's PGLite handle, serving the op-registry
// over localhost HTTP (+ the dev console at /). Engines reach the same registry over stdio-MCP
// (mcp.ts), which proxies here when this daemon is up.
//   bun packages/funes-engine/src/daemon.ts --vault <star path> [--port 7777] [--db <pgdata>] [--stats] [--capability <token file>] [--locus <machine>]
// SECURITY (P1.5): binds 127.0.0.1 ONLY. Mutations (remember/supersede/forget) pass funes-api's
// write guards — POST + content-type application/json + body cap + CROSS-ORIGIN REJECTION, so a
// drive-by browser page can no longer POST a mutation (the verified Codex R1#2 hole). Local
// non-browser callers (the MCP daemon proxy) still mutate — loopback is the floor. With --capability
// <token file>, mutations ALSO require a matching x-funes-capability header (constant-time check):
// the opt-in scoped-write gate. Reads are unguarded (the dev console's same-origin fetches work).
// With --actor-map <v2 access file> (or FUNES_ACTOR_MAP) instead (RAI-159, PLAN-0.4.0 item 22), the
// x-funes-capability token names an ACTOR with a role, resolved per request: its grant reaches the
// dispatch, which refuses an op or star outside it (403). On /api/:op and /api/inbox a read with no
// token stays ungated, as before, and a write with no token, or any request with a token the file
// does not name, is 401. GET /api/health (daemonProbe keys on it, tokenless), /api/ops (the registry,
// not the caller's grant) and /api/events take no token at all.
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FunesIndexStore } from "./store.ts";
import { makeStore, funesBackend, funesDbDir } from "./factory.ts";
import { DEFAULT_DAEMON_PORT } from "./daemon-client.ts";
import { buildApp } from "./app.ts";
import { grantFor, readAccessPolicy, resolveWriteActor, UNKNOWN_ACTOR, type Grant } from "./actor.ts";
import { operations, publicOpNames } from "./ops.ts";
import type { PolicyHeaders } from "funes-api";
import { presentedToken } from "funes-core";
import consoleHtml from "./console.html" with { type: "text" };

/** ADR-0016: the daemon's one legacy credential header, read beside `Authorization: Bearer` until 0.6.0. */
const LEGACY_HEADER = "x-funes-capability";

/** Build a constant-time capability authorizer for the daemon's write guard: a mutation must present
 *  its token (presentedToken: Bearer, or x-funes-capability) matching the token file's contents.
 *  Missing/unreadable file, or an absent, mismatched, malformed or conflicting credential ⇒ denied (nobody is authorized, never everybody). Re-reads per call so the token can rotate. */
export function capabilityAuthorizer(capabilityPath: string): (h: PolicyHeaders) => boolean {
  return (h) => {
    let expected: string;
    try { expected = readFileSync(capabilityPath, "utf8").trim(); } catch { return false; }
    const p = presentedToken((n) => h.get(n), LEGACY_HEADER);
    const presented = "token" in p ? p.token : null;
    if (!expected || !presented) return false;
    const a = createHash("sha256").update(presented).digest();
    const b = createHash("sha256").update(expected).digest();
    return timingSafeEqual(a, b);
  };
}

/** RAI-159: the per-op authorizer over a version-2 access file, re-read on every request that
 *  presents a token (no cache: a revocation needs no restart). No token: a read is admitted with no
 *  grant (the loopback floor, unchanged) and a mutation is refused. A token the file does not name —
 *  or a file that no longer validates — refuses. The op itself is checked by dispatchToolCall against
 *  the grant, so its refusal names the actor and the op. */
export function accessAuthorizer(mapPath: string): (h: PolicyHeaders, op: string) => Grant | boolean {
  const mutating = new Set(operations.filter((o) => !o.readonly).map((o) => o.name));
  const publicOps = publicOpNames();
  return (h, op) => {
    const p = presentedToken((n) => h.get(n), LEGACY_HEADER);
    if ("refused" in p) return false; // malformed or conflicting: never the tokenless read floor
    const presented = p.token;
    if (!presented) return !mutating.has(op);
    let policy: ReturnType<typeof readAccessPolicy>;
    try {
      policy = readAccessPolicy(mapPath, publicOps);
    } catch (e) {
      process.stderr.write(`funes daemon: ${(e as Error).message}\n`); // the loader's messages never carry a token
      return false;
    }
    if (policy === "v1") return false;
    return grantFor(policy, presented) ?? false;
  };
}

/** Validate a daemon's access file at STARTUP: it must be version 2 — a v1 {token: actor} map names
 *  one capability's actor, which is a face's concern; the daemon serves many sessions. */
export function assertDaemonAccessFile(mapPath: string): void {
  if (readAccessPolicy(mapPath, publicOpNames()) === "v1") {
    throw new Error(`--actor-map ${mapPath}: the daemon reads a version-2 access file only ({"version": 2, "roles": …, "actors": …}) — refusing to serve (fail-closed)`);
  }
}

/** RAI-159: the daemon's two access-control inputs from argv + environment. PRESENCE selects: a
 *  trailing `--capability` or `--actor-map` with no value used to parse as absent and start the daemon
 *  ungated, so it refuses (as `--ops` does). `--actor-map` wins over FUNES_ACTOR_MAP; a set-but-empty
 *  variable is returned as "" and refused by the access-file check. */
export function daemonAccessArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): { capabilityPath?: string; actorMapPath?: string } {
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (v == null || !v.trim()) throw new Error(`${name} was given no value — refusing to serve (fail-closed)`);
    return v;
  };
  return { capabilityPath: value("--capability"), actorMapPath: value("--actor-map") ?? env.FUNES_ACTOR_MAP };
}

export interface DaemonOpts {
  vault: string;
  store: FunesIndexStore;
  port?: number;
  /** Move 5: daemon-wide rerank posture (`--rerank`). When true, every recall runs the
   *  cross-encoder final stage — a no-op unless `store` was also created with a Reranker. */
  rerank?: boolean;
  /** P1.5: opt-in scoped-write capability. When set, mutations require a matching
   *  x-funes-capability header on top of the built-in CSRF/content guards. */
  capabilityPath?: string;
  /** RAI-159: a version-2 access file (`--actor-map` or FUNES_ACTOR_MAP): per-request grants from the
   *  x-funes-capability token. Exclusive with `capabilityPath`. */
  actorMapPath?: string;
  /** 0.3.0 item 24: THIS daemon's actor, for the dispatch context. The caller constructs `store`
   *  with the same value as its `writeActor`, so the stamped row always names the daemon. With no
   *  access file the audit line names it too; with `actorMapPath` the audit line names the CALLER's
   *  grant actor while the row keeps the daemon's (ADR-0009). A proxied write never carries the
   *  stdio process's own --actor. */
  actor?: string;
  /** PLAN-0.4.0 item 10: `--locus`, over FUNES_LOCUS — resolved by buildApp. */
  locus?: string;
}

/** Start the HTTP daemon. Exported for tests (inject a fake-embedder store, port 0). The store→Hono
 *  wiring lives in buildApp (./app.ts) so the unified Astro server can reuse it without dragging in
 *  this file's Bun-only console.html import; the daemon passes that console in for its dev GET /. */
export function startDaemon(opts: DaemonOpts) {
  if (opts.actorMapPath != null) {
    if (opts.capabilityPath) throw new Error("funes daemon: --capability and a version-2 --actor-map together — the access file names every caller; drop --capability");
    assertDaemonAccessFile(opts.actorMapPath);
  }
  // The Host header cannot validate itself (see crossOriginRejected in funes-api) — a forged Host
  // matches a forged Origin and the CSRF check passes on symmetry alone. Declaring the hosts this
  // daemon actually binds breaks that. Filled AFTER serve() because port 0 means "kernel picks"
  // (tests) and the real port is not known until then; the array is populated synchronously before
  // Bun.serve returns to the caller, so no request can observe it empty.
  const allowedHosts: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", // hard-coded loopback — never a config knob in S2
    port: opts.port ?? DEFAULT_DAEMON_PORT,
    fetch: buildApp({
      allowedHosts,
      store: opts.store,
      vault: opts.vault,
      rerank: opts.rerank,
      consoleHtml: consoleHtml as unknown as string,
      authorizeWrite: opts.capabilityPath ? capabilityAuthorizer(opts.capabilityPath) : undefined,
      authorize: opts.actorMapPath != null ? accessAuthorizer(opts.actorMapPath) : undefined,
      actor: opts.actor,
      locus: opts.locus,
    }).fetch,
  });
  for (const h of ["127.0.0.1", "localhost", "[::1]"]) allowedHosts.push(`${h}:${server.port}`);
  return server;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string, def?: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
  };
  const vault = resolve(flag("--vault", process.cwd())!);
  const backend = funesBackend();
  const dbDir = flag("--db", funesDbDir(vault, backend))!;
  const port = Number(flag("--port", process.env.FUNES_DAEMON_PORT ?? String(DEFAULT_DAEMON_PORT)));
  // R8: --stats opts into recall telemetry (recall_stats counters; advisory only, never
  // ranking). Default OFF — no flag, no table, no writes.
  const stats = argv.includes("--stats");
  // Move 5: --rerank opts into the cross-encoder final stage daemon-wide (default OFF — the
  // daemon stays light unless asked). The reranker is constructed ONCE here and injected into
  // the store; the model itself lazy-loads on the first recall (CrossEncoderReranker.load),
  // so the no-flag daemon never touches the ~23MB onnx model. Mirrors the CLI `--rerank`.
  const rerank = argv.includes("--rerank");
  // RAI-159: both access-control inputs, checked BEFORE the store opens — a bad access file refuses
  // with nothing to close.
  let capabilityPath: string | undefined;
  let actorMapPath: string | undefined;
  try {
    ({ capabilityPath, actorMapPath } = daemonAccessArgs(argv));
    if (actorMapPath != null) assertDaemonAccessFile(actorMapPath);
  } catch (e) {
    console.error(`funes daemon: ${(e as Error).message}`);
    process.exit(2);
  }
  // 0.3.0 item 24: resolved ONCE, here, from `--actor` over FUNES_ACTOR — the resolver the HTTP face
  // uses (face.ts). It goes to BOTH places a write's actor is read: the store constructor (the
  // stamped `write_actor`) and the dispatch context (the designation audit line). With an access
  // file (RAI-159) the audit line names each caller's grant instead, and the row keeps this actor.
  const actor = resolveWriteActor({ actor: flag("--actor") });
  const store = await makeStore({ vault, dbDir, backend, trackRecalls: stats, rerank, writeActor: actor }); // vault -> collision/identity guard runs; dirty index -> loud error (repair = CLI reindex)
  let server: ReturnType<typeof startDaemon>;
  try {
    server = startDaemon({ vault, store, port, rerank, capabilityPath, actorMapPath, actor, locus: flag("--locus") });
  } catch (e) {
    console.error(`funes daemon: ${(e as Error).message}`); // --capability beside --actor-map, and a refused --locus, land here
    await store.close();
    process.exit(2);
  }
  console.log(
    `funes daemon: ${vault}  [backend=${backend}]${stats ? "  (recall telemetry ON)" : ""}${rerank ? "  (rerank ON)" : ""}${capabilityPath ? "  (write capability REQUIRED)" : ""}${actorMapPath != null ? "  (access file v2: per-request grants)" : ""}` +
    // Stated at startup because "unknown" is a legitimate and otherwise SILENT outcome.
    `  [actor: ${actor}]${actor === UNKNOWN_ACTOR ? " (no trusted source — writes stamp unknown)" : ""}`,
  );
  console.log(`  console http://127.0.0.1:${server.port}/  ·  api http://127.0.0.1:${server.port}/api/{recall,page,tree,health}`);

  // Graceful shutdown — CLOSE PGLite cleanly on SIGTERM/SIGINT. Without this, `launchctl bootout`
  // (SIGTERM) kills the process mid-flight and leaves pgdata needing WAL recovery; a subsequent
  // open under FileProvider can abort *and damage* the index (observed 2026-06-22 during a daemon→
  // unified-surface handoff — recovered from a funes-backup snapshot). A clean close removes that
  // window. launchd's ExitTimeOut (~20s) easily covers the sub-second PGLite close.
  let closing = false;
  const shutdown = async (sig: string) => {
    if (closing) return;
    closing = true;
    console.log(`funes daemon: ${sig} → closing store cleanly`);
    try { server.stop(true); } catch { /* already stopping */ }
    try { await store.close(); } catch { /* best-effort */ }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
