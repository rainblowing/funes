// funes stdio-MCP server, as a reusable function. P3.15: mcp.ts was a top-level script, so the CLI
// could not start an MCP server without spawning a second process. It is split rather than
// converted: `bun .../mcp.ts` is still spawned directly by mcp-boundary.test.ts and by every star
// manifest's identity.command, so that entrypoint has to keep working unchanged.
// funes stdio-MCP server — recall/page/tree/health + (S3) remember/supersede/forget over the
// op-registry. Mutations are FunesStore-routed (out_memory/ only, sanitized, server-stamped
// untrusted); elevation is CLI-only.
//
// Protocol: MCP revision 2026-07-28 (the stateless core) via SDK v2, AND the 2025-era handshake —
// `serveStdio` pins a connection to the era of its opening message, so both keep working. funes
// declares tools and nothing else, so every feature 2026-07-28 removed (sessions, the handshake,
// the GET stream, resources/subscribe, ping, logging/setLevel, server-initiated requests) is one it
// never used. `server/discover` is answered by the SDK from the capabilities below.
//   bun packages/funes-engine/src/mcp.ts --vault <star path> [--db <pgdata dir>] [--readonly] [--ops a,b,c]
// --readonly exposes ONLY the read operations (recall/page/tree/neighbors/graph/health/hotlist) and
// rejects every mutation — used to wire a star's memory into a SIBLING session as query-only, so a
// cross-star recall connection can never write into the other star's vault (the daemon-proxy path is
// guarded too, not just the direct store).
// --ops a,b,c is a tighter EXPLICIT read-only allowlist. Bare --readonly still exposes page/tree/
// graph, which read the vault FILESYSTEM and bypass index_scope; the allowlist admits only the ops
// named. An empty/unknown/mutation-containing allowlist fails closed at startup.
// --cross-star marks a SIBLING (cross-star) surface: it requires --ops, refuses fs-served ops
// (page/tree/graph/neighbors) at startup, and turns on the atomic index_scope serve guard (H9) so a
// stale/missing/ignored/mid-reindex boundary refuses recall/indexed_page. An own-star --ops binding
// omits --cross-star and keeps its fs ops (personal legitimately uses page over its own brain).
// Engines (Claude Code/Codex/Gemini) spawn this per session. PGLite is single-connection:
// if the HTTP daemon is already running for the same vault, this server transparently
// PROXIES tool calls to it instead of opening the store a second time.
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { FunesStore } from "./funes-store.ts";
import { makeStore, funesBackend, funesDbDir } from "./factory.ts";
import { operations, buildToolDefs, dispatchToolCall, type Operation, type OperationContext } from "./ops.ts";
import { resolveWriteDesignation } from "./write-designation.ts";
import { resolveWriteActor, UNKNOWN_ACTOR } from "./actor.ts";
import { resolveExposedOps, refusalMessage } from "./mcp-config.ts";
import { daemonProbe, DEFAULT_DAEMON_PORT } from "./daemon-client.ts";
import { FUNES_VERSION } from "./version.ts";

