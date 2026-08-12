#!/usr/bin/env bun
// funes daemon (S2) — the ONE process that owns a star's PGLite handle, serving the op-registry
// over localhost HTTP (+ the dev console at /). Engines reach the same registry over stdio-MCP
// (mcp.ts), which proxies here when this daemon is up.
//   bun packages/funes-engine/src/daemon.ts --vault <star path> [--port 7777] [--db <pgdata>] [--stats] [--capability <token file>]
// SECURITY (P1.5): binds 127.0.0.1 ONLY. Mutations (remember/supersede/forget) pass funes-api's
// write guards — POST + content-type application/json + body cap + CROSS-ORIGIN REJECTION, so a
// drive-by browser page can no longer POST a mutation (the verified Codex R1#2 hole). Local
// non-browser callers (the MCP daemon proxy) still mutate — loopback is the floor. With --capability
// <token file>, mutations ALSO require a matching x-funes-capability header (constant-time check):
// the opt-in scoped-write gate. Reads are unguarded (the dev console's same-origin fetches work).
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FunesIndexStore } from "./store.ts";
import { makeStore, funesBackend, funesDbDir } from "./factory.ts";
import { DEFAULT_DAEMON_PORT } from "./daemon-client.ts";
import { buildApp } from "./app.ts";
import type { PolicyHeaders } from "funes-api";
import consoleHtml from "./console.html" with { type: "text" };

/** Build a constant-time capability authorizer for the daemon's write guard: a mutation must present
 *  x-funes-capability matching the token file's contents. Missing/unreadable file or absent/mismatched
 *  header ⇒ denied (nobody is authorized, never everybody). Re-reads per call so the token can rotate. */
export function capabilityAuthorizer(capabilityPath: string): (h: PolicyHeaders) => boolean {
  return (h) => {
    let expected: string;
    try { expected = readFileSync(capabilityPath, "utf8").trim(); } catch { return false; }
    const presented = String(h.get("x-funes-capability") ?? "");
    if (!expected || !presented) return false;
    const a = createHash("sha256").update(presented).digest();
    const b = createHash("sha256").update(expected).digest();
    return timingSafeEqual(a, b);
  };
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
}

/** Start the HTTP daemon. Exported for tests (inject a fake-embedder store, port 0). The store→Hono
 *  wiring lives in buildApp (./app.ts) so the unified Astro server can reuse it without dragging in
 *  this file's Bun-only console.html import; the daemon passes that console in for its dev GET /. */
export function startDaemon(opts: DaemonOpts) {
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
  const capabilityPath = flag("--capability");
  const store = await makeStore({ vault, dbDir, backend, trackRecalls: stats, rerank }); // vault -> collision/identity guard runs; dirty index -> loud error (repair = CLI reindex)
  const server = startDaemon({ vault, store, port, rerank, capabilityPath });
  console.log(`funes daemon: ${vault}  [backend=${backend}]${stats ? "  (recall telemetry ON)" : ""}${rerank ? "  (rerank ON)" : ""}${capabilityPath ? "  (write capability REQUIRED)" : ""}`);
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
