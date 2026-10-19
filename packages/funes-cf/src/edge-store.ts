// The edge store (PLAN-0.5.0 item 37, ADR-0015, record 31): the taste star's index as a Durable
// Object's SQLite — a twin of funes-libsql's index, built and signed at the edge locus.
//
// - Two slots (`_a`, `_b`) of nodes (+ frontmatter), edges, chunks (L2-normalized float32 BLOBs),
//   FTS5 unicode61 weighted 0/10/3/1 and page_stat(id, version). `meta.live_slot` names the slot
//   recall reads; a full build fills the other one and goes live in one transactionSync (swap).
// - The writer's protocol tables (receipts, apply_journal, build_state, grants, login_seen,
//   mint_handles) sit
//   outside every slot: no build and no schema rebuild touches them.
// - Every id list binds ONE JSON array through json_each(?): DO SQLite allows 100 bound parameters.
// - The vector arm is libSQL's shape: an exact dot product in JS, the top n×3 chunks by (score desc,
//   page_id, ord), then the first chunk per page. Fusion and ranking are the shared code, so both
//   backends sign one rank/2.
// - Recall awaits only the query embedding, then reads one synchronous snapshot.
//
// What stays outside: the build driver (item 39, writer.ts: R2 listing, batches, the alarm), the
// embedder and its canary (item 38), the apply frame (item 35), edge health (item 40).
import type {
  Embedder, GuardedResult, IndexedPage, IndexStats, MemoryItem, OkfCounts, PageStat, PageStatRecord,
  RecallQuery, RecallResult, RememberResult, ScalarFrontmatter, ScopeExpectation, ScopeSignature, ServingIndex, Trust,
} from "funes-core";
import { buildGraphArm, chunkText, CHUNK_SIG, embeddingSignature, expectationRefusal, GRAPH_ARM_CAP_OUT, matchesFilter, rrf, rrfScores } from "funes-core";
import {
  encodeGeneration, ftsTerms, generationRecord, GENERATION_VERSION, hashItem, PARSER_VERSION, rankRecall, resolveRrfK,
  servingSignature, zoneOfFile, canonicalFrontmatter,
} from "funes-shared";

/** The edge index's own schema version, never libSQL's "4" (record 31): an input to the content
 *  generation, so an edge generation can never equal a Mac locus's. */
export const SCHEMA_VERSION = "do-sqlite/1";
/** fts5 bm25 weights over (nid, title, description, body) — libSQL's, so both sign one FTS shape. */
const BM25 = [0, 10, 3, 1] as const;
/** The edge resolves every serving setting from an empty env (record 31): no Worker variable moves
 *  RRF k or the graph arm, so the arm is always "v2" (out-only) and k the default. */
const ENV = {};
/** The versions a live slot is built under; a change starts a full build (record 31, trigger 2). */
const BUILT_VERSIONS = { schema: SCHEMA_VERSION, parser: PARSER_VERSION, generation: GENERATION_VERSION };
/** The one post-seed build waits this long after the last apply (record 31, trigger 4). */
const SEED_QUIET_MS = 15 * 60_000;

/** A running build's progress (item 39): the spec it began under, and its skip and OKF counts. */
export interface BuildProgress extends OkfCounts { spec: string; skipped: number }

type Slot = "a" | "b";
const other = (s: Slot): Slot => (s === "a" ? "b" : "a");
const SLOT_TABLES = ["nodes", "edges", "chunks", "nodes_fts", "page_stat"] as const;

/** One page ready to write: the item and one L2-normalized vector per chunk. */
export interface IndexRow {
  item: MemoryItem;
  vectors: Float32Array[];
}
/** One staged index change: a row to write, or an id to drop. */
export type IndexOp = { put: IndexRow } | { del: string };

type NodeRow = {
  id: string; path: string | null; title: string; type: string | null; body: string; trust: string;
  volatile: number; freshness: number | null; description: string | null; resource: string | null;
  source: string | null; authored: number | null; write_actor: string; frontmatter: string | null;
};