/** Run the stdio MCP server to completion. `argv` is the args AFTER the command name. */
export async function runMcp(argv: string[]): Promise<void> {
  const flag = (name: string, def?: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
  };

  // The HUB is a different server with a different tool surface (hub-mcp.ts) — dispatched here so
  // one command name serves both, exactly as twinkling's derived `.mcp.hub.json` invokes it.
  if (argv.includes("--stars-file")) {
    const { runHubMcp } = await import("./hub-mcp.ts");
    return runHubMcp(argv);
  }

  const vault = resolve(flag("--vault", process.cwd())!);
  // 0.3.0 item 25, resolved ONCE at startup as face.ts already does. dispatchToolCall falls back to
  // resolving per call when a context carries none, and resolveDesignationMode is fail-closed on an
  // unknown mode — so a misspelled FUNES_WRITE_DESIGNATION used to survive the boot and then throw
  // on the FIRST WRITE, mid-session, as an MCP tool error. Resolved here it is a startup failure,
  // which is what a typo in a mode deserves. Resolved BEFORE the daemon probe and the store open so
  // the proxy path fails the same way the direct one does.
  const designation = resolveWriteDesignation(vault);
  // 0.3.0 item 24, resolved at the same moment and for the same reason: `--actor` over FUNES_ACTOR
  // through the resolver the HTTP face uses, fail-closed on an unusable name BEFORE the probe, so
  // both paths refuse a bad flag identically. It is USED only on the direct-open path below — a
  // proxied call carries no actor (tool arguments never do; actor.test.ts pins it), and the daemon
  // stamps its own. A mapping file stays a face concern.
  const actor = resolveWriteActor({ actor: flag("--actor") });
  const readonlyOnly = argv.includes("--readonly");
  // --ops's mere presence is allowlist mode; the value is parsed even if empty so an empty list
  // fails closed (rather than silently degrading to "no restriction").
  const opsAllow = argv.includes("--ops")
    ? (flag("--ops") ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  // H8: --cross-star marks this server as a SIBLING (cross-star) boundary. It (a) refuses fs-served
  // ops (page/tree/graph/neighbors — they read the vault filesystem and bypass index_scope) at
  // startup, and (b) turns on the atomic index_scope serve guard (H9). It is the sibling's static
  // config that carries it; an own-star runtime binding never does (personal legitimately uses page).
  const crossStar = argv.includes("--cross-star");
  // --cross-star is the cross-star SURFACE — defined by an explicit read-only allowlist. Without
  // --ops there is no allowlist to bound, so fail closed rather than serve the full/-readonly set.
  if (crossStar && opsAllow == null) {
    process.stderr.write("funes mcp: --cross-star requires --ops (the cross-star surface is an explicit index-served read-only allowlist)\n");
    process.exit(2);
  }
  const restriction = { readonly: readonlyOnly, ops: opsAllow, crossStar };
  const restricted = readonlyOnly || opsAllow != null;
  // Fail closed BEFORE opening a store or serving a byte: a bad allowlist (or an fs op on a
  // --cross-star surface) must never reach the wire.
  let exposed: Operation[];
  try {
    exposed = resolveExposedOps(operations, restriction);
  } catch (e) {
    process.stderr.write(`funes mcp: ${(e as Error).message}\n`);
    process.exit(2);
  }

  const backend = funesBackend();
  const dbDir = flag("--db", funesDbDir(vault, backend))!;
  const port = Number(process.env.FUNES_DAEMON_PORT ?? DEFAULT_DAEMON_PORT);

  // One owner of pgdata: prefer the daemon when it serves this vault; else open directly.
  const daemon = await daemonProbe(port, vault);
  let ctx: OperationContext | null = null;
  if (!daemon) {
    // item 24: the actor reaches BOTH the store constructor (the stamped write_actor) and the
    // dispatch context (the audit line), so the two cannot disagree about one write.
    const store = await makeStore({ vault, dbDir, backend, writeActor: actor }); // vault -> collision/identity guard runs; no allowDirty: dirty -> loud error
    const funes = new FunesStore(store, { root: vault });
    ctx = { remote: true, trust: "untrusted", vault, store, funes, designation, actor };
  }

  // H9: the cross-star serve-time scope guard is per-call AND atomic — NOT computed once at startup
  // (that missed mid-session drift) and NOT a check-then-use (a reindex could re-admit excluded rows
  // between the check and the separate content query). In --cross-star mode a client `recall`/
  // `indexed_page` is TRANSLATED to the guarded_* op, which resolves the CURRENT manifest hash from
  // star.yaml and does the check + retrieve + re-check in ONE guarded store read — server-side over the
  // daemon proxy too (the client can't span two RPCs atomically). health stays a plain, exempt call.
  const guardedName = (name: string): string | null =>
    crossStar && name === "recall" ? "guarded_recall"
    : crossStar && name === "indexed_page" ? "guarded_indexed_page"
    : null;

  // SDK v2 / spec 2026-07-28: `serveStdio` owns the era decision for the connection — the opening
  // message selects 2026-07-28 or the legacy 2025-era handshake, ONE instance from this factory is
  // pinned for the connection's life, and `server/discover` is answered by the SDK from the
  // capabilities below. We stay on the LOW-LEVEL `Server` + setRequestHandler rather than
  // `McpServer.registerTool` on purpose: registerTool takes the tool's inputSchema as an ENFORCING
  // schema and validates every call against it pre-dispatch. funes's advertised JSON Schema is
  // deliberately looser than its zod (see ops.ts `count`: a string/garbage `k` coerces or falls back
  // rather than erroring, and the silent clamp is the shipped contract) — so registerTool would turn
  // the most likely sloppy LLM call into an error. `args` stays the ONE enforcement schema.
  const buildServer = (): Server => {
    const server = new Server(
      { name: "funes", version: FUNES_VERSION },
      { capabilities: { tools: {} } },
    );

    // v2 takes the METHOD STRING for spec methods (v1 took a zod request schema object).
    server.setRequestHandler("tools/list", async () => ({
      tools: buildToolDefs(exposed),
    }));

    server.setRequestHandler("tools/call", async (req) => {
      const { name, arguments: args = {} } = req.params;
      try {
        // Guard the direct AND the daemon-proxy path: an op this server does not expose must never reach
        // dispatch or the daemon. Fires for --readonly (mutations dropped) and --ops (anything off the
        // allowlist), with a mode-specific message. Checked FIRST — an off-allowlist op is refused as
        // such regardless of scope state.
        // NOT redundant under v2: because we register ONE `tools/call` handler (not per-tool via
        // registerTool), nothing else refuses an off-allowlist name. This IS the boundary — the
        // `--ops`/`--readonly` refusal wording is part of the documented surface. Do not delete it.
        if (restricted && !exposed.some((o) => o.name === name)) {
          throw new Error(refusalMessage(name, restriction));
        }
        // H9: in --cross-star mode, route recall/indexed_page through the atomic guarded op — over the
        // proxy the daemon runs it server-side; direct, dispatch it from the FULL registry (the guarded
        // ops are internal, absent from `exposed`). Everything else (health, own-star ops) dispatches as-is.
        const guarded = guardedName(name);
        const dispatchName = guarded ?? name;
        const result = daemon
          ? await daemon.call(dispatchName, args as Record<string, unknown>)
          : await dispatchToolCall(guarded ? operations : exposed, dispatchName, args as Record<string, unknown>, ctx!);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `error: ${(e as Error).message}` }], isError: true };
      }
    });
    return server;
  };

  // One connection per stdio process, so the factory runs once — but it stays a factory because
  // that is the seam the SDK uses to pin an era-appropriate instance for the connection.
  serveStdio(buildServer);
  const mode = opsAllow != null ? ` [ops: ${exposed.map((o) => o.name).join(",")}${crossStar ? "; cross-star" : ""}]` : readonlyOnly ? " [readonly]" : "";
  process.stderr.write(
    `funes mcp: serving ${vault} (${daemon ? `proxying daemon :${port}` : "direct store"})${mode}` +
    // The actor is stated only where it applies: over the proxy the daemon's own actor is stamped,
    // and naming this process's here would claim an attribution no write will carry.
    (daemon ? "" : ` [actor: ${actor}]${actor === UNKNOWN_ACTOR ? " (no trusted source — writes stamp unknown)" : ""}`) + "\n",
  );

}
