// LibsqlStore — a funes-core Store on libSQL (native vector + FTS5), the FUNES_BACKEND=libsql
// alternative to funes-engine. Same recall contract (FTS + chunked-vector + edge-walk -> RRF ->
// trust-weight -> dup-collapse -> recency-tiebreak -> optional rerank); the ONLY differences from
// PGLite are the query arms: FTS5+bm25 (unicode61, so RU rides FTS too — a pglite ASCII-tsvector
// gap) and exact vector_distance_cos over chunks (DiskANN ANN is a later optimisation; exact is
// sub-10ms at this scale). libsql is SYNCHRONOUS (better-sqlite3 API); methods stay async only for
// the embedder. The DB is a single FILE — WAL gives multi-process safety (the structural fix for
// PGLite's single-connection corruption). graph()/neighbors()/hotlist() are FULLY implemented
// (parity with pglite — the earlier "step-2b stubs" note here outlived the code; fixed 2026-07-13).
import Database from "libsql";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Graph from "graphology";
import { circular } from "graphology-layout";
import forceAtlas2 from "graphology-layout-forceatlas2";
import louvain from "graphology-communities-louvain";
import type { Embedder, MemoryItem, RecallQuery, RecallResult, RememberResult, ScopeSignature, Trust } from "funes-core";
import { rrf, rrfScores, DEFAULT_RRF_K, resolveGraphArm, embeddingSignature, normalizeRelationType, buildGraphArm, GRAPH_ARM_CAP_OUT, GRAPH_ARM_CAP_IN, GRAPH_ARM_HUB_MAX } from "funes-core";
import type { GraphNeighborRow } from "funes-core";
import { acquireWriteLock, withWriteLock } from "funes-shared";
import type { WriteLock } from "funes-shared";
import { CHUNK_SIG, chunkText } from "funes-core";
import { INDEX_SCHEMA_VERSION } from "funes-shared";

// P2.10: fts5 bm25 column weights over (nid, title, description, body). fts5 bm25() is lower=better,
// and a higher weight makes matches in that column dominate the score — so a query term that hits a
// page's TITLE ranks it above pages that merely mention the term in the body. The FTS arm feeds RRF
// by RANK, so these weights reshape the FTS ordering that RRF then fuses. FROZEN-ish (versioned vs
// the recall golden). The libSQL analogue of the pglite setweight(title 'A') fix (ab95b13).
const BM25_TITLE_WEIGHT = 10.0;
const BM25_DESC_WEIGHT = 3.0;
const BM25_BODY_WEIGHT = 1.0;
import { zoneOfFile } from "funes-shared";
import { guardRefusal } from "funes-core";
import type { Reranker } from "funes-core";
import type { HotlistRow, IndexedPage, GraphArtifact, GraphNode, GraphEdge, NeighborsResult, GuardedResult, FunesIndexStore } from "funes-core";
import {
  hashItem, isVolatile, freshnessEpoch, authoredEpoch, RRF_TIE_EPS, recencyTiebreak, trustAdjust, zoneAdjust, entityAdjust, collapseDuplicates,
} from "./ranking.ts";

type DB = InstanceType<typeof Database>; // libsql's default export is a constructor + namespace

// MIRROR of funes-engine/src/store.ts graph-bake helpers — kept in sync so both backends lay out
// constellations identically (the forceAtlas2/louvain params below are load-bearing for that).
const RELATION_FAMILIES: Record<string, string[]> = {
  structural: ["contains", "part-of", "instance-of", "has-instance", "subtype-of", "supertype-of", "implements", "implemented-by", "composed-of", "component-of"],
  dependency: ["depends-on", "dependency-of", "requires", "required-by", "uses", "used-by", "extends", "extended-by", "wraps", "wrapped-by"],
  epistemic: ["supports", "supported-by", "contradicts", "contradicted-by", "refines", "refined-by", "qualifies", "qualified-by", "derived-from", "source-of", "cites", "cited-by"],
  temporal: ["precedes", "succeeds", "supersedes", "superseded-by", "co-occurs-with", "valid-from", "valid-until", "observed-at"],
  causal: ["causes", "caused-by", "enables", "enabled-by", "blocks", "blocked-by", "triggers", "triggered-by", "solves", "solved-by", "competes-with", "complements"],
};
// N4 (2026-07-13, mirror of pglite): auto-derived types get explicit "structural" entries
// (status quo made deliberate); lookups normalize spelling — storage keeps authored strings.
const TYPE_TO_FAMILY: Record<string, string> = { "related-to": "structural", mentions: "structural" };
for (const fam in RELATION_FAMILIES) for (const t of RELATION_FAMILIES[fam]!) TYPE_TO_FAMILY[t] = fam;
const familyOf = (type: string): string => TYPE_TO_FAMILY[normalizeRelationType(type)] ?? "structural";
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Unicode-aware word tokens (\p{L}\p{N}) — matches the FTS5 unicode61 tokenizer, so RU/EN both feed
// the FTS arm. (PGLite's WORD is ASCII-only; this is the intended RU-recall improvement.)
const WORD = /[\p{L}\p{N}]+/gu;
const vlit = (v: Float32Array | number[]) => "[" + Array.from(v).join(",") + "]";
const ph = (n: number) => Array(n).fill("?").join(",");

// SQLite URI filename for mode=ro (the libsql binding ignores a `readonly` option — the URI is the
// only open-mode channel). %, ? and # would change the URI's meaning inside a path — encode them.
const roUri = (p: string): string => `file:${p.replace(/[%?#]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}?mode=ro`;
// F3: a brief writer lock (a broker mid-remember, a publisher finalizing) makes a reader WAIT this
// long rather than surface SQLITE_BUSY as a 500 — set on BOTH RW and RO opens.
const BUSY_TIMEOUT_MS = 5_000;

