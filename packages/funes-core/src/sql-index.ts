// The one index module (RAI-314, ADR-0023): one schema per slot, the writes, recall and the one
// resumable build walk over the Vault port, on any SQL engine that gives it a sync exec port. Each
// engine supplies a dialect (schema version, DDL, lexical arm, vector scan, stat row); the adapters
// live in the hosts: libsql and turso in funes-engine, DO SQLite in funes-cf. No driver is imported here.
//
// Port rules: args are always one array; a BLOB binds and reads as Uint8Array (an adapter may hand
// back an ArrayBuffer, which the module normalizes); no statement binds more than 100 parameters,
// because every id list binds ONE JSON array through json_each; no temp table, ATTACH or SQL BEGIN.
import type { Embedder, MemoryItem, OkfCounts, PageStat, PageStatRecord, PageSwap, RecallQuery, RecallResult, RememberResult, ScalarFrontmatter, ScopeSignature, Trust } from "./types.ts";
import { embeddingSignature, isTombstoned } from "./types.ts";
import type { ContentIdentity, GuardedResult, IndexedPage, IndexStats, ServingIndex } from "./index-store.ts";
import { expectationRefusal, type ScopeExpectation } from "./scope-guard.ts";
import { CHUNK_SIG, chunkText } from "./chunking.ts";
import { canonicalFrontmatter, encodeGeneration, epochSeconds, GENERATION_VERSION, generationRecord, hashItem, PARSER_VERSION } from "./generation.ts";
import { BM25_COLUMN_WEIGHTS, ftsTerms, rankRecall } from "./ranking.ts";
import { DEFAULT_RRF_K, rrf, rrfScores } from "./rrf.ts";
import { buildGraphArm, GRAPH_ARM_CAP_OUT } from "./graph-arm.ts";
import { matchesFilter } from "./filter.ts";
import { servingSignature } from "./serving-signature.ts";
import { lstatVersion, parseLstatVersion } from "./lstat-version.ts";
import { pathOrder, zoneOfFile, type Vault, type VaultPath } from "./vault.ts";
import { mayClaimIndex, ownerClaimRefused } from "./star-uri.ts";
import { normalizePage, parseFrontmatter, textToItemWithMeta } from "./markdown.ts";
import { referenceMaps, resolveEdgeTargets, type ReferenceMaps } from "./reindex.ts";
import { sha256Hex } from "./funes-store.ts";

// ── the exec port ────────────────────────────────────────────────────────────────────────────────
export type SqlValue = string | number | bigint | null | Uint8Array;
export interface SqlExec {
  all<T = Record<string, unknown>>(sql: string, args?: readonly SqlValue[]): T[];
  /** Rows one at a time (the vector scan): only one BLOB is live at once. */
  iterate<T = Record<string, unknown>>(sql: string, args?: readonly SqlValue[]): Iterable<T>;
  /** The rows the statement changed. */
  run(sql: string, args?: readonly SqlValue[]): number;
  /** `fn` is sync; a throw rolls back. libsql: BEGIN IMMEDIATE; DO SQLite: transactionSync. */
  tx<T>(fn: () => T): T;
}

// ── dialects ─────────────────────────────────────────────────────────────────────────────────────
export type Backend = "libsql" | "do-sqlite" | "turso";
/** The schema version per backend; the module is its one owner. Each is an input to the content
 *  generation, so an edge generation never equals a home one. No bump in 0.6.0: the additive set at
 *  libsql "4" is `nodes.gen_record`, the `build_refs` and `build_stat` tables and the `build_cursor`
 *  meta key. */
export const SCHEMA_VERSIONS: Readonly<Record<Backend, string>> = { libsql: "4", "do-sqlite": "do-sqlite/1", turso: "turso/1" };

/** One slot's tables: a home index has one unsuffixed slot; org and the edge have two, `_a` and `_b`. */
export interface Slot { nodes: string; edges: string; chunks: string; fts: string; stat: string }
export const slotTables = (sfx = ""): Slot => ({ nodes: `nodes${sfx}`, edges: `edges${sfx}`, chunks: `chunks${sfx}`, fts: `nodes_fts${sfx}`, stat: `page_stat${sfx}` });

export interface LexicalArm {
  put(x: SqlExec, t: Slot, it: MemoryItem): void;
  del(x: SqlExec, t: Slot, idsJson: string): number;
  /** The ranked ids; `onlyJson` (a JSON id array) restricts them. */
  top(x: SqlExec, t: Slot, terms: string, n: number, onlyJson: string | null): string[];
  /** Drop the lexical rows of every id `keepSql` (a select of ids) does not name. */
  keepOnly(x: SqlExec, t: Slot, keepSql: string): void;
}
export interface Dialect {
  readonly backend: Backend;
  readonly schemaVersion: string;
  /** One slot's tables, `if not exists`. */
  ddl(t: Slot, dim: number): string[];
  readonly lexical: LexicalArm;
  /** An engine-native exact scan; absent = the shared JS scan. Same order key either way. */
  vectorTop?(x: SqlExec, t: Slot, qv: Float32Array, n: number, onlyJson: string | null): string[];
  /** `hash`: the sha256 of the bytes `version` names, or null (RAI-318). */
  statPut(x: SqlExec, t: Slot, id: string, version: string, hash: string | null): void;
  /** `hash`: the slot's stat table has the column (an index built before 0.6.0 may not). */
  statRows(x: SqlExec, t: Slot, hash: boolean): PageStat[];
  /** The slot's stat table, `if not exists`: the lstat triple of a folder, or an opaque version. */
  statDdl(t: Slot): string;
}

const only = (col: string, onlyJson: string | null) => (onlyJson == null ? "" : ` and ${col} in (select value from json_each(?))`);
const onlyArg = (onlyJson: string | null): SqlValue[] => (onlyJson == null ? [] : [onlyJson]);

/** FTS5 unicode61 over (nid, title, description, body), weighted by BM25_COLUMN_WEIGHTS; `nid` is
 *  the exact-tie key. libsql and DO SQLite. */
export const FTS5: LexicalArm = {
  put(x, t, it) {
    x.run(`delete from ${t.fts} where nid=?`, [it.id]);
    x.run(`insert into ${t.fts}(nid,title,description,body) values (?,?,?,?)`, [it.id, it.title, it.description ?? "", it.body]);
  },
  del: (x, t, j) => x.run(`delete from ${t.fts} where nid in (select value from json_each(?))`, [j]),
  keepOnly: (x, t, keep) => { x.run(`delete from ${t.fts} where nid not in (${keep})`); },
  top: (x, t, terms, n, o) =>
    x.all<{ nid: string }>(`select nid from ${t.fts} where ${t.fts} match ?${only("nid", o)} order by bm25(${t.fts}, ${BM25_COLUMN_WEIGHTS.join(", ")}), nid limit ?`,
      [terms, ...onlyArg(o), n]).map((r) => r.nid),
};
const fts5Ddl = (t: Slot) => `create virtual table if not exists ${t.fts} using fts5(nid unindexed, title, description, body, tokenize='unicode61')`;

/** The libsql "4" layout. `nodes.embedding` and `nodes.embedding_signature` stay, nullable and never
 *  written (a later schema bump drops them); `neighbors` and the graph bake read chunk 0. The home
 *  keeps its lstat-triple stat columns. */
