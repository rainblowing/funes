#!/usr/bin/env bun
// The one funes CLI (RAI-317): one command table, one strict parser (cli-parse.ts). The 11 op verbs
// are generated from the home ceiling and run through `dispatchToolCall`, or over HTTP MCP with
// `--url` (cli-ops.ts). The 13 operator commands below are CLI-only. It dispatches unconditionally at
// load, with no `import.meta.main` (undefined on older Node 22.x); mcp.ts runs it with `mcp` prepended.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { makeStore, funesDbDir, readStarIdentity } from "./factory.ts";
import { E5Embedder } from "./embedder.ts";
import { funesHome } from "./funes-home.ts";
import type { FunesIndexStore } from "funes-core";
import { processLocus } from "./process-locus.ts";
import { assertWriteAllowed } from "funes-core/internal";
import { reindex as reindexVault } from "./reindex.ts";
import { corpusOf, readIndexScopeExcludes } from "./scope.ts";
import { ownStarExpectation } from "funes-core/internal";
import { sameStar } from "funes-core/internal";
import { FUNES_VERSION } from "funes-core/internal";
import { assertIndexNotInSyncRoot } from "./sync-root.ts";
import { parse, type Command } from "./cli-parse.ts";
import { OP_COMMANDS, cliDesignation, exitCodeOf, noteEmptyOrStale, opArgs, runOp, type OpCommand } from "./cli-ops.ts";

// P3.15: a CLI owes the user a sentence, not a stack trace. Only a bug class (and a non-Error throw)
// prints its stack (RAI-317 Q12): about 140 plain `throw new Error(` sites are user errors.
for (const ev of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(ev, (err: unknown) => {
    const bug = !(err instanceof Error) || err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError || err instanceof SyntaxError;
    // Sixteen throw sites brand their own message `funes: …` (they also surface over MCP), so the
    // brand is stripped before it is added: one `funes: `, never two.
    const msg = bug ? ((err as Error | undefined)?.stack ?? String(err)) : `funes: ${(err as Error).message.replace(/^funes: /, "")}`;
    // writeSync, not console.error: on a piped stderr console.error is asynchronous and process.exit()
    // drops the pending write — the command would die with no explanation.
    try { writeSync(2, msg + "\n"); } catch { /* stderr already gone */ }
    process.exit(exitCodeOf(err));
  });
}

