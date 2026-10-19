// The taste star's one writer (PLAN-0.5.0 item 35; ADR-0010 §Revision "The edge apply", ADR-0011
// §Consequences, record 24 §4–§9). The DO (taste-do.ts) proves its locus and hands this its bucket;
// this module names no binding (test/config.node.ts).
//
// Every mutation runs in one serializer hold, under ctx.waitUntil:
//   recover()                      finish a pending journal, turn an abandoned one into a conflict;
//                                  if a journal stays pending, answer 503 and do nothing else (I6)
//   first hold of the instance     the canary (item 38), then the star.yaml publish
//   a build trigger (item 39)      writes build_state; while it exists every mutation answers 503
//                                  (applyState `building`) and the alarm runs one batch per hold
//   phase 0, no write             grant, arguments, id window, receipt, path, base, sanitize,
//                                  protected fields, trust stamp, normalize, byte-equal no-op, index
//                                  rows — FunesStore's own order, over R2Vault's staging frame
//   S1 journal                     the commit point: the writes, the index rows, the receipt fields
//   S2/S3 history, page(s)         each put behind a fence; a 429 retries behind a fresh fence
//   S4 one transactionSync         the receipt, the index rows, the journal's removal, the 30-day prune
//   the reply                      held by the output gate until S4 is durable
// `recall`, `recall_v2`, `indexed_page`, `health` and `vault_page` read and take no hold; `health`
// is this writer's own (item 40).
import { Buffer } from "node:buffer";
import { isPagePath, isTombstoned, zoneOfFile, type MemoryItem, type PageStat } from "funes-core";
import {
  dispatchToolCall, FunesStore, grantCoversStar, normalizePage, PROPOSAL_PROTOCOL, starConfigFromText, textToItemWithMeta,
  vaultChangedSince,
  type FunesStoreOpts, type Operation, type OperationContext, type StarConfig,
} from "funes-engine/portable";
import { scopeHash, serialize } from "funes-shared";
import { EdgeStore, type BuildProgress, type IndexOp, type IndexRow } from "./edge-store.ts";
import { EDGE_OPERATIONS, grantForRequest } from "./grants.ts";
import { logError } from "./log.ts";
import { R2Conflict, R2Vault, type StagedWrite } from "./r2-vault.ts";
import { WorkersAiEmbedder } from "./workers-ai-embedder.ts";

/** The taste star's `memory.memoryDir` (its star.yaml; record 24 §9): passed, never probed. */
const MEMORY_DIR = "items";
const DAY = 86_400_000;
/** The serializer's bounded wait (record 24 §5). */
const HOLD_WAIT_MS = 30_000;
/** S1's alarm, and the alarm's backoff while a journal stays pending. ponytail: one fixed step;
 *  exponential if a long R2 outage ever matters. */
const RETRY_MS = 60_000;
/** A full build's batch: at most this many pages, then a transactionSync and the next alarm. */
const BATCH_PAGES = 500;
/** An object listed above this is skipped unread: DO SQLite holds at most 2 MB a row (record 31). */
const MAX_OBJECT_BYTES = 1024 * 1024;
/** A batch reads and embeds in this many lanes: at most 6 calls in flight, the simultaneous
 *  connection limit (record 31). The embedder paces them to 40 a second. */
const LANES = 6;

/** What the DO answers the entry (item 43 maps it onto MCP): an HTTP status and a JSON body. */
export interface Reply { status: number; body: unknown }

/** The entry's grant check (item 43): the preset's ops on 200. */
export type Authorized = { status: 200; actor: string; ops: string[] } | { status: 401 | 403 };

export interface WriterOpts {
  storage: DurableObjectStorage;
  bucket: R2Bucket;
  ai: Ai;
  /** The bundled star.yaml, as text: the live configuration, and the bytes the first hold publishes. */
  starText: string;
  /** The proven locus (taste-do.ts): the designation's both halves, and the rows' write_actor. */
  locus: string;
  /** ctx.waitUntil: an apply continues after the client disconnects (record 24 §4). */
  waitUntil(p: Promise<unknown>): void;
  /** R2Vault's 429 backoff clock (tests pass a no-op). */
  sleep?(ms: number): Promise<void>;
  /** A build batch's page count (tests pass a small one). Default BATCH_PAGES. */
  batchPages?: number;
}