export const LIBSQL_DIALECT: Dialect = {
  backend: "libsql",
  schemaVersion: SCHEMA_VERSIONS.libsql,
  ddl: (t, dim) => [
    `create table if not exists ${t.nodes}(id text primary key, path text, title text, type text, body text, content_hash text, embedding_signature text,
      trust text not null default 'untrusted', volatile integer not null default 0, freshness real, description text, resource text,
      source text, authored real, write_actor text not null default 'unknown', embedding F32_BLOB(${dim}), frontmatter text)`,
    `create table if not exists ${t.edges}(source text, type text, target text, weight real default 1.0)`,
    `create index if not exists ${t.edges}_source on ${t.edges}(source)`,
    `create index if not exists ${t.edges}_target on ${t.edges}(target)`,
    `create table if not exists ${t.chunks}(page_id text not null, ord integer not null, embedding F32_BLOB(${dim}), primary key(page_id, ord))`,
    fts5Ddl(t),
  ],
  lexical: FTS5,
  vectorTop: (x, t, qv, n, o) => firstPerPage(
    x.all<{ page_id: string }>(`select page_id from ${t.chunks} where embedding is not null${only("page_id", o)} order by vector_distance_cos(embedding, vector32(?)), page_id, ord limit ?`,
      [...onlyArg(o), `[${Array.from(qv).join(",")}]`, n * 3]).map((r) => r.page_id), n),
  statPut(x, t, id, version, hash) {
    const s = parseLstatVersion(version);
    if (!s) throw new Error(`page_stat: version ${JSON.stringify(version)} of "${id}" is not an lstat triple`);
    x.run(`insert or replace into ${t.stat}(id,mtime_ms,ctime_ms,size,hash) values (?,?,?,?,?)`, [id, s.mtimeMs, s.ctimeMs, s.size, hash]);
  },
  statRows: (x, t, hash) => x.all<{ id: string; m: number; c: number; s: number; h: string | null }>(`select id, mtime_ms m, ctime_ms c, size s, ${hash ? "hash" : "null"} h from ${t.stat}`)
    .map((r) => ({ id: r.id, version: lstatVersion({ mtimeMs: r.m, ctimeMs: r.c, size: r.s }), hash: r.h })),
  statDdl: (t) => `create table if not exists ${t.stat}(id text primary key, mtime_ms real not null, ctime_ms real not null, size integer not null, hash text)`,
};

/** DO SQLite: no vector functions, so the shared JS scan; the stat is the R2 etag. */
export const DO_SQLITE_DIALECT: Dialect = {
  backend: "do-sqlite",
  schemaVersion: SCHEMA_VERSIONS["do-sqlite"],
  ddl: (t) => [
    `create table if not exists ${t.nodes}(id text primary key, path text, title text not null, type text, body text not null,
      content_hash text not null, trust text not null, volatile integer not null, freshness real, description text, resource text,
      source text, authored real, write_actor text not null, frontmatter text, gen_record text)`,
    `create table if not exists ${t.edges}(source text not null, type text not null, target text not null, weight real not null, primary key(source, type, target))`,
    `create index if not exists ${t.edges}_target on ${t.edges}(target)`,
    `create table if not exists ${t.chunks}(page_id text not null, ord integer not null, embedding blob not null, primary key(page_id, ord))`,
    fts5Ddl(t),
  ],
  lexical: FTS5,
  statPut: (x, t, id, version, hash) => { x.run(`insert or replace into ${t.stat}(id,version,hash) values (?,?,?)`, [id, version, hash]); },
  statRows: (x, t, hash) => x.all<PageStat>(`select id, version, ${hash ? "hash" : "null"} hash from ${t.stat}`),
  statDdl: (t) => `create table if not exists ${t.stat}(id text primary key, version text not null, hash text)`,
};
/** Turso's `fts` index method (Tantivy BM25, RAI-321) on the nodes row itself: it follows every
 *  nodes write, so put and del do nothing. Its weights are BM25 field boosts, not FTS5 column
 *  multipliers, so the lexical order may differ from FTS5's. On 0.8.3 (pinned) the score is 0 unless
 *  `fts_score` and `fts_match` take the same bound `?1`, and a second ORDER BY key replaces the score
 *  key unless the scored query is a subquery. Higher scores are better. */
const TURSO_COLS = "title, description, body";
const TURSO_WEIGHTS = `title=${BM25_COLUMN_WEIGHTS[1]}.0,description=${BM25_COLUMN_WEIGHTS[2]}.0,body=${BM25_COLUMN_WEIGHTS[3]}.0`;
export const TURSO_FTS: LexicalArm = {
  put: () => {},
  del: () => 0,
  keepOnly: () => {},
  top: (x, t, terms, n, o) =>
    x.all<{ id: string }>(`select id from (select id, fts_score(${TURSO_COLS}, ?1) s from ${t.nodes} where fts_match(${TURSO_COLS}, ?1)${o == null ? "" : " and id in (select value from json_each(?3))"}) order by s desc, id limit ?2`,
      o == null ? [terms, n] : [terms, n, o]).map((r) => r.id),
};

/** Turso (RAI-312, RAI-314): libsql's row layout with `gen_record` from the start, the `fts` index on
 *  `nodes`, the same `vector_distance_cos` scan. The stat is the libsql lstat triple: a home Turso
 *  star walks a folder. Opened by the host with `experimental: ["index_method"]`, in WAL. */
export const TURSO_DIALECT: Dialect = {
  backend: "turso",
  schemaVersion: SCHEMA_VERSIONS.turso,
  ddl: (t, dim) => [
    `create table if not exists ${t.nodes}(id text primary key, path text, title text, type text, body text, content_hash text,
      trust text not null default 'untrusted', volatile integer not null default 0, freshness real, description text, resource text,
      source text, authored real, write_actor text not null default 'unknown', frontmatter text, gen_record text)`,
    `create table if not exists ${t.edges}(source text, type text, target text, weight real default 1.0)`,
    `create index if not exists ${t.edges}_source on ${t.edges}(source)`,
    `create index if not exists ${t.edges}_target on ${t.edges}(target)`,
    `create table if not exists ${t.chunks}(page_id text not null, ord integer not null, embedding F32_BLOB(${dim}), primary key(page_id, ord))`,
    `create index if not exists ${t.fts} on ${t.nodes} using fts (${TURSO_COLS}) with (weights = '${TURSO_WEIGHTS}')`,
  ],
  lexical: TURSO_FTS,
  vectorTop: LIBSQL_DIALECT.vectorTop,
  statPut: LIBSQL_DIALECT.statPut,
  statRows: LIBSQL_DIALECT.statRows,
  statDdl: LIBSQL_DIALECT.statDdl,
};

/** The org tier (RAI-312, RAI-314 Q7): Turso's rows, and the stat is the RowVault's row revision, an
 *  opaque version as at the edge. Two slots: recall reads the live one, and a migration (a new
 *  embedder or schema) fills the other and flips. */
export const ORG_DIALECT: Dialect = {
  ...TURSO_DIALECT,
  statPut: DO_SQLITE_DIALECT.statPut,
  statRows: DO_SQLITE_DIALECT.statRows,
  statDdl: DO_SQLITE_DIALECT.statDdl,
};
export const ORG_SLOTS: readonly string[] = ["_a", "_b"];

// ── rows ─────────────────────────────────────────────────────────────────────────────────────────
/** One page ready to write: the item and one vector per chunk, or null = the slot already holds
 *  exactly this row (same fingerprint and generation record): only `write_actor` may move. */
export interface IndexRow { item: MemoryItem; vectors: Float32Array[] | null }
/** One index change: a row to write, an id to drop, or the stat of a page a write swapped (RAI-318). */
export type IndexOp = { put: IndexRow } | { del: string } | { stat: PageSwap };
/** The page an op names. */
export const opId = (o: IndexOp): string => ("put" in o ? o.put.item.id : "del" in o ? o.del : o.stat.id);