// ── the command table ─────────────────────────────────────────────────────────────────────────────
const S = { type: "string" } as const;
const B = { type: "boolean" } as const;
interface OperatorCommand extends Command { synopsis: string; summary: string }
const OPERATORS: OperatorCommand[] = [
  { verb: "reindex", flags: { vault: S, fresh: B }, synopsis: "reindex [--fresh]",
    summary: "build or refresh the live index; an interrupted build resumes where it stopped. --fresh rebuilds it\n" +
      "in place (a changed model or schema needs it); writers wait meanwhile, and readers see a partial index." },
  { verb: "publish", flags: { vault: S, force: B, json: B, rollback: B, from: S }, synopsis: "publish [--force] [--json]  ·  publish --rollback [--from <file>] [--json]",
    summary: "build <home>/published.db off-path and swap it in whole; the live index.db is never touched. It skips\n" +
      "when published.db already carries the vault's content; else it builds from a clone of published.db, so\n" +
      "unchanged pages are not re-embedded. --force builds from empty. The outgoing file stays as published.db.prev.\n" +
      "--rollback serves published.db.prev again (or --from another file in the home), by the same swap; it refuses\n" +
      "an absent target, the served file, a build under another index_scope hash or another star's owner id,\n" +
      "and one that fails quick_check. It holds only while publish and watch are stopped. A held publish lock exits 75." },
  { verb: "serve", flags: { vault: S, bind: S, port: S, host: S, access: S, ops: S, published: B, stats: B },
    synopsis: "serve --bind <ip> [--port <n>] [--host <name:port>] [--access <file>] [--ops <a,b>] [--published] [--stats]",
    summary: "the one HTTP MCP server: POST /mcp with Authorization: Bearer. The tier is the star's memory.tier. With\n" +
      "no --access, a loopback bind serves tokenless reads only. Off loopback it refuses to start without an access\n" +
      "file, an exact --host, the star's write_locus equal to this locus, and (home tier) a Tailscale address." },
  { verb: "mcp", flags: { vault: S, ops: S, "cross-star": B, published: B }, synopsis: "mcp [--ops <a,b>] [--cross-star] [--published]",
    summary: "run the stdio MCP server. --ops narrows it to the read ops named; --cross-star (requires --ops) serves the\n" +
      "cross-star reads only; --published serves the star's published index read-only and reopens it on a swap." },
  { verb: "watch", flags: { vault: S, syncthing: S, interval: S, "min-interval": S }, synopsis: "watch [--syncthing <url>] [--interval <5s>] [--min-interval <60s>]",
    summary: "keep a receive-only Syncthing replica published: polls the folder's status and runs `publish --json` once\n" +
      "it is idle, needs nothing, and its sequence has held for two polls — at most once per --min-interval.\n" +
      "Loopback https only, pinned to Syncthing's https-cert.pem; API key from STGUIAPIKEY, else config.xml.\n" +
      "Syncthing down: backs off 2s -> 30s. Exit 2 on a refusal (not receiveonly, no key or certificate)." },
  { verb: "doctor", flags: { vault: S, published: B, json: B }, synopsis: "doctor [--published] [--json]",
    summary: "audit the live index: dangling edges by type, orphan and dangling-only nodes, relation spelling forks,\n" +
      "Syncthing conflict copies and unparsed pages. A report; it never repairs and never fails on a finding.\n" +
      "--published audits <home>/published.db instead, its owner checked against star.yaml before the first row." },
  { verb: "scan", flags: { vault: S }, synopsis: "scan",
    summary: "the share-clean gate: the built-in secret detector, plus gitleaks when it is on PATH, over every markdown\n" +
      "file in star.yaml index_scope. Prints the file and kind of each finding, never the value. Exit 1 on a finding." },
  { verb: "okf normalize", flags: { vault: S, apply: B }, synopsis: "okf normalize [--apply]",
    summary: "the OKF floor's lint: each file the normalizer would edit, and each it refuses. Writes nothing; exit 1 while\n" +
      "any remains. --apply converts where the write rule allows (exit 3 elsewhere), pre-images under .history/." },
  { verb: "eval", flags: { vault: S, fixture: S, baseline: B, json: B, published: B, draft: B, out: S, seen: S, unseen: S, force: B, url: S, "token-file": S },
    synopsis: "eval [--fixture <f>] [--baseline] [--json] [--published] [--draft [--out <f>] [--seen <n>] [--unseen <n>] [--force]] [--url <e> [--token-file <f>]]",
    summary: "the recall eval over the live index (--published: published.db; --url: an HTTP MCP endpoint). --baseline\n" +
      "writes this locus's baseline once; --draft samples a fixture skeleton whose answers a human fills." },
  { verb: "elevate", positionals: 1, flags: { vault: S }, synopsis: "elevate <id>",
    summary: "promote an item to trusted: a deliberate human act, never implied by a write (the write rule applies)." },
  { verb: "purge", positionals: 1, flags: { vault: S }, synopsis: "purge <id>",
    summary: "delete an item's file outright: the only hard delete (the write rule applies)." },
  { verb: "token mint", flags: { access: S, actor: S, role: S, star: { type: "string", multiple: true }, out: S, edge: S, label: S, days: S },
    synopsis: "token mint --access <file> --actor <name> --role <role> --star <ref|*>… --out <file>\n" +
      "  token mint --edge <star key> --role <outbox|bot|agent> --label <label> --star <ref>… [--days <n>] --out <file>",
    summary: "mint a token: into a v2 access file (serve's --access), or as the transaction for an edge grant. The token\n" +
      "goes to --out (0600, never over a file that holds one), never to stdout." },
  { verb: "home move", flags: {}, synopsis: "home move",
    summary: "move ~/.twinkling to ~/.funes, offline: refuses when FUNES_HOME is set, on a live lock owner, a new home\n" +
      "already holding state, or a cross-device rename. A rerun finishes an interrupted move." },
  { verb: "home", flags: {}, synopsis: "home", summary: "print the funes home ($FUNES_HOME, else ~/.funes)." },
];
const TABLE: Array<OpCommand | OperatorCommand> = [...OP_COMMANDS, ...OPERATORS];

/** The funes home as help names it, or a placeholder when it refuses: help answers before the refusal. */
const homeForHelp = () => { try { return funesHome(); } catch { return "<funes home>"; } };
const indent = (text: string, n: number) => text.split("\n").map((l) => " ".repeat(n) + l).join("\n");
const entry = (c: OpCommand | OperatorCommand) => `  ${c.synopsis}\n${indent(c.summary, 6)}`;
const usage = () => `usage: funes <command> [options]        funes ${FUNES_VERSION}

Memory ops: the MCP tools, the same names and arguments; --json prints the MCP answer exactly.
${OP_COMMANDS.map(entry).join("\n")}
  Every op takes [--vault <path> | --url <endpoint> [--token-file <file>]] and [--json]. The default
  output is YAML. Put a positional that starts with a dash after --. --url sends the call to funes serve
  or the edge; off loopback it needs --token-file (on loopback the default is FUNES_CAPABILITY_FILE,
  else <funes home>/funes-cap).

Operator commands (CLI only), each with [--vault <path>]:
${OPERATORS.map(entry).join("\n")}

  funes <command> --help shows one command.   funes --version
  --vault defaults to the CURRENT DIRECTORY. FUNES_HOME relocates the funes home.
  Model cache: ${join(homeForHelp(), "models")}, 135MB on first run.
  The locus is FUNES_LOCUS, else the short hostname. A write (an op, elevate, purge, okf normalize
  --apply) proceeds when star.yaml declares no meta.write_locus or this locus equals it, else it
  refuses with not-write-locus. CLI writes stamp the actor "unknown".
  Exit codes: 0 ok · 1 error · 2 usage or an invalid argument · 3 refused (not-write-locus, not-granted,
  out-of-scope) · 75 busy (the write lock or the publish lock; try again).`;

