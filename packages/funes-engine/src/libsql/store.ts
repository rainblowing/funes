// LibsqlStore — the libSQL and Turso host of the one index module (RAI-314, ADR-0023): funes-core's
// SqlIndex over a sync exec port on one libsql or Turso FILE, in WAL. The engine is the star's
// `memory.substrate`; Turso (B8b, RAI-344) differs only in its open, its dialect (the `fts` index
// method), no read-only open and no publish. The schema, the writes,
// recall and the build walk are the module's; this file keeps what is the host's: the RW open (WAL,
// busy_timeout) and the RO `mode=ro` open, the schema fence and the dirty guard, the star's write lock
// around every write and the whole build, the in-place `--fresh` reset, `finalizeForPublish`, recall
// telemetry, the hotlist, and the graph bake and `neighbors` (both read chunk 0).
import Database from "libsql";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import Graph from "graphology";
import { circular } from "graphology-layout";
import forceAtlas2 from "graphology-layout-forceatlas2";
import louvain from "graphology-communities-louvain";
import type { Embedder } from "funes-core";
import type { BuildInput, BuildResult, FinalizeReindex, MemoryItem, PageStatRecord, PageSwap, RecallQuery, RecallResult, RememberResult, ScopeSignature, SqlExec, SqlValue } from "funes-core/internal";
import { normalizeRelationType } from "funes-core";
import { CHUNK_SIG, embeddingSignature, LIBSQL_DIALECT, mayClaimIndex, ownerClaimRefused, SCHEMA_VERSIONS, slotTables, SqlIndex, TURSO_DIALECT, zoneOfFile } from "funes-core/internal";
import { acquireWriteLock, withScopedWriteLock, withWriteLock } from "../write-lock.ts";
import type { WriteLock } from "../write-lock.ts";
import type { ScopeExpectation } from "funes-core/internal";
import type { HotlistRow, FunesIndexStore, IndexStats } from "funes-core";
import type { IndexedPage, GraphArtifact, GraphAuditRows, GraphNode, GraphEdge, NeighborsResult, GuardedResult, ContentIdentity } from "funes-core/internal";

type DB = InstanceType<typeof Database>; // libsql's default export is a constructor + namespace

/** `db.transaction()` issues ROLLBACK after SQLite has already rolled the transaction back itself
 *  (SQLITE_FULL, IOERR), and its "cannot rollback - no transaction is active" then replaces the real
 *  cause (RAI-306 skeptic K2: a disk-full publish reported only the rollback error). */
function txn<T>(d: DB, fn: () => T): () => T {
  return () => {
    if (d.inTransaction) return d.transaction(fn)(); // nested: keep the savepoint path
    d.exec("BEGIN IMMEDIATE"); // a write transaction from its first statement (RAI-309 layer 4)
    try { const r = fn(); d.exec("COMMIT"); return r; }
    catch (e) { if (d.inTransaction) try { d.exec("ROLLBACK"); } catch { /* keep the first cause */ } throw e; }
  };
}

/** The module's exec port over one libsql handle. Args bind as ONE array (a lone BLOB argument
 *  aborts libsql); statements are prepared once per SQL string. */
export function libsqlExec(d: DB): SqlExec {
  const stmts = new Map<string, ReturnType<DB["prepare"]>>();
  const st = (sql: string) => { let s = stmts.get(sql); if (!s) { s = d.prepare(sql); stmts.set(sql, s); } return s; };
  const args = (a: readonly SqlValue[] | undefined) => (a ?? []) as unknown[];
  return {
    all: <T>(sql: string, a?: readonly SqlValue[]) => st(sql).all(args(a)) as T[],
    iterate: <T>(sql: string, a?: readonly SqlValue[]) => d.prepare(sql).iterate(args(a)) as Iterable<T>,
    run: (sql, a) => Number(st(sql).run(args(a)).changes ?? 0),
    tx: (fn) => txn(d, fn)(),
  };
}