type NodeRow = {
  id: string; path: string | null; title: string; type: string | null; body: string; trust: string;
  volatile: number; freshness: number | null; description: string | null; resource: string | null;
  source: string | null; authored: number | null; write_actor: string | null; frontmatter: string | null;
};
type Fresh = MemoryItem & { volatile?: boolean; freshness?: string | null };

const json = (ids: Iterable<string>) => JSON.stringify([...ids]);
const fmOf = (s: string | null | undefined): ScalarFrontmatter | null => (s == null ? null : (JSON.parse(s) as ScalarFrontmatter));
const iso = (s: number | null) => (s == null ? null : new Date(s * 1000).toISOString());
/** A vector's own little-endian float32 bytes, never a view's whole buffer. */
const blob = (v: Float32Array) => new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
const f32 = (b: ArrayBuffer | Uint8Array) => (b instanceof Uint8Array ? new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) : new Float32Array(b));
function firstPerPage(pages: string[], n: number): string[] {
  const out: string[] = [];
  for (const p of pages) { if (!out.includes(p)) out.push(p); if (out.length >= n) break; }
  return out;
}

// ── the build ────────────────────────────────────────────────────────────────────────────────────
/** What one full build reports (and the CLI prints). */
export interface BuildResult {
  files: number;
  /** Rows written with new vectors (new or content-changed pages). */
  indexed: number;
  /** Pages whose content fingerprint was unchanged: no re-embed. */
  skipped: number;
  tombstoned: number;
  /** Rows the finalize removed: pages gone from the vault, or excluded. */
  pruned: number;
  /** Pages whose frontmatter is malformed: skipped fail-closed, stat still recorded (ADR-0012). */
  unparsed: string[];
}
const emptyResult = (): BuildResult => ({ files: 0, indexed: 0, skipped: 0, tombstoned: 0, pruned: 0, unparsed: [] });

/** The committed position of a running build (meta `build_cursor`). It is a position, not a
 *  "partial index" flag: `reindex_dirty` is that flag. */
interface BuildCursor {
  spec: string;
  reason: string;
  phase: "refs" | "pages";
  after: VaultPath | null;
  okf: OkfCounts | null;
  skipped: number;
  /** The slot suffix the build fills (absent: the shadow slot of two, else the one). */
  slot?: string;
}

/** What a host hands the walk. */
export interface BuildInput {
  /** `list({exclude, after})` in bytewise UTF-8 path order; `read` returns the version WITH the bytes. */
  vault: Vault;
  exclude?: (rel: string) => boolean;
  /** Stamped at finalize: a signature stamps, null clears (a configless rebuild), undefined keeps. */
  scope?: ScopeSignature | null;
  /** The star the build claims the index for: a compare-and-set at finalize (RAI-157). */
  owner?: { id: string; was?: string | null };
  /** Count the OKF floor (default true; `memory.okf: false` passes false). */
  okf?: boolean;
  /** The OKF counts of the files the port never lists (a folder's `index.md`, `log.md`), taken at begin. */
  reserved?: () => Promise<OkfCounts>;
  /** Why the build runs (the edge triggers); default "operator". */
  reason?: string;
  /** Concurrent reads and embeds per batch (the edge: 6, its connection limit). Default 1. */
  lanes?: number;
  /** A page above this many bytes is skipped and counted; its stat is still recorded (DO: 2 MB a row). */
  maxPageBytes?: number;
  /** Pages per batch (default 32; the edge alarm passes its own per step). */
  batch?: number;
  /** Per committed batch, with the running counts. */
  onBatch?: (r: BuildResult) => void;
  /** Inside the finalize transaction, after the slot went live (the edge clears its own marks). */
  onFinalize?: () => void;
}

const decoder = new TextDecoder();
/** A page's aliases as the reference maps read them, or null; the same reader in both passes, so
 *  the staleness check compares like with like. */
/** The OKF counts a build starts from: the reserved files' (null when the star counts nothing). */
async function okfBase(input: BuildInput): Promise<OkfCounts | null> {
  return input.okf === false ? null : input.reserved ? await input.reserved() : { nonconformant: 0, malformed: 0 };
}

function aliasesOf(bytes: Uint8Array): string | null {
  try {
    const a = parseFrontmatter(decoder.decode(bytes)).data.aliases;
    return a == null ? null : JSON.stringify(a);
  } catch {
    return null; // the id stands, the aliases are skipped
  }
}

/** One walked file against the OKF floor (ADR-0012): the OKF scope is the index scope minus the
 *  incoming zone; a file the normalizer would edit or refuse is nonconformant. */
export function countOkf(okf: OkfCounts, rel: string, bytes: Uint8Array): void {
  if (zoneOfFile(rel) === "incoming") return;
  const n = normalizePage(bytes, { path: rel });
  if ("invalid" in n || n.edit !== "none") okf.nonconformant++;
  if ("invalid" in n && n.invalid === "malformed") okf.malformed++;
}

async function inLanes<T, R>(xs: T[], lanes: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(lanes, xs.length)) }, async () => {
    for (let i = next++; i < xs.length; i = next++) out[i] = await fn(xs[i]!);
  }));
  return out;
}

// ── the module ───────────────────────────────────────────────────────────────────────────────────
export interface SqlIndexOpts {
  exec: SqlExec;
  dialect: Dialect;
  embedder: Embedder;
  /** Slot suffixes: [""] (home, org; the default) or ["_a", "_b"] (the edge: recall reads the live
   *  slot, a build fills the other and flips `live_slot`). */
  slots?: readonly string[];
  /** provenance-v1 STAMPED actor of every row this handle writes; "unknown" never overwrites one. */
  writeActor?: string;
  /** RAI-307: recheck `embedding_signature` and `schema_version` inside every write transaction. */
  recheck?: boolean;
  /** Where the index is, for messages. */
  where?: string;
  /** Two slots only (the org tier, RAI-314 Q10): a build whose schema and embedding spec are the live
   *  slot's fills the live slot in place, so writes proceed; any other build fills the shadow slot. */
  inPlaceOnSameSpec?: boolean;
}

export class SqlIndex implements ServingIndex {
  readonly x: SqlExec;
  readonly dialect: Dialect;
  readonly embedder: Embedder;
  private readonly slots: readonly string[];
  private readonly writeActor: string;
  private readonly doRecheck: boolean;
  private readonly where: string;
  private readonly inPlaceOnSameSpec: boolean;
  private cols: Set<string> | null = null;
  /** The reference maps of the running build, per spec: built once per process, not per batch. */
  private maps: { spec: string; maps: ReferenceMaps } | null = null;

  constructor(o: SqlIndexOpts) {
    this.x = o.exec;
    this.dialect = o.dialect;
    this.embedder = o.embedder;
    this.slots = o.slots ?? [""];
    this.writeActor = o.writeActor ?? "unknown";
    this.doRecheck = o.recheck === true;
    this.where = o.where ?? "this index";
    this.inPlaceOnSameSpec = o.inPlaceOnSameSpec === true;
  }

  /** The embedding spec rows are built under. Read live: a canary drift moves the edge's `cfp`. */
  get sig(): string {
    return `${embeddingSignature(this.embedder)}:${CHUNK_SIG}`;
  }

