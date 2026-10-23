// RAI-317 Q1, Q2, Q5: the op verbs. Each one is GENERATED from a registry entry of the home ceiling —
// the same name, the same arguments — and runs through `dispatchToolCall` (local) or the same call over
// HTTP MCP (`--url`). No per-op CLI code: the op's own zod is the one argument gate.
//   argv form: a required arg named query, path, id or oldId is the one positional; every other arg is
//   a kebab-case flag; an array is a repeatable flag whose values also split on commas; an object is
//   JSON; `body` reads stdin when absent.
//   output: `--json` prints `toolText(result)`, byte-equal to the stdio MCP text; the default is YAML.
//   exit codes: 0 ok · 1 error · 2 invalid · 3 refused · 75 busy.
import { writeSync } from "node:fs";
import { stringify as toYaml } from "yaml";
import type { PageStatRecord } from "funes-core/internal";
import { ceiling, type OpEntry } from "funes-core";
import { toolText } from "funes-core/internal";
import type { Command } from "./cli-parse.ts";
import { vaultChangedSince } from "funes-core/internal";
import { FolderVault } from "./folder-vault.ts";
import { readIndexScopeExcludes } from "./scope.ts";
import { resolveWriteDesignation } from "./process-locus.ts";
import { type WriteDesignation } from "funes-core/internal";
import { processLocus } from "./process-locus.ts";

type Kind = "string" | "number" | "boolean" | "list" | "json";

export interface OpCommand extends Command {
  op: string;
  /** flag name → op arg key (`as-of` → `as_of`). */
  args: Record<string, string>;
  kinds: Record<string, Kind>;
  /** The op arg the one positional fills. */
  positional?: string;
  /** The op arg that reads stdin when absent. */
  stdin?: string;
  synopsis: string;
  summary: string;
}

const POSITIONAL = new Set(["query", "path", "id", "oldId"]);
const kebab = (k: string) => k.replace(/_/g, "-").replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const kindOf = (t: unknown): Kind => t === "boolean" ? "boolean" : t === "number" || t === "integer" ? "number" : t === "array" ? "list" : t === "object" ? "json" : "string";

/** The flags every op verb takes besides its op args. */
const COMMON = { vault: { type: "string" }, url: { type: "string" }, "token-file": { type: "string" }, json: { type: "boolean" } } as const;

export function opCommand(e: OpEntry): OpCommand {
  const { properties, required = [] } = e.inputSchema;
  const positional = Object.keys(properties).find((k) => required.includes(k) && POSITIONAL.has(k));
  const stdin = "body" in properties ? "body" : undefined;
  const args: Record<string, string> = {}, kinds: Record<string, Kind> = {}, flags: Command["flags"] = { ...COMMON };
  const syn: string[] = [e.name, ...(positional ? [`<${kebab(positional)}>`] : [])];
  for (const [k, s] of Object.entries(properties)) {
    if (k === positional) continue;
    const name = kebab(k), kind = kindOf(s.type);
    args[name] = k;
    kinds[name] = kind;
    flags[name] = kind === "boolean" ? { type: "boolean" } : { type: "string", multiple: kind === "list" };
    const text = kind === "boolean" ? `--${name}`
      : k === stdin ? `--${name} <text>|stdin`
      : `--${name} <${kind === "number" ? "n" : kind === "json" ? "json" : name}>${kind === "list" ? "…" : ""}`;
    syn.push(required.includes(k) ? text : `[${text}]`);
  }
  return { verb: e.name, op: e.name, flags, positionals: positional ? 1 : 0, args, kinds, positional, stdin, synopsis: syn.join(" "), summary: e.description.split(/(?<=\.)\s/)[0]! };
}

/** The 11 op verbs: the home tier's ceiling, in registry order (RAI-304). */
export const OP_COMMANDS: OpCommand[] = ceiling("home").map(opCommand);

/** The op args for parsed values, or a usage error. The positional and every flag pass as given:
 *  numbers stay strings, so the op's zod coerces and clamps them exactly as over MCP. */