// ── parse ─────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const parsed = parse(argv, TABLE);
if (parsed.kind === "help") {
  // --help is answered BEFORE anything runs: it once fell through to reindex and indexed the cwd.
  console.log(parsed.cmd ? `usage: funes ${parsed.cmd.synopsis}\n${indent(parsed.cmd.summary, 2)}` : usage());
  process.exit(parsed.code);
}
if (parsed.kind === "error" && argv[0] === "--version" && argv.length === 1) {
  funesHome(); // a legacy home refuses every command, this one too (ADR-0016)
  console.log(FUNES_VERSION);
  process.exit(0);
}
if (parsed.kind === "error") {
  writeSync(2, `funes: ${parsed.message} — funes --help lists the commands and flags\n`);
  process.exit(2);
}
const { cmd, values, positionals } = parsed;
const str = (k: string): string | undefined => values[k] as string | undefined;
const has = (k: string): boolean => values[k] === true;
function fail(code: number, msg: string): never {
  writeSync(2, `${msg}\n`);
  process.exit(code);
}

// ADR-0016 (RAI-311): a legacy home, an empty FUNES_HOME or a retired name refuses EVERY command, not
// only the ones that touch a home-derived path. `home move` is the exception: a legacy home is its input.
if (cmd.verb !== "home move") funesHome();

/** `--vault` defaults to the cwd, and a path that is not there is a refusal, not a default: the wrong
 *  directory or a typo would otherwise index whatever is around, or answer nothing with exit 0. */
const vaultArg = (): string => {
  const raw = str("vault") ?? process.cwd();
  const v = resolve(raw);
  if (!existsSync(v)) fail(2, `funes: --vault ${v} does not exist${str("vault") === undefined ? " (no --vault given, so this is the current directory)" : ""}`);
  if (!statSync(v).isDirectory()) fail(2, `funes: --vault ${v} is not a directory`);
  return v;
};
/** This process's locus (FUNES_LOCUS over the short hostname); a refused name is a usage error. */
const locusArg = (): string | null => {
  try { return processLocus(); } catch (e) { return fail(2, `funes: ${(e as Error).message}`); }
};
/** The index home of a vault: the directory of its live index.db, where published.db sits too. */
const homeOf = (vault: string) => dirname(funesDbDir(vault));

/** The guarded read every MCP op takes, against the own-star expectation: a star.yaml narrowed since
 *  the build refuses with the MCP message and exit 3, after the store is closed. */
async function guardedOrRefuse<T>(store: FunesIndexStore, vault: string, retrieve: () => Promise<T>): Promise<T> {
  const r = await store.guardedRead(ownStarExpectation(() => readIndexScopeExcludes(vault)), retrieve);
  if ("ok" in r) return r.ok;
  await store.close().catch(() => {});
  return fail(3, `funes: ${r.refusal}`);
}

/** The corpus `publish` builds from a valid or absent star.yaml scope: the same exclude predicate as
 *  reindex's, and the scope signature it stamps. Shared with `eval --json`, whose `vaultGeneration`
 *  must be the target THIS publish would stamp (PLAN-0.4.0 item 17). */
const publishCorpus = corpusOf;

/** The operator writes (elevate, purge): the one write rule BEFORE the store opens (RAI-324). */
async function openWriter(vault: string, op: string) {
  try { assertWriteAllowed(cliDesignation(vault), op); } catch (e) { return fail(exitCodeOf(e) === 3 ? 3 : 2, `funes: ${(e as Error).message}`); }
  const { folderFunesStore } = await import("./funes-store.ts");
  const store = await makeStore({ vault });
  return { store, funes: folderFunesStore(store, { root: vault }) };
}

async function readStdin(): Promise<string> {
  // `Readable.toWeb`, not `Bun.stdin` (Bun only): stable on Bun and on the Node range the bin supports.
  const { Readable } = await import("node:stream");
  return (await new Response(Readable.toWeb(process.stdin) as ReadableStream).text()).trim();
}

