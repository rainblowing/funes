// mcp.ts server-config helpers — pure + testable, so the fail-closed op-exposure rules are unit
// tested without spawning a server. mcp.ts stays the thin wiring around these.
//
// One way to restrict what a funes MCP server exposes beyond the tier's ceiling and the grant:
//   --ops a,b,c           an EXPLICIT allowlist — expose EXACTLY these ops, fail closed. With
//                         --cross-star it is the cross-star surface (recall + indexed_page + health).
// `--readonly` is gone (RAI-310 D1): the tier ceiling and `--ops` cover it; the CLI parser refuses it.
import type { OpEntry } from "funes-core";

/** Resolve the op set an MCP server exposes, fail-closed. Throws (caller exits before serving) when
 *  an `--ops` allowlist is empty, names an unknown op, or names any op that is not read-only —
 *  automated/cross-star surfaces are read-only by construction, never by convention. H8: on a
 *  `--cross-star` surface it ALSO refuses any fs-served op (page/tree/graph/neighbors) — those read
 *  the vault filesystem and bypass index_scope, so a cross-star boundary admits index-served reads
 *  only. */
export function resolveExposedOps(
  allOps: OpEntry[],
  opts: { ops: string[] | null; crossStar?: boolean },
): OpEntry[] {
  let picked: OpEntry[];
  if (opts.ops != null) {
    if (opts.ops.length === 0) throw new Error("--ops: empty allowlist — refusing to serve (fail-closed)");
    const byName = new Map(allOps.map((o) => [o.name, o]));
    picked = [];
    const seen = new Set<string>();
    for (const name of opts.ops) {
      const op = byName.get(name);
      if (!op) throw new Error(`--ops: unknown operation "${name}" — refusing to serve (fail-closed)`);
      if (!op.readonly) {
        throw new Error(`--ops: operation "${name}" is not read-only — the allowlist admits read-only ops only (fail-closed)`);
      }
      if (!seen.has(name)) { seen.add(name); picked.push(op); } // dedupe, preserve allowlist order
    }
  } else {
    picked = allOps;
  }
  // H8: a --cross-star surface admits the cross-star reads only (ADR-0020) — any other op reads the
  // vault filesystem (or writes it) and bypasses index_scope, so it can never sit on a cross-star
  // boundary. Fail closed at startup, before a byte is served.
  if (opts.crossStar) {
    const fsOp = picked.find((o) => !o.crossStar);
    if (fsOp) {
      throw new Error(`--cross-star: operation "${fsOp.name}" is not a cross-star read (it reads the vault filesystem and bypasses index_scope) — a cross-star surface admits the cross-star reads only (fail-closed)`);
    }
  }
  return picked;
}

/** The refusal message for an op that a restricted server does not expose (checked before dispatch,
 *  so a mutation never reaches it). */
export function refusalMessage(name: string, opts: { ops: string[] | null; published?: boolean }): string {
  return opts.ops != null
    ? `operation ${name}: not in this server's --ops allowlist`
    : `operation ${name}: refused on a --published funes server (the published index is read-only)`;
}
