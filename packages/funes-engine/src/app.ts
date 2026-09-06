// Store→Hono wiring for DIRECT mode (the daemon and the unified Astro surface both own the single
// PGLite connection in-process). This is the funes-side `createApi`: it wires the canonical
// funes-api spine's deps from a star's op-registry + ctx.
//
// 0.3.0 item 15 removed DIRECT from the SERVED FACES (face.ts) — the publication-protocol consumers,
// where a published generation was always the right answer and the live-index fallback silently
// served bytes frozen at open time. It does NOT apply here. This wiring is the live index's OWNER,
// not a consumer of someone else's: the daemon and the unified surface hold the only handle, they
// are the process that mutates it, and they never adopt a swap. That is the CLI's posture, not a
// face's. What item 15 does bind here is identity: if machine state is ever recorded for this path,
// it binds to a random database instance id stored INSIDE the database — never a hash of the db
// path, which is unchanged when a different database replaces the file sitting at it.
//
// Kept SEPARATE from daemon.ts on purpose: daemon.ts imports console.html via a Bun text-import
// (`with { type: "text" }`) + has an import.meta.main side effect — both landmines for a Vite/Node
// build. The unified Astro server bundles THIS module instead (createApp + ops, no Bun-only imports).
import { resolve } from "node:path";
import type { FunesIndexStore } from "./store.ts";
import { FunesStore } from "./funes-store.ts";
import { operations, buildToolDefs, dispatchToolCall, type OperationContext } from "./ops.ts";
import { resolveWriteDesignation } from "./write-designation.ts";
import { createApp, type PolicyHeaders } from "funes-api";

export interface BuildAppOpts {
  store: FunesIndexStore;
  vault: string;
  /** Move 5: daemon-wide rerank posture — a no-op unless `store` was created with a Reranker. */
  rerank?: boolean;
  /** Optional dev-console HTML for GET / . The standalone daemon passes its bundled console.html;
   *  the unified Astro server OMITS it (Astro owns "/", only /api/* is delegated to this app). */
  consoleHtml?: string;
  /** P1.5: optional per-host write policy for mutations (beyond the built-in CSRF/content guards) —
   *  the daemon wires a capability check when a token is configured; absent ⇒ local non-browser
   *  callers may mutate (loopback floor). */
  authorizeWrite?(headers: PolicyHeaders): boolean | Promise<boolean>;
  /** Max mutation body bytes (default 1 MiB in funes-api). */
  maxBodyBytes?: number;
  /** Hosts this app is actually served on. Without it the CSRF check compares Origin against the
   *  attacker-supplied Host and passes on symmetry; see crossOriginRejected in funes-api. */
  allowedHosts?: readonly string[];
  /** 0.3.0 item 24: the actor this process performs its writes as, resolved ONCE at startup from
   *  trusted configuration (the daemon's `--actor` / FUNES_ACTOR) — carried into every dispatch so
   *  the designation audit names the same actor the store stamps. Never from a request. */
  actor?: string;
}

/** Build the canonical funes-api Hono app wired to a star's in-process op-registry (DIRECT mode).
 *  Per-op timing is tracked here (the HTTP wiring) and surfaced in /api/health's timingsMs, mirroring
 *  surface/api createApi. The op-registry stays the source of truth; the route table lives in funes-api. */
export function buildApp(opts: BuildAppOpts) {
  const vault = resolve(opts.vault);
  const ctx: OperationContext = {
    remote: true, trust: "untrusted", vault, store: opts.store,
    funes: new FunesStore(opts.store, { root: vault }),
    rerank: opts.rerank === true,
    // 0.3.0 item 25, resolved ONCE here rather than per dispatch. buildApp runs at startup (the
    // daemon, the unified Astro server), and resolveDesignationMode is fail-closed — so a misspelled
    // FUNES_WRITE_DESIGNATION refuses to build the app instead of throwing on the first mutation an
    // hour into a session. Same posture as face.ts, which has always resolved at startup.
    designation: resolveWriteDesignation(vault),
    actor: opts.actor,
  };
  const timings = new Map<string, number>(); // op -> last duration ms (console health footer)
  const call = async (op: string, args: Record<string, unknown>) => {
    const start = performance.now();
    const result = await dispatchToolCall(operations, op, args, ctx);
    timings.set(op, Math.round(performance.now() - start));
    return result;
  };
  // P1.5: the registry knows which ops mutate — funes-api applies the write guards (POST + JSON +
  // body cap + cross-origin rejection + optional capability) to exactly those. A drive-by browser
  // POST to a mutation is refused; the same-origin dev console and the non-browser MCP proxy are not.
  const mutating = new Set(operations.filter((o) => !o.readonly).map((o) => o.name));
  return createApp({
    call,
    rawHealth: async () => ({
      ...((await dispatchToolCall(operations, "health", {}, ctx)) as Record<string, unknown>),
      timingsMs: Object.fromEntries(timings),
    }),
    opDefs: () => buildToolDefs(operations),
    consoleHtml: opts.consoleHtml,
    allowedHosts: opts.allowedHosts,
    isMutation: (op) => mutating.has(op),
    authorizeWrite: opts.authorizeWrite,
    maxBodyBytes: opts.maxBodyBytes,
  });
}