/** The one alarm, set only here (record 24 S1): never later than one already set. */
export async function armAlarm(storage: DurableObjectStorage, at: number): Promise<void> {
  const cur = await storage.getAlarm();
  if (cur == null || at < cur) await storage.setAlarm(at);
}

type Receipt = Parameters<NonNullable<FunesStoreOpts["receipts"]>["put"]>[0];
type Grant = NonNullable<OperationContext["grant"]>;

/** The fence found its journal no longer pending: the operator abandoned it (record 24 §4). */
class Abandoned extends Error {}

interface JournalRow extends Record<string, SqlStorageValue> {
  id: number; proposal_id: string | null; payload_hash: string | null; written_hash: string | null; writes: string; index_ops: string | null;
}

const b64 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const encodeWrites = (ws: readonly StagedWrite[]) => JSON.stringify(ws.map((w) => ({ ...w, bytes: b64(w.bytes) })));
const decodeWrites = (s: string): StagedWrite[] => (JSON.parse(s) as Array<StagedWrite & { bytes: string }>).map((w) => ({ ...w, bytes: unb64(w.bytes) }));
const vec = (v: Float32Array) => b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
const unvec = (s: string) => { const u = unb64(s); return new Float32Array(u.buffer, u.byteOffset, u.byteLength / 4); };
const encodeOps = (ops: IndexOp[]) => JSON.stringify(ops.map((o) => ("put" in o ? { put: { item: o.put.item, vectors: o.put.vectors.map(vec) } } : o)));
const decodeOps = (s: string | null): IndexOp[] => (s == null ? [] : (JSON.parse(s) as Array<{ put: { item: MemoryItem; vectors: string[] } } | { del: string }>)
  .map((o) => ("put" in o ? { put: { item: o.put.item, vectors: o.put.vectors.map(unvec) } } : o)));
const opId = (o: IndexOp) => ("put" in o ? o.put.item.id : o.del);

export class Writer {
  private readonly sql: SqlStorage;
  private readonly store: EdgeStore;
  private readonly embedder: WorkersAiEmbedder;
  private readonly vault: R2Vault;
  private readonly star: StarConfig;
  /** The host ceiling's ops, with `health` answered by this writer (item 40): an edge's health is its
   *  own, from the DO's tables, never the folder op's operator state. */
  private readonly ops: Operation[];
  /** The bundled star's canonical key: the owner a swap stamps and a trigger compares. */
  private readonly owner: string;
  /** One mutex per writer, which is one per instance: across instances the fence does the work. */
  private readonly key = `taste-writer:${crypto.randomUUID()}`;
  private started = false;
  // The apply in this hold (the hold serializes, so one at a time): its journal row, and its receipt.
  private journalId: number | null = null;
  private proposal: Pick<Receipt, "proposalId" | "payloadHash"> | null = null;
  private receipt: Receipt | null = null;

  constructor(private readonly o: WriterOpts) {
    this.sql = o.storage.sql;
    this.embedder = new WorkersAiEmbedder(o.ai, o.storage);
    this.store = new EdgeStore(o.storage, this.embedder, { writeActor: o.locus });
    this.star = starConfigFromText(o.starText);
    this.owner = this.star.identity.key ?? ""; // taste-do.ts's locus proof refuses a star with none
    this.vault = new R2Vault(o.bucket, {
      journal: (writes, out) => this.journal(writes, out),
      fence: (step) => this.fence(step),
      sleep: o.sleep,
    });
    this.ops = EDGE_OPERATIONS.map((op) => (op.name === "health" ? { ...op, run: () => this.health() } : op));
  }

  /** The entry's check before it reads a body (item 43, ADR-0014): 401 for no grant, 403 for a grant
   *  that does not name this star, else the actor and its preset's ops (tools/list). Read now, from
   *  the rows; `call` reads them again. */
  authorize(presented: string | null): Authorized {
    const grant = grantForRequest(this.sql, presented, new Date());
    if (!grant) return { status: 401 };
    if (!grantCoversStar(grant, this.star.identity.id)) return { status: 403 };
    return { status: 200, actor: grant.actor, ops: [...grant.ops] };
  }