// ── the op verbs ──────────────────────────────────────────────────────────────────────────────────
async function runOpVerb(c: OpCommand): Promise<void> {
  const args = opArgs(c, values, positionals);
  if (typeof args === "string") fail(2, `funes: ${args}`);
  const a = args as Record<string, unknown>;
  const url = str("url");
  const readBody = async () => {
    if (c.stdin && a[c.stdin] === undefined && !process.stdin.isTTY) a[c.stdin] = await readStdin();
  };
  let r: Awaited<ReturnType<typeof runOp>>;
  if (url !== undefined) {
    if (str("vault") !== undefined) fail(2, `funes ${c.verb}: --url and --vault exclude each other (the server owns its star)`);
    const { connectMcp, remoteToken } = await import("./mcp-client.ts");
    let client: Awaited<ReturnType<typeof connectMcp>>;
    try {
      const token = remoteToken(url, str("token-file"));
      await readBody();
      client = await connectMcp(url, token);
    } catch (e) {
      return fail(exitCodeOf(e), `funes ${c.verb}: ${(e as Error).message}`);
    }
    try { r = await runOp(c.op, a, has("json"), client.call); } finally { await client.close().catch(() => {}); }
  } else {
    if (str("token-file") !== undefined) fail(2, `funes ${c.verb}: --token-file needs --url`);
    const vault = vaultArg();
    // RAI-317 Q4: the designation is resolved ONCE, before stdin and before the store; a write the
    // rule refuses refuses here too, so a read locus never creates an index to refuse a write.
    let designation: ReturnType<typeof cliDesignation>;
    try { designation = cliDesignation(vault); } catch (e) { return fail(2, `funes: ${(e as Error).message}`); }
    const { ceiling, dispatchToolCall } = await import("funes-core");
    if (!ceiling("home").find((o) => o.name === c.op)!.readonly) {
      try { assertWriteAllowed(designation, c.op); } catch (e) { return fail(3, `funes ${c.verb}: ${(e as Error).message}`); }
    }
    await readBody();
    const { folderContext } = await import("./funes-store.ts");
    const store = await makeStore({ vault });
    try {
      const ctx = { ...folderContext({ vault, store }), designation };
      r = await runOp(c.op, a, has("json"), (name, x) => dispatchToolCall(name, x, ctx));
      if (c.op === "recall" && r.code === 0) {
        // 0.3.0 item 18: an empty or stale index is said on stderr, so --json stdout stays exact.
        await noteEmptyOrStale(store, vault, await store.stats(), (r.result as { results: unknown[] }).results.length, String(a.query));
      }
    } finally {
      await store.close();
    }
  }
  if (r.err) writeSync(2, `${r.err}\n`);
  if (r.out) process.stdout.write(`${r.out}\n`);
  process.exitCode = r.code;
}

// ── the operator commands ─────────────────────────────────────────────────────────────────────────
async function reindex(): Promise<void> {
  const vault = vaultArg();
  const db = funesDbDir(vault);
  const fresh = has("fresh");
  // index_scope is honored natively and fail-closed on a bad manifest (H2): invalid refuses; absent is
  // a configless star, silent (RAI-318: the walk refuses a lost one); valid stamps the scoped one.
  const scope = readIndexScopeExcludes(vault);
  if (scope.kind === "invalid") fail(2, `reindex: star.yaml index_scope is invalid — ${scope.reason}. Fix the manifest and retry (refusing to reindex; a broken scope must not re-admit excluded files).`);
  if (scope.kind === "valid" && scope.excludes.length) {
    process.stderr.write(`index_scope: excluding ${scope.excludes.length} glob(s)\n`);
  }
  // F6: --fresh rebuilds in place; readers see a partial index and every writer waits on the write lock.
  if (fresh) {
    process.stderr.write(`reindex --fresh: the index at ${db} is rebuilt IN PLACE — new opens refuse and writers wait until this run completes. Restart the surface and every MCP session after it.\n`);
  }
  const t0 = Date.now();
  const r = await reindexVault(vault, {
    fresh,
    onProgress: (p) =>
      process.stderr.write(`\r  ${p.files} files · ${p.indexed} indexed · ${p.skipped} unchanged · ${p.tombstoned} tombstoned`),
  });
  process.stderr.write("\n");
  console.log(`reindex complete: ${r.files} files (${r.indexed} indexed, ${r.skipped} unchanged, ${r.tombstoned} tombstoned, ${r.pruned} pruned, ${r.unparsed.length} unparsed) in ${((Date.now() - t0) / 1000).toFixed(0)}s\n  -> ${db}`);
  // 0.4.0 item 11 (RAI-134): a page whose frontmatter does not parse is named here; `doctor` names it too.
  if (r.unparsed.length) console.log((await import("./doctor.ts")).formatUnparsedLine(r.unparsed));
}

