#!/usr/bin/env bun
// funes local CLI over a star's markdown — derived PGLite index at <vault>/.funes/pgdata/.
//   reindex   --vault <path> [--db <path>] [--max N] [--fresh]
//             --fresh = wipe + full rebuild (recomputes stale derived columns, e.g. the ab95b13
//             tsvector weighting on hash-skipped rows). OFFLINE repair: the index is unqueryable
//             mid-run — a SERVED libsql home uses `publish --force` instead (no-downtime swap).
//   publish   --vault <path> [--home <index-dir>] [--force]   (conditional generation publish, libsql)
//   republish --vault <path> [--home <index-dir>] [--force] [--json]   (repair a published home, libsql)
//   query     "<question>" [--vault <path>] [--db <path>] [-k N] [--rerank] [--json]
//   remember  --vault <path> --title "T" [--body "..."|stdin] [--type memory] [--tags a,b] [--source s]
//             [--volatile] [--as-of DATE]
//   supersede --vault <path> <oldId> --title "T" [--body "..."|stdin] [--volatile] [--as-of DATE]
//   link      --vault <path> <fromId> <toId> [--type related_to]
//   forget    --vault <path> <id> [--hard]
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CrossEncoderReranker, type Reranker } from "./rerank.ts";
import { makeStore, funesDbDir, readStarIdentity, repairIndexForFresh } from "./factory.ts";
import { E5Embedder } from "./embedder.ts";
import { withWriteLock } from "funes-shared";
import type { FunesIndexStore } from "./store.ts";
import { noteEmptyOrStale, openIndex, openMutator, refuseIfDaemon } from "./cli-open.ts";
import { resolveLocus } from "./write-designation.ts";
import { indexDir } from "./reindex.ts";
import { readIndexScopeExcludes, scopeHash, buildScopeExclude, configlessExclude, anyExclude, ownStarExpectation } from "./scope.ts";
import type { ScopeSignature } from "funes-core";
import type { GenerationManifest } from "./publication.ts";
import { FUNES_VERSION } from "./version.ts";
import { LIBSQL_ONLY } from "./artifact.ts";
import { assertIndexNotInSyncRoot } from "./sync-root.ts";
import type { RepublishVerdict } from "./publication.ts"; // type-only: erased, so publication.ts stays a lazy import

// P3.15: every subcommand runs at top level, so a throw surfaced as a raw Node stack trace — the
// FUNES_BACKEND=postgres refusal, a missing vault, a lock held by another writer. A CLI owes the
// user a sentence; the trace stays one env var away for when it is actually wanted.
for (const ev of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(ev, (err: unknown) => {
    const e = err as Error | undefined;
    // Sixteen throw sites already brand their own message `funes: …`, because they ALSO surface
    // through the MCP/daemon/face paths, which have no wrapper of their own. Branding again here
    // printed "funes: funes: could not load the embedding model …" — the first line a user sees on
    // the one hard failure this artifact has. Strip here rather than unbrand there: the prefix is
    // still doing work everywhere else, and one guard where every caller already routes through
    // beats sixteen edits that the seventeenth throw site would then get wrong.
    const raw = e?.message ?? String(err);
    const msg = process.env.FUNES_DEBUG === "1" ? (e?.stack ?? String(err)) : `funes: ${raw.replace(/^funes: /, "")}`;
    // writeSync, not console.error: when stderr is a PIPE (any CI, any `2>&1 | ...`) console.error
    // is asynchronous and process.exit() discards the pending write — the command then dies
    // silently with status 1 and no explanation, which is strictly worse than the stack trace this
    // handler replaced. It cost a CI run to find, because a TTY makes the same code look fine.
    try { writeSync(2, msg + "\n"); } catch { /* stderr already gone */ }
    process.exit(1);
  });
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name: string, def?: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};
const has = (name: string) => argv.includes(name);
/** `--vault` DEFAULTS TO CWD, which turns the three likeliest mistakes — wrong directory, typo'd
 *  path, forgotten flag — into silent success: reindex would index whatever happened to be around,
 *  query would print nothing and exit 0. A path that is not there is a refusal, not a default. */
const vaultArg = (): string => {
  const raw = flag("--vault", process.cwd())!;
  const v = resolve(raw);
  if (!existsSync(v)) {
    writeSync(2, `funes: --vault ${v} does not exist${raw === process.cwd() ? " (no --vault given, so this is the current directory)" : ""}\n`);
    process.exit(2);
  }
  if (!statSync(v).isDirectory()) { writeSync(2, `funes: --vault ${v} is not a directory\n`); process.exit(2); }
  return v;
};
// noteEmptyOrStale lives in cli-open.ts, where a test can reach it (this file dispatches at load).
// PGLite persists to a directory (Postgres data dir), not a single file.
const dbFor = (vault: string) => flag("--db", funesDbDir(vault))!;
/** Boolean flags take no value — the positional parser must not let them swallow the next token
 *  (S0 fix: `forget --hard <id>` used to lose the id to flag-order sensitivity). */
const BOOL_FLAGS = new Set(["--hard", "--json", "--rerank", "--ignore-scope", "--fresh", "--force", "--volatile", "--live", "--okf"]);
/** Nth non-flag positional after the command (value-flags consume their value; bool flags don't). */
const positional = (n = 1): string | undefined => {
  const pos: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("-")) {
      if (!BOOL_FLAGS.has(a)) i++; // skip the value of a value-flag
      continue;
    }
    pos.push(a);
  }
  return pos[n - 1];
};
const list = (s?: string) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
/** `--as-of`, with the ops registry's `isoDate` semantics (ops.ts): empty means absent, and an
 *  unparseable date is REFUSED rather than dropped — as_of feeds the freshness column, so silently
 *  discarding it writes the memory as never-stale, which is the exact failure the field prevents.
 *  Called BEFORE the body is read, so a typo'd date fails before stdin blocks or an index is opened. */
const asOfArg = (): string | undefined => {
  const v = flag("--as-of");
  if (!v) return undefined;
  if (Number.isNaN(Date.parse(v))) {
    writeSync(2, `funes: --as-of must be an ISO-8601 date (e.g. 2026-07-19), got ${JSON.stringify(v)}\n`);
    process.exit(2);
  }
  return v;
};
async function bodyFrom(): Promise<string> {
  const b = flag("--body");
  if (b != null) return b;
  // P3.15: `Readable.toWeb` rather than `Bun.stdin` (Bun-only) or `new Response(process.stdin)` —
  // the latter leans on undici accepting a Node stream as a body, which varies across the Node
  // range the release gate covers. This is explicit and stable on both runtimes.
  const { Readable } = await import("node:stream");
  return (await new Response(Readable.toWeb(process.stdin) as ReadableStream).text()).trim();
}
/** PLAN-0.4.0 item 10: this machine's locus, `--locus` over FUNES_LOCUS (resolveLocus), for the verbs
 *  that carry it — doctor reports it, the mutators are audited with it. A refused name is a usage
 *  error, exit 2, before any store is opened — fail-closed at startup, as `--ops` is. */
const locusArg = (): string | null => {
  try {
    return resolveLocus({ flag: flag("--locus"), env: process.env });
  } catch (e) {
    writeSync(2, `funes: ${(e as Error).message}\n`);
    process.exit(2);
  }
};
// The two openers live in cli-open.ts, where a test can reach them — this file dispatches at module
// load. `--db`, `--actor` and `--locus` are this file's flags, threaded through here so neither
// opener reads argv. `openStore` is the maintenance/read open (reindex, query) and carries NO actor;
// `openFunes` is the six canonical mutators' open (items 24 + 25) and names the op for the audit.
const openStore = (vault: string, opts: { allowDirty?: boolean; reranker?: Reranker } = {}) =>
  openIndex(vault, { dbDir: flag("--db"), ...opts });
const openFunes = (vault: string, op: string) => openMutator(vault, op, { dbDir: flag("--db"), actor: flag("--actor"), locus: locusArg() ?? undefined });

/** Exit code for a REFUSAL — a boundary that held, as opposed to a usage error (2) or a failure (1).
 *  The fleet gate already exits 3 when it refuses to advance; the scope guard below joins it, so a
 *  harness handling `funes query --json` can tell "the index is out of policy" from "it crashed". */
const EXIT_REFUSED = 3;