const json = (ids: Iterable<string>) => JSON.stringify([...ids]);
const fmOf = (s: string | null): ScalarFrontmatter | null => (s == null ? null : (JSON.parse(s) as ScalarFrontmatter));
const epoch = (v: unknown): number | null => {
  if (v == null) return null;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t / 1000;
};
const iso = (s: number | null) => (s == null ? null : new Date(s * 1000).toISOString());
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  const out = new Float32Array(v.length);
  if (n === 0) return out;
  const inv = 1 / Math.sqrt(n);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! * inv;
  return out;
}
/** The BLOB a vector is stored as: its own little-endian float32 bytes, never a view's whole buffer. */
const blob = (v: Float32Array): ArrayBuffer => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;

/** The writer's protocol tables, outside every slot (no build or schema rebuild touches them).
 *  Idempotent: the edge store runs it, and so does /mint (item 44), which needs no index. */
export function createProtocolTables(sql: SqlStorage): void {
  sql.exec(`
    create table if not exists receipts(proposal_id text primary key, payload_hash text not null, written_hash text not null, applied_at text not null);
    create table if not exists apply_journal(id integer primary key, state text not null default 'pending', step integer not null default 0,
      proposal_id text, payload_hash text, written_hash text, writes text not null, index_ops text, created_at text not null);
    create table if not exists build_state(id integer primary key check (id = 1), reason text not null, started_at text not null, last_key text);
    create table if not exists grants(token_sha256 text primary key, actor text not null, role text not null, stars text not null,
      created_at text not null, expires_at text, revoked_at text, label text not null);
    create table if not exists login_seen(hash text primary key, expires_at integer not null);
    create table if not exists mint_handles(handle_sha256 text primary key, expires_at integer not null);
  `);
}

export class EdgeStore implements ServingIndex {
  private readonly storage: DurableObjectStorage;
  private readonly sql: SqlStorage;
  private readonly embedder: Embedder;
  private readonly writeActor: string;
  /** Staged by remember/remove inside an apply frame; durable only at commit (S4). The apply journal
   *  carries a copy (item 35), so a restart commits exactly these rows. */
  staged: IndexOp[] = [];

  constructor(storage: DurableObjectStorage, embedder: Embedder, opts: { writeActor?: string } = {}) {
    this.storage = storage;
    this.sql = storage.sql;
    this.embedder = embedder;
    this.writeActor = opts.writeActor ?? "unknown";
    this.init();
  }

  /** The embedding spec the rows are built under: the embedder's signature plus the chunk signature.
   *  Read live, never cached: a canary drift (item 38) moves the embedder's `cfp` mid-instance. */
  private get sig(): string {
    return `${embeddingSignature(this.embedder)}:${CHUNK_SIG}`;
  }

  // ── schema ─────────────────────────────────────────────────────────────────────────────────
  private init(): void {
    this.sql.exec("create table if not exists meta(key text primary key, value text not null)");
    const stamped = this.meta("schema_version");
    if (stamped != null && stamped !== SCHEMA_VERSION) {
      // A schema rebuild recreates only the slot tables and the index meta (record 31). The
      // protocol tables survive it, and the empty index starts a full build (item 39).
      for (const s of ["a", "b"] as const) for (const t of SLOT_TABLES) this.sql.exec(`drop table if exists ${t}_${s}`);
      this.sql.exec("delete from meta");
      this.sql.exec("delete from index_dirty");
    }
    this.sql.exec("create table if not exists index_dirty(id text primary key)");
    createProtocolTables(this.sql);
    for (const s of ["a", "b"] as const) {
      this.sql.exec(`
        create table if not exists nodes_${s}(id text primary key, path text, title text not null, type text, body text not null,
          content_hash text not null, trust text not null, volatile integer not null, freshness real, description text, resource text,
          source text, authored real, write_actor text not null, frontmatter text, gen_record text not null);
        create table if not exists edges_${s}(source text not null, type text not null, target text not null, weight real not null,
          primary key(source, type, target));
        create index if not exists edges_${s}_target on edges_${s}(target);
        create table if not exists chunks_${s}(page_id text not null, ord integer not null, embedding blob not null, primary key(page_id, ord));
        create virtual table if not exists nodes_fts_${s} using fts5(nid unindexed, title, description, body, tokenize='unicode61');
        create table if not exists page_stat_${s}(id text primary key, version text not null);
      `);
    }
    if (stamped !== SCHEMA_VERSION) this.setMeta("schema_version", SCHEMA_VERSION);
  }

