// A star's one writer at the edge (PLAN-0.5.0 item 35; ADR-0010 §Revision "The edge apply", ADR-0011
// §Consequences, record 24 §4–§9; ADR-0024). The DO (star-do.ts) proves its star and hands this the
// proven config, its key and its bucket; this module names no binding (test/config.node.ts).
//
// Every mutation runs in one serializer hold, under ctx.waitUntil:
//   recover()                      finish a pending journal, turn an abandoned one into a conflict;
//                                  if a journal stays pending, answer 503 and do nothing else (I6)
//   a build trigger (item 39)      begins the one build walk (RAI-314) and arms the alarm: while its
//                                  build_cursor exists every mutation answers 503 (applyState
//                                  `building`) and the alarm runs one batch per hold. The canary is the
//                                  embedder's, lazy (ADR-0024); its drift moves the spec (`versions`)
//   phase 0, no write             grant, arguments, id window, receipt, path, base, sanitize,
//                                  protected fields, trust stamp, normalize, byte-equal no-op, index
//                                  rows — FunesStore's own order, over R2Vault's staging frame
//   S1 journal                     the commit point: the writes, the index rows, the receipt fields
//   S2/S3 history, page(s)         each put behind a fence; a 429 retries behind a fresh fence
//   S4 one transactionSync         the receipt, the index rows, the journal's removal, the 30-day prune
//   the reply                      held by the output gate until S4 is durable
// `recall`, `indexed_page`, `health` and `page` read and take no hold; `health` is the registry's,
// wrapped with this writer's tier keys (item 40, RAI-308).
import { Buffer } from "node:buffer";
import { authorize, dispatchToolCall, portContext, type OperationContext, type Refusal } from "funes-core";
import { corpusOf, isPagePath, isTombstoned, opId, type BuildInput, type IndexOp, type MemoryItem } from "funes-core/internal";
import { serialize, textToItemWithMeta, type FunesStoreOpts, type StarConfig } from "funes-core/internal";
import { EdgeStore } from "./edge-store.ts";
import { PROPOSAL_PROTOCOL } from "./proposal-protocol.ts";
import { EDGE_OPERATIONS, livePolicy } from "./grants.ts";
import { logError } from "./log.ts";
import { R2Conflict, R2Vault, type StagedWrite } from "./r2-vault.ts";
import { WorkersAiEmbedder } from "./workers-ai-embedder.ts";

const DAY = 86_400_000;
/** The serializer's bounded wait (record 24 §5). */
const HOLD_WAIT_MS = 30_000;
/** S1's alarm, and the alarm's backoff while a journal stays pending. ponytail: one fixed step;
 *  exponential if a long R2 outage ever matters. */
const RETRY_MS = 60_000;
/** A full build's batch: at most this many pages, then a transactionSync and the next alarm. */
const BATCH_PAGES = 500;
/** A page above this is skipped and counted: DO SQLite holds at most 2 MB a row (record 31). */
const MAX_OBJECT_BYTES = 1024 * 1024;
/** A batch reads and embeds in this many lanes: at most 6 calls in flight, the simultaneous
 *  connection limit (record 31). The embedder paces them to 40 a second. */
const LANES = 6;

/** What the DO answers the entry (item 43 maps it onto MCP): an HTTP status and a JSON body. */
export interface Reply { status: number; body: unknown }

/** Why an object does not serve (ADR-0024): no proven config (404), or R2 did not answer (503). */
export type NotServing = { status: 404 | 503; error: "unknown-star" | "unavailable"; message: string };

/** The entry's grant check (item 43, RAI-310): the grant cut to the edge ceiling, or the refusal.
 *  `ops` is a list: the value crosses the DO's RPC. */
export type Authorized = { actor: string; ops: string[]; stars: readonly string[] } | Refusal | NotServing;