// The graph-bake helpers (the forceAtlas2/louvain params below are load-bearing: they fix the layout).
const RELATION_FAMILIES: Record<string, string[]> = {
  structural: ["contains", "part-of", "instance-of", "has-instance", "subtype-of", "supertype-of", "implements", "implemented-by", "composed-of", "component-of"],
  dependency: ["depends-on", "dependency-of", "requires", "required-by", "uses", "used-by", "extends", "extended-by", "wraps", "wrapped-by"],
  epistemic: ["supports", "supported-by", "contradicts", "contradicted-by", "refines", "refined-by", "qualifies", "qualified-by", "derived-from", "source-of", "cites", "cited-by"],
  temporal: ["precedes", "succeeds", "supersedes", "superseded-by", "co-occurs-with", "valid-from", "valid-until", "observed-at"],
  causal: ["causes", "caused-by", "enables", "enabled-by", "blocks", "blocked-by", "triggers", "triggered-by", "solves", "solved-by", "competes-with", "complements"],
};
// N4 (2026-07-13, mirror of pglite): auto-derived types get explicit "structural" entries
// (status quo made deliberate); lookups normalize spelling — storage keeps authored strings.
// `references` joins them (2026-08-22, serena `mem:` extraction): a cross-reference between two
// memories is associative like `related-to`, not evidential like `cites`.
const TYPE_TO_FAMILY: Record<string, string> = { "related-to": "structural", mentions: "structural", references: "structural" };
for (const fam in RELATION_FAMILIES) for (const t of RELATION_FAMILIES[fam]!) TYPE_TO_FAMILY[t] = fam;
const familyOf = (type: string): string => TYPE_TO_FAMILY[normalizeRelationType(type)] ?? "structural";
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** The k nearest pages to one page, by chunk 0 (RAI-314 Q8): `id, title, path, trust, dist`. */
const KNN = `select n.id, n.title, n.path, n.trust, vector_distance_cos(c.embedding, (select embedding from chunks where page_id=? and ord=0)) as dist
  from nodes n join chunks c on c.page_id=n.id and c.ord=0 where n.id<>? and c.embedding is not null order by dist asc, n.id limit ?`;


// SQLite URI filename for mode=ro (the libsql binding ignores a `readonly` option — the URI is the
// only open-mode channel). %, ? and # would change the URI's meaning inside a path — encode them.
const roUri = (p: string): string => `file:${p.replace(/[%?#]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}?mode=ro`;
/** A raw `libsql` handle on an index file, for the CLI verbs that must read or edit `meta` WITHOUT
 *  `LibsqlStore.create` — which refuses the drifted or foreign index they exist to inspect. It runs
 *  under bun AND node; the `bun:sqlite` it replaces did not, and the npm CLI is a node program. */
export const openRawIndex = (dbPath: string, readonly: boolean, engine: Engine = "libsql"): DB =>
  engine === "turso" ? openTurso(dbPath) : new Database(readonly ? roUri(dbPath) : dbPath);
/** A star's index engine: its `memory.substrate`. */
export type Engine = "libsql" | "turso";
const DIALECTS = { libsql: LIBSQL_DIALECT, turso: TURSO_DIALECT } as const;

/** The Turso engine (RAI-312, RAI-314; pinned 0.8.3): its synchronous `/compat` handle, which has
 *  libsql's shape (`prepare`, `exec`, `inTransaction`, one-array binds), with the experimental `fts`
 *  index method on. WAL is its default journal mode; no MVCC and no `BEGIN CONCURRENT` in 0.6.0: one
 *  connection in one thread runs every transaction `BEGIN IMMEDIATE`, one at a time. The engine
 *  loads only when a Turso star opens. */
export function openTurso(dbPath: string): DB {
  const { Database: Turso } = createRequire(import.meta.url)("@tursodatabase/database/compat") as { Database: new (p: string, o: object) => DB };
  return new Turso(dbPath, { experimental: ["index_method"] });
}
// F3: a brief writer lock (a broker mid-remember, a publisher finalizing) makes a reader WAIT this
// long rather than surface SQLITE_BUSY as a 500 — set on BOTH RW and RO opens.
const BUSY_TIMEOUT_MS = 5_000;
const INDEX_SCHEMA = SCHEMA_VERSIONS.libsql;
/** The schema versions a READ-ONLY open serves (PLAN-0.3.0 rollout step 30, dual-read): the current
 *  one, plus "3" — the 0.2.x layout, which "4" fenced without changing a row. The read-write open
 *  accepts only the current one; see init(). Exact equality ships in 0.6.1 (RAI-314, plan B8). */
const READ_COMPAT_SCHEMA_VERSIONS: ReadonlySet<string> = new Set(["3", INDEX_SCHEMA]);

/** The tables derived from the vault: the in-place `--fresh` drops them and the module recreates
 *  them. `meta` and `recall_stats` are not derived: they survive a rebuild. */
const DERIVED = ["nodes", "edges", "chunks", "nodes_fts", "page_stat", "build_refs", "build_stat"] as const;
/** One meta value through a raw handle (`init` and the reset run before a store wraps the handle). */
const metaOf = (d: DB, key: string): string | undefined => (d.prepare("select value from meta where key=?").get(key) as { value: string } | undefined)?.value;
const EDGES_UNIQ = "create unique index if not exists edges_uniq on edges(source, type, target)";
const indexOn = (d: DB, embedder: Embedder, engine: Engine) => new SqlIndex({ exec: libsqlExec(d), dialect: DIALECTS[engine], embedder });

/** What the raw inspect of `reindex --fresh` read, before the owner claim (RAI-307 Q4 steps 2-3). */
export interface InspectedIndex { embeddingSignature: string | null; schemaVersion: string | null }