async function publish(): Promise<void> {
  // RAI-306 S1: build <home>/published.db off-path and swap it in whole. The git sidecar's hook and
  // `watch` run this; a clean-tree pass costs a parse walk, not an embed pass.
  const rollback = has("rollback");
  if (str("from") !== undefined && !rollback) fail(2, "funes publish: --from needs --rollback");
  if (rollback && has("force")) fail(2, "funes publish: --rollback and --force are two different repairs — pick one");
  const vault = vaultArg();
  // The home is derived from the vault (RAI-317): published.db sits beside the live index.db.
  const home = homeOf(vault);
  assertIndexNotInSyncRoot(home); // 0.3.0 item 23, before an embedder exists
  // P1.7: --json emits ONE line a caller (twinkl.ing's star-sync hook, `watch`) parses.
  const asJson = has("json");
  const scope = readIndexScopeExcludes(vault);
  if (scope.kind === "invalid") {
    if (asJson) console.log(JSON.stringify({ ok: false, error: `index_scope invalid: ${scope.reason}`, home, vault }));
    else console.error(`publish: star.yaml index_scope is invalid — ${scope.reason}. Refusing (a broken scope must not re-admit excluded files).`);
    process.exit(2);
  }
  const { publishReindex, rollbackPublished } = await import("./publication.ts");
  // A failed build exits 1; a held publish lock exits 75 (`busy`), so a caller can retry it.
  const failed = (what: string, e: unknown): never => {
    if (asJson) console.log(JSON.stringify({ ok: false, error: (e as Error).message, home, vault }));
    else console.error(`${what}: ${(e as Error).message}`);
    process.exit(exitCodeOf(e) === 75 ? 75 : 1);
  };
  if (rollback) {
    try {
      const r = await rollbackPublished({ vault, home, embedder: new E5Embedder(), scopeSignature: publishCorpus(scope).scopeSignature, from: str("from") });
      if (asJson) console.log(JSON.stringify({ ok: true, rollback: true, generation: r.generation, home, from: r.from, dbPath: r.dbPath, vault }));
      else console.log(`publish --rollback: ${r.from} served as ${r.dbPath} (generation ${r.generation.slice(0, 12)}…) — it holds only while publish and watch stay stopped`);
    } catch (e) {
      failed("publish --rollback: REFUSED", e);
    }
    return;
  }
  try {
    const r = await publishReindex({
      vault, home, embedder: new E5Embedder(), ...publishCorpus(scope),
      starId: readStarIdentity(vault).id ?? undefined, // PLAN-0.2.1 step 12: part of the skip predicate
      force: has("force"),
    });
    if (asJson) {
      console.log(JSON.stringify({ ok: true, skipped: r.skipped, generation: r.generation, home, dbPath: r.dbPath, cloned: r.cloned, cloneError: r.cloneError, reason: r.reason, vault }));
    } else {
      if (r.cloneError) console.error(`publish: ${r.cloneError}`);
      console.log(
        r.skipped
          ? `publish: generation ${r.generation.slice(0, 12)}… already current — skipped`
          : `publish: generation ${r.generation.slice(0, 12)}… ${r.cloned ? "built from a clone of published.db" : "built from empty"} (${r.reason}) + swapped in\n  -> ${r.dbPath}`,
      );
    }
  } catch (e) {
    failed("publish: FAILED", e);
  }
}

async function watch(): Promise<void> {
  // PLAN-0.4.0 item 15 (RAI-126): the publish trigger on a read locus. Each spawned publish derives the
  // same home from the same vault, so the two cannot disagree.
  const vault = vaultArg();
  const { parseDuration } = await import("./publication.ts");
  const durationMs = (name: string, def: number): number => {
    try { return parseDuration(`--${name}`, str(name)) ?? def; } catch (e) { return fail(2, `funes watch: ${(e as Error).message}`); }
  };
  const intervalMs = durationMs("interval", 5_000);
  if (intervalMs <= 0) fail(2, "funes: watch --interval must be positive");
  const { runWatch } = await import("./watch.ts");
  process.exit(await runWatch({ vault, syncthing: str("syncthing"), intervalMs, minIntervalMs: durationMs("min-interval", 60_000) }));
}

/** The index a reading command opens (RAI-317 Q6): the live index.db, or with --published the star's
 *  published.db, its owner checked against star.yaml before the first row (RAI-306 Q19). */
async function readIndex(vault: string, what: string): Promise<{ dbPath: string; published: boolean }> {
  if (!has("published")) {
    const dbPath = funesDbDir(vault);
    if (!existsSync(dbPath)) fail(2, `${what}: no live index at ${dbPath} — run \`funes reindex --vault ${vault}\` first`);
    assertIndexNotInSyncRoot(dbPath); // item 23: a direct LibsqlStore.create bypasses makeStore's guard
    return { dbPath, published: false };
  }
  const identity = readStarIdentity(vault);
  if (!identity.id) {
    fail(2, `${what}: ${vault} declares no star.yaml meta.id, so WHICH star a published index belongs to cannot be proven. Give the star an id, or read the live index (drop --published).`);
  }
  const { publishedDbPath, remedyPublish } = await import("./publication.ts");
  const home = homeOf(vault);
  const dbPath = publishedDbPath(home);
  if (!existsSync(dbPath)) {
    throw new Error(`${what}: "${identity.name ?? basename(vault)}" has nothing published in ${home} — ${remedyPublish(vault)}`);
  }
  assertIndexNotInSyncRoot(dbPath);
  // The owner stamp inside the bytes is the only identity that travels with a copied file: two stars
  // called `notes` resolve to the same home. Absence never matches.
  const { readIndexOwner } = await import("./index-owner.ts");
  const stamped = readIndexOwner(dbPath);
  if (stamped === null || !(stamped === identity.id || sameStar(stamped, identity.id!))) {
    throw new Error(`${what}: the index at ${dbPath} carries star identity "${stamped ?? "(none)"}", but star.yaml serves it as "${identity.id}" — refusing to answer in another star's name`);
  }
  return { dbPath, published: true };
}