export interface WriterOpts {
  storage: DurableObjectStorage;
  bucket: R2Bucket;
  ai: Ai;
  /** The proven config (star-do.ts): `memory_dir` and `item_pages` declared, its key the object's. */
  star: StarConfig;
  /** The star key: the object's name, the bucket prefix `<key>/_/` and the owner a build stamps. */
  key: string;
  /** The proven locus (star-do.ts): the designation's both halves, and the rows' write_actor. */
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
// A null vector list is "the slot already holds this row" (funes-core IndexRow).
const encodeOps = (ops: IndexOp[]) => JSON.stringify(ops.map((o) => ("put" in o ? { put: { item: o.put.item, vectors: o.put.vectors?.map(vec) ?? null } } : o)));
const decodeOps = (s: string | null): IndexOp[] => (s == null ? [] : (JSON.parse(s) as Array<{ put: { item: MemoryItem; vectors: string[] | null } } | Exclude<IndexOp, { put: unknown }>>)
  .map((o) => ("put" in o ? { put: { item: o.put.item, vectors: o.put.vectors?.map(unvec) ?? null } } : o)));

export class Writer {
  private readonly sql: SqlStorage;
  private readonly store: EdgeStore;
  private readonly embedder: WorkersAiEmbedder;
  private readonly vault: R2Vault;
  private readonly star: StarConfig;
  /** One mutex per writer, which is one per instance: across instances the fence does the work. The
   *  mutex map is per isolate, shared by every object in it, so the key names the star too. */
  private readonly key: string;
  // The apply in this hold (the hold serializes, so one at a time): its journal row, and its receipt.
  private journalId: number | null = null;
  private proposal: Pick<Receipt, "proposalId" | "payloadHash"> | null = null;
  private receipt: Receipt | null = null;

  constructor(private readonly o: WriterOpts) {
    this.sql = o.storage.sql;
    this.embedder = new WorkersAiEmbedder(o.ai, o.storage);
    this.store = new EdgeStore(o.storage, this.embedder, { writeActor: o.locus });
    this.star = o.star;
    this.key = `star:${o.key}:${crypto.randomUUID()}`;
    this.vault = new R2Vault(o.bucket, {
      journal: (writes, out) => this.journal(writes, out),
      fence: (step) => this.fence(step),
      sleep: o.sleep,
    }, `${o.key}/_/`);
  }

  /** The star's mint allowlist (`edge.mint.telegram_ids`; the proof refused a malformed one). */
  get mintIds(): readonly string[] {
    return this.star.mintIds ?? [];
  }

  /** The proven object's first act (star-do.ts): arm the alarm when work remains — a pending
   *  journal, a running build, or a build trigger — so the recovery hold runs. Storage reads only. */
  async wake(): Promise<void> {
    if (this.pending() || this.building() || this.store.buildTrigger(this.o.key, this.buildInput())) await armAlarm(this.o.storage, Date.now());
  }

  /** The one `authorize` over the live rows, read now (ADR-0014): 401 for no grant, 403 for a grant
   *  that does not name this star. The entry checks it before it reads a body; `call` again. */
  private async grant(presented: string | null): Promise<Grant | Refusal> {
    const policy = livePolicy(this.sql, new Date());
    if (!policy) return { status: 401, error: "unauthorized", message: "the grants do not validate, so every token is refused: send Authorization: Bearer <token> once they do" };
    return authorize(presented, policy, { tier: "edge", star: this.star.identity.id, loopback: false, crossStar: false });
  }

  async authorize(presented: string | null): Promise<Authorized> {
    const g = await this.grant(presented);
    return "status" in g ? g : { actor: g.actor, ops: [...g.ops], stars: g.stars };
  }

