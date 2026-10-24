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
//   bun packages/funes-engine/src/mcp.ts --vault <star path> [--ops a,b,c] [--cross-star] [--published]
// The process opens the star's libSQL index itself (ADR-0021): libSQL WAL is multi-process safe, so
// no probe and no proxy. The write rule's locus is FUNES_LOCUS over the short hostname (RAI-302).
// --published (ADR-0018, ADR-0021) serves the star's `<home>/published.db` read-only, read ops only,
// and reopens the path when a publish swaps it.
// A retired flag (`--readonly`, `--actor`, `--db`, `--locus`, …) refuses at startup and names its
// replacement (RAI-310 D1): the one CLI parser refuses every flag `mcp` does not declare (cli-parse.ts).
// --ops a,b,c is an EXPLICIT read-only allowlist: it admits only the ops named. An
// empty/unknown/mutation-containing allowlist fails closed at startup.
// --cross-star marks a SIBLING (cross-star) surface: it requires --ops, refuses every op that is not a
// cross-star read (page/tree/graph/neighbors) at startup, and dispatches on a cross-star context, so a
// stale/missing/ignored/mid-reindex boundary refuses recall/indexed_page (ADR-0020: no guarded twins). An own-star --ops binding
// omits --cross-star and keeps its fs ops (personal legitimately uses page over its own brain).
// FUNES_ACTOR_MAP=<v2 access file> (RAI-159) gives the SESSION a role: FUNES_CAPABILITY_FILE must then
// name its own token (no fallback to the shared ~/.twinkling/funes-cap), the token must name an actor
// whose grant reaches this star, and the exposed ops narrow to that role — or the server does not
// start. Resolved once: revoking a session's grant needs a session restart. The grant's actor is the
// stamped write_actor; with no grant a write stamps `unknown` (RAI-310 D9).
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { FunesStore } from "funes-core/internal";
import { folderVaultContext, folderFunesStore } from "./funes-store.ts";
import { makeStore } from "./factory.ts";
import type { FunesIndexStore } from "funes-core";
import { openPublished, type StoreLease } from "./published-store.ts";
import { ceiling as tierCeiling, dispatchToolCall, type OpEntry, type OperationContext } from "funes-core";
import { buildToolDefs, toolText } from "funes-core/internal";
import { resolveWriteDesignation } from "./process-locus.ts";
import { processLocus } from "./process-locus.ts";
import { resolveSessionGrant } from "./actor.ts";
import { type Grant } from "funes-core";
import { assertLocalOpen, readStarIdentity } from "./factory.ts";
import { resolveExposedOps, refusalMessage } from "./mcp-config.ts";
import { FUNES_VERSION } from "funes-core/internal";

/** The stdio server's options, as the CLI parsed them (`funes mcp`). */
export interface McpOpts {
  vault: string;
  /** `--ops`: present (even empty) ⇒ allowlist mode; an empty list fails closed. */
  ops?: string;
  crossStar?: boolean;
  published?: boolean;
}