  /** One request from the entry. The grant is read now, before any hold (record 24 §6 step 1). */
  async call(presented: string | null, name: string, args: Record<string, unknown>): Promise<Reply> {
    const grant = grantForRequest(this.sql, presented, new Date());
    if (!grant) return { status: 401, body: { error: "unauthorized" } };
    const op = this.ops.find((x) => x.name === name);
    if (!op || op.readonly) return this.dispatch(grant, name, args);
    const p = this.hold(() => this.apply(grant, name, args));
    this.o.waitUntil(p);
    return p;
  }

  /** The one alarm: a hold with nothing to apply, which runs one build batch while a build runs. It
   *  re-arms at the earliest of: the retry while a journal stays pending or a batch failed, the next
   *  batch, and the one post-seed build's due time. */
  async alarm(): Promise<void> {
    const r = await this.hold(async () => {
      if (!this.building()) return { status: 200, body: null };
      try {
        await this.buildBatch();
      } catch (e) {
        return this.transient(e); // the last key is kept: the next batch resumes after it
      }
      return { status: 200, body: null };
    });
    if (r.status !== 200) return armAlarm(this.o.storage, Date.now() + RETRY_MS);
    const next = this.building() ? Date.now() : this.store.seedDue();
    if (next != null) await armAlarm(this.o.storage, next);
  }

  /** A serializer hold: recovery first, then (once per instance) the canary and the star.yaml
   *  publish, then any full-build trigger. */
  private hold(fn: () => Promise<Reply>): Promise<Reply> {
    return serialize(this.key, async () => {
      try {
        await this.recover();
        if (!this.started) {
          await this.embedder.runCanary();
          await this.publishStar();
          this.started = true;
        }
        const reason = this.building() ? null : this.store.buildTrigger(this.owner);
        if (reason) this.sql.exec("insert into build_state(id, reason, started_at, last_key) values (1, ?, ?, null)", reason, new Date().toISOString());
      } catch (e) {
        return this.transient(e);
      }
      return fn();
    }, HOLD_WAIT_MS);
  }

  private pending(): JournalRow | null {
    return this.sql.exec<JournalRow>("select * from apply_journal where state = 'pending' order by id limit 1").toArray()[0] ?? null;
  }
  private building(): boolean {
    return this.sql.exec("select id from build_state").toArray().length > 0;
  }
  /** Record 24's applyState, as edge health (item 40) reports it. */
  applyState(): "pending" | "building" | "idle" {
    return this.pending() ? "pending" : this.building() ? "building" : "idle";
  }

  /** A transient error with no ADR-0010 status (record 24 §4): the sender retries the same bytes. */
  private transient(e: unknown): Reply {
    this.store.discard();
    const applyState = this.applyState();
    logError("writer-transient", e);
    return { status: 503, body: { error: (e as Error).message, applyState } };
  }

  /** The frame's context: FunesStore over R2Vault and the edge store, with the taste star's rules. */
  private context(grant: Grant): OperationContext {
    const funes = new FunesStore(this.store, {
      vault: this.vault, star: () => this.star, memoryDir: MEMORY_DIR,
      serialize: (fn) => serialize(this.key, fn, HOLD_WAIT_MS),
      receipts: {
        get: async (id) => {
          const r = this.sql.exec<{ payload_hash: string; written_hash: string; applied_at: string }>(
            "select payload_hash, written_hash, applied_at from receipts where proposal_id = ?", id).toArray()[0];
          return r ? { proposalId: id, payloadHash: r.payload_hash, ...(r.written_hash ? { writtenHash: r.written_hash } : {}), appliedAt: r.applied_at } : null;
        },
        pending: (p) => { this.proposal = p; },
        put: async (r) => { this.receipt = r; }, // S4 writes it, with the index rows
      },
      itemPages: true,
      // ADR-0014: only the outbox preset's actor is `outbox@<label>` (grants.ts), and it carries only
      // the approved seed and the replica watcher: its creates keep the zone default (record 24 §6.10).
      createTrust: grant.actor.startsWith("outbox@") ? "zone" : "untrusted",
    });
    return {
      remote: true, trust: "untrusted", vault: this.vault, star: () => this.star, store: this.store, funes, grant, actor: grant.actor,
      designation: { mode: "audit", locus: this.o.locus, authority: this.o.locus },
    };
  }

