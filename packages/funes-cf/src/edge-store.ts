// The edge store (PLAN-0.5.0 item 37; RAI-314, ADR-0023): the star's index as a Durable Object's
// SQLite — funes-core's one index module (SqlIndex) over the DO adapter of its exec port.
//
// - Two slots (`_a`, `_b`); `meta.live_slot` names the slot recall reads. The one build walk fills
//   the other slot and flips `live_slot` in its finalize transaction.
// - The DO adapter: `sql.exec` with the args spread, BLOBs as ArrayBuffer, `transactionSync`. No
//   vector functions, so the module's JS scan; every id list binds one JSON array (100-bind cap).
// - The writer's protocol tables (receipts, apply_journal, grants, login_seen, mint_handles) and
//   `index_dirty` sit outside every slot: no build and no schema rebuild touches them. A running
//   build is the module's `build_cursor`, its spec the `build_spec` the finalize stamps.
// - Recall awaits only the query embedding, then reads one synchronous snapshot.
//
// What stays outside: the build driver (writer.ts: the alarm, one batch per hold), the embedder and
// its canary, the apply frame (S1–S4), edge health.
import type { Embedder, IndexStats } from "funes-core";
import type { BuildInput, GuardedResult, IndexedPage, IndexOp, MemoryItem, PageStatRecord, PageSwap, RecallQuery, RecallResult, RememberResult, ScopeExpectation, ServingIndex, SqlExec, SqlValue } from "funes-core/internal";
import { DO_SQLITE_DIALECT, opId, SCHEMA_VERSIONS, slotTables, SqlIndex } from "funes-core/internal";

export type { IndexOp } from "funes-core/internal";

/** The one post-seed build waits this long after the last apply (record 31, trigger 4). */
const SEED_QUIET_MS = 15 * 60_000;
const SLOTS = ["_a", "_b"] as const;

/** The DO adapter of the module's exec port. A Uint8Array binds as its own ArrayBuffer (DO SQLite
 *  stores an ArrayBuffer as a BLOB); a bigint as a number. */
export function doExec(storage: DurableObjectStorage): SqlExec {
  const bind = (a: readonly SqlValue[] = []): SqlStorageValue[] =>
    a.map((v) => (v instanceof Uint8Array ? (v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer) : typeof v === "bigint" ? Number(v) : v));
  return {
    all: <T>(s: string, a?: readonly SqlValue[]) => storage.sql.exec(s, ...bind(a)).toArray() as T[],
    iterate: <T>(s: string, a?: readonly SqlValue[]) => storage.sql.exec(s, ...bind(a)) as unknown as Iterable<T>,
    run: (s, a) => storage.sql.exec(s, ...bind(a)).rowsWritten,
    tx: (fn) => storage.transactionSync(fn),
  };
}

/** The writer's protocol tables, outside every slot (no build or schema rebuild touches them).
 *  Idempotent: the edge store runs it, and so does /mint (item 44), which needs no index. */
export function createProtocolTables(sql: SqlStorage): void {
  sql.exec(`
    create table if not exists receipts(proposal_id text primary key, payload_hash text not null, written_hash text not null, applied_at text not null);
    create table if not exists apply_journal(id integer primary key, state text not null default 'pending', step integer not null default 0,
      proposal_id text, payload_hash text, written_hash text, writes text not null, index_ops text, created_at text not null);
    create table if not exists grants(token_sha256 text primary key, actor text not null, role text not null, stars text not null,
      created_at text not null, expires_at text, revoked_at text, label text not null);
    create table if not exists login_seen(hash text primary key, expires_at integer not null);
    create table if not exists mint_handles(handle_sha256 text primary key, expires_at integer not null);
  `);
}

export class EdgeStore implements ServingIndex {
  private readonly sql: SqlStorage;
  /** The one index module over this DO's SQLite. */
  readonly index: SqlIndex;
  /** Staged by remember/remove inside an apply frame; durable only at commit (S4). The apply journal
   *  carries a copy (item 35), so a restart commits exactly these rows. */
  staged: IndexOp[] = [];

  constructor(storage: DurableObjectStorage, embedder: Embedder, opts: { writeActor?: string } = {}) {
    this.sql = storage.sql;
    this.index = new SqlIndex({ exec: doExec(storage), dialect: DO_SQLITE_DIALECT, embedder, slots: SLOTS, writeActor: opts.writeActor ?? "unknown" });
    this.init();
  }

  private init(): void {
    this.sql.exec("create table if not exists meta(key text primary key, value text not null)");
    const stamped = this.index.meta("schema_version");
    if (stamped != null && stamped !== SCHEMA_VERSIONS["do-sqlite"]) {
      // A schema rebuild recreates only the slot and build tables and the index meta (record 31). The
      // protocol tables survive it, and the empty index starts a full build.
      for (const sfx of SLOTS) for (const t of Object.values(slotTables(sfx))) this.sql.exec(`drop table if exists ${t}`);
      this.sql.exec("drop table if exists build_refs");
      this.sql.exec("drop table if exists build_stat");
      this.sql.exec("delete from meta");
      this.sql.exec("delete from index_dirty");
    }
    this.sql.exec("create table if not exists index_dirty(id text primary key)");
    createProtocolTables(this.sql);
    this.index.createTables();
    this.index.addColumns();
    if (stamped !== SCHEMA_VERSIONS["do-sqlite"]) this.index.setMeta("schema_version", SCHEMA_VERSIONS["do-sqlite"]);
  }