/** `reindex --fresh` steps 4-5 (RAI-307 Q4, RAI-309 Requirement 1): set `reindex_dirty`, DROP and
 *  CREATE the derived tables in `embedder`'s shape and restamp `embedding_signature` and
 *  `schema_version` — in ONE immediate transaction, in the same file. The recheck compares against
 *  what the raw inspect read, so a session that changed the index between the inspect and this
 *  transaction refuses it. In separate transactions, a session that opened between them would
 *  recreate the tables in its own shape and stamp its own signature (LibsqlStore.init). Keeps
 *  `owner_star_id` and `recall_stats`. The caller holds the star's write lock, from its first guard
 *  to finalize; nothing here deletes a file. */
export function resetIndexInPlace(dbPath: string, embedder: Embedder, inspected: InspectedIndex, engine: Engine = "libsql"): void {
  const d = openRawIndex(dbPath, false, engine);
  try {
    d.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS};`);
    txn(d, () => {
      const sig = metaOf(d, "embedding_signature") ?? null, sv = metaOf(d, "schema_version") ?? null;
      if (sig !== inspected.embeddingSignature || sv !== inspected.schemaVersion) {
        throw new Error(`funes: reindex --fresh: the index at ${dbPath} changed since this run's inspect (signature "${sig}", schema "${sv}") — another build ran; run \`funes reindex --fresh\` again`);
      }
      for (const t of DERIVED) d.exec(`drop table if exists ${t}`); // Turso's `nodes_fts` index goes with `nodes`
      const index = indexOn(d, embedder, engine);
      index.createTables();
      index.addColumns();
      d.exec(EDGES_UNIQ);
      index.setMeta("reindex_dirty", "1");
      index.setMeta("embedding_signature", `${embeddingSignature(embedder)}:${CHUNK_SIG}`);
      index.setMeta("schema_version", index.dialect.schemaVersion);
      index.setMeta("generation", null); // it named rows the drop removed
      index.setMeta("build_cursor", null); // a position in rows the drop removed
    })();
  } finally {
    d.close();
  }
}

export class LibsqlStore implements FunesIndexStore {
  // P3.15: explicit fields, not TS parameter properties — non-erasable syntax that Node's
  // type-stripping loader refuses (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX) for the whole module.
  private db: DB;
  private embedder: Embedder;
  private sig: string;
  private trackRecalls: boolean;
  private dataPath?: string;
  private ro: boolean;
  /** The one index module over this handle. */
  readonly index: SqlIndex;

  private constructor(db: DB, embedder: Embedder, trackRecalls: boolean, dataPath: string | undefined, ro: boolean, writeActor: string, engine: Engine = "libsql") {
    this.db = db;
    this.embedder = embedder;
    this.sig = `${embeddingSignature(embedder)}:${CHUNK_SIG}`;
    this.trackRecalls = trackRecalls;
    this.dataPath = dataPath;
    this.ro = ro;
    // provenance-v1 STAMPED actor: the authenticated write principal, set by the serving context —
    // never from the item payload/frontmatter. Legacy/local/unauthenticated writes stamp 'unknown'.
    this.index = new SqlIndex({ exec: libsqlExec(db), dialect: DIALECTS[engine], embedder, writeActor, recheck: !ro, where: dataPath ?? ":memory:" });
  }