  private async dispatch(grant: Grant, name: string, args: Record<string, unknown>): Promise<Reply> {
    try {
      return { status: 200, body: await dispatchToolCall(this.ops, name, args, this.context(grant)) };
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      return { status: code === "FUNES_NOT_GRANTED" ? 403 : 400, body: { error: (e as Error).message, ...(typeof code === "string" ? { code } : {}) } };
    }
  }

  /** Edge health (item 40; record 24 §1, ADR-0015): the stats and record 24's protocol fields, read
   *  in one synchronous block from the DO's tables, outside the hold — so a pending journal reads
   *  `pending` while every mutation answers 503 — then freshness, version parity by an R2 listing,
   *  which is advisory and comes last. `conflicts` counts abandoned rows the next hold has not yet
   *  turned into conflicts. */
  private async health(): Promise<Record<string, unknown>> {
    const count = (q: string) => this.sql.exec<{ n: number }>(q).one().n;
    const stats = this.store.statsSync();
    const fields = {
      proposalProtocol: PROPOSAL_PROTOCOL,
      starId: this.star.identity.id,
      locus: this.o.locus,
      applyState: this.applyState(),
      indexDirty: count("select count(*) as n from index_dirty"),
      conflicts: count("select count(*) as n from apply_journal where state in ('conflict', 'abandoned')"),
    };
    const { changed, basis } = await vaultChangedSince(this.vault, this.star.scope, async () => stats.lastReindexAt, () => this.store.pageStats());
    return { ...stats, vaultChangedSinceReindex: changed, freshnessBasis: basis, ...fields };
  }

  /** One mutation, inside the hold: phase 0 and the frame through FunesStore, then S4. */
  private async apply(grant: Grant, name: string, args: Record<string, unknown>): Promise<Reply> {
    // ADR-0015: writes hold during a full build, so R2 is static from its first list to its swap.
    if (this.building()) return { status: 503, body: { error: "a full build of the edge index is running; retry", applyState: "building" } };
    this.journalId = null;
    this.proposal = this.receipt = null;
    let body: unknown;
    try {
      body = await dispatchToolCall(this.ops, name, args, this.context(grant));
    } catch (e) {
      if (e instanceof R2Conflict) {
        await this.conflict(this.journalId!);
        return { status: 500, body: { error: e.message } };
      }
      if (this.journalId != null || !(e as { code?: unknown }).code) return this.transient(e); // after S1 the change still completes
      this.store.discard();
      return { status: (e as { code?: unknown }).code === "FUNES_NOT_GRANTED" ? 403 : 400, body: { error: (e as Error).message, code: (e as { code?: unknown }).code } };
    }
    this.commit(this.receipt, this.store.staged, this.journalId);
    return { status: 200, body };
  }

  // ── S1, the fence, S4 ────────────────────────────────────────────────────────────────────────

  private async journal(writes: readonly StagedWrite[], out: unknown): Promise<void> {
    const writtenHash = (out as { writtenHash?: unknown } | null)?.writtenHash;
    this.journalId = this.sql.exec<{ id: number }>(
      `insert into apply_journal(proposal_id, payload_hash, written_hash, writes, index_ops, created_at) values (?, ?, ?, ?, ?, ?) returning id`,
      this.proposal?.proposalId ?? null, this.proposal?.payloadHash ?? null, typeof writtenHash === "string" ? writtenHash : null,
      encodeWrites(writes), encodeOps(this.store.staged), new Date().toISOString(),
    ).one().id;
    await armAlarm(this.o.storage, Date.now() + RETRY_MS);
    await this.o.storage.sync();
  }

  private async fence(step: number): Promise<void> {
    const n = this.sql.exec("update apply_journal set step = ? where id = ? and state = 'pending'", step, this.journalId).rowsWritten;
    if (n === 0) throw new Abandoned(`journal ${this.journalId} is no longer pending: abandoned by the operator`);
    await this.o.storage.sync();
  }

