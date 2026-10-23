// RAI-324 (RAI-302): a Node/Bun process entry's locus — `--locus` over FUNES_LOCUS over the
// normalized short hostname. The ONE module that reads the hostname for a locus, imported only by
// the host's entries (the CLI, `mcp`, `serve`, the folder context). The kernel (funes-core) reads no
// environment: it takes the designation this module resolves.
import { hostname } from "node:os";
import { designationFor, validLocus, type WriteDesignation } from "funes-core/internal";
import { readStarIdentity } from "./factory.ts";

/** PLAN-0.4.0 item 10: THIS process's locus — `--locus` over FUNES_LOCUS over `hostname` (RAI-324:
 *  its first label, as `hostname -s`), normalized, `null` when none is set. `hostname` is passed only
 *  by a Node/Bun process entry (process-locus.ts); portable code never reads one. Resolved ONCE per
 *  process at startup (like `--ops`) and carried from that one value into the write rule,
 *  `OperatorState.locus` (health, /api/health, doctor), the face's /health and
 *  the hub's groups. A set-but-empty flag or variable is refused, not unset. */
export function resolveLocus(o: { flag?: string; env?: NodeJS.ProcessEnv; hostname?: string }): string | null {
  const raw = o.flag ?? (o.env ?? process.env).FUNES_LOCUS;
  if (raw != null) {
    const source = o.flag != null ? "--locus" : "FUNES_LOCUS";
    const locus = validLocus(raw, source);
    // RAI-322: the org export declares `<w>.export`, so no process may be one (a short hostname has no dot)
    if (locus.endsWith(".export")) throw new Error(`${source} ${JSON.stringify(raw)} ends in ".export" — that suffix names the org export's write locus, never a machine (fail-closed)`);
    return locus;
  }
  const short = o.hostname?.split(".")[0];
  return short ? validLocus(short, "the short hostname") : null;
}

export const processLocus = (flag?: string, env: NodeJS.ProcessEnv = process.env): string | null =>
  resolveLocus({ flag, env, hostname: hostname() });

/** Resolve the designation for a vault. The authority can only come from the star's own manifest,
 *  which is the point — it travels with the star rather than with the machine. Both halves throw on
 *  a refused name. */
export function resolveWriteDesignation(vault: string, opts: { locus?: string; env?: NodeJS.ProcessEnv } = {}): WriteDesignation {
  // A serving context with no vault has no star manifest to declare anything: undeclared, not a crash.
  return designationFor(vault ? readStarIdentity(vault).writeLocus : null, `${vault}/star.yaml`, resolveLocus({ flag: opts.locus, env: opts.env ?? process.env }));
}