  /** A live slot exists, so a commit can land: before the first full build, every apply's rows go
   *  index-dirty instead (item 35). */
  get built(): boolean {
    return this.index.live() != null;
  }

  // ── writes ─────────────────────────────────────────────────────────────────────────────────
  /** ServingIndex.remember at the edge: STAGE rows and the swapped pages' stats (no
   *  read-your-writes); commit() makes them durable. */
  async remember(items: MemoryItem[], swaps: PageSwap[] = []): Promise<RememberResult> {
    const { rows, unchanged } = await this.index.embed(items);
    for (const put of rows) this.staged.push({ put });
    for (const stat of swaps) this.staged.push({ stat });
    return { indexed: items.length - unchanged, skipped: unchanged };
  }

  /** ServingIndex.remove at the edge: STAGE removals; answers how many are in the live slot now. */
  async remove(ids: string[], swaps: PageSwap[] = []): Promise<number> {
    const t = this.index.live();
    for (const id of ids) this.staged.push({ del: id });
    for (const stat of swaps) this.staged.push({ stat });
    if (t == null || !ids.length) return 0;
    return this.index.x.all<{ n: number }>(`select count(*) as n from ${t.nodes} where id in (select value from json_each(?))`, [JSON.stringify(ids)])[0]!.n;
  }

  /** S4's index half (the writer wraps it in its transactionSync): the staged rows into the LIVE
   *  slot, in staged order, clearing the index-dirty mark of every path it indexes. `ops` is a
   *  journal's copy when recovery finishes an apply; the staged rows are dropped either way. */
  commit(ops: IndexOp[] = this.staged): void {
    this.staged = [];
    if (!this.built) throw new Error("edge store: no live slot — a full build must run before an apply");
    this.index.apply(ops);
    for (const op of ops) this.sql.exec("delete from index_dirty where id=?", opId(op));
    if (ops.length) this.index.setMeta("last_apply_at", new Date().toISOString());
  }

  /** Drop what a failed frame staged, so the next frame cannot commit it. */
  discard(): void {
    this.staged = [];
  }

  // ── the full build's triggers (the writer drives the walk) ───────────────────────────────────
  /** The full-build trigger in force (record 31), or null: no live slot, another owner, a live slot
   *  built under another index scope (ADR-0024: R2 config edits it) or another spec (versions,
   *  embedding), or the one post-seed build. */
  buildTrigger(ownerStarId: string, input: Pick<BuildInput, "scope">, now = Date.now()): "no-live-slot" | "owner" | "scope" | "versions" | "seed" | null {
    if (!this.built) return "no-live-slot";
    if (this.index.meta("owner_star_id") !== ownerStarId) return "owner";
    if (input.scope !== undefined && this.index.meta("index_scope_hash") !== (input.scope?.hash ?? null)) return "scope";
    if (this.index.meta("build_spec") !== this.index.buildSpec(input)) return "versions";
    const due = this.seedDue();
    return due != null && now >= due ? "seed" : null;
  }

  /** When the one post-seed build falls due: 15 minutes after the last apply, while the generation
   *  is null and no build has yet indexed a page (`seed_built`). null when it never will. */
  seedDue(): number | null {
    const at = this.index.meta("last_apply_at");
    if (at == null || this.index.meta("seed_built") != null || this.index.meta("generation") != null) return null;
    return Date.parse(at) + SEED_QUIET_MS;
  }

  /** The edge's own stamps, inside the build's finalize transaction: the owner (a rebuild for
   *  another owner replaces it, never a compare-and-set), the seed mark, and every index-dirty mark
   *  (the new slot was built from R2 as it is). */
  finalized(ownerStarId: string): void {
    this.index.setMeta("owner_star_id", ownerStarId);
    if (this.index.x.all(`select 1 from ${this.index.live()!.nodes} limit 1`).length) this.index.setMeta("seed_built", "1");
    this.sql.exec("delete from index_dirty");
  }

  // ── reads ──────────────────────────────────────────────────────────────────────────────────
  recall(q: RecallQuery): Promise<RecallResult[]> { return this.index.recall(q); }
  indexedPage(ref: { id?: string; path?: string }): Promise<IndexedPage | null> { return this.index.indexedPage(ref); }
  /** Synchronous storage reads only — no input gate may open between them (record 31). */
  statsSync(): IndexStats { return this.index.statsSync(); }
  stats(): Promise<IndexStats> { return this.index.stats(); }
  /** The live slot's version record — a full build writes it, each apply upserts its swaps' rows
   *  (RAI-318). null before the first flip. */
  pageStats(): Promise<PageStatRecord | null> { return this.index.pageStats(); }
  guardedRead<T>(expected: () => ScopeExpectation, retrieve: () => Promise<T>): Promise<GuardedResult<T>> { return this.index.guardedRead(expected, retrieve); }
  servingSignature(): string { return this.index.servingSignature(); }
  async close(): Promise<void> {}
}