  // ── schema and meta ────────────────────────────────────────────────────────────────────────────
  /** Every slot's tables, `if not exists`, and the build tables (outside every slot). */
  createTables(): void {
    this.x.run("create table if not exists meta(key text primary key, value text)");
    for (const sfx of this.slots) {
      const t = slotTables(sfx);
      for (const s of this.dialect.ddl(t, this.embedder.dim)) this.x.run(s);
      this.x.run(this.dialect.statDdl(t));
    }
    this.x.run("create table if not exists build_refs(id text primary key, aliases text)");
    this.x.run("create table if not exists build_stat(id text primary key, version text, hash text)");
    this.cols = null;
  }
  /** The additive column at libsql "4" (ADR-0007's precedent): absent on an index built before it.
   *  Run only by a writable open, after its guards. */
  addColumns(): void {
    for (const sfx of this.slots) {
      const t = slotTables(sfx);
      const cols = new Set(this.x.all<{ name: string }>(`pragma table_info(${t.nodes})`).map((r) => r.name));
      if (!cols.has("gen_record")) this.x.run(`alter table ${t.nodes} add column gen_record text`);
      if (!this.hasHash(t.stat)) this.x.run(`alter table ${t.stat} add column hash text`); // RAI-318
    }
    if (!this.hasHash("build_stat")) this.x.run("alter table build_stat add column hash text");
    this.cols = null;
  }
  private hasColumn(c: string): boolean {
    const t = this.live() ?? slotTables(this.slots[0]);
    this.cols ??= new Set(this.x.all<{ name: string }>(`pragma table_info(${t.nodes})`).map((r) => r.name));
    return this.cols.has(c);
  }
  /** RAI-318: the additive `hash` column of a stat table (absent on an index built before 0.6.0). */
  private hasHash(table: string): boolean {
    return this.x.all<{ name: string }>(`pragma table_info(${table})`).some((r) => r.name === "hash");
  }
  private tableExists(name: string): boolean {
    return this.x.all("select 1 from sqlite_master where name=?", [name]).length > 0;
  }

  meta(key: string): string | null {
    return this.x.all<{ value: string }>("select value from meta where key=?", [key])[0]?.value ?? null;
  }
  setMeta(key: string, value: string | null): void {
    if (value == null) this.x.run("delete from meta where key=?", [key]);
    else this.x.run("insert into meta(key,value) values (?,?) on conflict(key) do update set value=excluded.value", [key, value]);
  }

  /** The slot recall reads: the one slot, or `live_slot` (null before the first build). */
  live(): Slot | null {
    if (this.slots.length === 1) return slotTables(this.slots[0]);
    const s = this.meta("live_slot");
    return s == null ? null : slotTables(`_${s}`);
  }
  /** The slot a build fills: the running build's, else the one a build begun now would fill. */
  buildSlot(): Slot {
    return slotTables(this.cursor()?.slot ?? this.nextSlot());
  }
  /** In place for one slot. Of two, the one recall does not read — or, under `inPlaceOnSameSpec`, the
   *  live one when the build that made it ran under this schema and embedding spec. */
  private nextSlot(): string {
    if (this.slots.length === 1) return this.slots[0]!;
    const s = this.meta("live_slot");
    if (s != null && this.inPlaceOnSameSpec) {
      const spec = JSON.parse(this.meta("build_spec") ?? "{}") as { schema?: string; sig?: string };
      if (spec.schema === this.dialect.schemaVersion && spec.sig === this.sig) return `_${s}`;
    }
    return s === "a" ? "_b" : "_a";
  }
  /** Does the build fill the slot recall reads? Then writes proceed during it (RAI-314 Q10). */
  private fillsLive(c: BuildCursor): boolean {
    return this.slots.length === 1 || (c.slot != null && c.slot === `_${this.meta("live_slot")}`);
  }
  /** A build fills the shadow slot: every mutation refuses `building` until the flip, because the
   *  shadow slot would miss it (RAI-314 Q10). */
  get shadowBuilding(): boolean {
    const c = this.cursor();
    return c != null && !this.fillsLive(c);
  }

  /** RAI-307: the per-write recheck. An open-time guard protects nothing after the open: a handle that
   *  outlived an in-place `--fresh` would write into the rebuilt tables under its old signature. */
  recheck(): void {
    if (!this.doRecheck) return;
    const sig = this.meta("embedding_signature"), sv = this.meta("schema_version");
    if (sig !== this.sig || sv !== this.dialect.schemaVersion) {
      throw new Error(`funes: the index at ${this.where} was rebuilt by another build after this process opened it (signature "${sig}", schema "${sv}") — restart this process to reopen it.`);
    }
  }

  // ── writes ─────────────────────────────────────────────────────────────────────────────────────
  /** Chunk and embed pages. A page whose fingerprint the `from` slot holds, built under this embedding
   *  spec, reuses its vectors; one the `to` slot holds exactly gets no vectors (null: keep the row). */
  async embed(items: MemoryItem[], from: Slot | null = this.live(), to: Slot | null = from, lanes = 1): Promise<{ rows: IndexRow[]; unchanged: number }> {
    const reuse = from != null && this.meta("embedding_signature") === this.sig;
    const rows: IndexRow[] = new Array(items.length);
    const todo: Array<{ i: number; texts: string[] }> = [];
    let unchanged = 0;
    items.forEach((item, i) => {
      const was = from == null ? undefined : this.x.all<{ h: string | null; g: string | null }>(
        `select content_hash h, ${this.hasColumn("gen_record") ? "gen_record" : "null"} g from ${from.nodes} where id=?`, [item.id])[0];
      const same = was?.h === hashItem(item);
      if (same) unchanged++;
      if (same && reuse) {
        if (to === from && was!.g === JSON.stringify(generationRecord(item))) { rows[i] = { item, vectors: null }; return; }
        rows[i] = { item, vectors: this.x.all<{ e: ArrayBuffer | Uint8Array }>(`select embedding e from ${from.chunks} where page_id=? order by ord`, [item.id]).map((r) => f32(r.e)) };
        return;
      }
      todo.push({ i, texts: chunkText(`${item.title}\n${item.body}`) });
    });
    const flat = todo.flatMap((t) => t.texts);
    const per = Math.ceil(flat.length / Math.max(1, lanes)) || 1;
    const groups: string[][] = [];
    for (let i = 0; i < flat.length; i += per) groups.push(flat.slice(i, i + per));
    const vecs = (await inLanes(groups, lanes, (g) => this.embedder.embedPassages(g))).flat();
    let o = 0;
    for (const { i, texts } of todo) { rows[i] = { item: items[i]!, vectors: vecs.slice(o, o + texts.length) }; o += texts.length; }
    return { rows, unchanged };
  }

  /** Drop rows from a slot; returns the nodes removed and every row touched (all four tables). */
  private deleteRows(t: Slot, ids: string[]): { nodes: number; touched: number } {
    if (!ids.length) return { nodes: 0, touched: 0 };
    const j = json(ids);
    // RETURNING, not the change count: DO SQLite counts index and FTS shadow writes too
    const nodes = this.x.all(`delete from ${t.nodes} where id in (select value from json_each(?)) returning id`, [j]).length;
    const touched = nodes + this.dialect.lexical.del(this.x, t, j)
      + this.x.run(`delete from ${t.chunks} where page_id in (select value from json_each(?))`, [j])
      + this.x.run(`delete from ${t.edges} where source in (select value from json_each(?))`, [j]);
    return { nodes, touched };
  }