  /** One request from the entry. The grant is read again inside this RPC, before any hold (record 24
   *  §6 step 1): a row revoked after the entry's check refuses here. */
  async call(presented: string | null, name: string, args: Record<string, unknown>): Promise<Reply> {
    const grant = await this.grant(presented);
    // the shape of every other refusal here: the message, and the reason as `code` (so a client tells 401 from 403)
    if ("status" in grant) return { status: grant.status, body: { error: grant.message, code: grant.error } };
    const op = EDGE_OPERATIONS.find((x) => x.name === name);
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

  /** A serializer hold: recovery first, then any full-build trigger begins the build and arms the
   *  alarm that runs it. A canary drift moves the embedding spec, so a running build restarts at its
   *  next batch, and a built slot triggers `versions` at the next hold. */
  private hold(fn: () => Promise<Reply>): Promise<Reply> {
    return serialize(this.key, async () => {
      try {
        await this.recover();
        const reason = this.building() ? null : this.store.buildTrigger(this.o.key, this.buildInput());
        if (reason) {
          await this.embedder.canaryOnce(); // the build's spec carries the recorded cfp
          await this.store.index.begin({ ...this.buildInput(), reason });
          await armAlarm(this.o.storage, Date.now());
        }
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
    return this.store.index.building;
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

  /** The frame's context: FunesStore over R2Vault and the edge store, with the star's declared rules. */
  private context(grant: Grant): OperationContext {
    return portContext({
      index: this.store, vault: this.vault, star: () => this.star, memoryDir: this.star.memoryDir!, // the proof requires both
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
      itemPages: this.star.itemPages!,
      // ADR-0014: only the outbox preset's actor is `outbox@<label>` (grants.ts), and it carries only
      // the approved seed and the replica watcher: its creates keep the zone default (record 24 §6.10).
      createTrust: grant.actor.startsWith("outbox@") ? "zone" : "untrusted",
      tier: "edge", designation: { locus: this.o.locus, authority: this.o.locus }, grant, actor: grant.actor,
    });
  }

  private async dispatch(grant: Grant, name: string, args: Record<string, unknown>): Promise<Reply> {
    try {
      // RAI-308: health's tier keys first, read synchronously before the op reaches the R2 listing;
      // the contract keys spread last, so a tier key can never overwrite one.
      const tier = name === "health" ? this.tierFields() : null;
      const body = await dispatchToolCall(name, args, this.context(grant));
      return { status: 200, body: tier ? { ...tier, ...(body as object) } : body };
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      return { status: code === "not-granted" ? 403 : 400, body: { error: (e as Error).message, ...(typeof code === "string" ? { code } : {}) } };
    }
  }

  /** Edge health's tier keys (item 40; record 24 §1, ADR-0015; RAI-308's closed list), read in one
   *  synchronous block from the DO's tables, outside the hold — so a pending journal reads `pending`
   *  while every mutation answers 503. `conflicts` counts abandoned rows the next hold has not yet
   *  turned into conflicts. The contract fields and freshness are the registry op's. */
  tierFields(): Record<string, unknown> {
    const count = (q: string) => this.sql.exec<{ n: number }>(q).one().n;
    return {
      proposalProtocol: PROPOSAL_PROTOCOL,
      starId: this.star.identity.id,
      applyState: this.applyState(),
      indexDirty: count("select count(*) as n from index_dirty"),
      conflicts: count("select count(*) as n from apply_journal where state in ('conflict', 'abandoned')"),
      okf: this.store.statsSync().okf,
    };
  }

  /** One mutation, inside the hold: phase 0 and the frame through FunesStore, then S4. */
  private async apply(grant: Grant, name: string, args: Record<string, unknown>): Promise<Reply> {
    // ADR-0015: writes hold during a full build, so R2 is static from its first list to its swap.
    if (this.building()) return { status: 503, body: { error: "a full build of the edge index is running; retry", applyState: "building" } };
    this.journalId = null;
    this.proposal = this.receipt = null;
    let body: unknown;
    try {
      body = await dispatchToolCall(name, args, this.context(grant));
    } catch (e) {
      if (e instanceof R2Conflict) {
        await this.conflict(this.journalId!);
        return { status: 500, body: { error: e.message } };
      }
      if (this.journalId != null || !(e as { code?: unknown }).code) return this.transient(e); // after S1 the change still completes
      this.store.discard();
      return { status: (e as { code?: unknown }).code === "not-granted" ? 403 : 400, body: { error: (e as Error).message, code: (e as { code?: unknown }).code } };
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

  // ── the full build (item 39; RAI-314) ────────────────────────────────────────────────────────

  /** The one build walk's input at the edge: R2 as the vault, the star's one scope exclude, six lanes
   *  (the simultaneous connection limit; the embedder paces them), the 1 MiB skip, and the edge's own
   *  finalize stamps. */
  private buildInput(): BuildInput {
    const { exclude, scopeSignature } = corpusOf(this.star.scope);
    return {
      vault: this.vault, exclude, scope: scopeSignature, okf: this.star.identity.capabilities.okf !== false,
      lanes: LANES, maxPageBytes: MAX_OBJECT_BYTES, onFinalize: () => this.store.finalized(this.o.key),
    };
  }

  /** One batch of the running build, inside the alarm's hold (so recover() ran and no journal is
   *  pending): at most `batchPages` pages after the cursor, committed with the cursor in one
   *  transactionSync; the last batch finalizes and flips the slot. A build begun under another spec
   *  (a deploy mid-build, a canary drift) starts over. An R2 or Workers AI error fails the batch,
   *  which the alarm retries from the same cursor. */
  private async buildBatch(): Promise<void> {
    await this.store.index.buildStep(this.buildInput(), this.o.batchPages ?? BATCH_PAGES);
  }
}