export class LibsqlStore implements FunesIndexStore {
  // P3.15: explicit fields, not TS parameter properties — non-erasable syntax that Node's
  // type-stripping loader refuses (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX) for the whole module.
  private db: DB;
  private embedder: Embedder;
  private sig: string;
  private reranker?: Reranker;
  private trackRecalls: boolean;
  private dataPath?: string;
  private ro: boolean;
  // provenance-v1 STAMPED actor: the authenticated write principal, set by the serving context —
  // never from the item payload/frontmatter. Legacy/local/unauthenticated writes stamp 'unknown'.
  private writeActor: string;

  private constructor(
    db: DB,
    embedder: Embedder,
    sig: string,
    reranker?: Reranker,
    trackRecalls = false,
    dataPath?: string,
    ro = false,
    writeActor = "unknown",
  ) {
    this.db = db;
    this.embedder = embedder;
    this.sig = sig;
    this.reranker = reranker;
    this.trackRecalls = trackRecalls;
    this.dataPath = dataPath;
    this.ro = ro;
    this.writeActor = writeActor;
  }

  static async create(
    embedder: Embedder,
    dbPath?: string,
    opts: { allowDirty?: boolean; reranker?: Reranker; trackRecalls?: boolean; readonly?: boolean; writeActor?: string } = {},
  ): Promise<LibsqlStore> {
    if (opts.readonly) {
      // READ-ONLY open (canon host read face, 2026-07-16): SQLite mode=ro — NO WAL pragma, NO DDL, NO
      // meta writes, so an index on an RO mount opens cleanly (the RW path's journal_mode=WAL
      // header write is what crash-looped the read face). Validation-only init below; recall
      // telemetry is forced OFF (recordRecalls is a write). Published gen dbs are journal_mode=
      // DELETE (publishReindex finalizes), so the open needs no -wal/-shm either.
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
      const s = new LibsqlStore(db!, embedder, `${embeddingSignature(embedder)}:${CHUNK_SIG}`, opts.reranker, false, dbPath, true);
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
    const db = new Database(dbPath ?? ":memory:");
    if (dbPath && dbPath !== ":memory:") {
      db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS};`); // F3: same reader-friendly wait as the RO path
      if (isNewDb) db.exec("PRAGMA journal_mode=WAL;"); // multi-process safe (local FS) — new dbs only
    }
    const s = new LibsqlStore(db, embedder, `${embeddingSignature(embedder)}:${CHUNK_SIG}`, opts.reranker, opts.trackRecalls ?? false, dbPath, false, opts.writeActor ?? "unknown");
    s.init(opts.allowDirty ?? false);
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
    if (!stored) throw new Error(`funes: index at ${dbPath} carries no embedding signature — rebuild it before serving read-only`);
    if (stored !== this.sig) {
      throw new Error(
        `funes: embedding drift — index built with "${stored}" but embedder is "${this.sig}". Delete the index (its .funes dir) and reindex.`,
      );
    }
    // P2.10: a RO handle can't migrate the fts schema — refuse an old/unknown one loudly (the writer
    // side migrates on its next open; publish a fresh generation for a served read home).
    const sv = (d.prepare("select value from meta where key='schema_version'").get() as { value: string } | undefined)?.value;
    if (sv !== INDEX_SCHEMA_VERSION) {
      throw new Error(`funes: index at ${dbPath} has schema_version "${sv ?? "1(pre-versioning)"}" != "${INDEX_SCHEMA_VERSION}" — rebuild/publish it on the WRITER side before serving read-only.`);
    }
    const dirty = (d.prepare("select value from meta where key='reindex_dirty'").get() as { value: string } | undefined)?.value;
    if (dirty === "1") {
      throw new Error(`funes: index at ${dbPath} is dirty (an interrupted full reindex) — run \`funes reindex\` on the WRITER side before serving it.`);
    }
  }

  /** Defense in depth UNDER the face's op allowlist: an RO handle refuses writes with a clear
   *  message instead of surfacing SQLite's raw SQLITE_READONLY mid-transaction. Guards locked()
   *  (remember/remove/prune) + beginReindex — the real write entrypoints. */
  private assertWritable(): void {
    if (this.ro) throw new Error("funes: this store handle is READ-ONLY (mode=ro) — writes are refused (the read face never mutates the index)");
  }

  get recallTracking(): boolean { return this.trackRecalls; }

  // ── write mutex (slice 4): every STRUCTURAL write takes the cross-process per-index lock; a
  // reindex holds it across begin→remember→prune→end (reentrant per process). :memory: stores
  // skip locking — nothing to protect across processes. recordRecalls (hit-count telemetry on
  // the read path) is deliberately UNLOCKED: a benign counter, and locking reads would thrash. ──
  private reindexLock?: WriteLock;
  get lockResource(): string | null {
    return this.dataPath && this.dataPath !== ":memory:" ? this.dataPath : null;
  }
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    this.assertWritable(); // RO handles refuse every structural write, before any lock
    const res = this.lockResource;
    return res ? withWriteLock(res, fn) : fn();
  }

  /** P2.10: rebuild the fts5 table as the weighted 4-column schema, repopulated from the `nodes`
   *  table (which already carries title/description/body) — so a pre-2 index migrates WITHOUT
   *  re-embedding. Idempotent enough: it drops + recreates + refills in one exec. */
  private migrateFtsToV2(): void {
    this.db.exec(`
      drop table if exists nodes_fts;
      create virtual table nodes_fts using fts5(nid unindexed, title, description, body, tokenize='unicode61');
      insert into nodes_fts(nid,title,description,body)
        select id, title, coalesce(description,''), body from nodes;
    `);
  }

  private init(allowDirty: boolean): void {
    const d = this.db;
    d.exec(`
      create table if not exists meta(key text primary key, value text);
      create table if not exists nodes(
        id text primary key, path text, title text, type text, body text,
        content_hash text, embedding_signature text,
        trust text not null default 'untrusted',
        volatile integer not null default 0,
        freshness real,                       -- epoch seconds, or null
        description text, resource text,      -- OKF-aligned enrichment (2026-07)
        source text, authored real,           -- provenance-v1 DECLARED (2026-07-22): origin + authoring epoch
        write_actor text not null default 'unknown', -- provenance-v1 STAMPED: never from frontmatter
        embedding F32_BLOB(${this.embedder.dim})
      );
      create table if not exists edges(source text, type text, target text, weight real default 1.0);
      create index if not exists edges_source on edges(source);
      create index if not exists edges_target on edges(target);
      create table if not exists chunks(
        page_id text not null, ord integer not null, embedding F32_BLOB(${this.embedder.dim}),
        primary key(page_id, ord));
      create virtual table if not exists nodes_fts using fts5(nid unindexed, title, description, body, tokenize='unicode61');
    `);
    if (this.trackRecalls) {
      d.exec(`create table if not exists recall_stats(
        memory_id text primary key, hit_count integer not null default 0, last_recalled text);`);
    }
    // embedding drift guard (H1): a DIFFERENT stored signature is a hard stop; absent is grandfathered.
    const stored = (d.prepare("select value from meta where key='embedding_signature'").get() as { value: string } | undefined)?.value;
    if (stored && stored !== this.sig) {
      throw new Error(
        `funes: embedding drift — index built with "${stored}" but embedder is "${this.sig}". Delete the index (its .funes dir) and reindex.`,
      );
    }
    if (!stored) {
      d.prepare("insert into meta(key,value) values ('embedding_signature',?) on conflict(key) do update set value=excluded.value").run(this.sig);
    }
    // P2.10 schema-version guard (Codex R2#4): the fts5 table schema is versioned in meta. A FRESH
    // index (no embedding sig yet) stamps the current version below. A BUILT index whose schema is
    // OLD is either MIGRATED (the pre-2 single-column fts5 → the weighted 4-column one, rebuilt from
    // the nodes table's title/description/body — NO re-embed) or, for an RO handle or an unknown
    // version, REFUSED loudly. `if not exists` above left an old fts table intact, so migrate drops it.
    const storedSchema = (d.prepare("select value from meta where key='schema_version'").get() as { value: string } | undefined)?.value;
    const stampSchema = () => d.prepare("insert into meta(key,value) values ('schema_version',?) on conflict(key) do update set value=excluded.value").run(INDEX_SCHEMA_VERSION);
    if (!stored) {
      stampSchema(); // fresh index
    } else if (storedSchema !== INDEX_SCHEMA_VERSION) {
      // Migration ladder to the current version. Both known steps are additive on a writer open —
      // pre-2 (null) ALSO needs the fts5 single→4-column rebuild (P2.10); v2→v3 (provenance-v1) needs
      // only the source/authored/write_actor columns, added idempotently by the enrich block below.
      // A read-only handle can't migrate; an unknown/newer version refuses loudly.
      const migratable = storedSchema == null || storedSchema === "2";
      if (!migratable) {
        throw new Error(`funes: index schema_version "${storedSchema}" != "${INDEX_SCHEMA_VERSION}" at ${this.dataPath} — this build can't read it. Delete the index and reindex (or \`funes publish --force\` a served home).`);
      }
      if (this.ro) {
        throw new Error(`funes: index schema is "${storedSchema ?? "pre-2"}" but this build serves "${INDEX_SCHEMA_VERSION}" at ${this.dataPath} — a READ-ONLY handle can't migrate it; run \`funes reindex\` (or restart the writer) to upgrade the schema first.`);
      }
      if (storedSchema == null) this.migrateFtsToV2(); // pre-2 fts rebuild; column adds happen below
      stampSchema();
    }
    // H2 dirty-marker: an interrupted full reindex refuses normal opens.
    const dirty = (d.prepare("select value from meta where key='reindex_dirty'").get() as { value: string } | undefined)?.value;
    if (dirty === "1" && !allowDirty) {
      throw new Error("funes: index is dirty (an earlier full reindex was interrupted) — run `funes reindex` to rebuild before querying.");
    }
    // enrich migration (2026-07) — runs AFTER the embedding-signature + dirty guards, so a rejected or
    // dirty open never gets a schema mutation. Adds description/resource to a pre-existing nodes table
    // (create-if-not-exists won't alter it); idempotent via pragma; columns populate on the next reindex.
    {
      const cols = new Set((d.prepare("pragma table_info(nodes)").all() as { name: string }[]).map((r) => r.name));
      if (!cols.has("description")) d.exec("alter table nodes add column description text");
      if (!cols.has("resource")) d.exec("alter table nodes add column resource text");
      // provenance-v1 (schema-v3): additive columns; existing rows get null/'unknown' (legacy semantics).
      if (!cols.has("source")) d.exec("alter table nodes add column source text");
      if (!cols.has("authored")) d.exec("alter table nodes add column authored real");
      if (!cols.has("write_actor")) d.exec("alter table nodes add column write_actor text not null default 'unknown'");
    }
    // N1/N3 (graph research, 2026-07-13): dedup existing edge rows, then enforce uniqueness on
    // (source,type,target) — the unique index would refuse to build over duplicates, so the
    // DELETE runs first (no-op when clean). Raw authored type strings; same ordering invariant
    // as the enrich migration above (after the signature + dirty guards). edges_target ships in
    // the schema block (create-if-not-exists → existing DBs pick it up on open).
    d.exec("delete from edges where rowid not in (select min(rowid) from edges group by source, type, target)");
    d.exec("create unique index if not exists edges_uniq on edges(source, type, target)");
  }

  async beginReindex(): Promise<void> {
    this.assertWritable();
    const res = this.lockResource;
    if (res) this.reindexLock = await acquireWriteLock(res); // held until endReindex (or close-belt)
    this.db.prepare("insert into meta(key,value) values ('reindex_dirty','1') on conflict(key) do update set value='1'").run();
  }
  async endReindex(): Promise<void> {
    this.assertWritable(); // F7: RO handles refuse every mutating entry point, not just the locked() ones
    // Freshness honesty (stack review B-4): stamp the completed full rebuild so surfaces can say
    // "indexed <when>" instead of the misleading "index clean" (dirty only means not-interrupted).
    this.db.prepare("insert into meta(key,value) values ('last_reindex_at',?) on conflict(key) do update set value=excluded.value").run(new Date().toISOString());
    this.db.prepare("delete from meta where key='reindex_dirty'").run();
    this.reindexLock?.release();
    this.reindexLock = undefined;
  }

  async remember(items: MemoryItem[]): Promise<RememberResult> {
    if (items.length === 0) return { indexed: 0, skipped: 0 };
    return this.locked(() => this.rememberUnlocked(items));
  }
  private async rememberUnlocked(items: MemoryItem[]): Promise<RememberResult> {
    const d = this.db;
    // incremental: skip items whose content hash already matches (no re-embed)
    const existing = new Map<string, string>();
    const existingDesc = new Map<string, string | null>();
    for (let i = 0; i < items.length; i += 400) {
      const slice = items.slice(i, i + 400);
      const rows = d.prepare(`select id, content_hash, description from nodes where id in (${ph(slice.length)})`).all(...slice.map((x) => x.id)) as { id: string; content_hash: string | null; description: string | null }[];
      for (const row of rows) { existing.set(row.id, row.content_hash ?? ""); existingDesc.set(row.id, row.description ?? null); }
    }
    const changed = items.filter((it) => existing.get(it.id) !== hashItem(it));
    const unchanged = items.filter((it) => existing.has(it.id) && existing.get(it.id) === hashItem(it));
    // trust/volatile/freshness sync for hash-skipped rows (metadata-only, no re-embed)
    if (unchanged.length) {
      // provenance-v1: source/authored are declared metadata → synced here too (a source-only edit is
      // hash-skipped, so without this it would never persist).
      // write_actor is NEVER overwritten by an anonymous writer. A full reindex re-remembers every
      // live file through a store opened with no actor, whose default is 'unknown' — so before this,
      // routine maintenance silently replaced the authenticated principal that actually made the
      // write. coalesce(nullif(?,'unknown'), …) keeps whatever is already recorded.
      // CEILING: this is not-deleting, not attribution. The value is still last-writer-wins among
      // real actors and is absent from canonical markdown, so it cannot be reconstructed if lost.
      // The upgrade path is an append-only mutation ledger; until then do not read it as an audit
      // trail (README says so explicitly).
      const upd = d.prepare("update nodes set trust=?, volatile=?, freshness=?, description=?, resource=?, source=?, authored=?, write_actor=coalesce(nullif(?,'unknown'), write_actor) where id=? and (trust is not ? or volatile is not ? or freshness is not ? or description is not ? or resource is not ? or source is not ? or authored is not ? or write_actor is not coalesce(nullif(?,'unknown'), write_actor))");
      const delFtsU = d.prepare("delete from nodes_fts where nid=?");
      const insFtsU = d.prepare("insert into nodes_fts(nid,title,description,body) values (?,?,?,?)");
      const tx = d.transaction(() => {
        for (const it of unchanged) {
          const tr = it.trust ?? "untrusted", vo = isVolatile(it) ? 1 : 0, fr = freshnessEpoch(it);
          const de = it.description ?? null, re = it.resource ?? null;
          const so = it.source ?? null, au = authoredEpoch(it), wa = this.writeActor;
          upd.run(tr, vo, fr, de, re, so, au, wa, it.id, tr, vo, fr, de, re, so, au, wa);
          // description folds into FTS — refresh the FTS row when it changed on a hash-skipped item,
          // else a description-only edit isn't searchable until the body next changes (Codex #1).
          if ((existingDesc.get(it.id) ?? null) !== de) {
            delFtsU.run(it.id);
            insFtsU.run(it.id, it.title, it.description ?? "", it.body);
          }
        }
      });
      tx();
    }
    if (changed.length === 0) return { indexed: 0, skipped: items.length };

    // chunk every changed page, embed ALL chunks of the batch in ONE call (throughput path)
    const chunkLists = changed.map((it) => chunkText(`${it.title}\n${it.body}`));
    const embs = await this.embedder.embedPassages(chunkLists.flat());

    const insNode = d.prepare(`insert into nodes(id,path,title,type,body,content_hash,embedding_signature,trust,volatile,freshness,description,resource,source,authored,write_actor,embedding)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,vector32(?))
      on conflict(id) do update set path=excluded.path,title=excluded.title,type=excluded.type,body=excluded.body,
        content_hash=excluded.content_hash,embedding_signature=excluded.embedding_signature,trust=excluded.trust,
        volatile=excluded.volatile,freshness=excluded.freshness,description=excluded.description,resource=excluded.resource,
        source=excluded.source,authored=excluded.authored,write_actor=coalesce(nullif(excluded.write_actor,'unknown'), nodes.write_actor),embedding=excluded.embedding`);
    const delFts = d.prepare("delete from nodes_fts where nid=?");
    const insFts = d.prepare("insert into nodes_fts(nid,title,description,body) values (?,?,?,?)");
    const delChunks = d.prepare("delete from chunks where page_id=?");
    const insChunk = d.prepare("insert into chunks(page_id,ord,embedding) values (?,?,vector32(?))");
    const delEdges = d.prepare("delete from edges where source=?");
    const insEdge = d.prepare("insert or ignore into edges(source,type,target,weight) values (?,?,?,?)"); // edges_uniq (N3): last line of defense behind extraction dedupe

    const tx = d.transaction(() => {
      let off = 0;
      for (let i = 0; i < changed.length; i++) {
        const it = changed[i]!;
        const nChunks = chunkLists[i]!.length;
        insNode.run(it.id, it.path ?? null, it.title, it.type ?? null, it.body, hashItem(it), this.sig,
          it.trust ?? "untrusted", isVolatile(it) ? 1 : 0, freshnessEpoch(it), it.description ?? null, it.resource ?? null,
          it.source ?? null, authoredEpoch(it), this.writeActor, vlit(embs[off]!));
        delFts.run(it.id);
        // title/description/body go to SEPARATE fts5 columns (P2.10) so bm25 can weight them; a
        // description-only edit refreshes the row via the metadata-sync path above, not this one.
        insFts.run(it.id, it.title, it.description ?? "", it.body);
        delChunks.run(it.id);
        for (let c = 0; c < nChunks; c++) insChunk.run(it.id, c, vlit(embs[off + c]!));
        off += nChunks;
        delEdges.run(it.id);
        for (const e of it.edges ?? []) insEdge.run(it.id, e.type, e.target, e.weight ?? 1.0);
      }
    });
    tx();
    return { indexed: changed.length, skipped: items.length - changed.length };
  }

  async remove(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return this.locked(() => this.removeUnlocked(ids));
  }
  private async removeUnlocked(ids: string[]): Promise<number> {
    const d = this.db;
    let removed = 0;
    const tx = d.transaction(() => {
      for (let i = 0; i < ids.length; i += 400) {
        const s = ids.slice(i, i + 400);
        removed += (d.prepare(`delete from nodes where id in (${ph(s.length)})`).run(...s).changes as number) ?? 0;
        d.prepare(`delete from chunks where page_id in (${ph(s.length)})`).run(...s);
        d.prepare(`delete from edges where source in (${ph(s.length)})`).run(...s);
        d.prepare(`delete from nodes_fts where nid in (${ph(s.length)})`).run(...s);
      }
    });
    tx();
    return removed;
  }

  async prune(keepIds: string[]): Promise<number> {
    return this.locked(() => this.pruneUnlocked(keepIds));
  }
  private async pruneUnlocked(keepIds: string[]): Promise<number> {
    const d = this.db;
    let removed = 0;
    const tx = d.transaction(() => {
      d.exec("create temp table if not exists _keep(id text primary key)");
      d.exec("delete from _keep");
      const ins = d.prepare("insert or ignore into _keep(id) values (?)");
      for (const id of keepIds) ins.run(id);
      removed = (d.prepare("delete from nodes where id not in (select id from _keep)").run().changes as number) ?? 0;
      d.prepare("delete from chunks where page_id not in (select id from _keep)").run();
      d.prepare("delete from edges where source not in (select id from _keep)").run();
      d.prepare("delete from nodes_fts where nid not in (select id from _keep)").run();
    });
    tx();
    return removed;
  }

  /** E1 Rev 2 (spec 2026-07-14): SQL row normalization for the v2 graph arm — distinct
   *  (seed,candidate) pairs, existence-filtered (join nodes: 36% of edges dangle — grill M8),
   *  per-seed capped via row_number (bounds DB work — grill M7), deterministically ordered.
   *  Hub-ineligible seeds are filtered BEFORE the IN query. All scoring/aggregation lives in
   *  funes-core buildGraphArm (grill M9 — parity by construction). */
  private graphArmV2(seeds: string[], fts: string[], vec: string[], limit: number, inbound: boolean): string[] {
    if (!seeds.length) return [];
    const d = this.db;
    const seedBestRank = new Map<string, number>();
    for (const [i, id] of fts.entries()) if (!seedBestRank.has(id) || i < seedBestRank.get(id)!) seedBestRank.set(id, i);
    for (const [i, id] of vec.entries()) if (!seedBestRank.has(id) || i < seedBestRank.get(id)!) seedBestRank.set(id, i);
    const P = ph(seeds.length);
    const rows: GraphNeighborRow[] = [];
    // OUT: distinct pairs, existence-filtered, capped per seed (deterministic prefix).
    for (const r of d.prepare(
      `with pairs as (select distinct e.source as seed, e.target as cand from edges e join nodes nn on nn.id = e.target where e.source in (${P})),
            ranked as (select seed, cand, row_number() over (partition by seed order by cand) rn from pairs)
       select seed, cand from ranked where rn <= ${GRAPH_ARM_CAP_OUT} order by seed, cand`).all(...seeds) as { seed: string; cand: string }[]) {
      rows.push({ seed: r.seed, candidate: r.cand, dir: "out" });
    }
    // seed in-degree = count(DISTINCT source) (grill M6) — needed for hub gate + IN damping.
    const seedInDegree = new Map<string, number>();
    const contribOutDegree = new Map<string, number>();
    if (inbound) {
      for (const r of d.prepare(`select target as seed, count(distinct source) n from edges where target in (${P}) group by target`).all(...seeds) as { seed: string; n: number }[]) {
        seedInDegree.set(r.seed, r.n);
      }
      const eligible = seeds.filter((s) => (seedInDegree.get(s) ?? 0) <= GRAPH_ARM_HUB_MAX && (seedInDegree.get(s) ?? 0) > 0);
      if (eligible.length) {
        const PE = ph(eligible.length);
        const inRows = d.prepare(
          `with pairs as (select distinct e.target as seed, e.source as cand from edges e join nodes nn on nn.id = e.source where e.target in (${PE})),
                ranked as (select seed, cand, row_number() over (partition by seed order by cand) rn from pairs)
           select seed, cand from ranked where rn <= ${GRAPH_ARM_CAP_IN} order by seed, cand`).all(...eligible) as { seed: string; cand: string }[];
        const contribs = [...new Set(inRows.map((r) => r.cand))];
        if (contribs.length) {
          for (const r of d.prepare(`select source, count(distinct target) n from edges where source in (${ph(contribs.length)}) group by source`).all(...contribs) as { source: string; n: number }[]) {
            contribOutDegree.set(r.source, r.n);
          }
        }
        for (const r of inRows) rows.push({ seed: r.seed, candidate: r.cand, dir: "in" });
      }
    }
    return buildGraphArm({ seeds, seedBestRank, rows, seedInDegree, contribOutDegree, inbound, graphListMax: 4 * limit });
  }

  async recall(q: RecallQuery): Promise<RecallResult[]> {
    const limit = q.k ?? 5;
    const n = Math.max(limit * 4, 20);
    const d = this.db;
    // E1 Rev 2: bounded deterministic graph arm. DEFAULT_GRAPH_ARM="v2" (OUT-only) adopted P2.11 —
    // env still pins "legacy" (pre-v2 unbounded walk, goldens compare against it) or "v2in" (+IN).
    const graphArm = resolveGraphArm(process.env.FUNES_GRAPH_ARM);
    const v2 = graphArm !== "legacy";

    // FTS arm — FTS5 MATCH (OR-of-quoted-terms) ranked by WEIGHTED bm25 (lower = better; P2.10:
    // title/description/body columns weighted so a title hit outranks a body mention — the libSQL
    // analogue of pglite's setweight(title 'A')). bm25 weights are positional per column incl. the
    // unindexed `nid` (0). v2: `, nid` secondary key makes exact-bm25 ties deterministic (grill H2).
    const terms = (q.query.match(WORD) ?? []).filter((t) => t.length >= 2);
    const ftsq = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
    const bm25 = `bm25(nodes_fts, 0.0, ${BM25_TITLE_WEIGHT}, ${BM25_DESC_WEIGHT}, ${BM25_BODY_WEIGHT})`;
    const fts = ftsq
      ? (d.prepare(`select nid from nodes_fts where nodes_fts match ? order by ${bm25}${v2 ? ", nid" : ""} limit ?`).all(ftsq, n) as { nid: string }[]).map((r) => r.nid)
      : [];

    // vector arm — EXACT cosine over CHUNKS, keep each page's best (min-distance) chunk.
    const qv = await this.embedder.embedQuery(q.query);
    const vecRows = d.prepare(`select page_id from chunks where embedding is not null order by vector_distance_cos(embedding, vector32(?))${v2 ? ", page_id, ord" : ""} limit ?`).all(vlit(qv), n * 3) as { page_id: string }[];
    const vec: string[] = [];
    const seenPages = new Set<string>();
    for (const row of vecRows) {
      if (seenPages.has(row.page_id)) continue;
      seenPages.add(row.page_id);
      vec.push(row.page_id);
      if (vec.length >= n) break;
    }

    // edge-walk from the top FTS+vec seeds
    const seeds = [...new Set([...fts.slice(0, limit), ...vec.slice(0, limit)])];
    let edges: string[];
    if (v2) {
      edges = this.graphArmV2(seeds, fts, vec, limit, graphArm === "v2in");
    } else {
      const bySource = new Map<string, string[]>();
      if (seeds.length) {
        const er = d.prepare(`select source, target from edges where source in (${ph(seeds.length)})`).all(...seeds) as { source: string; target: string }[];
        for (const row of er) {
          if (!row.target) continue;
          const list = bySource.get(row.source) ?? [];
          list.push(row.target);
          bySource.set(row.source, list);
        }
      }
      const edgeHits: string[] = [];
      for (const s of seeds) edgeHits.push(...(bySource.get(s) ?? []));
      edges = [...new Set(edgeHits)];
    }

    // RRF k. Default DEFAULT_RRF_K=5 — adopted P2.10b (2026-07-21) after the personal-index sweep
    // showed k=60 flattens fusion so much the weighted FTS arm couldn't move the fused top-k; k=5
    // won every metric on all three fixture sets (rrf.ts has the numbers). FUNES_RRF_K stays as the
    // measurement override for future sweeps. A non-finite value falls back to the default.
    const kEnv = Number(process.env.FUNES_RRF_K);
    const rrfK = Number.isFinite(kEnv) ? kEnv : DEFAULT_RRF_K;
    const scores = rrfScores([fts, vec, edges], rrfK);
    const merged = rrf([fts, vec, edges], rrfK, { tieBreakIds: v2 });

    const useRerank = !!q.rerank && !!this.reranker;
    const cap = useRerank ? Math.min(merged.length, limit * 4) : limit;

    // existence-filter BEFORE slicing (dangling edge targets must not starve results below k)
    const byId = new Map<string, { id: string; title: string; path: string | null; trust: string; volatile: number; fresh: number | null; description: string | null; resource: string | null; source: string | null; authored: number | null; write_actor: string | null }>();
    for (let i = 0; i < merged.length; i += 400) {
      const s = merged.slice(i, i + 400);
      for (const row of d.prepare(`select id,title,path,trust,volatile,freshness as fresh,description,resource,source,authored,write_actor from nodes where id in (${ph(s.length)})`).all(...s) as any[]) {
        byId.set(row.id, row);
      }
    }
    const all: RecallResult[] = [];
    for (const id of merged) {
      const row = byId.get(id);
      if (!row) continue;
      all.push({ id: row.id, title: row.title, path: row.path ?? undefined, score: scores.get(id) ?? 0, trust: row.trust as RecallResult["trust"], description: row.description ?? undefined, resource: row.resource ?? undefined,
        source: row.source ?? undefined, authored: row.authored != null ? new Date(row.authored * 1000).toISOString() : undefined, writeActor: row.write_actor ?? undefined,
        volatile: row.volatile === 1 ? true : undefined,
        freshness: row.fresh != null ? new Date(row.fresh * 1000).toISOString().slice(0, 10) : undefined });
    }

    // Move 5 composition: RRF -> trust-weight -> zone-weight -> entity-boost -> dup-collapse -> recency-tiebreak -> (optional) rerank.
    // (adj = ONE composed multiplicative ordering key; comment fixed 2026-07-13 — it omitted the entity boost.)
    const adj = new Map(all.map((r) => [r.id, entityAdjust(zoneAdjust(trustAdjust(r.score, r.trust), r.path ?? `${r.id}.md`), q.query, r.title, r.id)]));
    const weighted = [...all].sort((a, b) => adj.get(b.id)! - adj.get(a.id)!);
    const collapsed = collapseDuplicates(weighted, (r) => adj.get(r.id)!);
    const ordered = recencyTiebreak(
      collapsed.map((r) => ({ r, score: adj.get(r.id)! })),
      (x) => { const row = byId.get(x.r.id); return row ? { volatile: row.volatile === 1, fresh: row.fresh } : undefined; },
    ).map((x) => x.r);
    const out = ordered.slice(0, cap);
    if (!useRerank || out.length <= 1) return this.recordRecalls(out.slice(0, limit));

    const bodyById = new Map<string, string>();
    for (let i = 0; i < out.length; i += 400) {
      const s = out.slice(i, i + 400);
      for (const row of d.prepare(`select id, body from nodes where id in (${ph(s.length)})`).all(...s.map((r) => r.id)) as { id: string; body: string | null }[]) {
        bodyById.set(row.id, row.body ?? "");
      }
    }
    const order = await this.reranker!.rerank(q.query, out.map((r) => ({ id: r.id, text: `${r.title}\n${bodyById.get(r.id) ?? ""}` })));
    const resById = new Map(out.map((r) => [r.id, r]));
    const reranked: RecallResult[] = [];
    for (const id of order) { const r = resById.get(id); if (r) { reranked.push(r); resById.delete(id); } }
    for (const r of out) if (resById.has(r.id)) reranked.push(r);
    return this.recordRecalls(reranked.slice(0, limit));
  }

  /** Both return paths (RRF-only and reranked) funnel through here, so rank is stamped ONCE, at
   *  the last moment — after tiebreak and any rerank — and therefore always describes the order
   *  actually handed back rather than an intermediate one. */
  private async recordRecalls(results: RecallResult[]): Promise<RecallResult[]> {
    results.forEach((r, i) => { r.rank = i + 1; });
    if (this.trackRecalls && results.length) {
      const now = new Date().toISOString();
      const up = this.db.prepare("insert into recall_stats(memory_id,hit_count,last_recalled) values (?,1,?) on conflict(memory_id) do update set hit_count=hit_count+1, last_recalled=excluded.last_recalled");
      const tx = this.db.transaction(() => { for (const r of results) up.run(r.id, now); });
      tx();
    }
    return results;
  }

  async stats(): Promise<{ nodes: number; edges: number; embeddingSignature: string | null; reindexDirty: boolean; lastReindexAt: string | null; scopeHash: string | null; ignoreScope: boolean; generation: string | null }> {
    const d = this.db;
    const n = (d.prepare("select count(*) as c from nodes").get() as { c: number }).c;
    const e = (d.prepare("select count(*) as c from edges").get() as { c: number }).c;
    const sig = (d.prepare("select value from meta where key='embedding_signature'").get() as { value: string } | undefined)?.value ?? null;
    const dirty = (d.prepare("select value from meta where key='reindex_dirty'").get() as { value: string } | undefined)?.value === "1";
    const last = (d.prepare("select value from meta where key='last_reindex_at'").get() as { value: string } | undefined)?.value ?? null;
    const scope = await this.getScopeSignature();
    return { nodes: Number(n), edges: Number(e), embeddingSignature: sig, reindexDirty: dirty, lastReindexAt: last, scopeHash: scope?.hash ?? null, ignoreScope: scope?.ignoreScope ?? false, generation: await this.getGeneration() };
  }

  /** generation-v1 (R5#1): persist the content-generation stamp of the last FULL build — meta key
   *  `generation`, advanced by reindex.ts exactly where the scope signature is (full runs only). */
  async setGeneration(generation: string): Promise<void> {
    this.assertWritable(); // F7
    this.db.prepare("insert into meta(key,value) values ('generation',?) on conflict(key) do update set value=excluded.value").run(generation);
  }

  async getGeneration(): Promise<string | null> {
    return (this.db.prepare("select value from meta where key='generation'").get() as { value: string } | undefined)?.value ?? null;
  }

  /** Persist the index_scope signature (closure sprint 3B) — meta keys `index_scope_hash` +
   *  `index_scope_ignored`. Called by a FULL reindex only, so the hash advances with the prune. */
  async setScopeSignature(sig: ScopeSignature): Promise<void> {
    this.assertWritable(); // F7
    this.db.prepare("insert into meta(key,value) values ('index_scope_hash',?) on conflict(key) do update set value=excluded.value").run(sig.hash);
    this.db.prepare("insert into meta(key,value) values ('index_scope_ignored',?) on conflict(key) do update set value=excluded.value").run(sig.ignoreScope ? "1" : "0");
  }

  /** H2: invalidate the persisted signature (a full rebuild from an absent/invalid manifest) — both
   *  meta keys cleared, so getScopeSignature returns null and cross-star reads fail closed. */
  async clearScopeSignature(): Promise<void> {
    this.assertWritable(); // F7
    this.db.prepare("delete from meta where key='index_scope_hash'").run();
    this.db.prepare("delete from meta where key='index_scope_ignored'").run();
  }

  async getScopeSignature(): Promise<ScopeSignature | null> {
    const hash = (this.db.prepare("select value from meta where key='index_scope_hash'").get() as { value: string } | undefined)?.value;
    if (!hash) return null;
    const ig = (this.db.prepare("select value from meta where key='index_scope_ignored'").get() as { value: string } | undefined)?.value;
    return { hash, ignoreScope: ig === "1" };
  }

  /** H9: the {scope-signature, reindex-dirty} tuple the guard checks (mirrors the pglite backend). */
  private scopeState(): { scopeHash: string | null; ignoreScope: boolean; reindexDirty: boolean } {
    const hash = (this.db.prepare("select value from meta where key='index_scope_hash'").get() as { value: string } | undefined)?.value ?? null;
    const ig = (this.db.prepare("select value from meta where key='index_scope_ignored'").get() as { value: string } | undefined)?.value === "1";
    const dirty = (this.db.prepare("select value from meta where key='reindex_dirty'").get() as { value: string } | undefined)?.value === "1";
    return { scopeHash: hash, ignoreScope: ig, reindexDirty: dirty };
  }

  /** H9: atomic cross-star serve guard (mirrors funes-engine) — check-retrieve-RECHECK the
   *  {scope-signature, reindex-dirty} state so a reindex re-admitting excluded rows between the
   *  check and the retrieval can never be served. Never mtime-cached. */
  async guardedRead<T>(expectedHash: string, retrieve: () => Promise<T>): Promise<GuardedResult<T>> {
    const r1 = guardRefusal(this.scopeState(), expectedHash);
    if (r1) return { refusal: r1 };
    const value = await retrieve();
    const r2 = guardRefusal(this.scopeState(), expectedHash);
    if (r2) return { refusal: r2 };
    return { ok: value };
  }

  /** Publisher-side finalization (RO-open companion, 2026-07-16): wal_checkpoint(TRUNCATE) +
   *  journal_mode=DELETE on THIS handle, so the published gen db is consumable from a READ-ONLY
   *  mount (a WAL db needs -shm even for readers) with zero -wal/-shm sidecars. Same-connection
   *  BY DESIGN: a second connection hits SQLITE_BUSY while this one's prepared statements are
   *  alive (statement handles pin the native connection until GC). publishReindex calls this
   *  right before close(); the file is never served WAL again (consumers open mode=ro). */
  async finalizeForPublish(): Promise<void> {
    this.assertWritable();
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

  /** Semantic + typed neighbourhood of one node (the graph-explorer / inspector data source).
   *  EXACT cosine kNN over nodes.embedding (head-chunk, like pglite) + frontmatter edges both ways. */
  async neighbors(id: string, k = 8): Promise<NeighborsResult> {
    const d = this.db;
    const self = d.prepare("select id,title,path,trust,type from nodes where id=?").get(id) as { id: string; title: string; path: string | null; trust: string; type: string | null } | undefined;
    if (!self) return { node: null, similar: [], edgesOut: [], edgesIn: [] };
    const knn = d.prepare(
      `select id,title,path,trust, vector_distance_cos(embedding, (select embedding from nodes where id=?)) as dist
         from nodes where id<>? and embedding is not null order by dist asc limit ?`,
    ).all(id, id, k) as { id: string; title: string; path: string | null; trust: string; dist: number }[];
    const eo = d.prepare("select e.type as type, e.target as target, n.title as title, n.trust as trust from edges e left join nodes n on n.id=e.target where e.source=?").all(id) as { type: string; target: string; title: string | null; trust: string | null }[];
    const ei = d.prepare("select e.type as type, e.source as source, n.title as title, n.trust as trust from edges e left join nodes n on n.id=e.source where e.target=?").all(id) as { type: string; source: string; title: string | null; trust: string | null }[];
    return {
      node: { id: self.id, title: self.title, path: self.path ?? undefined, trust: self.trust, type: self.type ?? undefined },
      similar: knn.map((r) => ({ id: r.id, title: r.title, path: r.path ?? undefined, trust: r.trust, score: Math.round((1 - r.dist) * 1000) / 1000 })),
      edgesOut: eo.map((r) => ({ type: r.type, id: r.target, title: r.title, trust: r.trust ?? undefined })),
      edgesIn: ei.map((r) => ({ type: r.type, id: r.source, title: r.title, trust: r.trust ?? undefined })),
    };
  }

  /** Cross-star (--ops) read: one page's INDEXED snapshot, from the `nodes` row ONLY — never a
   *  filesystem read, so index_scope is the capability boundary with no TOCTOU. Matches by node id
   *  OR the stored `path` (with or without `.md`). null when it is not in the index. */
  async indexedPage(ref: { id?: string; path?: string }): Promise<IndexedPage | null> {
    const keys: string[] = [];
    if (ref.id) keys.push(ref.id);
    if (ref.path) { keys.push(ref.path); keys.push(ref.path.replace(/\.md$/, "")); }
    if (!keys.length) return null;
    const row = this.db.prepare(
      `select id, path, title, type, trust, description, resource, source, authored, write_actor, body
         from nodes where id in (${ph(keys.length)}) or path in (${ph(keys.length)}) limit 1`,
    ).get(...keys, ...keys) as {
      id: string; path: string | null; title: string; type: string | null;
      trust: string; description: string | null; resource: string | null;
      source: string | null; authored: number | null; write_actor: string | null; body: string;
    } | undefined;
    return row
      ? { id: row.id, path: row.path, title: row.title, type: row.type, trust: row.trust,
          description: row.description, resource: row.resource,
          source: row.source, authored: row.authored != null ? new Date(row.authored * 1000).toISOString() : null,
          writeActor: row.write_actor ?? "unknown", body: row.body }
      : null;
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
    const signature = `${this.sig}:libsql:${fpRows.length}:${fp}:sim${simTopK}@${simCutoff}`;
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

    // P1b parity: thresholded similarity edges. Per-node exact top-k cosine (reuse the subquery-
    // embedding form proven in neighbors()); SQLite has no LATERAL so we loop. De-dup undirected;
    // skip pairs a typed edge already connects. Added to g so the islands get a layout home + a
    // community; emitted family "similarity". Degree (god-nodes) stays TYPED-only (captured above).
    const simEdges: GraphEdge[] = [];
    if (simTopK > 0 && g.order > 1) {
      const knn = d.prepare(
        `select id, vector_distance_cos(embedding, (select embedding from nodes where id=?)) as dist
           from nodes where id<>? and embedding is not null order by dist asc limit ?`,
      );
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
    if (artifactPath) { try { writeFileSync(artifactPath, JSON.stringify(artifact)); } catch { /* read-only fs -> serve uncached */ } }
    return artifact;
  }
}