async function evaluate(): Promise<void> {
  const vault = vaultArg();
  // The fixture lives IN THE STAR it measures: its queries and expected ids ARE that corpus, and a
  // fixture under packages/ would ship private material through the public projection.
  const fixturePath = str("fixture") ?? join(vault, "out", "out_eval", "recall-eval.json");
  const { runEval, formatReport, validateFixture, evalJson, baselinePath, makeBaseline, parseBaseline, compareBaseline, formatComparison } = await import("./recall-eval.ts");
  const { LibsqlStore } = await import("./libsql/store.ts");
  // --draft samples CANDIDATE PAGES and writes a skeleton. It never fills `relevant`: the expected ids
  // are the human's, authored before any run output is visible (the anti-peeking rule).
  if (has("draft")) {
    const { draftFixture } = await import("./recall-eval-draft.ts");
    const out = str("out") ?? fixturePath;
    if (existsSync(out) && !has("force")) fail(2, `eval --draft: ${out} exists — pass --force to overwrite (a drafted fixture is cheap; an AUTHORED one is not)`);
    assertIndexNotInSyncRoot(funesDbDir(vault));
    const live = await LibsqlStore.create(new E5Embedder(), funesDbDir(vault), { readonly: true });
    try {
      const drafted = draftFixture(live, { vault, seen: Number(str("seen") ?? "20"), unseen: Number(str("unseen") ?? "10") });
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify(drafted, null, 2) + "\n");
      console.log(`eval --draft: wrote ${drafted.cases.length} case(s) to ${out}`);
      console.log("  Next: rewrite each `query` as a real question, then fill each `relevant` with the ids that ANSWER it.");
      console.log("  Nothing runs until every case has a relevant id — that refusal is the anti-peeking rule.");
    } finally {
      await live.close();
    }
    return;
  }
  if (!existsSync(fixturePath)) fail(2, `eval: no fixture at ${fixturePath} — draft one with \`funes eval --vault <path> --draft\`, or pass --fixture <file>`);
  // Read as BYTES and parsed from them: `--json` hashes exactly what was scored (PLAN-0.4.0 item 17).
  const fixtureBytes = readFileSync(fixturePath);
  const fixture = JSON.parse(fixtureBytes.toString("utf8")) as import("./recall-eval.ts").EvalFixture;
  const problems = validateFixture(fixture);
  if (problems.length > 0) fail(2, `eval: the fixture is not runnable —\n  ${problems.join("\n  ")}`);
  const fixtureSha256 = createHash("sha256").update(fixtureBytes).digest("hex");
  type Signature = import("./recall-eval.ts").EvalSignature;
  // PLAN-0.5.0 item 25: the baseline is a FILE per locus beside the fixture, written ONCE by this
  // command and never by hand. A run without --baseline re-reads this locus's file and compares.
  const baselineStep = (report: import("./recall-eval.ts").EvalReport, generation: string | null, signature: Signature, locus: string | null): void => {
    if (!locus) {
      if (has("baseline")) fail(2, "eval --baseline: no locus — set FUNES_LOCUS (the short hostname is the default); the file is per locus");
      return;
    }
    let path = "";
    try { path = baselinePath(fixturePath, locus); } catch (e) { fail(2, `eval: ${(e as Error).message}`); }
    if (has("baseline")) {
      if (existsSync(path)) fail(2, `eval: a baseline already exists at ${path} — move it aside deliberately to re-baseline`);
      // Q1: taken only over a named, valid build — never over rows a mutation has unnamed.
      if (!generation) fail(2, "eval --baseline: refused — no content generation (no named build); take it after a full build, before any write");
      const b = makeBaseline(report, { locus, generation: generation!, signature, fixtureSha256, at: new Date().toISOString() });
      writeFileSync(path, JSON.stringify(b, null, 2) + "\n", { flag: "wx" }); // never over a file that appeared meanwhile
      console.log(`  baseline written to ${path}`);
    } else if (existsSync(path)) {
      let b: import("./recall-eval.ts").EvalBaseline;
      try { b = parseBaseline(readFileSync(path, "utf8")); } catch (e) { return fail(2, `${(e as Error).message} (${path})`); }
      console.log(formatComparison(path, compareBaseline(b, { generation, signature, fixtureSha256, report })));
    }
  };
  // PLAN-0.5.0 item 25: recall over HTTP MCP — the edge's only door. No file, no store, no model here:
  // the generation, the signatures and the locus are the server's answer (health answers the locus).
  const url = str("url");
  if (url !== undefined) {
    const { connectMcpEval } = await import("./recall-eval-mcp.ts");
    const { remoteToken } = await import("./mcp-client.ts");
    let src: Awaited<ReturnType<typeof connectMcpEval>>;
    try { src = await connectMcpEval(url, remoteToken(url, str("token-file"))); } catch (e) { return fail(2, `eval: ${(e as Error).message}`); }
    try {
      const report = await runEval(fixture, src.recall, { page: src.page });
      const a = await src.answered();
      const signature: Signature = { embedding: a.embeddingSignature, serving: a.servingSignature };
      console.log(formatReport(report));
      console.log(`  generation ${a.contentGeneration ?? "none (no named build)"} · locus ${a.locus ?? "unnamed"}`);
      if (has("json")) console.log(JSON.stringify({ ...evalJson(report, { generation: a.contentGeneration }, fixtureBytes, null), locus: a.locus, signature }));
      baselineStep(report, a.contentGeneration, signature, a.locus);
      if (!report.passed) process.exitCode = 1;
    } finally {
      await src.close();
    }
    return;
  }
  if (str("token-file") !== undefined) fail(2, "eval: --token-file needs --url");
  const { dbPath } = await readIndex(vault, "eval");
  const store = await LibsqlStore.create(new E5Embedder(), dbPath, { readonly: true });
  try {
    const generation = (await store.contentIdentity()).contentGeneration;
    // item 16 on the CLI: each case's recall is the guarded read every MCP op takes; a narrowed
    // star.yaml refuses with exit 3. A case's `where` compiles against the live declaration (ADR-0013).
    const { planWhere } = await import("funes-core/internal");
    const { readRecallDeclaration } = await import("./recall-planner.ts");
    const report = await runEval(
      fixture,
      (query, k, where) => guardedOrRefuse(store, vault, () =>
        store.recall({ query, k, ...(where ? { filter: planWhere(query, where, readRecallDeclaration(vault)).filter } : {}) })),
      {
        page: (id) => guardedOrRefuse(store, vault, async () => {
          const p = await store.indexedPage({ id });
          if (!p) return null;
          const n = await store.neighbors(id, 0);
          return { text: [p.title, p.description, p.body].filter(Boolean).join("\n"), links: [...n.edgesOut, ...n.edgesIn].map((e) => e.id) };
        }),
      },
    );
    console.log(formatReport(report));
    console.log(`  generation ${generation ?? "none (no named build)"}`);
    if (has("json")) {
      // PLAN-0.4.0 item 17: what a publish of this vault would stamp now, so the release gate can tell
      // a lagging publication (not comparable) from a parity mismatch. A parse walk, no embed.
      const { computeTargetGeneration } = await import("./publication.ts");
      const scope = readIndexScopeExcludes(vault);
      const vaultGeneration = scope.kind === "invalid" ? null : computeTargetGeneration(vault, { embedder: new E5Embedder(), ...publishCorpus(scope) });
      console.log(JSON.stringify(evalJson(report, { generation }, fixtureBytes, vaultGeneration)));
    }
    const signature: Signature = { embedding: (await store.stats()).embeddingSignature, serving: store.servingSignature() };
    baselineStep(report, generation, signature, locusArg());
    if (!report.passed) process.exitCode = 1;
  } finally {
    await store.close();
  }
}