export function opArgs(cmd: OpCommand, values: Record<string, unknown>, positionals: string[]): Record<string, unknown> | string {
  const out: Record<string, unknown> = {};
  if (cmd.positional && positionals[0] !== undefined) out[cmd.positional] = positionals[0];
  for (const [flag, arg] of Object.entries(cmd.args)) {
    const v = values[flag];
    if (v === undefined) continue;
    if (cmd.kinds[flag] === "json") {
      try { out[arg] = JSON.parse(String(v)); } catch { return `${cmd.verb}: --${flag} takes JSON`; }
    } else if (cmd.kinds[flag] === "list") {
      out[arg] = (v as string[]).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
    } else out[arg] = v;
  }
  return out;
}

/** RAI-317 Q4: the CLI's write designation, resolved ONCE at startup, before stdin and before the store:
 *  FUNES_LOCUS over the short hostname (the hostname default lives only at the process entries). */
export const cliDesignation = (vault: string): WriteDesignation =>
  resolveWriteDesignation(vault, { locus: processLocus() ?? undefined });

/** The exit code of a thrown refusal: its `code` decides (RAI-317 Q5). */
export function exitCodeOf(e: unknown): 1 | 2 | 3 | 75 {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "invalid") return 2;
  if (code === "not-write-locus" || code === "not-granted" || code === "out-of-scope") return 3;
  if (code === "busy") return 75;
  return 1;
}

/** Run one op call and render it. A proposal answer refused (ADR-0010) exits 3, or 2 when its reason
 *  is `invalid`, and still prints the answer. Diagnostics go to `err`, so `--json` stdout stays exact. */
export async function runOp(
  op: string, args: Record<string, unknown>, json: boolean,
  call: (op: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<{ code: number; out: string; err: string; result?: unknown }> {
  let result: unknown;
  try {
    result = await call(op, args);
  } catch (e) {
    // Some throw sites brand their own message `funes: …` (they surface over MCP too): one brand, not two.
    return { code: exitCodeOf(e), out: "", err: `funes ${op}: ${(e as Error).message.replace(/^funes: /, "")}` };
  }
  const out = json ? toolText(result) : typeof result === "string" ? result : toYaml(result).trimEnd();
  const r = result as { status?: unknown; reason?: unknown } | null;
  const code = r?.status === "refused" ? (r.reason === "invalid" ? 2 : 3) : 0;
  return { code, out, err: "", result };
}

/** One stderr line whenever a local `recall` is about to succeed while telling the user nothing.
 *  Silence and "no results" are indistinguishable at exit 0, and the staleness case is worse: it is
 *  how an agent cites content the vault has already superseded (0.3.0 item 18, 0.4.0 item 6). */
export async function noteEmptyOrStale(
  store: { pageStats(): Promise<PageStatRecord | null> }, vault: string, st: { nodes: number; lastReindexAt: string | null },
  hits: number, q?: string, write: (line: string) => void = (line) => writeSync(2, line),
): Promise<void> {
  if (st.nodes === 0) {
    write(`funes: the index is empty — run \`funes reindex --vault ${vault}\` first\n`);
    return;
  }
  if (hits === 0) write(`funes: no hits${q ? ` for ${JSON.stringify(q)}` : ""} across ${st.nodes} indexed note(s)\n`);
  // vaultChangedSince folds "never reindexed" and "could not walk the vault" into one null; only the
  // first has a useful instruction, so the NaN case keeps its own message.
  const at = st.lastReindexAt ? Date.parse(st.lastReindexAt) : NaN;
  if (Number.isNaN(at)) {
    write(`funes: no full reindex recorded — freshness unknown (run reindex to stamp it)\n`);
  } else {
    const f = await vaultChangedSince(new FolderVault(vault), readIndexScopeExcludes(vault), async () => st.lastReindexAt, () => store.pageStats());
    if (f.changed) {
      write(`funes: notes have changed since the last reindex (${st.lastReindexAt}) — those edits are INVISIBLE to recall; run \`funes reindex --vault ${vault}\`\n`);
    } else if (f.basis === "none") {
      write(`funes: this index records no per-page stats — freshness unknown (a full \`funes reindex --vault ${vault}\` records them)\n`);
    }
  }
}