  /** S4, one transactionSync: the receipt, the index rows (clearing their dirty marks), the journal's
   *  removal and the 30-day receipt prune. If the index rows throw, a second transaction keeps the
   *  receipt and the journal's removal and marks the rows' pages index-dirty instead. */
  private commit(receipt: Receipt | null, ops: IndexOp[], journalId: number | null): void {
    const done = () => {
      if (receipt) {
        this.sql.exec("insert into receipts(proposal_id, payload_hash, written_hash, applied_at) values (?, ?, ?, ?)",
          receipt.proposalId, receipt.payloadHash, receipt.writtenHash ?? "", receipt.appliedAt);
      }
      if (journalId != null) this.sql.exec("delete from apply_journal where id = ?", journalId);
      this.sql.exec("delete from receipts where applied_at < ?", new Date(Date.now() - 30 * DAY).toISOString());
    };
    try {
      this.o.storage.transactionSync(() => { done(); if (ops.length) this.store.commit(ops); });
    } catch (e) {
      logError("index-dirty", e);
      this.o.storage.transactionSync(() => {
        done();
        for (const o of ops) this.sql.exec("insert or ignore into index_dirty(id) values (?)", opId(o));
      });
    }
    this.store.discard();
  }

  // ── recovery ─────────────────────────────────────────────────────────────────────────────────

  /** The first act of every hold. An abandoned journal becomes a conflict with its pages re-indexed
   *  from R2 as they are; a pending one rolls forward and commits with its own receipt fields. A
   *  failure that leaves it pending throws, and the hold answers 503. */
  private async recover(): Promise<void> {
    for (;;) {
      for (const a of this.sql.exec<{ id: number }>("select id from apply_journal where state = 'abandoned'").toArray()) await this.conflict(a.id);
      const j = this.pending();
      if (!j) break;
      this.journalId = j.id;
      try {
        await this.vault.rollForward(decodeWrites(j.writes));
      } catch (e) {
        if (e instanceof Abandoned) continue;
        if (e instanceof R2Conflict) { await this.conflict(j.id); continue; }
        throw e;
      }
      this.commit(j.proposal_id == null ? null : {
        proposalId: j.proposal_id, payloadHash: j.payload_hash!, ...(j.written_hash ? { writtenHash: j.written_hash } : {}), appliedAt: new Date().toISOString(),
      }, decodeOps(j.index_ops), j.id);
    }
    // Index-dirty pages re-index here once a live slot exists; a failure leaves them dirty.
    const dirty = this.sql.exec<{ id: string }>("select id from index_dirty").toArray().map((r) => r.id);
    if (dirty.length && this.store.built) {
      await this.reindex(dirty.map((id) => `${id}.md`)).catch((e) => logError("index-dirty-retry", e));
    }
  }

  /** A journal that will not finish (another writer's bytes, or the operator's abandon): no receipt,
   *  the row kept as `conflict` for `health.conflicts`, its pages re-indexed from R2 as they are. */
  private async conflict(id: number): Promise<void> {
    this.store.discard(); // the failed frame's rows are not R2's
    const j = this.sql.exec<{ writes: string }>("select writes from apply_journal where id = ?", id).one();
    this.sql.exec("update apply_journal set state = 'conflict' where id = ?", id);
    await this.reindex(decodeWrites(j.writes).map((w) => w.path).filter(isPagePath));
  }

  /** Re-index pages from R2 as they are now: embed every one first, then one transaction (record 24
   *  §4 rule 3). */
  private async reindex(paths: string[]): Promise<void> {
    for (const path of paths) {
      const f = await this.vault.read(path);
      const id = path.slice(0, -".md".length);
      if (!f) { await this.store.remove([id]); continue; }
      const { item, meta, parseError } = textToItemWithMeta(f.bytes, path);
      // malformed: no row, as the build skips it fail-closed (ADR-0012) — never default meta
      if (parseError !== undefined || isTombstoned(meta)) await this.store.remove([id]);
      else await this.store.remember([item]);
    }
    this.commit(null, this.store.staged, null);
  }

  // ── the full build (item 39; ADR-0015, record 31) ────────────────────────────────────────────