async function doctor(): Promise<void> {
  // PLAN-0.2.1 step 24: the graph audit. Read-only in every sense: it opens the index `readonly: true`,
  // runs two selects and writes nothing — not even `graph.json`, the cache `graph()` keeps beside it.
  const locus = locusArg(); // PLAN-0.4.0 item 10: before the vault is read
  const vault = vaultArg();
  const { dbPath, published } = await readIndex(vault, "doctor");
  const { auditGraphRows, formatAuditReport, formatSyncConflicts, formatUnparsed, UNPARSED_FIRST, operatorState, formatOperatorState } = await import("./doctor.ts");
  const { unparsedPages } = await import("./reindex.ts");
  const { syncConflictFinding } = await import("./sync-conflicts.ts");
  const { folderStar } = await import("./funes-store.ts");
  const { LibsqlStore } = await import("./libsql/store.ts");
  // E5Embedder loads its model lazily on the first embed; the audit embeds nothing.
  const store = await LibsqlStore.create(new E5Embedder(), dbPath, { readonly: true });
  try {
    const generation = published ? (await store.contentIdentity()).contentGeneration : null;
    const report = auditGraphRows(await store.auditGraph());
    // 0.3.0 item 20: the same operator state `health` returns, so the two faces cannot drift.
    const state = operatorState({ store, star: folderStar(vault), designation: { locus } }, await store.stats());
    // `db` names the file audited, so a comparison of mixed kinds is visible (RAI-317 Q6).
    const header = { vault, db: published ? "published" as const : "live" as const, generation, source: dbPath, verified: published };
    // 0.4.0 item 7: conflict copies on disk. A finding, never a refusal and never an exit code.
    const syncConflicts = syncConflictFinding(vault);
    // 0.4.0 item 11: pages whose frontmatter does not parse, walked over the scope NOW. The key is
    // `vault.unparsed`: a fact about the files, never about the rows (ADR-0003).
    const { ids: unparsed, walkError } = unparsedPages(vault);
    const vaultUnparsed = { count: unparsed.length, first: unparsed.slice(0, UNPARSED_FIRST), ...(walkError ? { walkError } : {}) };
    const color = process.stdout.isTTY === true;
    console.log(has("json")
      ? JSON.stringify({ ...header, ...report, syncConflicts, "vault.unparsed": vaultUnparsed, state })
      : `${formatAuditReport(report, header)}\n\n${formatOperatorState(state)}\n\n${formatSyncConflicts(syncConflicts, { color })}\n\n${formatUnparsed(vaultUnparsed, { color })}`);
  } finally {
    await store.close();
  }
}

