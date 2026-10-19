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
import { folderContext } from "./funes-store.ts";
import { folderOperations as operations, operations as registry, buildToolDefs, dispatchToolCall, type OperationContext } from "./ops.ts"; // ADR-0010: no folder host serves put_page
import type { Grant } from "./actor.ts";
import { resolveWriteDesignation } from "./write-designation.ts";
import { createApp, type PolicyHeaders } from "funes-api";
import { CROSS_STAR_HEADER } from "./daemon-client.ts";

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
  /** RAI-159: the per-op authorizer (funes-api `authorize`) — returns the caller's grant, `true`
   *  (admitted with none) or a refusal. The daemon wires `accessAuthorizer` from a v2 access file. */
  authorize?(headers: PolicyHeaders, op: string): Grant | boolean | null | Promise<Grant | boolean | null>;
  /** Max mutation body bytes (default 1 MiB in funes-api). */
  maxBodyBytes?: number;
  /** Hosts this app is actually served on. Without it the CSRF check compares Origin against the
   *  attacker-supplied Host and passes on symmetry; see crossOriginRejected in funes-api. */
  allowedHosts?: readonly string[];
  /** 0.3.0 item 24: the actor this process performs its writes as, resolved ONCE at startup from
   *  trusted configuration (the daemon's `--actor` / FUNES_ACTOR) — carried into every dispatch, so
   *  the designation audit names the actor the store stamps unless a request's grant (`authorize`,
   *  RAI-159) names its caller there instead. Never from a request payload. */
  actor?: string;
  /** PLAN-0.4.0 item 10: this process's `--locus`, which wins over FUNES_LOCUS; the daemon passes its
   *  flag. (twinkling's unified surface never calls buildApp: it builds its own context for
   *  createApi, and dispatchToolCall resolves FUNES_LOCUS onto it on the first dispatch.) */
  locus?: string;
}

/** Build the canonical funes-api Hono app wired to a star's in-process op-registry (DIRECT mode).
 *  Per-op timing is tracked here (the HTTP wiring) and surfaced in /api/health's timingsMs, mirroring
 *  surface/api createApi. The op-registry stays the source of truth; the route table lives in funes-api. */
export function buildApp(opts: BuildAppOpts) {
  const vault = resolve(opts.vault);
  const ctx: OperationContext = {
    ...folderContext({ vault, store: opts.store, trust: "untrusted", remote: true }),
    rerank: opts.rerank === true,
    // 0.3.0 item 25, resolved ONCE here rather than per dispatch. buildApp runs at startup (the
    // daemon; the unified Astro server never calls it — see BuildAppOpts.locus), and
    // resolveDesignationMode is fail-closed — so a misspelled FUNES_WRITE_DESIGNATION refuses to
    // build the app instead of throwing on the first mutation an hour into a session. Same posture as face.ts, which has always resolved at startup. A refused
    // locus or star.yaml write_locus refuses here too (PLAN-0.4.0 item 10); the locus it resolves is
    // the one this app's /api/health and recall_v2 report.
    designation: resolveWriteDesignation(vault, { locus: opts.locus }),
    actor: opts.actor,
  };
  const timings = new Map<string, number>(); // op -> last duration ms (console health footer)
  const call = async (op: string, args: Record<string, unknown>, grant?: object, headers?: PolicyHeaders) => {
    const start = performance.now();
    // RAI-159: a grant the authorizer resolved for THIS request rides on a per-call context — the
    // shared ctx is never mutated, so one caller's grant cannot reach another's call.
    // PLAN-0.5.0 item 17: a `--cross-star` stdio session proxying here marks its calls, so a
    // scope-guarded op it lists (recall_v2, hotlist) takes the cross-star expectation server-side.
    // Honoured from any caller: the marker can only make the guard stricter.
    const crossStar = headers?.get(CROSS_STAR_HEADER) === "1";
    const result = await dispatchToolCall(operations, op, args, grant || crossStar ? { ...ctx, ...(grant ? { grant: grant as Grant } : {}), ...(crossStar ? { crossStar } : {}) } : ctx);
    timings.set(op, Math.round(performance.now() - start));
    return result;
  };
  // P1.5: the registry knows which ops mutate — funes-api applies the write guards (POST + JSON +
  // body cap + cross-origin rejection + optional capability) to exactly those. A drive-by browser
  // POST to a mutation is refused; the same-origin dev console and the non-browser MCP proxy are not.
  // The whole registry, not this host's ceiling: put_page is not served here, yet it is a mutation,
  // so it meets the guards before dispatch answers it (ADR-0010).
  const mutating = new Set(registry.filter((o) => !o.readonly).map((o) => o.name));
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
    authorize: opts.authorize,
    maxBodyBytes: opts.maxBodyBytes,
  });
}