/** Run the stdio MCP server to completion. */
export async function runMcp(o: McpOpts): Promise<void> {
  const vault = resolve(o.vault);
  const servesPublished = o.published === true;
  // --ops's mere presence is allowlist mode; the value is parsed even if empty so an empty list
  // fails closed (rather than silently degrading to "no restriction").
  const opsAllow = o.ops !== undefined ? o.ops.split(",").map((s) => s.trim()).filter(Boolean) : null;
  // H8: --cross-star marks this server as a SIBLING (cross-star) boundary. It (a) refuses fs-served
  // ops (page/tree/graph/neighbors — they read the vault filesystem and bypass index_scope) at
  // startup, and (b) turns on the atomic index_scope serve guard (H9). It is the sibling's static
  // config that carries it; an own-star runtime binding never does (personal legitimately uses page).
  const crossStar = o.crossStar === true;
  // --cross-star is the cross-star SURFACE — defined by an explicit read-only allowlist. Without
  // --ops there is no allowlist to bound, so fail closed rather than serve the full/-readonly set.
  if (crossStar && opsAllow == null) {
    process.stderr.write("funes mcp: --cross-star requires --ops (the cross-star surface is an explicit index-served read-only allowlist)\n");
    process.exit(2);
  }
  const restriction = { ops: opsAllow, crossStar, published: servesPublished };
  // Fail closed BEFORE opening a store or serving a byte: a bad allowlist (or an fs op on a
  // --cross-star surface) must never reach the wire.
  let ceiling: OpEntry[];
  // RAI-159: with FUNES_ACTOR_MAP set, this session's own token names its actor and role, checked
  // HERE, before the store opens. The role narrows the ceiling above — how stdio says "remember but
  // not forget", which --ops cannot.
  let grant: Grant | null;
  // PLAN-0.4.0 item 10: the locus is a usage error like --ops, so it is resolved in the same exit-2
  // block — as doctor and the mutators (cli.ts locusArg) refuse it.
  let locus: string | null;
  try {
    assertLocalOpen(vault); // ADR-0021: a Turso star has one owner, its `funes serve`
    ceiling = resolveExposedOps(tierCeiling("home"), restriction); // ADR-0020: the home tier's ops
    grant = resolveSessionGrant(readStarIdentity(vault).id);
    locus = processLocus(); // RAI-324: FUNES_LOCUS over the short hostname
  } catch (e) {
    process.stderr.write(`funes mcp: ${(e as Error).message}\n`);
    process.exit(2);
  }
  // 0.3.0 item 25, resolved ONCE at startup, so a refused star.yaml write_locus (item 10) is a
  // startup failure, not an MCP tool error on the FIRST WRITE, mid-session. `locus` is already
  // validated and normalized; null means no FUNES_LOCUS and no hostname.
  const designation = resolveWriteDesignation(vault, { locus: locus ?? undefined });
  // C14: --ops and a read-only (published) store narrow the ceiling; the same set rides on ctx.narrow.
  const narrowed = servesPublished ? ceiling.filter((o) => o.readonly) : ceiling;
  const exposed = grant ? narrowed.filter((o) => grant.ops.has(o.name)) : narrowed;
  if (grant && exposed.length === 0) {
    process.stderr.write(`funes mcp: actor "${grant.actor}" is granted none of this server's operations — refusing to serve (fail-closed)\n`);
    process.exit(2);
  }
  const restricted = servesPublished || opsAllow != null || grant != null;
  const narrow = restricted ? new Set(exposed.map((o) => o.name)) : undefined;

  const ctxOf = (store: FunesIndexStore): OperationContext => ({
    ...folderVaultContext(vault, store), store, funes: folderFunesStore(store, { root: vault }),
    designation, ...(grant ? { grant } : {}), ...(crossStar ? { crossStar } : {}), ...(narrow ? { narrow } : {}),
  });
  let use: <T>(fn: (ctx: OperationContext) => Promise<T>) => Promise<T>;
  if (servesPublished) {
    let lease: StoreLease;
    try {
      lease = await openPublished(vault);
    } catch (e) {
      process.stderr.write(`funes mcp: ${(e as Error).message}\n`);
      process.exit(2);
    }
    use = (fn) => lease.use((store) => fn(ctxOf(store)));
  } else {
    // A session with a grant IS its grant's actor (RAI-159): one process, one credential. Else `unknown`.
    const ctx = ctxOf(await makeStore({ vault, writeActor: grant?.actor })); // vault -> collision/identity guard runs; no allowDirty: dirty -> loud error
    use = (fn) => fn(ctx);
  }

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
        // An op this server does not expose must never reach dispatch. Fires for --published (mutations dropped) and --ops (anything off the
        // allowlist), with a mode-specific message. Checked FIRST — an off-allowlist op is refused as
        // such regardless of scope state.
        // NOT redundant under v2: because we register ONE `tools/call` handler (not per-tool via
        // registerTool), nothing else refuses an off-allowlist name. This IS the boundary — the
        // `--ops` refusal wording is part of the documented surface. Do not delete it.
        if (restricted && !exposed.some((o) => o.name === name)) {
          // The ceiling's own refusal wins where it applies; past it, the grant is what said no.
          throw new Error(
            grant && ceiling.some((o) => o.name === name) ? `operation ${name}: not granted to actor "${grant.actor}"`
            : servesPublished || opsAllow != null ? refusalMessage(name, restriction)
            : `unknown operation: ${name}`, // a grant alone restricts; the unrestricted ceiling is the registry
          );
        }
        // ADR-0020: a cross-star call is the base op on a cross-star context.
        const result = await use((ctx) => dispatchToolCall(name, args as Record<string, unknown>, ctx));
        return { content: [{ type: "text", text: toolText(result) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `error: ${(e as Error).message}` }], isError: true };
      }
    });
    return server;
  };

  // One connection per stdio process, so the factory runs once — but it stays a factory because
  // that is the seam the SDK uses to pin an era-appropriate instance for the connection.
  serveStdio(buildServer);
  const mode = (opsAllow != null ? ` [ops: ${exposed.map((o) => o.name).join(",")}${crossStar ? "; cross-star" : ""}]` : servesPublished ? " [published, read-only]" : "") +
    (grant ? ` [grant: ${grant.actor} → ${exposed.map((o) => o.name).join(",")}]` : "");
  process.stderr.write(`funes mcp: serving ${vault}${mode}${grant ? "" : " [actor: unknown]"}\n`);
}