  private meta(key: string): string | null {
    const r = this.sql.exec<{ value: string }>("select value from meta where key=?", key).toArray();
    return r[0]?.value ?? null;
  }
  private setMeta(key: string, value: string): void {
    this.sql.exec("insert into meta(key,value) values (?,?) on conflict(key) do update set value=excluded.value", key, value);
  }
  private delMeta(...keys: string[]): void {
    this.sql.exec("delete from meta where key in (select value from json_each(?))", json(keys));
  }
  private live(): Slot | null {
    return this.meta("live_slot") as Slot | null;
  }
  /** A live slot exists, so a commit can land: before the first full build, every apply's rows go
   *  index-dirty instead (item 35). */
  get built(): boolean {
    return this.live() != null;
  }

  // ── writes: rows into a slot (sync; the caller owns the transaction) ──────────────────────
  private deleteRow(s: Slot, id: string): number {
    const n = this.sql.exec(`delete from nodes_${s} where id=? returning id`, id).toArray().length;
    this.sql.exec(`delete from nodes_fts_${s} where nid=?`, id);
    this.sql.exec(`delete from chunks_${s} where page_id=?`, id);
    this.sql.exec(`delete from edges_${s} where source=?`, id);
    return n;
  }
  private writeRow(s: Slot, { item: it, vectors }: IndexRow): void {
    this.deleteRow(s, it.id);
    const fresh = it as MemoryItem & { volatile?: boolean; freshness?: string | null };
    this.sql.exec(
      `insert into nodes_${s}(id,path,title,type,body,content_hash,trust,volatile,freshness,description,resource,source,authored,write_actor,frontmatter,gen_record)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      it.id, it.path ?? null, it.title, it.type ?? null, it.body, hashItem(it), it.trust ?? "untrusted", fresh.volatile === true ? 1 : 0,
      epoch(fresh.freshness), it.description ?? null, it.resource ?? null, it.source ?? null, epoch(it.authored), this.writeActor,
      canonicalFrontmatter(it.frontmatter), JSON.stringify(generationRecord(it)),
    );
    this.sql.exec(`insert into nodes_fts_${s}(nid,title,description,body) values (?,?,?,?)`, it.id, it.title, it.description ?? "", it.body);
    vectors.forEach((v, ord) => this.sql.exec(`insert into chunks_${s}(page_id,ord,embedding) values (?,?,?)`, it.id, ord, blob(v)));
    for (const e of it.edges ?? []) {
      this.sql.exec(`insert or ignore into edges_${s}(source,type,target,weight) values (?,?,?,?)`, it.id, e.type, e.target, e.weight ?? 1);
    }
  }

  /** Chunk and embed pages, one text per call (record 31), L2-normalized. A page whose content
   *  fingerprint is unchanged in the live slot, built under this very embedding spec, reuses its
   *  vectors: a drifted embedder (a moved `cfp`) re-embeds everything. */
  async embed(items: MemoryItem[]): Promise<IndexRow[]> {
    return (await this.embedRows(items)).rows;
  }

  /** embed(), also counting the items whose content fingerprint the live slot already holds — one
   *  read per item serves both the reuse and remember's `skipped`. */
  private async embedRows(items: MemoryItem[]): Promise<{ rows: IndexRow[]; unchanged: number }> {
    const s = this.live();
    const reuse = s != null && this.meta("embedding_signature") === this.sig;
    const rows: IndexRow[] = [];
    let unchanged = 0;
    for (const item of items) {
      const same = s != null && this.sql.exec<{ h: string }>(`select content_hash as h from nodes_${s} where id=?`, item.id).toArray()[0]?.h === hashItem(item);
      if (same) unchanged++;
      if (same && reuse) {
        const vectors = this.sql.exec<{ embedding: ArrayBuffer }>(`select embedding from chunks_${s} where page_id=? order by ord`, item.id)
          .toArray().map((r) => new Float32Array(r.embedding));
        rows.push({ item, vectors });
        continue;
      }
      const vectors: Float32Array[] = [];
      for (const text of chunkText(`${item.title}\n${item.body}`)) vectors.push(normalize(await this.embedder.embedPassage(text)));
      rows.push({ item, vectors });
    }
    return { rows, unchanged };
  }

  /** ServingIndex.remember at the edge: STAGE rows (no read-your-writes); commit() makes them durable. */
  async remember(items: MemoryItem[]): Promise<RememberResult> {
    const { rows, unchanged } = await this.embedRows(items);
    for (const put of rows) this.staged.push({ put });
    return { indexed: items.length - unchanged, skipped: unchanged };
  }

  /** ServingIndex.remove at the edge: STAGE removals; answers how many are in the live slot now. */
  async remove(ids: string[]): Promise<number> {
    const s = this.live();
    for (const id of ids) this.staged.push({ del: id });
    if (s == null || !ids.length) return 0;
    return this.sql.exec<{ n: number }>(`select count(*) as n from nodes_${s} where id in (select value from json_each(?))`, json(ids)).one().n;
  }

  /** S4's index half (item 35 wraps it in its transactionSync): the staged rows into the LIVE slot,
   *  in staged order. A row that moved clears the content generation; nothing records a page stat
   *  (only a full build does). Clears the index-dirty mark of every path it indexes. `ops` is a
   *  journal's copy when recovery finishes an apply; the staged rows are dropped either way. */
  commit(ops: IndexOp[] = this.staged): void {
    this.staged = [];
    const s = this.live();
    if (s == null) throw new Error("edge store: no live slot — a full build must run before an apply");
    let moved = 0;
    for (const op of ops) {
      const id = "put" in op ? op.put.item.id : op.del;
      if ("put" in op) {
        const was = this.sql.exec<{ g: string }>(`select gen_record as g from nodes_${s} where id=?`, id).toArray()[0]?.g;
        if (was !== JSON.stringify(generationRecord(op.put.item))) moved++;
        this.writeRow(s, op.put);
      } else moved += this.deleteRow(s, id);
      this.sql.exec("delete from index_dirty where id=?", id);
    }
    if (!ops.length) return;
    this.setMeta("last_apply_at", new Date().toISOString());
    if (moved && this.meta("generation") != null) {
      this.delMeta("generation");
      this.setMeta("generation_invalidated_at", new Date().toISOString());
      this.setMeta("generation_invalidated_reason", `apply: ${moved} row${moved === 1 ? "" : "s"} moved`);
    }
  }

  /** Drop what a failed frame staged, so the next frame cannot commit it. */
  discard(): void {
    this.staged = [];
  }

  // ── the full build's half (item 39 drives it) ─────────────────────────────────────────────
  /** What a build is built under: the running code's versions and embedding spec. A live slot built
   *  under another starts a build (trigger 2); a build begun under another restarts. */
  get buildSpec(): string {
    return JSON.stringify({ ...BUILT_VERSIONS, sig: this.sig });
  }

  /** The full-build trigger in force (record 31), or null. The canary's drift (item 38) writes its
   *  own build_state row. */
  buildTrigger(ownerStarId: string, now = Date.now()): "no-live-slot" | "owner" | "versions" | "seed" | null {
    if (this.live() == null) return "no-live-slot";
    if (this.meta("owner_star_id") !== ownerStarId) return "owner";
    if (this.meta("built_versions") !== JSON.stringify(BUILT_VERSIONS) || this.meta("embedding_signature") !== this.sig) return "versions";
    const due = this.seedDue();
    return due != null && now >= due ? "seed" : null;
  }

  /** When the one post-seed build falls due: 15 minutes after the last apply, while the generation
   *  is null and no build has yet indexed a page (`seed_built`). null when it never will. */
  seedDue(): number | null {
    const at = this.meta("last_apply_at");
    if (at == null || this.meta("seed_built") != null || this.meta("generation") != null) return null;
    return Date.parse(at) + SEED_QUIET_MS;
  }

  /** The running build's counters and the spec it began under, committed with each batch. */
  get buildProgress(): BuildProgress | null {
    const p = this.meta("build_progress");
    return p == null ? null : (JSON.parse(p) as BuildProgress);
  }
  set buildProgress(p: BuildProgress) {
    this.setMeta("build_progress", JSON.stringify(p));
  }

  private shadow(): Slot {
    const s = this.live();
    return s == null ? "a" : other(s);
  }
  /** Start a full build: empty the shadow slot. Recall keeps reading the live one. */
  beginBuild(): void {
    const s = this.shadow();
    for (const t of SLOT_TABLES) this.sql.exec(`delete from ${t}_${s}`);
  }
  /** One build batch into the shadow slot, with each page's version (the etag its bytes came with).
   *  Sync: the driver commits it with its counters and last key in one transactionSync. */
  writeBuild(rows: IndexRow[], stats: PageStat[]): void {
    const s = this.shadow();
    for (const r of rows) this.writeRow(s, r);
    for (const p of stats) this.sql.exec(`insert or replace into page_stat_${s}(id,version) values (?,?)`, p.id, p.version);
  }
  /** The swap, in one transactionSync: the shadow slot goes live with its content generation (v3,
   *  schema do-sqlite/1, this embedding spec), the scope signature, the page-stat stamp, the built
   *  versions and the owner; every index-dirty mark and the build_state row are cleared. */
  swap(f: { scope: ScopeSignature; ownerStarId: string; okf?: OkfCounts | null; skipped?: number }): void {
    this.storage.transactionSync(() => {
      const s = this.shadow();
      const records = this.sql.exec<{ g: string }>(`select gen_record as g from nodes_${s}`).toArray().map((r) => JSON.parse(r.g));
      const at = new Date().toISOString();
      this.setMeta("generation", encodeGeneration({ records, scope: f.scope, embeddingSpec: this.sig, parserVersion: PARSER_VERSION, indexSchemaVersion: SCHEMA_VERSION }));
      this.delMeta("generation_invalidated_at", "generation_invalidated_reason");
      this.setMeta("live_slot", s);
      this.setMeta("index_scope_hash", f.scope.hash);
      this.setMeta("index_scope_ignored", f.scope.ignoreScope ? "1" : "0");
      this.setMeta("last_reindex_at", at);
      this.setMeta("page_stat_at", at);
      this.setMeta("embedding_signature", this.sig);
      this.setMeta("built_versions", JSON.stringify(BUILT_VERSIONS));
      this.setMeta("owner_star_id", f.ownerStarId);
      if (f.okf) { this.setMeta("okf_nonconformant", String(f.okf.nonconformant)); this.setMeta("okf_malformed", String(f.okf.malformed)); }
      else this.delMeta("okf_nonconformant", "okf_malformed");
      this.setMeta("build_skipped", String(f.skipped ?? 0));
      this.delMeta("build_progress");
      if (records.length) this.setMeta("seed_built", "1");
      this.sql.exec("delete from index_dirty");
      this.sql.exec("delete from build_state");
    });
  }

  // ── recall: one await, then one synchronous snapshot ──────────────────────────────────────
  async recall(q: RecallQuery): Promise<RecallResult[]> {
    const qv = await this.embedder.embedQuery(q.query);
    // Nothing below awaits: no input gate opens, so every read is of one state.
    const s = this.live();
    if (s == null) return [];
    const limit = q.k ?? 5;
    const n = Math.max(limit * 4, 20);

    // ADR-0013: the allowed set — matchesFilter over every row's stored frontmatter — prefilters FTS
    // and the scan, and filters the fused list again (which covers the graph arm's candidates).
    // ponytail: one pass over every row per filtered query; fine at ~3k rows.
    let allowed: Set<string> | null = null;
    if (q.filter) {
      allowed = new Set();
      for (const r of this.sql.exec<{ id: string; frontmatter: string | null }>(`select id, frontmatter from nodes_${s}`)) {
        if (matchesFilter(fmOf(r.frontmatter), q.filter)) allowed.add(r.id);
      }
      if (!allowed.size) return [];
    }
    const only = allowed ? [json(allowed)] : [];

    const terms = ftsTerms(q.query).map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
    const fts = terms
      ? this.sql.exec<{ nid: string }>(
          `select nid from nodes_fts_${s} where nodes_fts_${s} match ?${allowed ? " and nid in (select value from json_each(?))" : ""}
           order by bm25(nodes_fts_${s}, ${BM25.join(", ")}), nid limit ?`, terms, ...only, n).toArray().map((r) => r.nid)
      : [];

    // The vector arm: an exact dot product (cosine, on normalized rows) over every chunk the filter
    // admits, skipped before scoring so k is never starved. The cursor is iterated, never buffered
    // whole, so only one chunk's BLOB is live at a time.
    // ponytail: exact scan of every chunk per recall (~13 MB at 3.2k × 1024); quantize or index past ~2e4 chunks.
    const qn = normalize(qv);
    const scored: Array<{ p: string; o: number; v: number }> = [];
    for (const r of this.sql.exec<{ page_id: string; ord: number; embedding: ArrayBuffer }>(`select page_id, ord, embedding from chunks_${s}`)) {
      if (allowed && !allowed.has(r.page_id)) continue;
      const e = new Float32Array(r.embedding);
      let dot = 0;
      for (let i = 0; i < e.length; i++) dot += e[i]! * qn[i]!;
      scored.push({ p: r.page_id, o: r.ord, v: dot });
    }
    scored.sort((a, b) => b.v - a.v || cmp(a.p, b.p) || a.o - b.o);
    const vec: string[] = [];
    for (const c of scored.slice(0, n * 3)) {
      if (!vec.includes(c.p)) vec.push(c.p);
      if (vec.length >= n) break;
    }

    const graph = this.graphArm(s, [...new Set([...fts.slice(0, limit), ...vec.slice(0, limit)])], fts, vec, limit);
    const rrfK = resolveRrfK(ENV);
    const scores = rrfScores([fts, vec, graph], rrfK);
    const merged = rrf([fts, vec, graph], rrfK, { tieBreakIds: true });

    const byId = new Map<string, NodeRow>();
    for (const r of this.sql.exec<NodeRow>(
      `select id,path,title,type,body,trust,volatile,freshness,description,resource,source,authored,write_actor,frontmatter
       from nodes_${s} where id in (select value from json_each(?))`, json(merged))) byId.set(r.id, r);
    const all: RecallResult[] = [];
    for (const id of merged) {
      const r = byId.get(id);
      if (!r || (allowed && !allowed.has(id))) continue;
      all.push({
        id, title: r.title, path: r.path ?? undefined, score: scores.get(id) ?? 0, trust: r.trust as Trust,
        description: r.description ?? undefined, resource: r.resource ?? undefined, source: r.source ?? undefined,
        authored: iso(r.authored) ?? undefined, writeActor: r.write_actor, volatile: r.volatile === 1 ? true : undefined,
        freshness: r.freshness != null ? iso(r.freshness)!.slice(0, 10) : undefined, frontmatter: fmOf(r.frontmatter) ?? undefined,
      });
    }
    const out = rankRecall(all, q, (h) => { const r = byId.get(h.id); return r ? { volatile: r.volatile === 1, fresh: r.freshness } : undefined; }).slice(0, limit);
    out.forEach((h, i) => { h.rank = i + 1; });
    return out;
  }

  /** The v2 graph arm (out-only; the edge env never selects v2in): libSQL's SQL with json_each in
   *  place of placeholder lists — distinct, existence-filtered, capped per seed with row_number. */
  private graphArm(s: Slot, seeds: string[], fts: string[], vec: string[], limit: number): string[] {
    if (!seeds.length) return [];
    const seedBestRank = new Map<string, number>();
    for (const list of [fts, vec]) list.forEach((id, i) => seedBestRank.set(id, Math.min(i, seedBestRank.get(id) ?? i)));
    const rows = this.sql.exec<{ seed: string; cand: string }>(
      `with pairs as (select distinct e.source as seed, e.target as cand from edges_${s} e join nodes_${s} nn on nn.id = e.target
                        where e.source in (select value from json_each(?))),
            ranked as (select seed, cand, row_number() over (partition by seed order by cand) rn from pairs)
       select seed, cand from ranked where rn <= ${GRAPH_ARM_CAP_OUT} order by seed, cand`, json(seeds)).toArray()
      .map((r) => ({ seed: r.seed, candidate: r.cand, dir: "out" as const }));
    return buildGraphArm({ seeds, seedBestRank, rows, seedInDegree: new Map(), contribOutDegree: new Map(), inbound: false, graphListMax: 4 * limit });
  }

  // ── reads ──────────────────────────────────────────────────────────────────────────────────
  async indexedPage(ref: { id?: string; path?: string }): Promise<IndexedPage | null> {
    const s = this.live();
    const keys = [ref.id, ref.path, ref.path?.replace(/\.md$/, "")].filter((k): k is string => !!k);
    if (s == null || !keys.length) return null;
    const r = this.sql.exec<NodeRow>(
      `select id,path,title,type,body,trust,description,resource,source,authored,write_actor,frontmatter from nodes_${s}
       where id in (select value from json_each(?1)) or path in (select value from json_each(?1)) limit 1`, json(keys)).toArray()[0];
    return r
      ? { id: r.id, path: r.path, title: r.title, type: r.type, trust: r.trust, description: r.description, resource: r.resource,
          source: r.source, authored: iso(r.authored), writeActor: r.write_actor, body: r.body, frontmatter: fmOf(r.frontmatter) }
      : null;
  }

  /** Synchronous storage reads only — recall_v2 reads it right after recall, and no input gate may
   *  open between them (record 31). */
  statsSync(): IndexStats {
    const s = this.live();
    const count = (t: string) => (s == null ? 0 : this.sql.exec<{ n: number }>(`select count(*) as n from ${t}_${s}`).one().n);
    const trust: Record<string, number> = {};
    const zones = { incoming: 0, output: 0, wiki: 0 };
    if (s != null) {
      for (const r of this.sql.exec<{ trust: string; n: number }>(`select trust, count(*) as n from nodes_${s} group by trust`)) trust[r.trust] = r.n;
      for (const r of this.sql.exec<{ id: string }>(`select id from nodes_${s}`)) zones[zoneOfFile(r.id)]++;
    }
    const okfN = this.meta("okf_nonconformant"), okfM = this.meta("okf_malformed");
    return {
      nodes: count("nodes"), edges: count("edges"), chunks: count("chunks"), trust, zones,
      embeddingSignature: this.meta("embedding_signature"),
      // ADR-0015: the build hold is health.applyState (item 40), never this. Only a swap makes a slot
      // live, so the live slot is always complete and recall serves it throughout a build.
      reindexDirty: false,
      lastReindexAt: this.meta("last_reindex_at"),
      scopeHash: this.meta("index_scope_hash"),
      ignoreScope: this.meta("index_scope_ignored") === "1",
      schemaVersion: this.meta("schema_version"),
      okf: okfN == null || okfM == null ? null : { nonconformant: Number(okfN), malformed: Number(okfM) },
      publicationId: null, // no publication at the edge
      contentGeneration: this.meta("generation"),
      invalidatedAt: this.meta("generation_invalidated_at"),
      invalidatedReason: this.meta("generation_invalidated_reason"),
    };
  }
  async stats(): Promise<IndexStats> {
    return this.statsSync();
  }

  /** The live slot's version record — only a full build writes one. null before the first swap. */
  async pageStats(): Promise<PageStatRecord | null> {
    const s = this.live();
    if (s == null) return null;
    return { at: this.meta("page_stat_at"), rows: this.sql.exec<{ id: string; version: string }>(`select id, version from page_stat_${s}`).toArray() };
  }

  async guardedRead<T>(expected: () => ScopeExpectation, retrieve: () => Promise<T>): Promise<GuardedResult<T>> {
    const state = () => ({ scopeHash: this.meta("index_scope_hash"), ignoreScope: this.meta("index_scope_ignored") === "1", reindexDirty: false });
    const r1 = expectationRefusal(state(), expected());
    if (r1) return { refusal: r1 };
    const value = await retrieve();
    const r2 = expectationRefusal(state(), expected());
    return r2 ? { refusal: r2 } : { ok: value };
  }

  servingSignature(): string {
    return servingSignature({ backend: "do-sqlite", bm25ColumnWeights: BM25, reranker: null, env: ENV });
  }

  async close(): Promise<void> {}
}