  /** Write rows set-wise (RAI-314): `nodes` and `edges` as one `insert … select … from json_each(?)`
   *  each, `chunks` as multi-row VALUES of at most 99 binds. Turso flushes its `fts` segment per
   *  statement, so per-row inserts cost it about 0.9 ms a row (RAI-321). */
  private writeRows(t: Slot, rows: Array<{ item: MemoryItem; vectors: Float32Array[] }>): void {
    if (!rows.length) return;
    const ids = json(rows.map((r) => r.item.id));
    this.x.run(`delete from ${t.chunks} where page_id in (select value from json_each(?))`, [ids]);
    this.x.run(`delete from ${t.edges} where source in (select value from json_each(?))`, [ids]);
    const cols = ["id", "path", "title", "type", "body", "content_hash", "trust", "volatile", "freshness", "description", "resource", "source", "authored", "write_actor", "frontmatter", "gen_record"];
    const values = rows.map(({ item: it }) => {
      const f = it as Fresh;
      return [it.id, it.path ?? null, it.title, it.type ?? null, it.body, hashItem(it), it.trust ?? "untrusted", f.volatile === true ? 1 : 0, epochSeconds(f.freshness),
        it.description ?? null, it.resource ?? null, it.source ?? null, epochSeconds(it.authored), this.writeActor, canonicalFrontmatter(it.frontmatter),
        JSON.stringify(generationRecord(it))];
    });
    this.x.run(
      `insert into ${t.nodes}(${cols.join(",")})
       select ${cols.map((_, i) => `value ->> ${i}`).join(", ")} from json_each(?) where true
       on conflict(id) do update set path=excluded.path, title=excluded.title, type=excluded.type, body=excluded.body, content_hash=excluded.content_hash,
         trust=excluded.trust, volatile=excluded.volatile, freshness=excluded.freshness, description=excluded.description, resource=excluded.resource,
         source=excluded.source, authored=excluded.authored, frontmatter=excluded.frontmatter, gen_record=excluded.gen_record,
         write_actor=coalesce(nullif(excluded.write_actor,'unknown'), ${t.nodes}.write_actor)`,
      [JSON.stringify(values)],
    );
    for (const { item } of rows) this.dialect.lexical.put(this.x, t, item);
    const chunks = rows.flatMap(({ item, vectors }) => vectors.map((v, ord) => [item.id, ord, blob(v)] as SqlValue[]));
    for (let i = 0; i < chunks.length; i += 33) {
      const part = chunks.slice(i, i + 33);
      this.x.run(`insert into ${t.chunks}(page_id,ord,embedding) values ${part.map(() => "(?,?,?)").join(",")}`, part.flat());
    }
    const edges = rows.flatMap(({ item }) => (item.edges ?? []).map((e) => [item.id, e.type, e.target, e.weight ?? 1]));
    if (edges.length) {
      this.x.run(`insert or ignore into ${t.edges}(source,type,target,weight) select value ->> 0, value ->> 1, value ->> 2, value ->> 3 from json_each(?)`, [JSON.stringify(edges)]);
    }
  }

  /** The writes, in order, into a slot (the live one by default). Sync: the caller owns the
   *  transaction. EVIDENCE-DRIVEN invalidation (item 11): only a row whose generation record moved,
   *  or a delete that touched a row, clears the content generation. While an in-place build runs,
   *  each write also records a `build_stat` row (version unknown), so the finalize never prunes it. */
  apply(ops: IndexOp[], t: Slot | null = this.live()): { removed: number } {
    if (!ops.length) return { removed: 0 };
    if (t == null) throw new Error("funes: no live slot — a full build must run before a write");
    this.recheck();
    let moved = 0, removed = 0;
    // consecutive puts write set-wise; a delete between them keeps the order of the ops
    let puts: Array<{ item: MemoryItem; vectors: Float32Array[] }> = [];
    const flush = () => { this.writeRows(t, puts); puts = []; };
    for (const op of ops) {
      if ("stat" in op) { // RAI-318: the write path records the stat of the page it swapped
        const { id, version, hash } = op.stat;
        if (version == null) this.x.run(`delete from ${t.stat} where id=?`, [id]);
        else this.dialect.statPut(this.x, t, id, version, hash);
        continue;
      }
      if ("del" in op) {
        flush();
        // the stat row stays: a page off the index can still be on disk (a tombstone)
        const r = this.deleteRows(t, [op.del]);
        moved += r.touched;
        removed += r.nodes;
        continue;
      }
      const { item, vectors } = op.put;
      if (puts.some((p) => p.item.id === item.id)) flush(); // one id twice: read and write after the first lands
      const g = JSON.stringify(generationRecord(item));
      const was = this.x.all<{ h: string | null; g: string | null }>(`select content_hash h, gen_record g from ${t.nodes} where id=?`, [item.id])[0];
      if (vectors == null) {
        if (was?.g !== g || was.h !== hashItem(item)) throw new Error(`funes: the row of "${item.id}" changed since it was embedded — retry the write`);
        this.x.run(`update ${t.nodes} set write_actor=coalesce(nullif(?,'unknown'), write_actor) where id=?`, [this.writeActor, item.id]);
        continue;
      }
      if (was?.g !== g) moved++;
      puts.push({ item, vectors });
    }
    flush();
    // RAI-307 Q2: the clear writes only generation = null; a shadow slot serves nothing yet
    if (moved && t.nodes === this.live()?.nodes) this.setMeta("generation", null);
    const c = this.cursor();
    if (c != null && this.fillsLive(c)) {
      for (const op of ops) {
        if ("stat" in op) this.x.run("insert or replace into build_stat(id, version, hash) values (?, ?, ?)", [op.stat.id, op.stat.version, op.stat.hash]);
        else this.x.run("insert or ignore into build_stat(id, version) values (?, null)", [opId(op)]);
        // A page a write brings into being gets its ref too, so the build does not restart on each new
        // page. A funes write declares no aliases; a page that does fails pass 2's alias check (Q5b).
        if (("put" in op || ("stat" in op && op.stat.version != null)) && this.x.run("insert or ignore into build_refs(id, aliases) values (?, null)", [opId(op)])) this.maps = null;
      }
    }
    return { removed };
  }

  /** Embed, then write in one transaction (the libsql and Turso write path; the edge stages instead). */
  async remember(items: MemoryItem[], swaps: PageSwap[] = []): Promise<RememberResult> {
    if (!items.length && !swaps.length) return { indexed: 0, skipped: 0 };
    const { rows, unchanged } = await this.embed(items);
    this.x.tx(() => this.apply([...rows.map((put) => ({ put })), ...swaps.map((stat) => ({ stat }))]));
    return { indexed: items.length - unchanged, skipped: unchanged };
  }
  async remove(ids: string[], swaps: PageSwap[] = []): Promise<number> {
    if (!ids.length && !swaps.length) return 0;
    return this.x.tx(() => this.apply([...ids.map((del) => ({ del })), ...swaps.map((stat) => ({ stat }))])).removed;
  }