  /** One batch of the running build, inside the alarm's hold (so recover() ran and no journal is
   *  pending). It lists at most `batchPages` keys `startAfter` the last one, reads and embeds the
   *  pages in LANES lanes, and commits the shadow rows, the counters and the last key in one
   *  transactionSync. An unfinished listing leaves the next batch to the next alarm; a finished one
   *  swaps. A build begun under another spec (a deploy mid-build), or reset by the canary's drift,
   *  starts over. A poison object is skipped and counted, never retried; an R2 or Workers AI error
   *  fails the batch, which the alarm retries from the same key. */
  private async buildBatch(): Promise<void> {
    const lastKey = this.sql.exec<{ last_key: string | null }>("select last_key from build_state").one().last_key;
    const spec = this.store.buildSpec;
    const was = this.store.buildProgress;
    const fresh = lastKey == null || was?.spec !== spec;
    const p: BuildProgress = fresh || !was ? { spec, nonconformant: 0, malformed: 0, skipped: 0 } : was;
    const { scope } = this.star;
    // ponytail: the taste star declares no index_scope; excludes at the edge need scope.ts's glob
    // matcher in the portable entry. Fail closed until then rather than stamp an unhonoured scope.
    if (scope.kind !== "valid" || scope.excludes.length) throw new Error("the edge build honours no memory.index_scope.exclude");

    const listed = await this.o.bucket.list({ startAfter: fresh ? undefined : lastKey!, limit: this.o.batchPages ?? BATCH_PAGES });
    const queue = listed.objects.filter((o) => isPagePath(o.key));
    const rows: IndexRow[] = [];
    const stats: PageStat[] = [];
    const one = async (o: R2Object): Promise<void> => {
      // A skipped page keeps its stat row (the listed etag), so health's listing parity still holds.
      if (o.size > MAX_OBJECT_BYTES) { stats.push({ id: o.key.slice(0, -".md".length), version: o.etag }); p.skipped++; return; }
      const got = await this.o.bucket.get(o.key);
      if (!got) { p.skipped++; return; }
      const bytes = new Uint8Array(await got.arrayBuffer());
      stats.push({ id: o.key.slice(0, -".md".length), version: got.etag }); // the etag of the bytes read
      let read: ReturnType<typeof textToItemWithMeta>;
      try {
        if (zoneOfFile(o.key) !== "incoming") { // the OKF floor's count, as reindex's countOkf
          const n = normalizePage(bytes, { path: o.key });
          if ("invalid" in n || n.edit !== "none") p.nonconformant++;
          if ("invalid" in n && n.invalid === "malformed") p.malformed++;
        }
        read = textToItemWithMeta(bytes, o.key);
      } catch {
        p.skipped++;
        return;
      }
      if (read.parseError !== undefined) { p.skipped++; return; } // malformed: skipped fail-closed (ADR-0012)
      if (isTombstoned(read.meta)) return;
      // ponytail: edge targets stay as authored, as every apply writes them; reindex's reference
      // maps need every page read first, a second pass per build.
      rows.push(...(await this.store.embed([read.item]))); // reuses vectors on fingerprint + signature
    };
    await Promise.all(Array.from({ length: LANES }, async () => {
      for (let o = queue.shift(); o; o = queue.shift()) await one(o);
    }));

    this.o.storage.transactionSync(() => {
      if (fresh) this.store.beginBuild();
      this.store.writeBuild(rows, stats);
      this.store.buildProgress = p;
      this.sql.exec("update build_state set last_key = ?", listed.objects.at(-1)?.key ?? lastKey);
    });
    if (!listed.truncated) {
      this.store.swap({
        scope: { hash: scopeHash(scope.excludes), ignoreScope: false }, ownerStarId: this.owner,
        okf: { nonconformant: p.nonconformant, malformed: p.malformed }, skipped: p.skipped,
      });
    }
  }

  // ── the first hold's publish ─────────────────────────────────────────────────────────────────

  /** R2's star.yaml becomes the bundled bytes: created once, or replaced on its etag; no history
   *  object (ADR-0011). Journaled and fenced like any frame. */
  private async publishStar(): Promise<void> {
    const want = new TextEncoder().encode(this.o.starText);
    this.journalId = null;
    this.proposal = this.receipt = null;
    await this.vault.atomically(async (tx) => {
      const cur = await this.vault.read("star.yaml");
      if (cur && Buffer.from(cur.bytes).equals(Buffer.from(want))) return;
      const r = await tx.swap("star.yaml", cur?.version ?? null, want);
      if (!r.ok) throw new Error("star.yaml changed in R2 while the writer published it");
    });
    if (this.journalId != null) this.commit(null, [], this.journalId);
  }
}