  static async create(
    embedder: Embedder,
    dbPath?: string,
    opts: {
      allowDirty?: boolean; trackRecalls?: boolean; readonly?: boolean; writeActor?: string;
      /** The star's `memory.substrate` (default libsql). */
      engine?: Engine;
      /** A private build file no other process opens (publish's off-path build, RAI-309 Q2): it
       *  reports no `lockResource` and takes no write lock. */
      privateBuild?: boolean;
    } = {},
  ): Promise<LibsqlStore> {
    const engine = opts.engine ?? "libsql";
    if (engine === "turso" && opts.readonly) throw new Error("funes: a Turso index has no read-only open — it is served read-write by its one `funes serve`");
    if (opts.readonly) {
      // READ-ONLY open (canon host read face, 2026-07-16): SQLite mode=ro — NO WAL pragma, NO DDL, NO
      // meta writes, so an index on an RO mount opens cleanly (the RW path's journal_mode=WAL
      // header write is what crash-looped the read face). Validation-only init below; recall
      // telemetry is forced OFF (recordRecalls is a write). Published dbs are journal_mode=
      // DELETE (publish finalizes), so the open needs no -wal/-shm either.
      if (!dbPath || dbPath === ":memory:") {
        throw new Error("funes: a read-only open needs an existing index FILE (:memory: has nothing to read)");
      }
      let db: DB | undefined;
      try {
        db = new Database(roUri(dbPath));
        db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS};`); // F3: wait out a brief writer lock, don't 500 the reader
        db.prepare("select 1").get(); // libsql can defer open errors to the first statement
      } catch (e) {
        try { db?.close(); } catch { /* never really opened */ } // F9: a DEFERRED open error still left a handle — don't leak it
        throw new Error(
          `funes: cannot open index read-only at ${dbPath} — ${(e as Error).message}. ` +
          "No index is built/published there (or the mount hides it): run `funes reindex`/`funes publish` on the WRITER side first.",
        );
      }
      const s = new LibsqlStore(db!, embedder, false, dbPath, true, "unknown");
      try {
        s.validateReadonly(dbPath);
      } catch (e) {
        db!.close(); // F9: a failed validation must not leak the opened native handle (a read face
        throw e;     //     retry-looping on a bad mount would otherwise exhaust fds)
      }
      return s;
    }
    if (dbPath && dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    // F3: WAL is a NEW-db pragma only. Opening an existing finalized (DELETE-journal) published
    // generation RW must leave its journal mode untouched — flipping it back to WAL recreates the
    // -shm sidecar and races the mode=ro readers (SQLITE_BUSY). A brand-new index still gets WAL.
    const isNewDb = !dbPath || dbPath === ":memory:" || !existsSync(dbPath);
    let db: DB;
    try {
      db = engine === "turso" ? openTurso(dbPath ?? ":memory:") : new Database(dbPath ?? ":memory:");
    } catch (e) {
      // Turso cannot read a libsql index (`using fts5`), and a second process meets its file lock
      throw new Error(`funes: cannot open the ${engine} index at ${dbPath ?? ":memory:"} — ${(e as Error).message}. ` +
        "If its star changed memory.substrate, run `funes reindex --fresh` on a moved-aside file; if another funes process holds it, stop that process.");
    }
    if (dbPath && dbPath !== ":memory:") {
      db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS};`); // F3: same reader-friendly wait as the RO path
      if (isNewDb) db.exec("PRAGMA journal_mode=WAL;"); // multi-process safe (local FS) — new dbs only
    }
    const s = new LibsqlStore(db, embedder, opts.trackRecalls ?? false, dbPath, false, opts.writeActor ?? "unknown", engine);
    s.privateBuild = opts.privateBuild === true;
    try {
      s.init(opts.allowDirty ?? false);
    } catch (e) {
      // F9's rule, on the WRITER path too: a refused open must not leak the native handle. The
      // schema fence made a read-write refusal a ROLLOUT event (a broker resolving per op against a
      // not-yet-rebuilt "3" home), and a leaked fd per retry is how that becomes an outage.
      db.close();
      throw e;
    }
    return s;
  }

  /** RO-open validation (zero writes): the file must BE a funes index (meta table), carry a
   *  readable embedding signature matching this embedder, and not be a crashed half-build. LOUD
   *  failures — a misconfigured read face must say exactly what is wrong AT STARTUP, not 500 later. */
  private validateReadonly(dbPath: string): void {
    const d = this.db;
    if (!d.prepare("select name from sqlite_master where type='table' and name='meta'").get()) {
      throw new Error(`funes: ${dbPath} is not a funes index (no meta table) — point the read face at a built/published index db`);
    }
    // F9: the meta table alone is not an index — assert the core OPERATIONAL tables exist too, so a
    // malformed/partial db (a half-built or hand-broken schema) fails LOUDLY at open, not with an
    // opaque SQL error on the first recall. (nodes_fts is an fts5 virtual table — it still shows in
    // sqlite_master by name.)
    for (const t of ["nodes", "edges", "chunks", "nodes_fts"]) {
      if (!d.prepare("select name from sqlite_master where name=?").get(t)) {
        throw new Error(`funes: index at ${dbPath} is missing the "${t}" table — a malformed/partial index; rebuild it on the WRITER side before serving read-only`);
      }
    }
    const stored = (d.prepare("select value from meta where key='embedding_signature'").get() as { value: string } | undefined)?.value;
    // RAI-307 Q4: one remedy per refusal. A read-only opener is never the index's builder.
    const rebuild = "rebuild it on its writer (`funes publish` there)";
    if (!stored) throw new Error(`funes: index at ${dbPath} carries no embedding signature — ${rebuild}.`);
    if (stored !== this.sig) {
      throw new Error(
        `funes: embedding drift — index at ${dbPath} built with "${stored}" but embedder is "${this.sig}". Refusing it: ${rebuild}, or bring funes on this locus to the build that signs "${stored}".`,
      );
    }
    // DUAL-READ (PLAN-0.3.0 rollout step 30): a v4 reader serves a "3" artefact as well as a "4" one,
    // because "4" changed no row layout — it is the version fence (R2#2) — and the readers are
    // deployed everywhere BEFORE any home is rebuilt, so a read face on a not-yet-rebuilt
    // home must keep serving. Anything else is refused: pre-2 has a different fts shape, and a
    // version this build has never seen is a newer build's artefact.
    const sv = (d.prepare("select value from meta where key='schema_version'").get() as { value: string } | undefined)?.value;
    if (sv == null || !READ_COMPAT_SCHEMA_VERSIONS.has(sv)) {
      throw new Error(`funes: index at ${dbPath} has schema_version "${sv ?? "1(pre-versioning)"}" != "${INDEX_SCHEMA}". Refusing it: ${rebuild}, or bring funes on this locus to the build that signs "${stored}".`);
    }
    const dirty = (d.prepare("select value from meta where key='reindex_dirty'").get() as { value: string } | undefined)?.value;
    if (dirty === "1") {
      throw new Error(`funes: index at ${dbPath} is dirty (an interrupted full reindex) — ${rebuild}.`);
    }
  }

  /** Defense in depth UNDER the face's op allowlist: an RO handle refuses writes with a clear
   *  message instead of surfacing SQLite's raw SQLITE_READONLY mid-transaction. */
  private assertWritable(): void {
    if (this.ro) throw new Error("funes: this store handle is READ-ONLY (mode=ro) — writes are refused (the read face never mutates the index)");
  }

  get recallTracking(): boolean { return this.trackRecalls; }

  // ── the write lock: every write and the whole build take the star's cross-process lock (reentrant
  // per process). :memory: stores skip it. recordRecalls (hit-count telemetry on the read path) is
  // deliberately UNLOCKED: a benign counter, and locking reads would thrash. ──
  private reindexLock?: WriteLock;
  private privateBuild = false;
  /** RAI-309 Q2: the live read-write index of a star reports its path, which is `funesDbDir(vault)`
   *  (makeStore refuses any other read-write path for a vault); a private build or `:memory:`, null. */
  get lockResource(): string | null {
    return this.dataPath && this.dataPath !== ":memory:" && !this.privateBuild ? this.dataPath : null;
  }
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    this.assertWritable(); // RO handles refuse every structural write, before any lock
    const res = this.lockResource;
    // The module rechecks inside each write transaction; this one names the remedy before a read of
    // a rebuilt table can fail on its new shape.
    const run = () => { this.index.recheck(); return fn(); };
    return res ? withWriteLock(res, run) : run();
  }

  private init(allowDirty: boolean): void {
    const d = this.db;
    this.index.createTables();
    if (this.trackRecalls) {
      d.exec(`create table if not exists recall_stats(
        memory_id text primary key, hit_count integer not null default 0, last_recalled text);`);
    }
    // embedding drift guard (H1): a DIFFERENT stored signature is a hard stop; absent is grandfathered.
    // Both refusals below end "Rebuild it: `funes reindex --fresh`.": walk-locus.sh runs --fresh on that string only.
    const stored = metaOf(d, "embedding_signature");
    if (stored && stored !== this.sig) {
      throw new Error(
        `funes: embedding drift — index at ${this.dataPath ?? ":memory:"} built with "${stored}" but embedder is "${this.sig}". Rebuild it: \`funes reindex --fresh\`.`,
      );
    }
    // Schema-version FENCE (PLAN-0.3.0 R2#2). A FRESH index (no embedding sig yet) stamps the current
    // version. A BUILT index is opened read-write ONLY at exactly the current version; the refusal
    // names the rebuild. `if not exists` above never touches an existing table, so a refused open has
    // mutated nothing.
    const storedSchema = metaOf(d, "schema_version");
    const schema = this.index.dialect.schemaVersion;
    if (!stored) {
      this.index.setMeta("embedding_signature", this.sig);
      this.index.setMeta("schema_version", schema); // fresh index
    } else if (storedSchema !== schema) {
      throw new Error(
        `funes: index schema_version "${storedSchema ?? "pre-2"}" != "${schema}" at ${this.dataPath} — this build does not migrate in place (the version is a fence, PLAN-0.3.0 R2#2). ` +
        "Rebuild it: `funes reindex --fresh`.",
      );
    }
    // H2 dirty-marker: an interrupted full reindex refuses normal opens.
    if (metaOf(d, "reindex_dirty") === "1" && !allowDirty) {
      throw new Error("funes: index is dirty (an earlier full reindex was interrupted) — run `funes reindex` to rebuild before querying.");
    }
    // The additive columns at "4" — AFTER the signature + dirty guards, so a rejected or dirty open
    // never gets a schema mutation; idempotent via pragma; columns populate on the next reindex.
    const cols = new Set((d.prepare("pragma table_info(nodes)").all() as { name: string }[]).map((r) => r.name));
    for (const [c, ddl] of [["description", "text"], ["resource", "text"], ["source", "text"], ["authored", "real"],
      ["write_actor", "text not null default 'unknown'"], ["frontmatter", "text"]] as const) {
      if (!cols.has(c)) d.exec(`alter table nodes add column ${c} ${ddl}`);
    }
    this.index.addColumns();
    // N1/N3: dedup existing edge rows, then enforce uniqueness on (source,type,target).
    d.exec("delete from edges where rowid not in (select min(rowid) from edges group by source, type, target)");
    d.exec(EDGES_UNIQ);
  }

  // ── the build ────────────────────────────────────────────────────────────────────────────────
  /** RAI-314: the one walk over this index, under the star's write lock for the whole run (RAI-309),
   *  so no mutation enters between begin and finalize. A private build or `:memory:` takes none. */
  async build(input: BuildInput): Promise<BuildResult> {
    this.assertWritable();
    const res = this.lockResource;
    const run = () => this.index.build(input);
    return res ? withScopedWriteLock(res, run) : run();
  }

  /** Mark the index dirty and hold the write lock until `finalizeReindex` (an operator fixture; the
   *  walk begins its own build). */
  async beginReindex(): Promise<void> {
    this.assertWritable();
    const res = this.lockResource;
    if (res) this.reindexLock = await acquireWriteLock(res); // held until finalizeReindex (or close-belt)
    try {
      this.index.x.tx(() => { this.index.recheck(); this.index.setMeta("reindex_dirty", "1"); });
    } catch (e) {
      this.reindexLock?.release();
      this.reindexLock = undefined;
      throw e;
    }
  }
  /** PLAN-0.3.0 item 12 — the stamps of a completed build in ONE transaction (the walk's finalize
   *  writes the same keys). The lock is released AFTER the commit, never inside it. */
  async finalizeReindex(f: FinalizeReindex): Promise<void> {
    this.assertWritable(); // F7: RO handles refuse every mutating entry point
    this.index.stamp(f);
    this.reindexLock?.release();
    this.reindexLock = undefined;
  }

  // ── writes ───────────────────────────────────────────────────────────────────────────────────
  async remember(items: MemoryItem[], swaps: PageSwap[] = []): Promise<RememberResult> {
    if (items.length === 0 && swaps.length === 0) return { indexed: 0, skipped: 0 };
    return this.locked(() => this.index.remember(items, swaps));
  }
  async remove(ids: string[], swaps: PageSwap[] = []): Promise<number> {
    if (ids.length === 0 && swaps.length === 0) return 0;
    return this.locked(() => this.index.remove(ids, swaps));
  }

  // ── reads ────────────────────────────────────────────────────────────────────────────────────
  async recall(q: RecallQuery): Promise<RecallResult[]> {
    return this.recordRecalls(await this.index.recall(q));
  }

  /** R8: advisory hit counters, after the module stamped the ranks. */
  private async recordRecalls(results: RecallResult[]): Promise<RecallResult[]> {
    if (this.trackRecalls && results.length) {
      const now = new Date().toISOString();
      const up = this.db.prepare("insert into recall_stats(memory_id,hit_count,last_recalled) values (?,1,?) on conflict(memory_id) do update set hit_count=hit_count+1, last_recalled=excluded.last_recalled");
      txn(this.db, () => { for (const r of results) up.run(r.id, now); })();
    }
    return results;
  }

  async stats(): Promise<IndexStats> { return this.index.statsSync(); }
  async lastReindexAt(): Promise<string | null> { return this.index.meta("last_reindex_at"); }
  async pageStats(): Promise<PageStatRecord | null> { return this.index.pageStats(); }
  async indexedPage(ref: { id?: string; path?: string }): Promise<IndexedPage | null> { return this.index.indexedPage(ref); }
  async contentIdentity(): Promise<ContentIdentity> { return this.index.contentIdentity(); }
  async guardedRead<T>(expected: () => ScopeExpectation, retrieve: () => Promise<T>): Promise<GuardedResult<T>> { return this.index.guardedRead(expected, retrieve); }
  /** RAI-307: the backend and the ranking version, as one readable string. */
  servingSignature(): string { return this.index.servingSignature(); }

  /** Step 24: the raw audit rows. No join to nodes and no type normalization — both would erase
   *  exactly what the audit exists to count. */
  async auditGraph(): Promise<GraphAuditRows> {
    const d = this.db;
    const nodeIds = (d.prepare("select id from nodes").all() as { id: string }[]).map((r) => r.id);
    const edges = d.prepare("select source,type,target from edges").all() as { source: string; type: string; target: string }[];
    return { nodeIds, edges };
  }

  /** The owning star's identity, INSIDE the db (meta key `owner_star_id`): a compare-and-set
   *  (RAI-157), the read and the write one transaction. Every full build stamps it the same way. */
  async setOwnerStarId(starId: string, opts: { was?: string | null } = {}): Promise<void> {
    this.assertWritable(); // F7
    this.index.x.tx(() => {
      const stamped = this.index.meta("owner_star_id");
      if (!mayClaimIndex(stamped, starId, opts.was)) throw ownerClaimRefused(stamped!, starId);
      this.index.setMeta("owner_star_id", starId);
    });
  }
  async getOwnerStarId(): Promise<string | null> { return this.index.meta("owner_star_id"); }

  /** The index_scope signature (closure sprint 3B), meta `index_scope_hash` + `index_scope_ignored`. */
  async setScopeSignature(sig: ScopeSignature): Promise<void> {
    this.assertWritable(); // F7
    this.index.setMeta("index_scope_hash", sig.hash);
    this.index.setMeta("index_scope_ignored", sig.ignoreScope ? "1" : "0");
  }
  /** H2: invalidate the persisted signature, so cross-star reads fail closed. */
  async clearScopeSignature(): Promise<void> {
    this.assertWritable(); // F7
    this.index.setMeta("index_scope_hash", null);
    this.index.setMeta("index_scope_ignored", null);
  }
  async getScopeSignature(): Promise<ScopeSignature | null> { return this.index.scopeSignature(); }

  /** Publisher-side finalization: wal_checkpoint(TRUNCATE) + journal_mode=DELETE on THIS handle, so
   *  the published db is consumable from a READ-ONLY mount with zero -wal/-shm sidecars. */
  async finalizeForPublish(): Promise<void> {
    this.assertWritable();
    if (this.index.dialect.backend === "turso") throw new Error("funes: a Turso index is never published — Turso keeps no DELETE journal mode; its `funes serve` serves the live index");
    if (!this.dataPath || this.dataPath === ":memory:") return; // nothing on disk to finalize
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    const r = this.db.prepare("PRAGMA journal_mode=DELETE;").get() as { journal_mode: string };
    if (r.journal_mode !== "delete") {
      throw new Error(`funes: publish finalization failed — journal_mode is "${r.journal_mode}", expected "delete" (is another handle open on ${this.dataPath}?)`);
    }
  }

  async close(): Promise<void> {
    this.reindexLock?.release(); // belt: an aborted begin→end window must not leave the star locked
    this.reindexLock = undefined;
    this.db.close();
  }

  /** Semantic + typed neighbourhood of one node (the graph-explorer / inspector data source): EXACT
   *  cosine kNN over each page's chunk 0 (RAI-314 Q8: the module never writes nodes.embedding) +
   *  frontmatter edges both ways. */
  async neighbors(id: string, k = 8): Promise<NeighborsResult> {
    const d = this.db;
    const self = d.prepare("select id,title,path,trust,type from nodes where id=?").get(id) as { id: string; title: string; path: string | null; trust: string; type: string | null } | undefined;
    if (!self) return { node: null, similar: [], edgesOut: [], edgesIn: [] };
    const knn = d.prepare(KNN).all(id, id, k) as { id: string; title: string; path: string | null; trust: string; dist: number }[];
    const eo = d.prepare("select e.type as type, e.target as target, n.title as title, n.trust as trust from edges e left join nodes n on n.id=e.target where e.source=?").all(id) as { type: string; target: string; title: string | null; trust: string | null }[];
    const ei = d.prepare("select e.type as type, e.source as source, n.title as title, n.trust as trust from edges e left join nodes n on n.id=e.source where e.target=?").all(id) as { type: string; source: string; title: string | null; trust: string | null }[];
    return {
      node: { id: self.id, title: self.title, path: self.path ?? undefined, trust: self.trust, type: self.type ?? undefined },
      similar: knn.map((r) => ({ id: r.id, title: r.title, path: r.path ?? undefined, trust: r.trust, score: Math.round((1 - r.dist) * 1000) / 1000 })),
      edgesOut: eo.map((r) => ({ type: r.type, id: r.target, title: r.title, trust: r.trust ?? undefined })),
      edgesIn: ei.map((r) => ({ type: r.type, id: r.source, title: r.title, trust: r.trust ?? undefined })),
    };
  }

  /** R8 hotlist — top-N most-recalled TRUSTED pages. [] when telemetry was never enabled. */
  async hotlist(n = 20): Promise<HotlistRow[]> {
    const d = this.db;
    const has = d.prepare("select name from sqlite_master where type='table' and name='recall_stats'").get();
    if (!has) return [];
    const rows = d.prepare(
      `select n.id as id, n.title as title, n.path as path, n.trust as trust, s.hit_count as hit_count, s.last_recalled as last_recalled
         from recall_stats s join nodes n on n.id=s.memory_id
        where n.trust='trusted'
        order by s.hit_count desc, s.last_recalled desc, n.id asc limit ?`,
    ).all(n) as { id: string; title: string; path: string | null; trust: string; hit_count: number; last_recalled: string | null }[];
    return rows.map((r) => ({ id: r.id, title: r.title, path: r.path ?? undefined, trust: r.trust, hit_count: Number(r.hit_count), last_recalled: r.last_recalled }));
  }

  /** Constellation bake — forceAtlas2 + seeded Louvain + degree, IDENTICAL params to pglite so
   *  layouts match. Similarity edges (P1b parity) connect the wikilink-less islands: per-node exact
   *  top-k cosine above a cutoff (SQLite has no LATERAL → a loop reusing the proven subquery-embedding
   *  form). They feed layout/community but NOT god-node degree. Cached on a content fingerprint. */
  async graph(opts: { iterations?: number; simTopK?: number; simCutoff?: number } = {}): Promise<GraphArtifact> {
    const d = this.db;
    const simTopK = opts.simTopK ?? 6;       // neighbours per node before the cutoff filter
    const simCutoff = opts.simCutoff ?? 0.8; // cosine floor (matches pglite)
    const fpRows = d.prepare("select content_hash from nodes order by id").all() as { content_hash: string | null }[];
    const fp = createHash("md5").update(fpRows.map((r) => r.content_hash ?? "").join(",")).digest("hex");
    const signature = `${this.sig}:${this.index.dialect.backend}:${fpRows.length}:${fp}:sim${simTopK}@${simCutoff}`;
    const artifactPath = this.dataPath && this.dataPath !== ":memory:" ? join(dirname(this.dataPath), "graph.json") : undefined;
    if (artifactPath && existsSync(artifactPath)) {
      try { const cached = JSON.parse(readFileSync(artifactPath, "utf8")) as GraphArtifact; if (cached.signature === signature) return cached; } catch { /* corrupt -> rebuild */ }
    }

    const nodeRows = d.prepare("select id,title,path,type,trust from nodes").all() as { id: string; title: string; path: string | null; type: string | null; trust: string }[];
    const edgeRows = d.prepare("select source,type,target,weight from edges").all() as { source: string; type: string; target: string; weight: number }[];
    const hits = new Map<string, number>();
    if (d.prepare("select name from sqlite_master where type='table' and name='recall_stats'").get()) {
      for (const r of d.prepare("select memory_id, hit_count from recall_stats").all() as { memory_id: string; hit_count: number }[]) hits.set(r.memory_id, Number(r.hit_count));
    }

    const g = new Graph({ type: "undirected" });
    for (const n of nodeRows) g.addNode(n.id);
    const typedEdges: GraphEdge[] = [];
    for (const e of edgeRows) {
      if (!g.hasNode(e.source) || !g.hasNode(e.target)) continue;
      if (!g.hasEdge(e.source, e.target)) g.addEdge(e.source, e.target, { weight: e.weight ?? 1 });
      typedEdges.push({ source: e.source, target: e.target, type: e.type, family: familyOf(e.type), weight: e.weight ?? 1 });
    }
    const typedDeg = new Map<string, number>();
    g.forEachNode((id) => typedDeg.set(id, g.degree(id)));

    // P1b parity: thresholded similarity edges. Per-node exact top-k cosine (chunk 0 of each
    // page, as neighbors() reads it); SQLite has no LATERAL so we loop. De-dup undirected;
    // skip pairs a typed edge already connects. Added to g so the islands get a layout home + a
    // community; emitted family "similarity". Degree (god-nodes) stays TYPED-only (captured above).
    const simEdges: GraphEdge[] = [];
    if (simTopK > 0 && g.order > 1) {
      const knn = d.prepare(KNN);
      const seenSim = new Set<string>();
      for (const n of nodeRows) {
        for (const r of knn.all(n.id, n.id, simTopK) as { id: string; dist: number }[]) {
          const sim = 1 - r.dist;
          if (sim < simCutoff || !g.hasNode(r.id)) continue;
          const key = n.id < r.id ? `${n.id} ${r.id}` : `${r.id} ${n.id}`;
          if (seenSim.has(key)) continue;
          seenSim.add(key);
          if (g.hasEdge(n.id, r.id)) continue; // already a typed edge between them
          g.addEdge(n.id, r.id, { weight: sim });
          simEdges.push({ source: n.id, target: r.id, type: "similar-to", family: "similarity", weight: Math.round(sim * 1000) / 1000 });
        }
      }
    }
    if (g.order > 0) {
      circular.assign(g);
      if (g.size > 0) {
        forceAtlas2.assign(g, { iterations: opts.iterations ?? (g.order > 2000 ? 150 : 300), settings: { ...forceAtlas2.inferSettings(g), barnesHutOptimize: g.order > 500 } });
        louvain.assign(g, { rng: seededRng(42) } as Parameters<typeof louvain.assign>[1]);
      }
    }
    const commSize = new Map<number, number>();
    g.forEachNode((_id, a) => { const c = (a.community as number) ?? 0; commSize.set(c, (commSize.get(c) ?? 0) + 1); });
    const rank = new Map([...commSize.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([c], i) => [c, i] as const));

    const nodes: GraphNode[] = nodeRows.map((n) => {
      const a = g.getNodeAttributes(n.id);
      return {
        id: n.id, label: (n.title || n.id).slice(0, 48),
        x: typeof a.x === "number" ? a.x : 0, y: typeof a.y === "number" ? a.y : 0,
        community: rank.get((a.community as number) ?? 0) ?? 0, degree: typedDeg.get(n.id) ?? 0,
        zone: zoneOfFile(n.path ?? `${n.id}.md`), type: n.type ?? null, trust: n.trust, hit_count: hits.get(n.id) ?? 0,
      };
    });
    const artifact: GraphArtifact = {
      signature, builtAt: new Date().toISOString(),
      stats: { nodes: nodes.length, edges: typedEdges.length, simEdges: simEdges.length, communities: rank.size },
      nodes, edges: [...typedEdges, ...simEdges],
    };
    // Temp + rename (RAI-309): a reader never sees a half-written graph.json.
    if (artifactPath) { try { const tmp = `${artifactPath}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(artifact)); renameSync(tmp, artifactPath); } catch { /* read-only fs -> serve uncached */ } }
    return artifact;
  }
}