  // ── recall: one await (the query vector), then one synchronous snapshot ─────────────────────────
  private jsVectorTop(t: Slot, qv: Float32Array, n: number, allowed: Set<string> | null): string[] {
    let qn = 0;
    for (const q of qv) qn += q * q;
    qn = Math.sqrt(qn) || 1;
    const scored: Array<{ p: string; o: number; v: number }> = [];
    // ponytail: exact scan of every chunk per recall (~13 MB at 3.2k × 1024); quantize or index past ~2e4 chunks.
    for (const r of this.x.iterate<{ page_id: string; ord: number; embedding: ArrayBuffer | Uint8Array }>(`select page_id, ord, embedding from ${t.chunks}`)) {
      if (allowed && !allowed.has(r.page_id)) continue;
      const e = f32(r.embedding);
      let dot = 0, en = 0;
      for (let i = 0; i < e.length; i++) { dot += e[i]! * qv[i]!; en += e[i]! * e[i]!; }
      scored.push({ p: r.page_id, o: r.ord, v: dot / ((Math.sqrt(en) || 1) * qn) });
    }
    scored.sort((a, b) => b.v - a.v || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0) || a.o - b.o);
    return firstPerPage(scored.slice(0, n * 3).map((c) => c.p), n);
  }

  private graphArm(t: Slot, seeds: string[], fts: string[], vec: string[], limit: number): string[] {
    if (!seeds.length) return [];
    const seedBestRank = new Map<string, number>();
    for (const list of [fts, vec]) list.forEach((id, i) => seedBestRank.set(id, Math.min(i, seedBestRank.get(id) ?? i)));
    const rows = this.x.all<{ seed: string; cand: string }>(
      `with pairs as (select distinct e.source as seed, e.target as cand from ${t.edges} e join ${t.nodes} nn on nn.id = e.target
                        where e.source in (select value from json_each(?))),
            ranked as (select seed, cand, row_number() over (partition by seed order by cand) rn from pairs)
       select seed, cand from ranked where rn <= ${GRAPH_ARM_CAP_OUT} order by seed, cand`, [json(seeds)])
      .map((r) => ({ seed: r.seed, candidate: r.cand }));
    return buildGraphArm({ seeds, seedBestRank, rows, graphListMax: 4 * limit });
  }

  async recall(q: RecallQuery): Promise<RecallResult[]> {
    const qv = await this.embedder.embedQuery(q.query);
    // Nothing below awaits: every read is of one state (the DO opens no input gate).
    const t = this.live();
    if (t == null) return [];
    const limit = q.k ?? 5;
    const n = Math.max(limit * 4, 20);
    const fm = this.hasColumn("frontmatter");
    // ADR-0013: the planner's allowed set — the pages whose stored frontmatter passes the compiled
    // `where` — bound into BOTH arms as one JSON array (so a selective filter cannot starve k) and
    // applied again to the fused list, which covers the graph arm's candidates.
    // ponytail: matchesFilter over every row per filtered query; fine at ~3k rows, compile the filter
    // to json_extract SQL if a declaring star nears ~10^5.
    let allowed: Set<string> | null = null;
    if (q.filter) {
      if (!fm) throw new Error("funes: `where` refused — this index has no `frontmatter` column (an artefact built before 0.5.0); reindex the star on its writer. Unfiltered recall still serves.");
      allowed = new Set();
      for (const r of this.x.iterate<{ id: string; frontmatter: string | null }>(`select id, frontmatter from ${t.nodes}`)) {
        if (matchesFilter(fmOf(r.frontmatter), q.filter)) allowed.add(r.id);
      }
      if (!allowed.size) return [];
    }
    const o = allowed ? json(allowed) : null;
    const terms = ftsTerms(q.query).map((w) => `"${w.replace(/"/g, '""')}"`).join(" OR ");
    const fts = terms ? this.dialect.lexical.top(this.x, t, terms, n, o) : [];
    const vec = this.dialect.vectorTop ? this.dialect.vectorTop(this.x, t, qv, n, o) : this.jsVectorTop(t, qv, n, allowed);
    // the bounded OUT-only graph arm from the top FTS+vec seeds, fused at DEFAULT_RRF_K
    const graph = this.graphArm(t, [...new Set([...fts.slice(0, limit), ...vec.slice(0, limit)])], fts, vec, limit);
    const scores = rrfScores([fts, vec, graph], DEFAULT_RRF_K);
    const merged = rrf([fts, vec, graph], DEFAULT_RRF_K, { tieBreakIds: true });
    // existence-filter BEFORE slicing (dangling edge targets must not starve results below k)
    const byId = new Map<string, NodeRow>();
    for (const r of this.x.all<NodeRow>(
      `select id,path,title,type,body,trust,volatile,freshness,description,resource,source,authored,write_actor,${fm ? "frontmatter" : "null as frontmatter"}
       from ${t.nodes} where id in (select value from json_each(?))`, [json(merged)])) byId.set(r.id, r);
    const all: RecallResult[] = [];
    for (const id of merged) {
      const r = byId.get(id);
      if (!r || (allowed && !allowed.has(id))) continue;
      all.push({
        id, title: r.title, path: r.path ?? undefined, score: scores.get(id) ?? 0, trust: r.trust as Trust,
        description: r.description ?? undefined, resource: r.resource ?? undefined, source: r.source ?? undefined,
        authored: iso(r.authored) ?? undefined, writeActor: r.write_actor ?? undefined, volatile: r.volatile === 1 ? true : undefined,
        freshness: r.freshness != null ? iso(r.freshness)!.slice(0, 10) : undefined, frontmatter: fmOf(r.frontmatter) ?? undefined,
      });
    }
    const out = rankRecall(all, q, (h) => { const r = byId.get(h.id); return r ? { volatile: r.volatile === 1, fresh: r.freshness } : undefined; }).slice(0, limit);
    out.forEach((h, i) => { h.rank = i + 1; });
    return out;
  }

  // ── reads ──────────────────────────────────────────────────────────────────────────────────────
  /** One page's INDEXED snapshot, by node id or stored path, from the live slot only. */
  async indexedPage(ref: { id?: string; path?: string }): Promise<IndexedPage | null> {
    const t = this.live();
    const keys = [ref.id, ref.path, ref.path?.replace(/\.md$/, "")].filter((k): k is string => !!k);
    if (t == null || !keys.length) return null;
    const r = this.x.all<NodeRow>(
      `select id,path,title,type,body,trust,description,resource,source,authored,write_actor,${this.hasColumn("frontmatter") ? "frontmatter" : "null as frontmatter"} from ${t.nodes}
       where id in (select value from json_each(?)) or path in (select value from json_each(?)) limit 1`, [json(keys), json(keys)])[0];
    return r
      ? { id: r.id, path: r.path, title: r.title, type: r.type, trust: r.trust, description: r.description, resource: r.resource,
          source: r.source, authored: iso(r.authored), writeActor: r.write_actor ?? "unknown", body: r.body, frontmatter: fmOf(r.frontmatter) }
      : null;
  }

  /** What this database says it IS. A LEGACY stamp (not this GENERATION_VERSION) is reported null,
   *  never reinterpreted (item 8); RAI-307 Q2: no invalidation record is kept. */
  contentIdentity(): ContentIdentity {
    const stamped = this.meta("generation");
    const valid = stamped != null && stamped.startsWith(`${GENERATION_VERSION}:`);
    return {
      contentGeneration: valid ? stamped : null,
      invalidatedAt: null,
      invalidatedReason: stamped != null && !valid ? `legacy ${stamped.split(":")[0]} stamp — not a content generation; reindex to establish one` : null,
    };
  }

  scopeSignature(): ScopeSignature | null {
    const hash = this.meta("index_scope_hash");
    return hash ? { hash, ignoreScope: this.meta("index_scope_ignored") === "1" } : null;
  }

  /** Synchronous reads only (the edge reads it beside a recall with no input gate between). */
  statsSync(): IndexStats {
    const t = this.live();
    const count = (tb: string) => this.x.all<{ c: number }>(`select count(*) as c from ${tb}`)[0]!.c;
    const trust: Record<string, number> = {};
    const zones = { incoming: 0, output: 0, wiki: 0 };
    if (t != null) {
      for (const r of this.x.all<{ trust: string; c: number }>(`select trust, count(*) as c from ${t.nodes} group by trust`)) trust[r.trust] = Number(r.c);
      for (const r of this.x.iterate<{ id: string }>(`select id from ${t.nodes}`)) zones[zoneOfFile(r.id)]++;
    }
    const scope = this.scopeSignature();
    const okfN = this.meta("okf_nonconformant"), okfM = this.meta("okf_malformed");
    return {
      nodes: t ? Number(count(t.nodes)) : 0, edges: t ? Number(count(t.edges)) : 0, chunks: t ? Number(count(t.chunks)) : 0, trust, zones,
      embeddingSignature: this.meta("embedding_signature"),
      // The edge never sets it: only a slot flip makes a slot live, so the live slot is always complete.
      reindexDirty: this.meta("reindex_dirty") === "1",
      lastReindexAt: this.meta("last_reindex_at"),
      scopeHash: scope?.hash ?? null, ignoreScope: scope?.ignoreScope ?? false,
      schemaVersion: this.meta("schema_version"), // what is stamped, not what this process serves
      okf: okfN == null || okfM == null ? null : { nonconformant: Number(okfN), malformed: Number(okfM) },
      ...this.contentIdentity(),
    };
  }
  async stats(): Promise<IndexStats> {
    return this.statsSync();
  }

  /** The live slot's stat record and its stamp; null when there is none to compare against (no live
   *  slot, or a read-only artefact built before the table existed) — never an empty record. */
  async pageStats(): Promise<PageStatRecord | null> {
    const t = this.live();
    if (t == null || !this.tableExists(t.stat)) return null;
    return { at: this.meta("page_stat_at"), rows: this.dialect.statRows(this.x, t, this.hasHash(t.stat)) };
  }

  /** H9 + item 16: check, retrieve, RECHECK — `expected` re-evaluated on the way out. */
  async guardedRead<T>(expected: () => ScopeExpectation, retrieve: () => Promise<T>): Promise<GuardedResult<T>> {
    const state = () => {
      const s = this.scopeSignature();
      return { scopeHash: s?.hash ?? null, ignoreScope: s?.ignoreScope ?? false, reindexDirty: this.meta("reindex_dirty") === "1" };
    };
    const r1 = expectationRefusal(state(), expected());
    if (r1) return { refusal: r1 };
    const value = await retrieve();
    const r2 = expectationRefusal(state(), expected());
    return r2 ? { refusal: r2 } : { ok: value };
  }

  servingSignature(): string {
    return servingSignature(this.dialect.backend);
  }

  async close(): Promise<void> {}

  // ── the one build walk ───────────────────────────────────────────────────────────────────────
  /** What a build is built under. A cursor begun under another spec restarts from the top (vectors
   *  are reused, so it is cheap); a live index built under another one is a trigger at the edge. */
  buildSpec(input: Pick<BuildInput, "scope">): string {
    const scope = input.scope === undefined ? this.meta("index_scope_hash") : (input.scope?.hash ?? null);
    return JSON.stringify({ schema: this.dialect.schemaVersion, parser: PARSER_VERSION, generation: GENERATION_VERSION, sig: this.sig, scope });
  }
  /** Present ⇔ a build is running. */
  get building(): boolean {
    return this.meta("build_cursor") != null;
  }
  private cursor(): BuildCursor | null {
    const c = this.meta("build_cursor");
    return c == null ? null : (JSON.parse(c) as BuildCursor);
  }

  /** Begin (or restart under a new spec): one transaction. In place, `reindex_dirty` marks the index;
   *  a shadow slot is emptied while recall keeps reading the live one. A no-op while a build begun
   *  under the same spec runs. */
  async begin(input: BuildInput): Promise<void> {
    const spec = this.buildSpec(input);
    if (this.cursor()?.spec === spec) return;
    // RAI-157: the owner claim refuses before the build touches a row; the finalize stamps it by CAS.
    const stamped = this.meta("owner_star_id");
    if (input.owner && !mayClaimIndex(stamped, input.owner.id, input.owner.was)) throw ownerClaimRefused(stamped!, input.owner.id);
    const c: BuildCursor = { spec, reason: input.reason ?? "operator", phase: "refs", after: null, okf: await okfBase(input), skipped: 0, slot: this.nextSlot() };
    const t = slotTables(c.slot);
    this.x.tx(() => {
      this.recheck();
      if (this.fillsLive(c)) this.setMeta("reindex_dirty", "1");
      else {
        for (const tb of [t.nodes, t.edges, t.chunks, t.stat]) this.x.run(`delete from ${tb}`);
        this.dialect.lexical.keepOnly(this.x, t, "select null where 0"); // Turso's `fts` is an index on nodes, not a table
      }
      this.x.run("delete from build_refs");
      this.x.run("delete from build_stat");
      this.setMeta("build_cursor", JSON.stringify(c));
    });
    this.maps = null;
  }

  /** Back to pass 1 under the same spec (the staleness check): the refs, the seen-set and the counts
   *  restart, so pass 2 counts each page once. */
  private async restartRefs(input: BuildInput, c: BuildCursor, r: BuildResult): Promise<"more"> {
    const okf = await okfBase(input);
    this.x.tx(() => {
      this.x.run("delete from build_refs");
      this.x.run("delete from build_stat");
      this.setMeta("build_cursor", JSON.stringify({ ...c, phase: "refs", after: null, okf, skipped: 0 }));
    });
    this.maps = null;
    Object.assign(r, emptyResult(), { indexed: r.indexed });
    return "more";
  }

  /** At most `max` paths strictly after `after`, in the port's bytewise order. */
  private async listAfter(input: BuildInput, after: VaultPath | null, max: number): Promise<{ page: VaultPath[]; more: boolean }> {
    const page: VaultPath[] = [];
    for await (const e of input.vault.list({ exclude: input.exclude, after: after ?? undefined })) {
      if (after != null && pathOrder(e.path, after) <= 0) continue; // an adapter that ignores `after`
      if (page.length === max) return { page, more: true };
      page.push(e.path);
    }
    return { page, more: false };
  }

  /** The whole build, batch after batch, from wherever its cursor stands (a crashed build resumes). */
  async build(input: BuildInput): Promise<BuildResult> {
    const r = emptyResult();
    while ((await this.buildStep(input, input.batch ?? 32, r)) === "more");
    return r;
  }

  /** One batch: everything it did commits with the advanced cursor, so a restart resumes after the
   *  last committed path. "done" after the finalize. */
  async buildStep(input: BuildInput, budget: number, r: BuildResult = emptyResult()): Promise<"more" | "done"> {
    await this.begin(input);
    const c = this.cursor()!;
    const t = this.buildSlot();
    const lanes = input.lanes ?? 1;
    const { page, more } = await this.listAfter(input, c.after, budget);
    const reads = await inLanes(page, lanes, (p) => input.vault.read(p));

    if (c.phase === "refs") { // pass 1: every page's id and aliases, so pass 2 resolves across batches
      const refs: Array<[string, string | null]> = [];
      page.forEach((p, i) => { const f = reads[i]; if (f) refs.push([p.slice(0, -3), aliasesOf(f.bytes)]); });
      const next: BuildCursor = more ? { ...c, after: page.at(-1)! } : { ...c, phase: "pages", after: null };
      this.x.tx(() => {
        this.recheck();
        for (const [id, a] of refs) this.x.run("insert or replace into build_refs(id, aliases) values (?,?)", [id, a]);
        this.setMeta("build_cursor", JSON.stringify(next));
      });
      this.maps = null;
      // a pass 1 that ended in this batch goes on to pass 2 at once: a star of one batch builds in one step
      return more ? "more" : this.buildStep(input, budget, r);
    }

    // pass 2: read, parse, check the refs, resolve, embed (outside any transaction), then one transaction
    if (this.maps?.spec !== c.spec) {
      const rows = this.x.all<{ id: string; aliases: string | null }>("select id, aliases from build_refs");
      this.maps = { spec: c.spec, maps: referenceMaps(rows.map((x) => ({ id: x.id, aliases: x.aliases == null ? undefined : JSON.parse(x.aliases) }))) };
    }
    const maps = this.maps.maps;
    const okf = c.okf ? { ...c.okf } : null;
    let skipped = c.skipped;
    const stats: Array<[string, string, string]> = [], drop: string[] = [], items: MemoryItem[] = [];
    const refOf = (id: string) => this.x.all<{ a: string | null }>("select aliases a from build_refs where id=?", [id])[0];
    for (let i = 0; i < page.length; i++) {
      const p = page[i]!, f = reads[i];
      if (!f) { skipped++; continue; } // gone since the listing: no stat, so the finalize prunes it
      const id = p.slice(0, -3);
      r.files++;
      stats.push([id, f.version, sha256Hex(f.bytes)]); // the version that came WITH the bytes (ADR-0007), and their hash (RAI-318)
      const ref = refOf(id);
      if (ref === undefined || ref.a !== aliasesOf(f.bytes)) return this.restartRefs(input, c, r); // Q5b: the refs went stale
      if (input.maxPageBytes != null && f.bytes.length > input.maxPageBytes) { skipped++; drop.push(id); continue; }
      let read: ReturnType<typeof textToItemWithMeta>;
      try {
        if (okf) countOkf(okf, p, f.bytes);
        read = textToItemWithMeta(f.bytes, p);
      } catch { skipped++; drop.push(id); continue; } // a poison page: skipped and counted, never retried
      // 0.5.0 item 20 (ADR-0012): malformed is skipped fail-closed (its trust and tombstone are
      // unknowable), after its stat is recorded; a soft tombstone stays on disk and never enters.
      if (read.parseError !== undefined) { r.unparsed.push(id); skipped++; drop.push(id); continue; }
      if (isTombstoned(read.meta)) { r.tombstoned++; drop.push(id); continue; }
      resolveEdgeTargets(read.item, maps);
      items.push(read.item);
    }
    const { rows, unchanged } = await this.embed(items, this.live(), t, lanes);
    r.indexed += items.length - unchanged;
    r.skipped += unchanged;
    const next: BuildCursor = { ...c, after: page.at(-1) ?? c.after, okf, skipped };
    this.x.tx(() => {
      // RAI-314 Q10: a write that swapped a page after this batch read it recorded its newer version
      // in build_stat (an in-place build at the org tier, where writes proceed): its rows stand.
      const newer = new Set(stats.filter(([id, v]) => {
        const s = this.x.all<{ v: string | null }>("select version v from build_stat where id=?", [id])[0];
        return s !== undefined && s.v !== v;
      }).map(([id]) => id));
      for (const [id, v, h] of stats) if (!newer.has(id)) this.x.run("insert or replace into build_stat(id, version, hash) values (?,?,?)", [id, v, h]);
      this.apply([...drop.filter((id) => !newer.has(id)).map((del) => ({ del })), ...rows.filter((r) => !newer.has(r.item.id)).map((put) => ({ put }))], t);
      this.setMeta("build_cursor", JSON.stringify(next));
    });
    input.onBatch?.(r);
    if (more) return "more";
    return this.finalize(input, next, t, r);
  }

  /** One transaction: the staleness check (Q5b), the prune of what no stat row names, the stat swap,
   *  the generation from the rows' records, the stamps, the owner (compare-and-set), the flip. */
  private async finalize(input: BuildInput, c: BuildCursor, t: Slot, r: BuildResult): Promise<"more" | "done"> {
    const stale = this.x.all("select 1 from build_refs where id not in (select id from build_stat) union all select 1 from build_stat where id not in (select id from build_refs) limit 1").length > 0;
    if (stale) return this.restartRefs(input, c, r);
    this.x.tx(() => {
      this.recheck();
      const gone = this.x.all<{ id: string }>(`select id from ${t.nodes} where id not in (select id from build_stat)`).map((x) => x.id);
      r.pruned += this.deleteRows(t, gone).nodes;
      // orphans a crash between two tables could leave: rows of no node
      this.x.run(`delete from ${t.chunks} where page_id not in (select id from build_stat)`);
      this.x.run(`delete from ${t.edges} where source not in (select id from build_stat)`);
      this.dialect.lexical.keepOnly(this.x, t, "select id from build_stat");
      this.x.run(`delete from ${t.stat}`);
      for (const s of this.x.all<{ id: string; version: string | null; hash: string | null }>("select id, version, hash from build_stat")) {
        if (s.version != null) this.dialect.statPut(this.x, t, s.id, s.version, s.hash); // a removed page's row has no version
      }
      const records = this.x.all<{ g: string }>(`select gen_record g from ${t.nodes}`).map((x) => JSON.parse(x.g));
      const scope = input.scope === undefined ? this.scopeSignature() : input.scope;
      const at = new Date().toISOString();
      if (input.owner) {
        const stamped = this.meta("owner_star_id");
        if (!mayClaimIndex(stamped, input.owner.id, input.owner.was)) throw ownerClaimRefused(stamped!, input.owner.id);
        this.setMeta("owner_star_id", input.owner.id);
      }
      this.setMeta("generation", encodeGeneration({ records, scope, embeddingSpec: this.sig, parserVersion: PARSER_VERSION, indexSchemaVersion: this.dialect.schemaVersion }));
      this.setMeta("schema_version", this.dialect.schemaVersion);
      this.setMeta("embedding_signature", this.sig);
      this.setMeta("index_scope_hash", scope?.hash ?? null);
      this.setMeta("index_scope_ignored", scope ? (scope.ignoreScope ? "1" : "0") : null);
      this.setMeta("last_reindex_at", at);
      this.setMeta("page_stat_at", at);
      this.setMeta("okf_nonconformant", c.okf ? String(c.okf.nonconformant) : null);
      this.setMeta("okf_malformed", c.okf ? String(c.okf.malformed) : null);
      this.setMeta("build_spec", c.spec);
      this.setMeta("build_skipped", String(c.skipped));
      if (this.slots.length > 1) this.setMeta("live_slot", t.nodes.slice(-1));
      input.onFinalize?.();
      this.setMeta("reindex_dirty", null);
      this.setMeta("build_cursor", null);
      this.x.run("delete from build_refs");
      this.x.run("delete from build_stat");
    });
    this.maps = null;
    return "done";
  }

  /** The stamps of a completed build, written directly (a host that builds rows another way: the
   *  libsql store's operator fixture). One transaction; `pageStats` replaces the record wholesale. */
  stamp(f: { contentGeneration: string; scope?: ScopeSignature | null; pageStats?: PageStat[]; okf?: OkfCounts | null }): void {
    const at = new Date().toISOString();
    const t = this.live() ?? this.buildSlot();
    this.x.tx(() => {
      this.setMeta("generation", f.contentGeneration);
      if (f.scope === null) { this.setMeta("index_scope_hash", null); this.setMeta("index_scope_ignored", null); }
      else if (f.scope) { this.setMeta("index_scope_hash", f.scope.hash); this.setMeta("index_scope_ignored", f.scope.ignoreScope ? "1" : "0"); }
      this.setMeta("last_reindex_at", at);
      if (f.pageStats) {
        this.x.run(`delete from ${t.stat}`);
        for (const s of f.pageStats) this.dialect.statPut(this.x, t, s.id, s.version, s.hash ?? null);
        this.setMeta("page_stat_at", at);
      } else this.setMeta("page_stat_at", null);
      this.setMeta("okf_nonconformant", f.okf ? String(f.okf.nonconformant) : null);
      this.setMeta("okf_malformed", f.okf ? String(f.okf.malformed) : null);
      this.setMeta("reindex_dirty", null);
    });
  }
}
