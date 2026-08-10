#!/usr/bin/env bun
// funes local CLI over a star's markdown — derived PGLite index at <vault>/.funes/pgdata/.
//   reindex   --vault <path> [--db <path>] [--max N] [--fresh]
//             --fresh = wipe + full rebuild (recomputes stale derived columns, e.g. the ab95b13
//             tsvector weighting on hash-skipped rows). OFFLINE repair: the index is unqueryable
//             mid-run — a SERVED libsql home uses `publish --force` instead (no-downtime swap).
//   publish   --vault <path> [--home <index-dir>] [--force]   (conditional generation publish, libsql)
//   query     "<question>" [--vault <path>] [--db <path>] [-k N] [--rerank] [--json]
//   remember  --vault <path> --title "T" [--body "..."|stdin] [--type memory] [--tags a,b] [--source s]
//   supersede --vault <path> <oldId> --title "T" [--body "..."|stdin]
//   link      --vault <path> <fromId> <toId> [--type related_to]
//   forget    --vault <path> <id> [--hard]
import { writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { FunesStore } from "./funes-store.ts";
import { CrossEncoderReranker, type Reranker } from "./rerank.ts";
import { makeStore, funesDbDir } from "./factory.ts";
import { indexDir } from "./reindex.ts";
import { readIndexScopeExcludes, scopeHash, buildScopeExclude, configlessExclude, anyExclude } from "./scope.ts";
import type { ScopeSignature } from "funes-core";
import { daemonProbe, DEFAULT_DAEMON_PORT } from "./daemon-client.ts";
import { FUNES_VERSION } from "./version.ts";
import { LIBSQL_ONLY } from "./artifact.ts";

// P3.15: every subcommand runs at top level, so a throw surfaced as a raw Node stack trace — the
// FUNES_BACKEND=postgres refusal, a missing vault, a lock held by another writer. A CLI owes the
// user a sentence; the trace stays one env var away for when it is actually wanted.
for (const ev of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(ev, (err: unknown) => {
    const e = err as Error | undefined;
    const msg = process.env.FUNES_DEBUG === "1" ? (e?.stack ?? String(err)) : `funes: ${e?.message ?? String(err)}`;
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
// PGLite persists to a directory (Postgres data dir), not a single file.
const dbFor = (vault: string) => flag("--db", funesDbDir(vault))!;
/** Boolean flags take no value — the positional parser must not let them swallow the next token
 *  (S0 fix: `forget --hard <id>` used to lose the id to flag-order sensitivity). */
const BOOL_FLAGS = new Set(["--hard", "--json", "--rerank", "--ignore-scope", "--fresh", "--force"]);
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
async function bodyFrom(): Promise<string> {
  const b = flag("--body");
  if (b != null) return b;
  // P3.15: `Readable.toWeb` rather than `Bun.stdin` (Bun-only) or `new Response(process.stdin)` —
  // the latter leans on undici accepting a Node stream as a body, which varies across the Node
  // range the release gate covers. This is explicit and stable on both runtimes.
  const { Readable } = await import("node:stream");
  return (await new Response(Readable.toWeb(process.stdin) as ReadableStream).text()).trim();
}
// PGLite is single-connection: when the S2 daemon holds this vault's pgdata, direct opens
// must refuse (twinkling's wrappers route reads through the daemon; raw CLI ops stop here).
async function refuseIfDaemon(vault: string): Promise<void> {
  const port = Number(process.env.FUNES_DAEMON_PORT ?? DEFAULT_DAEMON_PORT);
  const { resolve } = await import("node:path");
  if (await daemonProbe(port, resolve(vault))) {
    console.error(`the funes daemon is running for this vault (port ${port}) and owns its PGLite handle — stop it first.`);
    process.exit(2);
  }
}
const openStore = async (vault: string, opts: { allowDirty?: boolean; reranker?: Reranker } = {}) => {
  await refuseIfDaemon(vault);
  return makeStore({ vault, dbDir: dbFor(vault), allowDirty: opts.allowDirty, reranker: opts.reranker });
};
const openFunes = async (vault: string) => new FunesStore(await openStore(vault), { root: vault });

if (cmd === "--version" || cmd === "-v") {
  console.log(FUNES_VERSION);
} else if (cmd === "mcp") {
  // P3.15: the published bin is one command, so `funes mcp` starts the stdio server in-process.
  const { runMcp } = await import("./mcp-server.ts");
  await runMcp(argv.slice(1));
} else if (cmd === "reindex") {
  const vault = flag("--vault", process.cwd())!;
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
  const store = await openStore(vault, { allowDirty: true });
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
    onProgress: (p) =>
      process.stderr.write(`\r  ${p.files} files · ${p.indexed} indexed · ${p.skipped} unchanged · ${p.tombstoned} tombstoned`),
  });
  process.stderr.write("\n");
  console.log(`reindex complete: ${r.files} files (${r.indexed} indexed, ${r.skipped} unchanged, ${r.tombstoned} tombstoned, ${r.pruned} pruned) in ${((Date.now() - t0) / 1000).toFixed(0)}s\n  -> ${db}`);
  await store.close();
} else if (cmd === "publish" && LIBSQL_ONLY) {
  // P3.15: `publish` is absent from the PUBLISHED bin. It writes gen-*.db and swaps generation.json,
  // but the shipped `query` and `mcp` open index.db directly and the alpha has no daemon or face —
  // the only manifest consumers — so a published generation would have nothing in this artifact that
  // can read it. The code and its tests stay in source: the NAS canon sidecar drives `funes publish`
  // through star-sync --reindex-cmd and must keep working.
  console.error("funes: `publish` is not part of this build (it needs the daemon/face surfaces the alpha does not ship). Run funes from source for the publication protocol.");
  process.exit(2);
} else if (cmd === "publish") {
  // The PRODUCTION caller of the publication protocol (re-homing plan R3#6/R4#6/R5#2; re-review
  // major "no production publisher"): conditional off-path rebuild + atomic generation-manifest
  // publish. The git sidecar's reindex hook runs THIS, not plain `reindex` — consumers
  // (PublishedIndex in both faces) swap handles on the manifest change; a clean-tree sync pass
  // costs a parse walk, not an embed pass (skip-on-equal). Scope handling mirrors `reindex`
  // (fail-closed on an invalid manifest; absent ⇒ signature invalidated). libsql-backend only:
  // the multi-generation home layout is the single-file-db backend's (the NAS composition).
  const vault = flag("--vault", process.cwd())!;
  // HOME defaults to the libsql index HOME DIR (dirname of .../index.db) — the SAME dir a face's
  // default resolution homes at, so publisher and consumer agree by construction (unify fix
  // 2026-07-16: the old default was funesDbDir under the ambient backend — the index FILE path
  // used as a dir, or worse a pglite pgdata dir — and a face homed elsewhere never saw a manifest).
  const home = flag("--home") ?? dirname(funesDbDir(vault, "libsql"));
  const force = has("--force");
  // P1.7: --json emits ONE structured line a caller (twinkling's canon host-sync reindex hook) parses to
  // record the published generation + skip/build + home; and this command exits NON-ZERO on failure
  // so a reindex hook can degrade its cadence receipt (a failed publish is never a verifiable
  // success). Text mode stays the human default.
  const asJson = has("--json");
  const scope = readIndexScopeExcludes(vault);
  if (scope.kind === "invalid") {
    if (asJson) console.log(JSON.stringify({ ok: false, error: `index_scope invalid: ${scope.reason}`, home, vault }));
    else console.error(`publish: star.yaml index_scope is invalid — ${scope.reason}. Refusing (a broken scope must not re-admit excluded files).`);
    process.exit(2);
  }
  const excludes = scope.kind === "valid" ? scope.excludes : [];
  const { publishReindex } = await import("./publication.ts");
  const { LibsqlStore } = await import("funes-libsql"); // relative, factory.ts's own lazy-import pattern
  const { E5Embedder } = await import("./embedder.ts");
  const embedder = new E5Embedder();
  try {
    const r = await publishReindex({
      vault,
      home,
      embedder,
      open: (p) => LibsqlStore.create(embedder, p, { allowDirty: true }),
      // Same effective predicate as reindex, so a configless vault produces the SAME corpus
      // through both verbs (divergent corpora would mean divergent generations).
      exclude: anyExclude(buildScopeExclude(excludes), scope.kind === "absent" ? configlessExclude() : undefined),
      scopeSignature: scope.kind === "valid" ? { hash: scopeHash(excludes), ignoreScope: false } : null,
      force,
    });
    if (asJson) {
      console.log(JSON.stringify({ ok: true, skipped: r.skipped, generation: r.generation, home, dbPath: r.dbPath, vault }));
    } else {
      console.log(
        r.skipped
          ? `publish: generation ${r.generation.slice(0, 12)}… already current — skipped`
          : `publish: generation ${r.generation.slice(0, 12)}… built + published\n  -> ${r.dbPath}`,
      );
    }
  } catch (e) {
    // Structured failure (P1.7): a caller reads {ok:false} + the message; the non-zero exit is the
    // signal the sync loop degrades its receipt on.
    if (asJson) console.log(JSON.stringify({ ok: false, error: (e as Error).message, home, vault }));
    else console.error(`publish: FAILED — ${(e as Error).message}`);
    process.exit(1);
  }
} else if (cmd === "query") {
  const q = argv[1];
  if (!q || q.startsWith("--")) {
    console.error('usage: query "<question>" [--vault <path>] [--db <path>] [-k N] [--rerank] [--json]');
    process.exit(2);
  }
  const vault = flag("--vault", process.cwd())!;
  const k = Number(flag("-k", "5"));
  // S4: --rerank opts into the cross-encoder top stage (model lazy-loads on first recall).
  const rerank = has("--rerank");
  const store = await openStore(vault, rerank ? { reranker: new CrossEncoderReranker() } : {});
  const res = await store.recall({ query: q, k, rerank });
  if (has("--json")) {
    // Stable JSON contract for harness consumers (replaces text-scraping — GBrain N1/H6).
    console.log(JSON.stringify(res));
  } else {
    for (const r of res) console.log(`${r.score.toFixed(4)}  ${r.path ?? r.id}  — ${r.title}`);
  }
  await store.close();
} else if (cmd === "remember") {
  const vault = flag("--vault", process.cwd())!;
  const title = flag("--title");
  if (!title) { console.error('usage: remember --vault <path> --title "T" [--body "..."|stdin] [--type] [--tags a,b] [--source s]'); process.exit(2); }
  const store = await openFunes(vault);
  // C3: default-untrusted (H4 spec) — anything reaching the CLI is unvetted input; elevation
  // becomes an explicit step once the S3 sanitizer/elevation path lands.
  const { ids } = await store.remember([{
    title, body: await bodyFrom(), type: flag("--type"),
    meta: { tags: list(flag("--tags")), sources: list(flag("--source")), trust: "untrusted" },
  }]);
  console.log(has("--json") ? JSON.stringify({ id: ids[0] }) : `remembered: ${ids[0]}`);
  await store.close();
} else if (cmd === "supersede") {
  const vault = flag("--vault", process.cwd())!;
  const oldId = positional(1);
  const title = flag("--title");
  if (!oldId || !title) { console.error('usage: supersede --vault <path> <oldId> --title "T" [--body "..."|stdin]'); process.exit(2); }
  const store = await openFunes(vault);
  const { id } = await store.supersede(oldId, { title, body: await bodyFrom(), type: flag("--type"), meta: { trust: "untrusted" } });
  console.log(has("--json") ? JSON.stringify({ id }) : `superseded ${oldId} -> ${id}`);
  await store.close();
} else if (cmd === "link") {
  const vault = flag("--vault", process.cwd())!;
  const fromId = positional(1);
  const toId = positional(2);
  if (!fromId || !toId) { console.error("usage: link --vault <path> <fromId> <toId> [--type related_to]"); process.exit(2); }
  const store = await openFunes(vault);
  const type = flag("--type", "related_to")!;
  await store.link(fromId, toId, type);
  console.log(`linked ${fromId} -[${type}]-> ${toId}`);
  await store.close();
} else if (cmd === "forget") {
  const vault = flag("--vault", process.cwd())!;
  const id = positional(1);
  if (!id) { console.error("usage: forget --vault <path> <id> [--hard]"); process.exit(2); }
  const store = await openFunes(vault);
  await store.forget(id, { hard: has("--hard") });
  console.log(`${has("--hard") ? "purged" : "forgot (soft)"}: ${id}`);
  await store.close();
} else if (cmd === "elevate") {
  // H4 explicit elevation — the deliberate human act that flips a funes-written item to
  // trusted. CLI-only by design: never exposed through the remote op-registry.
  const vault = flag("--vault", process.cwd())!;
  const id = positional(1);
  if (!id) { console.error("usage: elevate --vault <path> <out_memory/id>"); process.exit(2); }
  const store = await openFunes(vault);
  await store.elevate(id);
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
  const vault = flag("--vault", process.cwd())!;
  const zone = memoryZoneOf(vault); // vault-v2: out/out_memory when an out/ container exists
  const dir = join(vault, zone);
  if (!existsSync(dir)) { console.log(`grandfather: no ${zone}/ — nothing to migrate (audit: empty)`); process.exit(0); }
  const store = await openFunes(vault);
  const audit: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".md") || name.endsWith(".summary.md")) continue;
    const id = `${zone}/${name.replace(/\.md$/, "")}`;
    const f = readMemoryFile(vault, id);
    if (!f || f.data.trust != null) continue; // already trust-tagged — leave it
    await store.elevate(id); // frontmatter trust: trusted + index sync, the same act as manual elevation
    audit.push(id);
  }
  console.log(`grandfathered ${audit.length} pre-trust ${zone} item(s) as trusted (audit list):`);
  for (const id of audit) console.log(`  ${id}`);
  await store.close();
} else {
  console.error(LIBSQL_ONLY
    ? "usage: funes <reindex|query|mcp|remember|supersede|link|forget|elevate|grandfather|--version> ..."
    : "usage: funes <reindex|publish|query|mcp|remember|supersede|link|forget|elevate|grandfather|--version> ...");
  process.exit(2);
}