/** PLAN-0.3.0 item 16 on the CLI (RAI-148). Every MCP op that answers out of the index's rows takes
 *  the store's check-retrieve-RECHECK guard against the own-star expectation (ops.ts
 *  dispatchToolCall) — and `funes query`, the surface a harness scrapes with --json, did not: an
 *  operator who narrowed star.yaml and had not reindexed went on receiving the withdrawn pages from
 *  the terminal while every MCP client was refused. Same thunk, same guard, same message; the CLI's
 *  only addition is the exit code. The store is closed before exiting: the refusal is a clean stop,
 *  not a crash. */
async function guardedOrRefuse<T>(store: FunesIndexStore, vault: string, retrieve: () => Promise<T>): Promise<T> {
  const r = await store.guardedRead(ownStarExpectation(vault), retrieve);
  if ("ok" in r) return r.ok;
  await store.close().catch(() => {});
  writeSync(2, `funes: ${r.refusal}\n`);
  process.exit(EXIT_REFUSED);
}

/** The corpus `publish` builds from a valid or absent star.yaml scope: the effective exclude
 *  predicate — the same as reindex's, so a configless vault produces the SAME corpus through both
 *  verbs (divergent corpora would mean divergent generations) — and the scope signature it stamps.
 *  Shared with `eval --json` (PLAN-0.4.0 item 17), whose `vaultGeneration` must be the target THIS
 *  publish would stamp, or a current publication reads as lagging its vault. */
function publishCorpus(scope: ReturnType<typeof readIndexScopeExcludes>) {
  const excludes = scope.kind === "valid" ? scope.excludes : [];
  return {
    exclude: anyExclude(buildScopeExclude(excludes), scope.kind === "absent" ? configlessExclude() : undefined),
    scopeSignature: scope.kind === "valid" ? { hash: scopeHash(excludes), ignoreScope: false } : null,
  };
}


/** The full verb list, with the flags that change what a command DOES (not every flag). Seven of
 *  these were reachable but undocumented — `funes` alone printed a bare one-line usage.
 *
 *  Two constraints from the release gate's smoke test, both load-bearing:
 *    1. it greps for the literal `usage: funes`, so that stays the first line;
 *    2. it asserts the word `publish` NEVER appears in the published (libsql-only) bin, so every
 *       mention of that verb — including in prose — sits behind LIBSQL_ONLY. */
