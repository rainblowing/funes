// RAI-317 Q10: THE argv parser, for every funes command and for the edge cluster's own entry
// (funes-cf/replica/cli.ts passes its own table). node:util.parseArgs, strict, so an unknown flag
// refuses instead of being silently unread. Two additions around it:
//   - the dash-value pre-pass: strict parseArgs refuses `--body "- item"` as ambiguous, so each
//     declared value option followed by a value becomes `--x=<value>`, up to `--`;
//   - the retired map: an unknown flag that funes 0.6.0 removed names its replacement (RAI-310 D1).
import { parseArgs } from "node:util";

export interface FlagSpec {
  type: "string" | "boolean";
  multiple?: boolean;
}

export interface Command {
  /** One word, or two for `token mint`, `okf normalize` and `home move`. */
  verb: string;
  /** Long flag names, without dashes. */
  flags: Record<string, FlagSpec>;
  /** How many positionals the command takes (default 0). */
  positionals?: number;
}

export type Values = Record<string, string | boolean | string[] | undefined>;

export type Parsed<C extends Command> =
  | { kind: "run"; cmd: C; values: Values; positionals: string[] }
  | { kind: "help"; code: 0 | 2; cmd?: C }
  | { kind: "error"; message: string };

/** A flag funes 0.6.0 removed, and what replaced it. Only for the message: the parser refuses every
 *  flag a command does not declare, and a command that declares one of these names keeps it. */
export const RETIRED_FLAGS: Readonly<Record<string, string>> = {
  "--readonly": "the tier's ceiling and --ops cover it: name the read ops with --ops",
  "--actor": "the grant names the actor: FUNES_ACTOR_MAP + FUNES_CAPABILITY_FILE on stdio, --access on funes serve",
  "--actor-map": "--access <v2 access file> on funes serve, FUNES_ACTOR_MAP on stdio",
  "--capability": "a version-2 access file: --access on funes serve, with Authorization: Bearer",
  "--db": "the index home comes from the vault; --published reads the star's published.db",
  "--home": "the index home comes from the vault (FUNES_HOME relocates the funes home)",
  "--locus": "the locus is FUNES_LOCUS over the short hostname",
  "--hub": "the hub went with the generation manifest (RAI-306): serve each star with `funes mcp --vault <star>`",
  "--stars-file": "the hub went with the generation manifest (RAI-306): serve each star with `funes mcp --vault <star>`",
  "--stars": "the hub went with the generation manifest (RAI-306)",
  "--face": "the face kinds were removed: one server, one star (`funes serve`)",
  "--role": "the face kinds were removed: `funes serve` is the one HTTP host",
  "--bind-allow": "the explicit --bind and the access file replace the allowlist",
  "--write-designation": "one write rule: FUNES_LOCUS against star.yaml meta.write_locus",
  "--ignore-scope": "index_scope always applies",
  "--live": "the live index is the default; --published reads the star's published.db",
  "--mcp": "--url <endpoint> [--token-file <file>]",
  "--hard": "`funes purge <id>` is the hard delete",
  "--source": "--sources",
  "--taste": "taste-bot's scripts/taste-eval.ts",
  "--rerank": "the reranker was deleted in funes 0.6.0 (RAI-314)",
  "--max": "a build resumes where it stopped: run `funes reindex` again",
  "-k": "--k",
  "-v": "--version",
};

/** `--x <value>` → `--x=<value>` for each declared value option, up to `--`. */
function joinValues(args: string[], flags: Record<string, FlagSpec>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") return [...out, ...args.slice(i)];
    if (a.startsWith("--") && !a.includes("=") && flags[a.slice(2)]?.type === "string" && i + 1 < args.length) {
      out.push(`${a}=${args[++i]}`);
    } else out.push(a);
  }
  return out;
}

/** `--help` or `-h` before `--`. */
function helpIn(args: string[]): boolean {
  const end = args.indexOf("--");
  const head = end < 0 ? args : args.slice(0, end);
  return head.includes("--help") || head.includes("-h");
}

/** Parse `argv` (the args after the program) against `table`. Never throws. */
export function parse<C extends Command>(argv: string[], table: readonly C[]): Parsed<C> {
  if (argv.length === 0) return { kind: "help", code: 2 };
  const cmd = table.find((c) => c.verb === `${argv[0]} ${argv[1]}`) ?? table.find((c) => c.verb === argv[0]);
  if (!cmd) {
    if (helpIn(argv)) return { kind: "help", code: 0 };
    const why = RETIRED_FLAGS[argv[0]!];
    return { kind: "error", message: why ? `${argv[0]} was removed in funes 0.6.0 — ${why}` : `unknown command ${JSON.stringify(argv[0])}` };
  }
  const rest = argv.slice(cmd.verb.split(" ").length);
  if (helpIn(joinValues(rest, cmd.flags))) return { kind: "help", code: 0, cmd }; // after the values join: `--body -h` is a body
  let values: Values, positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: joinValues(rest, cmd.flags), options: cmd.flags, strict: true, allowPositionals: true }) as { values: Values; positionals: string[] });
  } catch (e) {
    const err = e as Error & { code?: string };
    const flag = err.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? /'(-[^']*)'/.exec(err.message)?.[1] : undefined;
    if (flag === undefined) return { kind: "error", message: `${cmd.verb}: ${err.message.split("\n")[0]}` };
    const why = RETIRED_FLAGS[flag];
    return { kind: "error", message: why ? `${cmd.verb}: ${flag} was removed in funes 0.6.0 — ${why}` : `${cmd.verb}: unknown flag ${flag}` };
  }
  const max = cmd.positionals ?? 0;
  if (positionals.length > max) return { kind: "error", message: `${cmd.verb}: unexpected argument ${JSON.stringify(positionals[max])}` };
  return { kind: "run", cmd, values: { ...values }, positionals };
}