async function scan(): Promise<void> {
  // PLAN-0.5.0 item 22 (ADR-0012): the share-clean gate over the index scope, fail-closed on a broken star.yaml.
  const vault = vaultArg();
  const scope = readIndexScopeExcludes(vault);
  if (scope.kind === "invalid") fail(2, `scan refused — star.yaml index_scope is invalid: ${scope.reason}. Fix the manifest and retry.`);
  const { scanScope } = await import("./scan.ts");
  const res = scanScope(vault, publishCorpus(scope).exclude);
  if (!res.gitleaksRan) console.error("scan: gitleaks is not on PATH — the built-in detector only.");
  if (res.regexFindings.length > 0 || res.gitleaks.length > 0) {
    console.error(`scan: secret material in ${vault} — not share-clean (${res.files} file(s) scanned)`);
    for (const f of res.regexFindings) console.error(`  ${f.file}: ${Object.entries(f.kinds).map(([k, n]) => `${k}×${n}`).join(", ")}`);
    if (res.gitleaks.length) console.error(`  gitleaks:\n${res.gitleaks.map((l) => `    ${l}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`scan: clean — ${res.files} file(s) in the index scope`);
}

async function okfNormalize(): Promise<void> {
  // PLAN-0.5.0 item 21 (ADR-0012): the dry run is the lint, exit 1 while anything remains; --apply only
  // at the write locus (exit 3 elsewhere). Opens no index: reindex follows.
  const vault = vaultArg();
  const { okfApply, okfDryRun } = await import("./okf-normalize.ts");
  const line = (f: import("./okf-normalize.ts").OkfFinding) => "invalid" in f
    ? `  ${f.path}  REFUSED ${f.invalid}: ${f.reason}`
    : `  ${f.path}  ${f.edit}${f.reembed ? "  re-embed" : ""}${f.generation ? "  generation" : ""}`;
  try {
    if (!has("apply")) {
      const found = await okfDryRun(vault);
      for (const f of found) console.log(line(f));
      const refused = found.filter((f) => "invalid" in f).length;
      console.log(`okf normalize: ${found.length - refused} file(s) to normalize, ${refused} refused (dry run; --apply writes)`);
      process.exit(found.length ? 1 : 0);
    }
    const r = await okfApply(vault, { locus: locusArg() ?? undefined });
    for (const f of r.applied) console.log(line(f));
    for (const p of r.conflicts) console.log(`  ${p}  CONFLICT: changed since it was read — skipped`);
    for (const f of r.refused) console.log(line(f));
    console.log(`okf normalize --apply: ${r.applied.length} file(s) normalized (pre-images under .history/), ${r.conflicts.length} conflict(s), ${r.refused.length} refused — reindex next`);
    process.exit(r.conflicts.length || r.refused.length ? 1 : 0);
  } catch (e) {
    const err = e as Error & { usage?: boolean; code?: string };
    const refused = err.code === "not-write-locus";
    if (!err.usage && !refused) throw e;
    fail(refused ? 3 : 2, err.message);
  }
}

async function elevateOrPurge(op: "elevate" | "purge"): Promise<void> {
  const vault = vaultArg();
  const id = positionals[0] ?? fail(2, `usage: funes ${op} <id>`);
  const { store, funes } = await openWriter(vault, op);
  try {
    // H4: elevation is the deliberate human act that flips a funes-written item to trusted, CLI-only
    // by design (the registry refuses an `elevate` op). `purge` is the only hard delete (RAI-304).
    if (op === "elevate") await funes.elevate(id);
    else await funes.forget(id, { hard: true });
  } finally {
    await store.close();
  }
  console.log(op === "elevate" ? `elevated to trusted: ${id}` : `purged: ${id}`);
}

// ── dispatch ──────────────────────────────────────────────────────────────────────────────────────
switch (cmd.verb) {
  case "reindex": await reindex(); break;
  case "publish": await publish(); break;
  case "watch": await watch(); break;
  case "eval": await evaluate(); break;
  case "doctor": await doctor(); break;
  case "scan": await scan(); break;
  case "okf normalize": await okfNormalize(); break;
  case "elevate": case "purge": await elevateOrPurge(cmd.verb); break;
  case "mcp": {
    // P3.15: the published bin is one command, so `funes mcp` starts the stdio server in-process.
    const { runMcp } = await import("./mcp-server.ts");
    await runMcp({ vault: str("vault") ?? process.cwd(), ops: str("ops"), crossStar: has("cross-star"), published: has("published") });
    break;
  }
  case "serve": {
    // ADR-0021: the one HTTP host ships in the bin (build-cli requires serve.ts).
    const { runServe } = await import("./serve.ts");
    await runServe(values);
    break;
  }
  case "token mint": {
    // RAI-310 D6: one verb, a local and an edge sink over one row builder (token-mint.ts).
    const { runTokenMint } = await import("./token-mint.ts");
    const code = runTokenMint(values);
    if (code !== 0) process.exit(code);
    break;
  }
  case "home": console.log(funesHome()); break;
  case "home move": {
    const { moveHome } = await import("./home-move.ts");
    for (const l of moveHome()) console.log(l); // its test seams are options, never read from the environment
    break;
  }
  default: await runOpVerb(cmd as OpCommand);
}