const USAGE = `usage: funes <command> [options]        funes ${FUNES_VERSION}

  reindex   --vault <path> [--max N] [--fresh] [--ignore-scope]
              build/refresh the derived index. --fresh wipes and rebuilds${LIBSQL_ONLY ? "." : `, which is OFFLINE:
              the index is unqueryable mid-run, so a served libsql home wants \`publish --force\`.`}${LIBSQL_ONLY ? "" : `
  publish   --vault <path> [--home <index-dir>] [--force] [--retain-prior 24h]
              conditional generation publish (libsql): off-path rebuild, atomic swap, no downtime.
              The rebuild is seeded from the prior generation, so unchanged pages are not re-embedded;
              --force starts from empty instead (it is the repair verb) and re-embeds everything.
              --retain-prior pins the OUTGOING generation's db against collection for that window,
              so a rollback has something to restore. Default 24h: one full artefact copy per
              publish inside the window (doctor reports them); 0 pins nothing (acks + grace only).
  republish --vault <path> [--home <index-dir>] [--force] [--json] [--retain-prior 24h]
              repair a published home. Decides under the publication fence, in this order: no
              manifest -> refuses and names publish; dirty, unreadable, embedding-drifted, foreign
              schema, or not the artefact its manifest names -> rebuilds; an invalidated or legacy
              content generation -> rebuilds; valid and paired -> refuses unless --force. Prints
              what it repairs, then the new publication id and content generation. Never clones.
              Exit 2 on a refusal, 1 on a failed build.
  fleet     --home <dir> [--home <dir> …] [--advance <phase>] [--json]
              inventory a rollout: each home's schema version, publication id, content generation,
              and every LIVE principal's protocol + software version. --advance records a phase in
              each home's durable journal, all-or-none, and refuses while any home or live principal
              is inconsistent. Homes are named explicitly — there is no discovery input.
  watch     --vault <path> [--home <index-dir>] [--syncthing https://127.0.0.1:8384]
            [--interval 5s] [--min-interval 60s]
              keep a receive-only Syncthing replica published: polls the folder's status and runs
              \`publish --json\` once it is idle, needs nothing, and its sequence has held for two
              polls — at most once per --min-interval. Loopback https only, pinned to Syncthing's
              https-cert.pem; API key from STGUIAPIKEY, else config.xml. Syncthing down: backs off
              2s -> 30s. Exit 2 on a refusal (not receiveonly, no key or certificate, key refused).`}
  query     "<question>" [--vault <path>] [-k N] [--rerank] [--json]
              recall. --json is the stable contract for consumers; text output is for humans.
  export    --okf [--vault <path>] [--out <dir>]
              write an OKF Knowledge Bundle (default <vault>/out_okf; FUNES_OKF_DIR moves it
              to <dir>/<name> off-vault). Honors index_scope, skips tombstoned pages, refuses on any secret
              finding, and replaces the previous bundle only once a scanned one is built beside it.
              Stamps star.yaml memory.okf as okf_version (default "0.2"); false, or any value but "0.1"/"0.2", refuses.
  mcp       [--vault <path>] [--ops a,b] [--readonly] [--cross-star] [--locus <machine>]
              run the stdio MCP server (11 tools). Exits when its client closes stdin.
  doctor    --vault <path> ${LIBSQL_ONLY ? "--live [--json]" : "[--home <index-dir>] [--live] [--json]"}
              audit the graph: dangling edges by type, orphan and dangling-only nodes, relation
              spelling forks, Syncthing conflict copies on disk and in the index, and the retired
              artefacts the home still holds. Reports; never repairs.${LIBSQL_ONLY ? `
              This build has no generation to read, so --live (the working index) is required, and
              the report says on its face that it is unverified.` : `
              Defaults to the generation \`publish\` wrote, identity-checked before the first row.
              --live reads the working index instead and marks the result unverified.`}
  remember  --vault <path> --title "T" [--body "..."|stdin] [--type t] [--tags a,b] [--source s]
            [--volatile] [--as-of DATE]
              write a memory to out_memory/, recorded UNTRUSTED. --volatile marks it STATE — a rate,
              a plan, something a later write should replace; omit it for an append-only EVENT.
              --as-of dates the claim itself when that differs from when you wrote it.
  supersede --vault <path> <oldId> --title "T" [--body "..."|stdin] [--volatile] [--as-of DATE]
              write a successor and tombstone the old item. Restate --volatile: a successor that
              does not silently demotes a STATE claim to an EVENT.
  link      --vault <path> <fromId> <toId> [--type related_to]
  forget    --vault <path> <id> [--hard]
              tombstone (default) or delete outright (--hard).
  elevate   --vault <path> <id>
              promote an item to trusted. A deliberate human act, never implied by a write.
  grandfather --vault <path>
              mark pre-trust items in a zone as trusted, printing the audit list.
  --version

  --vault defaults to the CURRENT DIRECTORY. FUNES_DEBUG=1 prints stack traces.
  Model cache: FUNES_MODEL_DIR (default ~/.twinkling/models), 135MB on first run.
  The mutators (remember, supersede, link, forget, elevate, grandfather) stamp --actor <name>
  (over FUNES_ACTOR; neither set stamps "unknown") and are audited against star.yaml
  meta.write_locus: FUNES_WRITE_DESIGNATION=off|audit (default audit), this machine's locus
  from --locus <machine> over FUNES_LOCUS (neither set: no locus, never the hostname; doctor
  reports it). reindex never stamps an actor, so it keeps previous attribution.
  Exit codes: 0 ok · 1 error · 2 usage · 3 refused — the index_scope guard on query/eval
  (star.yaml changed since the index was built; a full reindex re-stamps the boundary)${LIBSQL_ONLY ? "" : `,
  or a fleet gate that will not advance`}.`;

// --help is intercepted BEFORE dispatch, for every verb. It used to be an unrecognised flag, so
// `funes reindex --help` fell through to reindex with --vault defaulting to the cwd and INDEXED THE
// USER'S CURRENT DIRECTORY — typed in a home directory, that is a full reindex of everything.
if (!cmd || cmd === "--help" || cmd === "-h" || argv.includes("--help") || argv.includes("-h")) {
  console.log(USAGE);
  process.exit(cmd ? 0 : 2); // an explicit --help succeeds; a bare `funes` is a usage error
}

if (cmd === "--version" || cmd === "-v") {
  console.log(FUNES_VERSION);
} else if (cmd === "mcp") {
  // P3.15: the published bin is one command, so `funes mcp` starts the stdio server in-process.
  const { runMcp } = await import("./mcp-server.ts");
  await runMcp(argv.slice(1));
} else if (cmd === "reindex") {
  const vault = vaultArg();
  const db = dbFor(vault);
  const max = flag("--max");
  const ignoreScope = has("--ignore-scope");
  const fresh = has("--fresh");
  // H3(a): a scope-bypassing run MUST be full so it stamps the ignore-scope marker (cross-star reads
  // then refuse). --ignore-scope + --max would leave the OLD signature (a bounded run never stamps),
  // re-admitting excluded pages with no marker — reject the combo.
  if (ignoreScope && max != null) {
    console.error("reindex: --ignore-scope cannot be combined with --max — a scope-bypassing run must be a FULL reindex so it stamps the ignore-scope marker. Drop one.");
    process.exit(2);
  }
  // --fresh (stale-derived-column repair, 2026-07-16) wipes the index inside the dirty epoch and
  // rebuilds — by definition a FULL run; a bounded wipe would leave an almost-empty index.
  if (fresh && max != null) {
    console.error("reindex: --fresh cannot be combined with --max — a fresh rebuild wipes the index first and must be a FULL reindex. Drop one.");
    process.exit(2);
  }
  // F6: --fresh wipes in place — LOUD warning that the index is unqueryable until this run finishes,
  // and that a serving face wants `publish --force` (no-downtime off-path swap), not this.
  if (fresh) {
    process.stderr.write(
      `reindex --fresh: the index at ${db} is WIPED until this run completes (opens refuse meanwhile). ` +
      "A SERVING face should use `funes publish --force` instead — off-path rebuild, atomic swap, no downtime.\n",
    );
  }
  // H3: --max must be a positive integer. NaN (`--max abc`) silently became a FULL run (`res.files >=
  // NaN` never breaks) that mis-stamped the signature; 0 likewise ran full; negatives ran 1 file but
  // left `full` true. Validate up front.
  let maxFiles: number | undefined;
  if (max != null) {
    const n = Number(max);
    if (!Number.isInteger(n) || n <= 0) {
      console.error(`reindex: --max must be a positive integer (got ${JSON.stringify(max)}).`);
      process.exit(2);
    }
    maxFiles = n;
  }
  // index_scope is honored NATIVELY (closure sprint 3B) AND fail-closed on a bad manifest (H2).
  // readIndexScopeExcludes is discriminated:
  //   invalid -> REFUSE (a broken manifest must never silently re-admit excluded, secret-bearing files);
  //   absent  -> configless own-star rebuild: index everything, but INVALIDATE any cross-star signature
  //              (scopeSignature: null) so a stale clean signature can't re-bless the re-admitted files;
  //   valid   -> apply the excludes + stamp the scoped signature (--ignore-scope stamps ignore:true).
  const scope = readIndexScopeExcludes(vault);
  if (scope.kind === "invalid") {
    console.error(`reindex: star.yaml index_scope is invalid — ${scope.reason}. Fix the manifest and retry (refusing to reindex; a broken scope must not re-admit excluded files).`);
    process.exit(2);
  }
  const excludes = scope.kind === "valid" ? scope.excludes : [];
  // A configless vault gets the built-in defaults on top (node_modules/dist/build/... at any
  // depth); a DECLARED scope is authoritative and never silently extended. --ignore-scope drops
  // both, since it exists to say "index literally everything".
  const exclude = ignoreScope
    ? undefined
    : anyExclude(buildScopeExclude(excludes), scope.kind === "absent" ? configlessExclude() : undefined);
  // valid -> stamp the scoped signature; absent -> null (invalidate). A --max bounded run never
  // reaches indexDir's stamp block, so this value is moot for bounded runs (leaves the prior).
  const scopeSignature: ScopeSignature | null =
    scope.kind === "valid" ? { hash: scopeHash(excludes), ignoreScope } : null;
  if (scope.kind === "absent") {
    process.stderr.write("index_scope: no star.yaml manifest — configless own-star rebuild; any cross-star signature is INVALIDATED (cross-star reads refuse until a scoped reindex)\n");
  } else if (excludes.length) {
    process.stderr.write(
      ignoreScope
        ? `index_scope: IGNORED (--ignore-scope) — ${excludes.length} glob(s) NOT applied; cross-star reads will refuse until a full reindex WITHOUT --ignore-scope\n`
        : `index_scope: excluding ${excludes.length} glob(s)\n`,
    );
  }
  // reindex is the repair path — it must open a dirty index (H2 dirty-epoch).
  //
  // --fresh, since the schema fence (PLAN-0.3.0 R2#2): the wipe used to happen INSIDE the opened
  // store (prune([]) in indexDir), and the open now refuses a stale schema_version or a drifted
  // embedding signature — so the repair verb would refuse its own patient. A stale index is removed
  // on the FILES before the open instead (repairIndexForFresh), after the same checks the open
  // runs and in the same order — the daemon probe here, then the owner marker and the sync-root
  // guard inside — and under the index's write lock across inspection, removal and the first open,
  // so no other funes writer can open the file in between. A current index is left to the ordinary
  // in-epoch wipe, which keeps the dirty marker over the rebuild. The embedder is built once, here,
  // so the signature the repair compares is the one the store will enforce.
  await refuseIfDaemon(vault);
  const embedder = new E5Embedder();
  const open = () => makeStore({ vault, dbDir: db, allowDirty: true, embedder });
  const store = fresh
    ? await withWriteLock(db, async () => { await repairIndexForFresh({ vault, dbPath: db, embedder }); return open(); })
    : await open();
  const t0 = Date.now();
  const r = await indexDir(store, vault, vault, {
    maxFiles,
    exclude,
    // --fresh: recompute EVERY row's derived columns (pg tsvectors etc.) by wiping first — the
    // supported repair path for indexes whose stored derivations predate a ranking fix (ab95b13
    // setweight never reaches hash-skipped rows on a plain reindex).
    fresh,
    // Stamped ONLY on a full run (indexDir gates on `full`); a --max run leaves the prior signature.
    scopeSignature,
    // …and the star's identity on the same gate, so the LIVE index carries `owner_star_id` too.
    // twinkling's publication gate inspects the built index.db, not the published generation, and
    // the `owner-vault` marker beside it cannot tell a substituted database from the real one.
    starId: readStarIdentity(vault).id ?? undefined,
    starIdWas: readStarIdentity(vault).idWas,
    onProgress: (p) =>
      process.stderr.write(`\r  ${p.files} files · ${p.indexed} indexed · ${p.skipped} unchanged · ${p.tombstoned} tombstoned`),
  });
  process.stderr.write("\n");
  // 0.3.0 item 17: record this machine's state. A completed FULL, unbounded local reindex is the
  // ONE event that establishes "this machine authored these rows" — a bounded --max run built part
  // of an index it did not prune, so it may not claim authorship of the whole thing. Bound to the
  // database's own immutable identity (publication id, else the random instance id), NEVER to the
  // index path: the path is unchanged when a different database replaces the file at it, and a
  // path-keyed marker would go on claiming a stranger's index was built here. Best-effort — a
  // machine-local note must never be the reason a successful reindex reports failure.
  if (maxFiles == null) {
    try {
      const { writeMachineState, bindingIdOf } = await import("./machine-state.ts");
      const boundTo = await bindingIdOf(store);
      if (boundTo) {
        writeMachineState(vault, {
          boundTo,
          authoredHere: true,
          desiredScopeHash: scopeSignature?.hash ?? null,
        });
      }
    } catch (e) {
      process.stderr.write(`machine state: not recorded (${(e as Error).message}) — reindex itself succeeded\n`);
    }
  }
  console.log(`reindex complete: ${r.files} files (${r.indexed} indexed, ${r.skipped} unchanged, ${r.tombstoned} tombstoned, ${r.pruned} pruned, ${r.unparsed.length} unparsed) in ${((Date.now() - t0) / 1000).toFixed(0)}s\n  -> ${db}`);
  // 0.4.0 item 11 (RAI-134): a page whose frontmatter does not parse is indexed with no type, title,
  // tags or metadata edges, and for years nothing said so. Named here; `doctor` names it too.
  if (r.unparsed.length) console.log((await import("./doctor.ts")).formatUnparsedLine(r.unparsed));
  await store.close();
} else if ((cmd === "publish" || cmd === "republish") && LIBSQL_ONLY) {
  // P3.15: `publish` is absent from the PUBLISHED bin. It writes gen-*.db and swaps generation.json,
  // but the shipped `query` and `mcp` open index.db directly and the alpha has no daemon or face —
  // the only manifest consumers — so a published generation would have nothing in this artifact that
  // can read it. The code and its tests stay in source: the NAS canon sidecar drives `funes publish`
  // through star-sync --reindex-cmd and must keep working. `republish` repairs what `publish` wrote,
  // so it is absent for the same reason and says so in the same words.
  console.error(`funes: \`${cmd}\` is not part of this build (it needs the daemon/face surfaces the alpha does not ship). Run funes from source for the publication protocol.`);
  process.exit(2);
} else if (cmd === "publish" || cmd === "republish") {
  // The PRODUCTION caller of the publication protocol (re-homing plan R3#6/R4#6/R5#2; re-review
  // major "no production publisher"): conditional off-path rebuild + atomic generation-manifest
  // publish. The git sidecar's reindex hook runs THIS, not plain `reindex` — consumers
  // (PublishedIndex in both faces) swap handles on the manifest change; a clean-tree sync pass
  // costs a parse walk, not an embed pass (skip-on-equal). Scope handling mirrors `reindex`
  // (fail-closed on an invalid manifest; absent ⇒ signature invalidated). libsql-backend only:
  // the multi-generation home layout is the single-file-db backend's (the NAS composition).
  //
  // `republish` (RAI-143 clause 1) is the same verb with a DECISION in front of the build: it
  // resolves the vault, the home, the scope and the embedder exactly as `publish` does — by being
  // this code, not a copy of it — and diverges only where marked below.
  const vault = vaultArg();
  // HOME defaults to the libsql index HOME DIR (dirname of .../index.db) — the SAME dir a face's
  // default resolution homes at, so publisher and consumer agree by construction (unify fix
  // 2026-07-16: the old default was funesDbDir under the ambient backend — the index FILE path
  // used as a dir, or worse a pglite pgdata dir — and a face homed elsewhere never saw a manifest).
  const home = flag("--home") ?? dirname(funesDbDir(vault, "libsql"));
  // 0.3.0 item 23, on the HOME rather than on the gen-*.db path: every generation this publisher
  // builds, the manifest that names them and the read faces' RO opens all live inside this dir, so
  // a home in a sync root is the same torn database with more copies of it. Checked here as well as
  // in publishReindex so the refusal lands before an embedder is constructed.
  assertIndexNotInSyncRoot(home);
  const force = has("--force");
  // P1.7: --json emits ONE structured line a caller (twinkling's canon host-sync reindex hook) parses to
  // record the published generation + skip/build + home; and this command exits NON-ZERO on failure
  // so a reindex hook can degrade its cadence receipt (a failed publish is never a verifiable
  // success). Text mode stays the human default.
  const asJson = has("--json");
  const scope = readIndexScopeExcludes(vault);
  if (scope.kind === "invalid") {
    if (asJson) console.log(JSON.stringify({ ok: false, error: `index_scope invalid: ${scope.reason}`, home, vault }));
    else console.error(`${cmd}: star.yaml index_scope is invalid — ${scope.reason}. Refusing (a broken scope must not re-admit excluded files).`);
    process.exit(2);
  }
  const { publishReindex, republishDecision, withPublicationFence, parseRetainPrior } = await import("./publication.ts");
  // `--retain-prior`: absent is undefined, so the publisher's 24 h default applies (0.4.0 item 9).
  // The parser is publication.ts's, where a test reaches it; this adds only the command's name.
  const retainPriorMs = (): number | undefined => {
    try { return parseRetainPrior(flag("--retain-prior")); } catch (e) { throw new Error(`${cmd}: ${(e as Error).message}`); }
  };
  const { LibsqlStore } = await import("funes-libsql"); // relative, factory.ts's own lazy-import pattern
  const { E5Embedder } = await import("./embedder.ts");
  // Constructed here for BOTH verbs, and cheap for both: the model loads lazily on the first embed
  // call, and the republish decision below embeds nothing — its read-only open compares the stored
  // embedding signature against this embedder's identity string, which is the drift check the read
  // face runs at startup without a model either.
  const embedder = new E5Embedder();
  const publishOpts = {
    vault,
    home,
    embedder,
    open: (p: string) => LibsqlStore.create(embedder, p, { allowDirty: true }),
    ...publishCorpus(scope),
    // PLAN-0.2.1 step 12: publish the star's identity WITH the generation. A vault with no
    // star.yaml id publishes as before (undefined ⇒ nothing stamped, skip predicate unchanged),
    // so an unmanifested vault is not broken by a field it never declared.
    starId: readStarIdentity(vault).id ?? undefined,
    starIdWas: readStarIdentity(vault).idWas,
    force,
    // PLAN-0.3.0 item 38: rollback retention is a STORED PIN, and it survives this process — which
    // is the whole point, because the collection that would have unlinked the rollback target runs
    // in whichever process publishes next. Unflagged, the publisher's 24 h default (0.4.0 item 9).
    retainPriorMs: retainPriorMs(),
  };
  if (cmd === "republish") {
    // RAI-143 clause 1 — the recovery matrix, decided and acted on under ONE hold of the publication
    // fence (item 9). Both calls inside take the fence themselves and pass straight through, because
    // it is reentrant per async owner; what the outer hold buys is that no concurrent publisher can
    // repair the home between the verdict and the rebuild that acts on it. `force: true` on the
    // rebuild whatever the verdict said: the repair verb never clones (item 14 — a repair that
    // starts from the bytes it is repairing is not a repair), and a forced build is the only one that
    // does not. Exit codes: 0 rebuilt, 2 refused (nothing to repair, or nothing published), 1 a build
    // that was attempted and failed — a caller must be able to tell "declined" from "broke".
    let verdict: RepublishVerdict | undefined;
    try {
      const r = await withPublicationFence(home, async () => {
        verdict = await republishDecision(home, { embedder, force });
        if (verdict.action === "refuse") return null;
        if (!asJson) console.log(`republish: repairing — ${verdict.detail}`);
        return publishReindex({ ...publishOpts, force: true });
      });
      if (!r) {
        if (asJson) console.log(JSON.stringify({ ok: false, refused: verdict!.why, error: verdict!.detail, home, vault }));
        else console.error(`republish: REFUSED — ${verdict!.detail}`);
        process.exit(2);
      }
      if (asJson) {
        console.log(JSON.stringify({ ok: true, repaired: verdict!.why, detail: verdict!.detail, publicationId: r.publicationId, contentGeneration: r.generation, clonedFrom: r.clonedFrom ?? null, dbPath: r.dbPath, home, vault }));
      } else {
        console.log(`republish: publication ${r.publicationId} · content generation ${r.generation} · built from empty (clonedFrom: null) + published\n  -> ${r.dbPath}`);
      }
    } catch (e) {
      if (asJson) console.log(JSON.stringify({ ok: false, error: (e as Error).message, home, vault }));
      else console.error(`republish: FAILED — ${(e as Error).message}`);
      process.exit(1);
    }
    process.exit(0);
  }
  try {
    const r = await publishReindex(publishOpts);
    if (asJson) {
      // `clonedFrom` is additive (item 14): the sync hook records it so "why did this republish
      // take eleven seconds" has an answer in the receipt rather than in a guess. `publicationId` is
      // additive too (item 15): `funes watch` binds this machine's state to it after every success.
      console.log(JSON.stringify({ ok: true, skipped: r.skipped, generation: r.generation, publicationId: r.publicationId, home, dbPath: r.dbPath, clonedFrom: r.clonedFrom ?? null, vault }));
    } else {
      console.log(
        r.skipped
          ? `publish: generation ${r.generation.slice(0, 12)}… already current — skipped`
          : `publish: generation ${r.generation.slice(0, 12)}… ${r.clonedFrom ? `built INCREMENTALLY from ${r.clonedFrom}` : "built from empty"} + published\n  -> ${r.dbPath}`,
      );
    }
  } catch (e) {
    // Structured failure (P1.7): a caller reads {ok:false} + the message; the non-zero exit is the
    // signal the sync loop degrades its receipt on.
    if (asJson) console.log(JSON.stringify({ ok: false, error: (e as Error).message, home, vault }));
    else console.error(`publish: FAILED — ${(e as Error).message}`);
    process.exit(1);
  }
} else if (cmd === "fleet" && LIBSQL_ONLY) {
  // Same reason `publish` is absent from the alpha bin: `fleet` gates a rollout of the generation
  // manifests that bin has no producer and no consumer for.
  console.error("funes: `fleet` is not part of this build (it gates a rollout of the generation-manifest protocol the alpha does not ship). Run funes from source.");
  process.exit(2);
} else if (cmd === "fleet") {
  // PLAN-0.3.0 item 39 — the fleet gate. `funes fleet --home A --home B [--advance <phase>] [--json]`
  //
  // EXPLICIT repeated --home, and no discovery input of any kind, on purpose: a rollout that infers
  // its own inventory can migrate six homes, miss two, and report success — and the two it missed
  // are exactly the ones with a legacy process still running on them. The phase journal lives in
  // each home (durable, so an interrupted run resumes by re-running the same command), and the gate
  // refuses to advance while ANY home or ANY live principal is inconsistent.
  const homes: string[] = [];
  for (let i = 1; i < argv.length - 1; i++) if (argv[i] === "--home") homes.push(resolve(argv[i + 1]!));
  if (homes.length === 0) {
    console.error("funes fleet: name every home explicitly — `funes fleet --home <dir> [--home <dir> …] [--advance <phase>] [--json]`.\n  There is no discovery input (item 39): a rollout that guesses its inventory silently skips the homes that most need it.");
    process.exit(2);
  }
  const asJson = has("--json");
  const { fleetReport, fleetAdvance, FLEET_PHASES } = await import("./publication.ts");
  const phase = flag("--advance");
  if (phase == null) {
    const reports = await fleetReport(homes);
    if (asJson) console.log(JSON.stringify({ ok: true, reports }));
    else for (const r of reports) {
      console.log(
        `${r.home}\n  phase: ${r.phase ?? "-"}  schema: ${r.schemaVersion ?? "-"}  publication: ${r.publicationId ?? "-"}\n` +
        `  contentGeneration: ${r.contentGeneration ?? `INVALID${r.invalidatedReason ? ` (${r.invalidatedReason})` : ""}`}\n` +
        (r.principals.length
          ? r.principals.map((p) => `  principal ${p.principal}: ${p.live ? "LIVE" : "stale"} proto=${p.protocolVersion ?? "-"} sw=${p.softwareVersion ?? "-"} acked=${p.acked} age=${Math.round(p.ageMs / 1000)}s`).join("\n") + "\n"
          : "  principals: none reporting\n") +
        (r.problems.length ? r.problems.map((p) => `  PROBLEM: ${p}`).join("\n") : "  consistent"),
      );
    }
    // Reporting alone never fails the process: an operator inventorying a broken fleet wants the
    // inventory, not an exit code. `--advance` is where a refusal has teeth.
    process.exit(0);
  }
  if (!(FLEET_PHASES as readonly string[]).includes(phase)) {
    console.error(`funes fleet: unknown phase "${phase}" — one of ${FLEET_PHASES.join(", ")}`);
    process.exit(2);
  }
  const result = await fleetAdvance(homes, phase as (typeof FLEET_PHASES)[number]);
  if (asJson) console.log(JSON.stringify({ ok: result.refusals.length === 0, ...result }));
  else if (result.refusals.length) {
    console.error(`funes fleet: REFUSING to advance to "${phase}" — nothing was written.\n` + result.refusals.map((r) => `  - ${r}`).join("\n"));
  } else {
    console.log(`funes fleet: ${result.advanced.length} home(s) at phase "${phase}"\n` + result.advanced.map((h) => `  ${h}`).join("\n"));
  }
  process.exit(result.refusals.length ? 3 : 0);
} else if (cmd === "watch" && LIBSQL_ONLY) {
  // PLAN-0.4.0 item 15: the watcher exists to run the verb this build withholds, so it is withheld
  // with it — and its usage sits in USAGE's source-only branch for the release gate's reason.
  console.error("funes: `watch` is not part of this build (it drives the generation-manifest protocol the alpha does not ship). Run funes from source.");
  process.exit(2);
} else if (cmd === "watch") {
  // PLAN-0.4.0 item 15 (RAI-126): the reindex trigger on a read locus. The home defaults exactly as
  // `publish`'s does, and is passed to every spawned publish explicitly, so the two cannot disagree.
  const vault = vaultArg();
  const home = flag("--home") ?? dirname(funesDbDir(vault, "libsql"));
  // publication.ts's one duration grammar, the one `--retain-prior` takes; absent is the default,
  // and a value it cannot parse refuses, naming the flag, rather than polling on nothing.
  const { parseDuration } = await import("./publication.ts");
  const durationMs = (name: string, def: number): number => {
    try { return parseDuration(name, flag(name)) ?? def; } catch (e) { throw new Error(`${cmd}: ${(e as Error).message}`); }
  };
  const intervalMs = durationMs("--interval", 5_000);
  if (intervalMs <= 0) { writeSync(2, "funes: watch --interval must be positive\n"); process.exit(2); }
  const { runWatch } = await import("./watch.ts");
  process.exit(await runWatch({ vault, home, syncthing: flag("--syncthing"), intervalMs, minIntervalMs: durationMs("--min-interval", 60_000) }));
} else if (cmd === "eval") {
  // PLAN-0.2.1 steps 8-10. ONE channel, always: the published generation, opened `readonly: true`,
  // daemon probe disabled. The live index is a writer's working file and moves under a run; the
  // hub reads published generations, so the eval must measure what the hub can actually serve. Hub
  // parity is a SEPARATE assertion (step 9) — same fixture, same numbers, a different reader.
  const vault = vaultArg();
  // The fixture lives IN THE STAR it measures, not in this repo. Two reasons, and the second is
  // the one that decided it: a fixture is about one corpus, so it belongs beside that corpus; and
  // its queries and expected ids ARE that corpus — the personal one names a tenancy contract,
  // medical and military paperwork, and private individuals. `packages/` is inside funes' public
  // projection (scripts/projection.ts), and the projection's deny-list is term-based, so it would
  // have shipped all of that without a word. Pass --fixture to point elsewhere.
  const fixturePath = flag("--fixture") ?? join(vault, "out", "out_eval", "recall-eval.json");
  const home = flag("--home") ?? dirname(funesDbDir(vault, "libsql"));
  const { readGenerationManifest, openPaired, computeTargetGeneration } = await import("./publication.ts");
  const { runEval, formatReport, validateFixture, evalJson } = await import("./recall-eval.ts");
  // --draft samples CANDIDATE PAGES and writes a skeleton. It deliberately does NOT fill `relevant`:
  // the expected ids are the human's, authored before any run output is visible, and a gate whose
  // answers were generated by the thing it gates measures nothing. `validateFixture` refuses the
  // skeleton until they are filled, so there is no path where a half-drafted fixture reports a score.
  if (has("--draft")) {
    const { draftFixture } = await import("./recall-eval-draft.ts");
    const out = flag("--out") ?? fixturePath;
    if (existsSync(out) && !has("--force")) {
      console.error(`eval --draft: ${out} exists — pass --force to overwrite (a drafted fixture is cheap; an AUTHORED one is not)`);
      process.exit(2);
    }
    const { LibsqlStore: LS } = await import("funes-libsql");
    const { E5Embedder: E5 } = await import("./embedder.ts");
    assertIndexNotInSyncRoot(funesDbDir(vault, "libsql")); // item 23: makeStore is not the only opener
    const live = await LS.create(new E5(), funesDbDir(vault, "libsql"), { readonly: true });
    try {
      const drafted = draftFixture(live, { vault, seen: Number(flag("--seen", "20")), unseen: Number(flag("--unseen", "10")) });
      mkdirSync(dirname(out), { recursive: true }); // the default path lives in the star, which may not have the zone yet
      writeFileSync(out, JSON.stringify(drafted, null, 2) + "\n");
      console.log(`eval --draft: wrote ${drafted.cases.length} case(s) to ${out}`);
      console.log("  Next: rewrite each `query` as a real question, then fill each `relevant` with the ids that ANSWER it.");
      console.log("  Nothing runs until every case has a relevant id — that refusal is the anti-peeking rule.");
    } finally {
      await live.close();
    }
    process.exit(0);
  }
  if (!existsSync(fixturePath)) {
    console.error(`eval: no fixture at ${fixturePath} — draft one with \`funes eval --vault <path> --draft\`, or pass --fixture <file>`);
    process.exit(2);
  }
  // Read as BYTES and parsed from them: `--json` hashes exactly what was scored (PLAN-0.4.0 item 17).
  const fixtureBytes = readFileSync(fixturePath);
  const fixture = JSON.parse(fixtureBytes.toString("utf8")) as import("./recall-eval.ts").EvalFixture;
  const problems = validateFixture(fixture);
  if (problems.length > 0) {
    console.error(`eval: the fixture is not runnable —\n  ${problems.join("\n  ")}`);
    process.exit(2);
  }
  const manifest = readGenerationManifest(home);
  if (!manifest) {
    console.error(`eval: nothing published in ${home} — run \`funes publish --vault ${vault}\` first (the eval never measures the live index)`);
    process.exit(2);
  }
  const { E5Embedder } = await import("./embedder.ts");
  const { LibsqlStore } = await import("funes-libsql");
  const dbPath = join(home, manifest.db);
  assertIndexNotInSyncRoot(dbPath); // item 23: a direct LibsqlStore.create bypasses makeStore's guard
  // RAI-148: the PAIRED open (item 8) — the publication id the manifest names must be the one
  // stamped in the bytes. This opened `join(home, manifest.db)` bare, so "publication id equality
  // holds on every open that names a manifest" was true of the read faces only.
  const store = await openPaired((p) => LibsqlStore.create(new E5Embedder(), p, { readonly: true }), dbPath, manifest);
  try {
    // item 16 on the CLI: each case's recall is the guarded read every MCP op takes, against the
    // own-star expectation — a star.yaml narrowed after this generation was built withdraws its
    // pages from the eval as it does from recall, and the refusal is exit 3 with the MCP message.
    const report = await runEval(fixture, (query, k) => guardedOrRefuse(store, vault, () => store.recall({ query, k })));
    console.log(formatReport(report));
    console.log(`  generation ${manifest.generation}`);

    // PLAN-0.2.1 steps 9 and 20 — HUB PARITY. Never the measurement channel: the numbers above are
    // the direct read, and this asserts the hub returns the SAME rows for the same queries. The two
    // paths differ in everything except the store they end at (a catalogue, an identity check, a
    // PublishedIndex lease, a guarded op, a fan-out), so a divergence here is a bug in one of those
    // — not a difference of opinion about relevance.
    if (has("--hub")) {
      const starsFile = flag("--hub")!;
      const starId = readStarIdentity(vault).id;
      if (!starId) {
        console.error("eval --hub: this vault declares no star.yaml meta.id, so the hub cannot be asked for its group");
        process.exit(2);
      }
      const { Hub } = await import("./hub.ts");
      const hub = await Hub.open(starsFile, { stars: [starId], log: () => {} });
      try {
        const mismatches: string[] = [];
        for (const c of fixture.cases) {
          const direct = report.cases.find((r) => r.id === c.id)!.returned;
          const r = await hub.recall({ query: c.query, perStar: fixture.k, total: fixture.k });
          const group = r.groups[0];
          const viaHub = (group?.hits ?? []).map((h) => String(h.id));
          if (r.errors.length > 0) mismatches.push(`${c.id}: hub errored — ${r.errors.map((e) => `${e.code}: ${e.message}`).join("; ")}`);
          else if (JSON.stringify(viaHub) !== JSON.stringify(direct)) {
            mismatches.push(`${c.id}: direct [${direct.join(", ")}] ≠ hub [${viaHub.join(", ")}]`);
          }
        }
        console.log(mismatches.length === 0
          ? `  HUB PARITY: pass — ${fixture.cases.length} queries return identical rows through the hub`
          : `  HUB PARITY: FAIL (${mismatches.length}/${fixture.cases.length})\n${mismatches.map((m) => `    ${m}`).join("\n")}`);
        if (mismatches.length > 0) process.exit(1);
      } finally {
        await hub.close();
      }
    }
    if (has("--json")) {
      // PLAN-0.4.0 item 17: what a publish of this vault would stamp now, so the release gate can
      // tell a lagging publication (not comparable) from a parity mismatch. A parse walk, no embed.
      const scope = readIndexScopeExcludes(vault);
      const vaultGeneration = scope.kind === "invalid"
        ? null
        : computeTargetGeneration(vault, { embedder: new E5Embedder(), ...publishCorpus(scope) });
      console.log(JSON.stringify(evalJson(report, manifest, fixtureBytes, vaultGeneration)));
    }
    // The baseline is written ONCE, by this command, and never edited by hand — a baseline a human
    // can retype is a baseline that drifts toward whatever the system currently does.
    if (has("--baseline")) {
      if (fixture.baseline) {
        console.error(`eval: a baseline already exists (generation ${fixture.baseline.generation}) — delete it deliberately to re-baseline`);
        process.exit(2);
      }
      const next = { ...fixture, baseline: {
        generation: manifest.generation, pAtK: report.pAtK, mrr: report.mrr,
        negativeRate: report.negativeRate, unseenPAtK: report.bySplit.unseen.pAtK,
        at: new Date().toISOString(),
      } };
      writeFileSync(fixturePath, JSON.stringify(next, null, 2) + "\n");
      console.log(`  baseline written to ${fixturePath}`);
    }
    if (!report.passed) process.exit(1);
  } finally {
    await store.close();
  }
} else if (cmd === "doctor") {
  // PLAN-0.2.1 step 24 — the graph audit. Read-only in every sense: it opens the published
  // generation `readonly: true`, runs two selects, and writes nothing. It does not prune, does not
  // rewrite an edge, and does not touch `graph.json` — the artifact `graph()` caches beside the
  // index — because an audit that warmed that cache would mutate what it came to measure.
  //
  // Published by default, and identity-checked before the first row is read, through the SAME four
  // layers the hub refuses on (star-identity.ts). The check is not ceremony here: the publication
  // home is derived from the vault's BASENAME, so two stars both called `notes` resolve to the same
  // home, and an unverified audit would report one star's dangling edges under the other's name.
  // PLAN-0.4.0 item 10: resolved before the vault is read — `FUNES_LOCUS='a@b' funes doctor` exits 2
  const locus = locusArg();
  const vault = vaultArg();
  // The published (libsql-only) artifact ships no publisher and no manifest consumer, so its
  // default path could only ever fail — and it would fail by naming a command that build does not
  // have. `--live` is genuinely useful there (its `reindex` writes exactly that index), so the verb
  // stays and only its default is withdrawn.
  if (LIBSQL_ONLY && !has("--live")) {
    console.error(`funes: this build has no generation for doctor to audit — run \`funes doctor --vault ${vault} --live\` to audit the working index (the report marks itself unverified).`);
    process.exit(2);
  }
  const home = flag("--home") ?? dirname(funesDbDir(vault, "libsql"));
  const asJson = has("--json");
  const { auditGraphRows, formatAuditReport, activeOverrides, formatOverrideFindings, formatSyncConflicts, formatRetained, formatUnparsed, UNPARSED_FIRST } = await import("./doctor.ts");
  const { unparsedPages } = await import("./reindex.ts");
  const { syncConflictFinding } = await import("./sync-conflicts.ts");
  // 0.3.0 item 20: doctor carried NONE of the operator state contract — an operator running the one
  // command named "doctor" learned about dangling edges and nothing about whether the index they
  // audit is the one their star.yaml asks for. Same assembly `health` returns, so the two faces
  // cannot drift into two accounts of one machine.
  const { operatorState, formatOperatorState } = await import("./machine-state.ts");
  // Constructed, never used: the audit embeds nothing, and E5Embedder loads its 135MB model lazily
  // on the first embed call. The store still wants one to validate the index's embedding signature.
  const { E5Embedder } = await import("./embedder.ts");
  const { LibsqlStore } = await import("funes-libsql");
  const { verifyPublishedStarIdentity, assertStampedStarIdentity } = await import("./star-identity.ts");

  let dbPath: string;
  let generation: string | null = null;
  let starId: string | null = null;
  /** The verified manifest on the published branch; null on --live, which names no publication. */
  let manifest: GenerationManifest | null = null;
  if (has("--live")) {
    // The explicit fallback the plan allows, and the report names itself UNVERIFIED because of it:
    // the live index is a writer's working file, it can move under this read, and there is no
    // manifest to check an identity against.
    dbPath = funesDbDir(vault, "libsql");
    if (!existsSync(dbPath)) {
      console.error(`doctor --live: no live index at ${dbPath} — run \`funes reindex --vault ${vault}\` first`);
      process.exit(2);
    }
  } else {
    const identity = readStarIdentity(vault);
    if (!identity.id) {
      console.error(
        `doctor: ${vault} declares no star.yaml meta.id, so WHICH star a published generation belongs to cannot be proven.\n` +
        "        Give the star an id, or audit the working index with --live and read the result as unverified.",
      );
      process.exit(2);
    }
    starId = identity.id;
    // Layer 1 is vacuous here by construction — the id we serve this star as IS its star.yaml id —
    // and it is left in rather than skipped so doctor and the hub run ONE verifier, not two that
    // drift. Layers 2-3 (a generation is published, and its manifest names this star) are the ones
    // doing work; layer 4 follows on the open handle below.
    manifest = verifyPublishedStarIdentity({
      path: vault, id: starId, name: identity.name ?? basename(vault), home,
      who: "doctor", serves: "star.yaml",
      noPublicationHint: "(doctor audits a published generation; --live audits the working index and says so)",
    });
    dbPath = join(home, manifest.db);
    generation = manifest.generation;
  }

  // item 23: --live audits the working index and the published branch audits a generation db; both
  // open libsql DIRECTLY, so neither inherits makeStore's guard. A torn index reports torn graph.
  assertIndexNotInSyncRoot(dbPath);
  // RAI-148: the PAIRED open (item 8). Doctor checked star identity through four layers and then
  // opened the db without asking whether it was the publication the manifest named — so a foreign
  // generation of the SAME star, moved under this manifest, audited as if it were the published one.
  // On --live there is no manifest and nothing to pair against; the check is a no-op by design.
  const { openPaired, retainedArtefacts } = await import("./publication.ts");
  const store = await openPaired((p) => LibsqlStore.create(new E5Embedder(), p, { readonly: true }), dbPath, manifest);
  // Layer 4 — the id inside the database bytes, the only one that travels with a copied file.
  // Outside the try on purpose: it closes the store itself when it refuses, so there is exactly one
  // owner of the handle at any moment and no double close.
  if (starId) await assertStampedStarIdentity(store, { expectedId: starId, dbPath, who: "doctor", serves: "star.yaml" });
  try {
    const report = auditGraphRows(await store.auditGraph());
    const state = await operatorState(store, vault, await store.stats(), process.env, locus);
    const header = { vault, generation, source: dbPath, verified: generation !== null };
    // 0.3.0 item 23: every ACTIVE override is a red finding, printed with the audit rather than
    // beside it — an operator reading a healthy graph report must see, in the same breath, that a
    // safety rule was suspended to produce it.
    const overrides = activeOverrides();
    // 0.4.0 item 7: conflict copies on disk (the vault walk) and in the rows this audit read (a
    // generation or index built before the walkers skipped them). A finding, never a refusal and
    // never an exit code; `health` stays the index's answer and does not walk the vault.
    const syncConflicts = syncConflictFinding(vault, await store.indexedIds());
    // 0.4.0 item 9: the home's gen-*.db files other than the one its manifest names — what the 24 h
    // default retention (and every pin and live ack) costs on disk. Read off the home in both modes:
    // the default home IS the live index's directory, so the files are there whichever copy is audited.
    const retained = retainedArtefacts(home);
    // 0.4.0 item 11: pages whose frontmatter does not parse, walked over the indexed scope NOW. The
    // JSON key is `vault.unparsed`, literally: `vault` is already the header's path, and the name must
    // say this is a fact about the files, never about the rows (ADR-0003) — the estate walk logs it
    // per home beside the row counts above, and must not compare the one against the other.
    const { ids: unparsed, walkError } = unparsedPages(vault);
    const vaultUnparsed = { count: unparsed.length, first: unparsed.slice(0, UNPARSED_FIRST), ...(walkError ? { walkError } : {}) };
    const color = process.stdout.isTTY === true;
    console.log(asJson
      ? JSON.stringify({ ...header, ...report, overrides, syncConflicts, retained, "vault.unparsed": vaultUnparsed, state })
      : `${formatAuditReport(report, header)}\n\n${formatOperatorState(state)}\n\n${formatOverrideFindings(overrides, { color })}\n\n${formatSyncConflicts(syncConflicts, { color, live: has("--live") })}\n\n${formatRetained(retained, { color })}\n\n${formatUnparsed(vaultUnparsed, { color })}`);
  } finally {
    await store.close();
  }
} else if (cmd === "export") {
  // PLAN-0.2.1 Phase 4, steps 25-27. The OKF exporter moved here from twinkling, at spec v0.2.
  // It reads MARKDOWN, not the index, so it needs no generation and no embedder — but it honors
  // `index_scope` itself, because a bundle that shipped what recall cannot see would be a second,
  // looser definition of what the star contains. The spec version is the star's too (RAI-45,
  // PLAN-0.4.0 item 16): `memory.okf` from star.yaml, "0.2" when undeclared; `false` refuses.
  const vault = vaultArg();
  if (!has("--okf")) {
    console.error("usage: funes export --okf [--vault <path>] [--out <dir>]  (OKF is the only export format today)");
    process.exit(2);
  }
  // Fail-closed on a broken scope, exactly as reindex does: a star.yaml we cannot read must not
  // silently widen the bundle to every file on disk.
  const scope = readIndexScopeExcludes(vault);
  if (scope.kind === "invalid") {
    console.error(`export refused — star.yaml index_scope is invalid: ${scope.reason}. A bundle must not be wider than the index.`);
    process.exit(2);
  }
  const excludes = scope.kind === "valid" ? scope.excludes : [];
  if (excludes.length) console.error(`index_scope: honoring ${excludes.length} exclude glob(s) — de-indexed is de-exported`);
  // The same fail-closed for `memory.okf`: a value we cannot honour is neither a version to stamp
  // nor an opt-out to obey, so it refuses here instead of falling back to the "0.2" default.
  const identity = readStarIdentity(vault);
  if (identity.okfInvalid !== null) {
    console.error(`export refused — star.yaml memory.okf must be "0.1", "0.2" or false (got ${identity.okfInvalid}). A bundle never carries a version the star did not declare.`);
    process.exit(2);
  }
  const { exportOkf, okfDefaultOutDir } = await import("./okf-export.ts");
  const outDir = flag("--out") ?? okfDefaultOutDir(vault);
  const res = await exportOkf(vault, outDir, {
    exclude: anyExclude(buildScopeExclude(excludes), scope.kind === "absent" ? configlessExclude() : undefined),
    starId: identity.id,
    okf: identity.capabilities.okf,
  });
  console.log(`export: ${res.concepts} concept(s) + ${res.indexes} index file(s) -> ${res.outDir}`);
  if (!res.gitleaksRan) {
    // Not a failure: the pure detector is the floor and it already passed over every byte. It is
    // still worth saying, because the two scanners catch different things.
    console.error("export: gitleaks is not on PATH — the bundle passed the built-in detector only.");
  }
  for (const w of res.warnings) console.error(`  warn: ${w}`);
  if (res.strandedBackup) {
    console.error(
      `export: an interrupted run left a backup at ${res.strandedBackup}. The current bundle won and the backup was KEPT — ` +
      "review it and delete it yourself; an export does not delete data it cannot prove is stale.",
    );
  }
} else if (cmd === "query") {
  const q = argv[1];
  if (!q || q.startsWith("--")) {
    console.error('usage: query "<question>" [--vault <path>] [--db <path>] [-k N] [--rerank] [--json]');
    process.exit(2);
  }
  const vault = vaultArg();
  const k = Number(flag("-k", "5"));
  // S4: --rerank opts into the cross-encoder top stage (model lazy-loads on first recall).
  const rerank = has("--rerank");
  const store = await openStore(vault, rerank ? { reranker: new CrossEncoderReranker() } : {});
  // item 16: the guarded read (see guardedOrRefuse). A refusal exits 3 before any embedding.
  const res = await guardedOrRefuse(store, vault, () => store.recall({ query: q, k, rerank }));
  const st = await store.stats();
  await noteEmptyOrStale(store, vault, st, res.length, q);
  if (has("--json")) {
    // Stable JSON contract for harness consumers (replaces text-scraping — GBrain N1/H6).
    console.log(JSON.stringify(res));
  } else {
    for (const r of res) console.log(`${r.score.toFixed(4)}  ${r.path ?? r.id}  — ${r.title}`);
  }
  await store.close();
} else if (cmd === "remember") {
  const vault = vaultArg();
  const title = flag("--title");
  if (!title) { console.error('usage: remember --vault <path> --title "T" [--body "..."|stdin] [--type] [--tags a,b] [--source s] [--volatile] [--as-of DATE]'); process.exit(2); }
  // P5.19 state/event split: the MCP op has accepted these two since it shipped, so an agent could
  // mark a write as STATE and the human at the terminal could not — the one surface most likely to
  // be recording a rate, a plan, or a price.
  const asOf = asOfArg();
  // 0.3.0 items 24 + 25 (cli-open.ts): designation + actor resolved once, the authorization
  // reported BEFORE the store opens; the canonical write itself runs under the publication fence
  // (item 9) — the same fence the broker face takes around a mutation and the publisher around a
  // publish, so a terminal write can no longer land between a publisher's validation and its swap.
  const { funes: store, fenced } = await openFunes(vault, "remember");
  const body = await bodyFrom(); // read OUTSIDE the fence — never hold a lock waiting on stdin
  // C3: default-untrusted (H4 spec) — anything reaching the CLI is unvetted input; elevation
  // becomes an explicit step once the S3 sanitizer/elevation path lands.
  const { ids } = await fenced(() => store.remember([{
    title, body, type: flag("--type"),
    // `volatile: false` is a no-op downstream (frontmatterFor emits `meta.volatile || undefined`),
    // so passing the flag unconditionally matches the op's `v === true` and writes no key for an EVENT.
    meta: { tags: list(flag("--tags")), sources: list(flag("--source")), trust: "untrusted", volatile: has("--volatile"), as_of: asOf },
  }]));
  console.log(has("--json") ? JSON.stringify({ id: ids[0] }) : `remembered: ${ids[0]}`);
  await store.close();
} else if (cmd === "supersede") {
  const vault = vaultArg();
  const oldId = positional(1);
  const title = flag("--title");
  if (!oldId || !title) { console.error('usage: supersede --vault <path> <oldId> --title "T" [--body "..."|stdin] [--volatile] [--as-of DATE]'); process.exit(2); }
  // Same two flags as `remember`, and for a sharper reason: a successor that cannot restate its own
  // volatility silently DEMOTES a state claim to an event — the exact failure supersession exists to
  // prevent. The MCP op restates it (P5.19); until now the CLI could only drop it.
  const asOf = asOfArg();
  const { funes: store, fenced } = await openFunes(vault, "supersede");
  const body = await bodyFrom();
  const { id } = await fenced(() => store.supersede(oldId, {
    title, body, type: flag("--type"),
    meta: { trust: "untrusted", volatile: has("--volatile"), as_of: asOf },
  }));
  console.log(has("--json") ? JSON.stringify({ id }) : `superseded ${oldId} -> ${id}`);
  await store.close();
} else if (cmd === "link") {
  const vault = vaultArg();
  const fromId = positional(1);
  const toId = positional(2);
  if (!fromId || !toId) { console.error("usage: link --vault <path> <fromId> <toId> [--type related_to]"); process.exit(2); }
  const { funes: store, fenced } = await openFunes(vault, "link");
  const type = flag("--type", "related_to")!;
  await fenced(() => store.link(fromId, toId, type));
  console.log(`linked ${fromId} -[${type}]-> ${toId}`);
  await store.close();
} else if (cmd === "forget") {
  const vault = vaultArg();
  const id = positional(1);
  if (!id) { console.error("usage: forget --vault <path> <id> [--hard]"); process.exit(2); }
  const { funes: store, fenced } = await openFunes(vault, "forget");
  await fenced(() => store.forget(id, { hard: has("--hard") }));
  console.log(`${has("--hard") ? "purged" : "forgot (soft)"}: ${id}`);
  await store.close();
} else if (cmd === "elevate") {
  // H4 explicit elevation — the deliberate human act that flips a funes-written item to
  // trusted. CLI-only by design: never exposed through the remote op-registry.
  const vault = vaultArg();
  const id = positional(1);
  if (!id) { console.error("usage: elevate --vault <path> <out_memory/id>"); process.exit(2); }
  const { funes: store, fenced } = await openFunes(vault, "elevate");
  await fenced(() => store.elevate(id));
  console.log(`elevated to trusted: ${id}`);
  await store.close();
} else if (cmd === "grandfather") {
  // H4 migration (one-shot): out_memory items written BEFORE the trust era — i.e. with no
  // trust field in their frontmatter — are elevated to trusted (they were hand-written/
  // curated by the owner at lone-local, per the Rev 6 S3 spec) and an audit list is emitted
  // so the blanket elevation is reviewable. Items already trust-tagged are left alone.
  const { readdirSync, existsSync } = await import("node:fs");
  const { readMemoryFile } = await import("./write.ts");
  // P3.15: import the zone helper from funes-shared directly. `./zones.ts` never existed here (this
  // threw on every `funes grandfather` run), and the funes-engine barrel would drag daemon.ts,
  // face.ts, console.html and Bun.serve into the published bundle.
  const { memoryZoneOf } = await import("funes-shared");
  const { isSyncConflict } = await import("./sync-conflicts.ts");
  const vault = vaultArg();
  const zone = memoryZoneOf(vault); // vault-v2: out/out_memory when an out/ container exists
  const dir = join(vault, zone);
  if (!existsSync(dir)) { console.log(`grandfather: no ${zone}/ — nothing to migrate (audit: empty)`); process.exit(0); }
  const { funes: store, fenced } = await openFunes(vault, "grandfather");
  const audit: string[] = [];
  const unparsed: string[] = [];
  // ONE fence around the whole migration, as the broker holds one around a whole mutation: a
  // publish landing between two elevations would validate against half a migration.
  await fenced(async () => {
    for (const name of readdirSync(dir).sort()) {
      // 0.4.0 item 7: this loop lists the zone ITSELF, behind walkMd's back, and elevate() writes
      // `trust: trusted` into the file and re-indexes it — so a conflict copy the walker skips would
      // be promoted to trusted and put back into the index here. Skipped at the same tier.
      if (!name.endsWith(".md") || name.endsWith(".summary.md") || isSyncConflict(name)) continue;
      const id = `${zone}/${name.replace(/\.md$/, "")}`;
      const f = readMemoryFile(vault, id);
      if (!f) continue;
      // 0.4.0 item 11: YAML that does not parse reads as `data: {}` — its trust, declared or not,
      // cannot be seen, so it is never elevated (and patchFrontmatter would refuse it mid-migration,
      // after the pages before it were elevated and before this audit printed). Listed instead.
      if (f.error !== undefined) { unparsed.push(`${id} (${f.error})`); continue; }
      if (f.data.trust != null) continue; // already trust-tagged — leave it
      await store.elevate(id); // frontmatter trust: trusted + index sync, the same act as manual elevation
      audit.push(id);
    }
  });
  console.log(`grandfathered ${audit.length} pre-trust ${zone} item(s) as trusted (audit list):`);
  for (const id of audit) console.log(`  ${id}`);
  if (unparsed.length) console.log(`not elevated — frontmatter does not parse, fix the YAML and re-run:\n${unparsed.map((u) => `  ${u}`).join("\n")}`);
  await store.close();
} else {
  writeSync(2, `funes: unknown command ${JSON.stringify(cmd)}\n\n${USAGE}\n`);
  process.exit(2);
}
