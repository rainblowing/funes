// Store→Hono wiring for DIRECT mode (the daemon and the unified Astro surface both own the single
// PGLite connection in-process). This is the funes-side `createApi`: it wires the canonical
// funes-api spine's deps from a star's op-registry + ctx.
//
// Kept SEPARATE from daemon.ts on purpose: daemon.ts imports console.html via a Bun text-import
// (`with { type: "text" }`) + has an import.meta.main side effect — both landmines for a Vite/Node
// build. The unified Astro server bundles THIS module instead (createApp + ops, no Bun-only imports).
import { resolve } from "node:path";
import type { FunesIndexStore } from "./store.ts";
import { FunesStore } from "./funes-store.ts";
import { operations, buildToolDefs, dispatchToolCall, type OperationContext } from "./ops.ts";
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
