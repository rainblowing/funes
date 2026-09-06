// mcp.ts server-config helpers — pure + testable, so the fail-closed op-exposure rules are unit
// tested without spawning a server. mcp.ts stays the thin wiring around these.
//
// Two ways to restrict what a funes MCP server exposes:
//   --readonly            drop every mutation (recall-only siblings; the pre-existing flag)
//   --ops a,b,c           an EXPLICIT allowlist — expose EXACTLY these ops, fail closed. This is
//                         the cross-star surface (recall + indexed_page + health): a bare
//                         --readonly still exposes page/tree/graph, which read the vault
//                         FILESYSTEM and bypass index_scope; the allowlist admits only the
//                         index-served read ops, so index_scope is the capability boundary.
import type { Operation } from "./ops.ts";

/** Resolve the op set an MCP server exposes, fail-closed. Throws (caller exits before serving) when
 *  an `--ops` allowlist is empty, names an unknown op, or names any op that is not read-only —
 *  automated/cross-star surfaces are read-only by construction, never by convention. H8: on a
 *  `--cross-star` surface it ALSO refuses any fs-served op (page/tree/graph/neighbors) — those read
 *  the vault filesystem and bypass index_scope, so a cross-star boundary admits index-served reads
 *  only. */
export function resolveExposedOps(
  allOps: Operation[],
  opts: { readonly: boolean; ops: string[] | null; crossStar?: boolean },
): Operation[] {
  let picked: Operation[];
  if (opts.ops != null) {
    if (opts.ops.length === 0) throw new Error("--ops: empty allowlist — refusing to serve (fail-closed)");
    const byName = new Map(allOps.map((o) => [o.name, o]));
    picked = [];
    const seen = new Set<string>();
    for (const name of opts.ops) {
      const op = byName.get(name);
      // H9: internal ops (guarded_*) are un-allowlistable — a client names the public recall/
      // indexed_page; treat an internal name as unknown (fail-closed), never directly servable.
      if (!op || op.internal) throw new Error(`--ops: unknown operation "${name}" — refusing to serve (fail-closed)`);
      if (!op.readonly) {
        throw new Error(`--ops: operation "${name}" is not read-only — the allowlist admits read-only ops only (fail-closed)`);
      }
      if (!seen.has(name)) { seen.add(name); picked.push(op); } // dedupe, preserve allowlist order
    }
  } else {
    // --readonly exposes the read-only subset MINUS internal guarded ops (never client-facing); the
    // unrestricted set keeps them so the daemon can still dispatch the proxy's guarded calls.
    picked = opts.readonly ? allOps.filter((o) => o.readonly && !o.internal) : allOps;
  }
  // H8: a --cross-star surface admits INDEX-served ops only — an fs-served op reads the vault
  // filesystem (or writes it) and bypasses index_scope, so it can never sit on a cross-star
  // boundary. Fail closed at startup, before a byte is served.
  if (opts.crossStar) {
    const fsOp = picked.find((o) => o.served === "fs");
    if (fsOp) {
      throw new Error(`--cross-star: operation "${fsOp.name}" reads the vault filesystem (served: fs) and bypasses index_scope — a cross-star surface admits index-served ops only (fail-closed)`);
    }
  }
  return picked;
}

/** The refusal message for an op that a restricted server does not expose (checked before both the
 *  direct-dispatch AND the daemon-proxy call, so a mutation never reaches either). */
export function refusalMessage(name: string, opts: { readonly: boolean; ops: string[] | null }): string {
  return opts.ops != null
    ? `operation ${name}: not in this server's --ops allowlist`
    : `operation ${name}: refused on a --readonly funes server`;
}
