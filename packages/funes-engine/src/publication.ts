// The cross-process index publication protocol (canon re-homing plan Rev 6, R3#6/R4#6/R5#2;
// conformance review major #2). Index consumers are separate PRINCIPALS (tailnet reader, remember
// broker, git sidecar) — an in-process handle swap cannot replace THEIR open handles, so
// publication goes through the filesystem:
//
//   writer (publishReindex, under the coordination lock when configured):
//     1. compute the TARGET generation-v1 from the vault content (generation.ts — cheap, no
//        embedding), SKIP when the published generation already equals it;
//     2. build the new index OFF-PATH (a fresh gen-<hex>.db beside the manifest — never the file
//        a consumer is serving from);
//     3. validate the build (not dirty, and its stamped generation EQUALS the target — a vault
//        mutated mid-build fails validation instead of publishing a mislabeled index);
//     4. FINALIZE the build for read-only consumers (wal_checkpoint(TRUNCATE) + journal_mode=
//        DELETE — an RO-mounted reader can't map WAL's -shm), then atomically publish the
//        generation manifest (temp file + rename on one filesystem);
//     5. best-effort retire the previous generation's db files (POSIX unlink — a consumer still
//        holding the old handle keeps its fd; new opens land on the new generation).
//
//   consumer (PublishedIndex): stats the manifest per op (or a short checkIntervalMs), opens +
//     swaps ITS OWN handle when the generation moved, and retires the old handle only after the
//     ops leasing it drain — a reader mid-op can never have its store closed under it (no torn
//     read), and a writer-broker resolving per op can never resume writing into a retired
//     generation.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Embedder, ScopeSignature } from "funes-core";
import { embeddingSignature, isTombstoned } from "funes-core";
import { CHUNK_SIG } from "./embedder.ts";
import { indexDir, walkResolvedItems, type IndexResult } from "./reindex.ts";
import { encodeGeneration, generationRecord, type GenerationRecord } from "funes-shared";
import { withCoordinationOrLock } from "./coordination.ts";
import type { FunesIndexStore } from "./store.ts";

export const GENERATION_MANIFEST = "generation.json";
/** The publish serialization lock's home when no coordination dir is configured (F1): a subdir of
 *  the publication home itself, so two publishers on one host contend on ONE lock.db. */
const PUBLISH_LOCK_DIR = ".publish-lock";

export interface GenerationManifest {
  version: 1;
  /** The published generation-v1 value (generation.ts). */
  generation: string;
  /** The store's db path RELATIVE to the manifest's dir (a file for libsql, a dir for pglite). */
  db: string;
  publishedAt: string;
}

export const manifestPath = (home: string): string => join(home, GENERATION_MANIFEST);

/** fsync a path (file OR directory), best-effort. A directory fsync after a rename is what makes
 *  the rename itself survive power loss (Codex R3#3); a file fsync flushes its data before we point
 *  the manifest at it. Best-effort because some platforms/filesystems (e.g. directory fsync on
 *  older macOS, or network mounts) reject it — a durability improvement must never fail a publish. */
function fsyncPath(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    /* best-effort: platform/fs may not support fsync on this target */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ── P1.6d: status-only per-principal ack channel + bounded retain-until-ack GC (Codex R3#3) ──────
// Index consumers (broker, read face) are separate PRINCIPALS in separate processes/containers,
// reachable only over the shared publication home's filesystem. Each writes the generation it is
// SERVING to a status file; the publisher reads those (never a network call, never the writer
// capability — this is a status-only channel) and retains a retired generation's db until every
// inventoried principal has acked the new one, or a TTL expires (a dead principal never acks). This
// replaces the previous immediate unlink: POSIX-unlink already protected in-flight readers, so this
// is disk-bounding + robustness (a principal that read the manifest but hasn't opened yet no longer
// races an unlink), not a data-loss fix.

const STATUS_DIR = ".status";
const PRINCIPALS_MANIFEST = "principals.json";
/** A retired generation's db is kept at least this long after it stops being current, so a consumer
 *  mid-open never races the unlink even with no inventory/acks. */
const DEFAULT_RETIRE_GRACE_MS = 60_000;
/** A principal whose status file is older than this is treated as DEAD — its ack no longer pins a
 *  generation (else a crashed consumer would retain a retired db forever). */
const DEFAULT_STALE_ACK_MS = 15 * 60_000;

const statusPath = (home: string, principal: string): string =>
  join(home, STATUS_DIR, `${principal.replace(/[^a-z0-9_-]/gi, "_")}.json`);

interface PrincipalStatus { principal: string; generation: string | null; at: number }

/** A principal records the generation it is now serving (atomic temp+rename). generation=null means
 *  DIRECT fallback (nothing published) — it pins nothing. */
export function writePrincipalStatus(home: string, principal: string, generation: string | null): void {
  try {
    mkdirSync(join(home, STATUS_DIR), { recursive: true });
    const p = statusPath(home, principal);
    const tmp = `${p}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify({ principal, generation, at: Date.now() } satisfies PrincipalStatus));
    renameSync(tmp, p);
  } catch {
    /* best-effort: a status write must never break serving a request */
  }
}

function readPrincipalStatuses(home: string): PrincipalStatus[] {
  let names: string[];
  try { names = readdirSync(join(home, STATUS_DIR)); } catch { return []; }
  const out: PrincipalStatus[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const s = JSON.parse(readFileSync(join(home, STATUS_DIR, n), "utf8")) as PrincipalStatus;
      if (s && typeof s.at === "number") out.push(s);
    } catch { /* skip unreadable/torn status */ }
  }
  return out;
}

/** The principals that MUST ack before a retired generation is GC'd (else only the TTL/grace
 *  bounds retention). Absent ⇒ null ⇒ TTL/grace-only. */
function readPrincipalInventory(home: string): string[] | null {
  try {
    const inv = JSON.parse(readFileSync(join(home, PRINCIPALS_MANIFEST), "utf8"));
    return Array.isArray(inv) && inv.every((x) => typeof x === "string") ? inv : null;
  } catch {
    return null;
  }
}

/** GC retired generation db files. `currentDb` is never removed. The immediately-previous db
 *  (`priorDb`) is RETAINED while any inventoried principal is still ALIVE (fresh status within
 *  staleAckMs) but serving an OLD generation — retain-until-ack — or while it is younger than
 *  `graceMs` (the floor that covers a consumer which read the manifest but hasn't opened yet, even
 *  with no inventory). A DEAD principal (no fresh status) never blocks GC. Older orphans (2+ behind
 *  or a crashed build's leftover) are removed once past the grace. POSIX unlink keeps any open fd
 *  valid regardless, so this only bounds disk + removes the manifest-read-then-open race. */
export function gcRetiredGenerations(
  home: string,
  opts: { currentDb: string; currentGeneration: string; priorDb?: string | null; graceMs?: number; staleAckMs?: number; now?: number },
): void {
  const now = opts.now ?? Date.now();
  const graceMs = opts.graceMs ?? DEFAULT_RETIRE_GRACE_MS;
  const staleAckMs = opts.staleAckMs ?? DEFAULT_STALE_ACK_MS;
  const fresh = readPrincipalStatuses(home).filter((s) => now - s.at <= staleAckMs);
  const inventory = readPrincipalInventory(home);
  // The grace window only matters when there ARE live consumers to protect: with no face running
  // (CLI publish, dev) the prior is removed immediately, exactly as before the ack channel.
  const hasLiveConsumers = fresh.length > 0;
  // A principal blocks GC of the prior only if it is ALIVE and serving something other than current;
  // a dead/absent principal (no fresh status) does not block (else a crash would retain forever).
  const blocked = inventory != null && inventory.some((p) => {
    const s = fresh.find((x) => x.principal === p);
    return s != null && s.generation !== opts.currentGeneration;
  });
  let files: string[];
  try { files = readdirSync(home); } catch { return; }
  for (const f of files) {
    if (!/^gen-.*\.db$/.test(f)) continue;
    if (f === opts.currentDb) continue; // never remove the live generation
    let st;
    try { st = statSync(join(home, f)); } catch { continue; }
    const young = hasLiveConsumers && now - st.mtimeMs < graceMs;
    if (f === opts.priorDb ? (blocked || young) : young) continue;
    rmDbFiles(join(home, f));
  }
}

/** Read + validate the published manifest; null when absent or unreadable (a consumer treats
 *  null as "nothing published", a writer as "no generation to skip against"). */
export function readGenerationManifest(home: string): GenerationManifest | null {
  try {
    const m = JSON.parse(readFileSync(manifestPath(home), "utf8")) as GenerationManifest;
    if (m?.version !== 1 || typeof m.generation !== "string" || typeof m.db !== "string" || m.db.includes("..") || m.db.startsWith("/")) return null;
    return m;
  } catch {
    return null;
  }
}

/** Atomic + crash-durable publish (Codex R3#3): write to a temp sibling, fsync the temp file,
 *  rename onto the manifest path (same dir ⇒ same filesystem ⇒ atomic on POSIX), then fsync the
 *  DIRECTORY so the rename survives power loss. A consumer reads either the old or the new manifest,
 *  never a torn one — and after a crash it reads a complete manifest, never a half-written temp. */
export function publishGenerationManifest(home: string, manifest: GenerationManifest): void {
  mkdirSync(home, { recursive: true });
  const tmp = join(home, `.${GENERATION_MANIFEST}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n");
  fsyncPath(tmp); // the manifest bytes hit disk before the rename points at them
  renameSync(tmp, manifestPath(home));
  fsyncPath(home); // the rename (directory entry) is durable
}

/** The records a FULL build over this vault would index — shares indexDir's exact resolved-item
 *  walk (walkResolvedItems: same reference maps, same edge resolution incl. N5 aliases, tombstones
 *  skipped) so the writer's target and the build's stamp can never disagree. Before Codex R1#4 this
 *  resolved basenames only (buildBasenameMap) while indexDir also resolved aliases, so an
 *  alias-using vault failed every publish on a target/built generation mismatch. Cheap: parses
 *  markdown, embeds nothing. */
export function collectGenerationRecords(vault: string, opts: { exclude?: (rel: string) => boolean } = {}): GenerationRecord[] {
  const records: GenerationRecord[] = [];
  for (const { item, meta } of walkResolvedItems(vault, vault, { exclude: opts.exclude })) {
    if (isTombstoned(meta)) continue;
    records.push(generationRecord(item));
  }
  return records;
}

/** The target generation a FULL build over this vault would stamp, given the embedder + scope. */
export function computeTargetGeneration(
  vault: string,
  opts: { embedder: Embedder; scopeSignature: ScopeSignature | null; exclude?: (rel: string) => boolean },
): string {
  return encodeGeneration({
    records: collectGenerationRecords(vault, { exclude: opts.exclude }),
    scope: opts.scopeSignature,
    embeddingSpec: `${embeddingSignature(opts.embedder)}:${CHUNK_SIG}`,
  });
}

export interface PublishReindexOpts {
  vault: string;
  /** The index HOME dir: the manifest and every generation db live here (for libsql this is the
   *  dir funesDbDir()'s index.db sits in). Must be writable by the publisher only. */
  home: string;
  /** The embedder the built store will enforce — also pins the target generation's embedding spec. */
  embedder: Embedder;
  /** Open/create the off-path store at a given db path (backend-specific — e.g.
   *  (p) => LibsqlStore.create(embedder, p) or a makeStore closure). */
  open: (dbPath: string) => Promise<FunesIndexStore>;
  exclude?: (rel: string) => boolean;
  scopeSignature?: ScopeSignature | null;
  /** Republish even when the published generation equals the target (repair path). */
  force?: boolean;
  batch?: number;
  onProgress?: (r: IndexResult) => void;
}

export interface PublishReindexResult {
  generation: string;
  /** true ⇒ the published generation already equalled the target; nothing was built or moved. */
  skipped: boolean;
  /** Absolute path of the newly built db (null when skipped). */
  dbPath: string | null;
}

const rmDbFiles = (p: string): void => {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(p + suffix, { recursive: true, force: true });
};

/** F5/R2-2: may we SKIP re-publishing this equal-generation manifest? Only if its target is fully
 *  servable to a read face RIGHT NOW. A pglite dir home has no RO-mount finalization concept, so it
 *  stays skippable-on-generation. A libsql single-file target must: exist, carry NO hot sidecar
 *  (-wal/-shm/-journal), have a DELETE-journal header, AND pass the read face's OWN zero-write RO
 *  validation (meta + core tables + embedding sig + NOT dirty) with an internal generation matching
 *  the manifest. Any failure ⇒ NOT servable ⇒ don't skip, rebuild — this catches the NAS's legacy
 *  WAL publication AND a dirty / partial / mislabeled one a header check alone would wave through. */
async function publishedTargetIsServable(home: string, manifest: GenerationManifest, embedder: Embedder): Promise<boolean> {
  const dbPath = join(home, manifest.db);
  let st;
  try { st = statSync(dbPath); } catch { return false; } // vanished ⇒ can't skip onto a missing db
  if (st.isDirectory()) return true; // pglite pgdata — not a single-file RO-finalized db
  for (const sfx of ["-wal", "-shm", "-journal"]) if (existsSync(dbPath + sfx)) return false; // hot sidecar ⇒ not finalized
  let fd: number | undefined; // fast header pre-filter: a WAL header can't be opened mode=ro at all
  try {
    fd = openSync(dbPath, "r");
    const head = Buffer.alloc(20);
    if (readSync(fd, head, 0, 20, 0) < 20) return false;
    if (head.toString("latin1", 0, 16) !== "SQLite format 3\0") return false;
    if (!(head[18] === 1 && head[19] === 1)) return false; // 1 = DELETE journal, 2 = WAL
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  // zero-write RO open: reuse the read face's own validation (meta/core-tables/sig/dirty refusal),
  // and require the db's internal generation stamp to match the manifest it's published under.
  try {
    const { LibsqlStore } = await import("funes-libsql");
    const ro = await LibsqlStore.create(embedder, dbPath, { readonly: true });
    try { return (await ro.getGeneration()) === manifest.generation; }
    finally { await ro.close(); }
  } catch {
    return false; // any RO-open / validation failure ⇒ rebuild, never skip
  }
}

/** In-process per-home serialization of TOP-LEVEL publishes (R2-1). The cross-process coordination
 *  lock is REENTRANT within one process, so two Promise.all() publishReindex() calls would overlap
 *  and an older delayed build could publish AFTER a newer one (manifest rollback). A per-home
 *  promise chain forces concurrent top-level publishes to run strictly one at a time, in start
 *  order — the later-started build serializes after the earlier and its manifest wins. Nested funes
 *  writes (indexDir → withCoordination) never route through here, so their reentrancy is untouched. */
const publishChains = new Map<string, Promise<unknown>>();
const homeKey = (home: string): string => { try { return realpathSync(home); } catch { return home; } };

/** Build-off-path → validate → FINALIZE → atomically publish. Serialized THREE ways: an in-process
 *  per-home mutex (R2-1: top-level publishes never overlap in one process), the shared vault lock
 *  when FUNES_COORDINATION_DIR is set else <home>/.publish-lock (F1: cross-process/container), and a
 *  collision-proof temp build renamed into place only after validate+finalize (F1: crash-safe belt). */
export async function publishReindex(opts: PublishReindexOpts): Promise<PublishReindexResult> {
  mkdirSync(opts.home, { recursive: true });
  const key = homeKey(opts.home);
  const prior = publishChains.get(key) ?? Promise.resolve();
  const settled = prior.then(() => publishReindexInner(opts), () => publishReindexInner(opts));
  const guard = settled.catch(() => {}); // the link the NEXT publish waits on (never rejects)
  publishChains.set(key, guard);
  try {
    return await settled;
  } finally {
    if (publishChains.get(key) === guard) publishChains.delete(key); // GC the tail (unbounded-growth guard)
  }
}

async function publishReindexInner(opts: PublishReindexOpts): Promise<PublishReindexResult> {
  return withCoordinationOrLock(join(opts.home, PUBLISH_LOCK_DIR), async () => {
    const scope = opts.scopeSignature ?? null;
    const target = computeTargetGeneration(opts.vault, { embedder: opts.embedder, scopeSignature: scope, exclude: opts.exclude });
    const current = readGenerationManifest(opts.home);
    // SKIP when the published generation equals the target (R3#6: reindex is CONDITIONAL — a
    // clean-tree sync pass costs a parse walk, not an embed pass) — UNLESS that publication is not
    // fully servable to a read face (F5/R2-2): a legacy WAL, dirty, partial, or mislabeled target
    // matches on generation but can't be served RO, so we rebuild instead of skipping.
    if (!opts.force && current?.generation === target && (await publishedTargetIsServable(opts.home, current, opts.embedder))) {
      return { generation: target, skipped: true, dbPath: null };
    }
    const hex = target.split(":")[1] ?? target;
    let finalDbName = `gen-${hex.slice(0, 12)}.db`;
    if (current?.db === finalDbName) finalDbName = `gen-${hex.slice(0, 12)}-${Date.now()}.db`; // force/rebuild: never onto the live file a consumer may hold
    const finalDbPath = join(opts.home, finalDbName);
    // Build into a COLLISION-PROOF temp name (F1), never the deterministic final path a concurrent
    // or crashed build might share — renamed atomically into place only after validate+finalize.
    const buildPath = join(opts.home, `gen-${hex.slice(0, 12)}.${process.pid}-${randomBytes(6).toString("hex")}.building.db`);
    rmDbFiles(buildPath);
    const store = await opts.open(buildPath);
    try {
      await indexDir(store, opts.vault, opts.vault, {
        exclude: opts.exclude,
        scopeSignature: scope,
        batch: opts.batch,
        onProgress: opts.onProgress,
      });
      // Validate BEFORE publishing: the built index must be clean and stamped with EXACTLY the
      // target generation — a vault that mutated between target computation and build walk stamps
      // a different generation and fails here instead of publishing a mislabeled index.
      const stats = await store.stats();
      const built = await store.getGeneration();
      if (stats.reindexDirty) throw new Error("publishReindex: built index is dirty — refusing to publish");
      if (built !== target) {
        throw new Error(
          `publishReindex: generation moved during the build (target ${target}, built ${built ?? "null"}) — vault mutated mid-build; not published, retry`,
        );
      }
      // FINALIZE before the swap (RO-open companion, 2026-07-16): checkpoint + journal_mode=DELETE
      // on the built gen db, so a consumer on a READ-ONLY mount can open it with zero write access
      // (a WAL db needs -shm even for readers). On the store's OWN handle — a second connection
      // hits SQLITE_BUSY while this one's statements are un-GC'd. Optional on the interface:
      // libsql-only (a pglite dir home has no SQLite journal to flip). Inside the try: a failed
      // finalize is a failed build (cleaned up, never published). After this the db has no
      // -wal/-shm sidecars, so the rename below moves a single self-contained file.
      await store.finalizeForPublish?.();
    } catch (e) {
      await store.close().catch(() => {});
      rmDbFiles(buildPath); // never leave a half-built generation for a future publish to trust
      throw e;
    }
    await store.close();
    // Durability order (Codex R3#3): fsync the built db, rename it into the served path, fsync the
    // dir so that rename survives a crash — all BEFORE the manifest is published to point at it. A
    // crash after this but before the manifest swap leaves an orphan gen db (harmless; the next
    // publish rebuilds), never a manifest pointing at a half-written or lost db.
    fsyncPath(buildPath);
    renameSync(buildPath, finalDbPath);
    fsyncPath(opts.home);
    publishGenerationManifest(opts.home, { version: 1, generation: target, db: finalDbName, publishedAt: new Date().toISOString() });
    // Retire retired generations under the ack channel (P1.6d): the immediately-previous db is kept
    // until every inventoried principal has acked the new generation (or a TTL/grace passes), so a
    // consumer that read the old manifest but hasn't opened yet never races the unlink. Consumers
    // still holding an old handle keep their fd regardless (POSIX unlink semantics).
    gcRetiredGenerations(opts.home, { currentDb: finalDbName, currentGeneration: target, priorDb: current?.db ?? null });
    return { generation: target, skipped: false, dbPath: finalDbPath };
  });
}

// ── the consumer half ─────────────────────────────────────────────────────────────────────────────

interface LiveHandle {
  /** null = the DIRECT fallback handle (no generation published yet). */
  generation: string | null;
  /** The manifest.db this handle was opened from (null = DIRECT fallback). PAIRS with `generation`
   *  as the live publication identity (F2) — a --force republish keeps the generation but moves the
   *  db, so the generation alone would never trigger a swap. */
  db: string | null;
  store: FunesIndexStore;
  leases: number;
  retired: boolean;
  /** Set by close() when it has to wait for in-flight leases; called by the last one to drain. */
  onDrained?: () => void;
}

/** A swap-target open that failed because the db FILE vanished (F4): ENOENT, or the read face's RO
 *  open reporting "cannot open index read-only …" — the publisher POSIX-unlinked the generation
 *  under us between our manifest read and the open. Retryable against a freshly re-read manifest. */
const isVanishedDb = (e: unknown): boolean => {
  const msg = (e as Error)?.message ?? "";
  return (e as { code?: string })?.code === "ENOENT" || /ENOENT|no such file|cannot open index read-only/i.test(msg);
};

export interface PublishedIndexOpts {
  /** Re-stat the manifest at most this often (ms). 0 (default) = per op — the strictest reading
   *  of "consumers stat the manifest per op"; a busy face can widen it to a short interval. */
  checkIntervalMs?: number;
  /** DIRECT-mode fallback (publication-home unify, 2026-07-16): when NO manifest is published,
   *  serve this static db path (generation null) instead of refusing — and keep statting, so the
   *  first publish is adopted on the next op through the normal swap+drain machinery (a face
   *  booted before the sidecar's first publish never needs a restart). Unset = refuse loudly,
   *  the original strict-consumer behavior. */
  fallbackDbPath?: string;
  /** P1.6d: called after each swap with the now-served generation (null = DIRECT fallback). A face
   *  wires it to write its status file — the ack the publisher's retain-until-ack GC reads. */
  onServe?(generation: string | null): void;
}

/** A consumer's handle onto the published index: every op runs through with(), which re-reads the
 *  manifest (per op or per checkIntervalMs), swaps to the newly published generation when it
 *  moved, and retires the old handle only after its in-flight ops drain. */
export class PublishedIndex {
  private current: LiveHandle | null = null;
  private lastCheck = 0;
  private swapping: Promise<void> | null = null;
  private closed = false;

  // P3.15: explicit fields, not parameter properties (non-erasable TS — Node's loader refuses it).
  private readonly home: string;
  private readonly open: (dbPath: string) => Promise<FunesIndexStore>;
  private readonly opts: PublishedIndexOpts;

  constructor(
    home: string,
    open: (dbPath: string) => Promise<FunesIndexStore>,
    opts: PublishedIndexOpts = {},
  ) {
    this.home = home;
    this.open = open;
    this.opts = opts;
  }

  /** The generation currently served (null before the first op). */
  get generation(): string | null {
    return this.current?.generation ?? null;
  }

  private async maybeSwap(): Promise<void> {
    const interval = this.opts.checkIntervalMs ?? 0;
    const now = Date.now();
    if (this.current && interval > 0 && now - this.lastCheck < interval) return;
    this.lastCheck = now;
    const manifest = readGenerationManifest(this.home);
    if (!manifest) {
      if (this.current) return; // keep serving the handle we have; a vanished manifest is the writer's bug
      if (!this.opts.fallbackDbPath) {
        throw new Error(`funes: no published generation at ${manifestPath(this.home)} — run a publishing reindex first`);
      }
      // fall through: open the DIRECT fallback as the current (generation-null) handle
    } else if (this.current && this.current.generation === manifest.generation && this.current.db === manifest.db) {
      return; // identity is the (generation, db) PAIR (F2): a --force republish keeps the generation but moves the db
    }
    if (this.swapping) return this.swapping; // one swap at a time; concurrent ops ride the same one
    this.swapping = (async () => {
      const opened = await this.openTarget(manifest);
      const old = this.current;
      this.current = { generation: opened.generation, db: opened.db, store: opened.store, leases: 0, retired: false };
      // LOUD mode/swap line (unify fix): a misconfigured home shows up as "DIRECT" in the logs
      // instead of silently never swapping.
      process.stderr.write(
        `funes index: serving ${opened.generation ? `published generation ${opened.generation.slice(0, 20)}…` : "DIRECT live index (no manifest)"} at ${opened.path}` +
        `${old ? ` (swapped from ${old.generation ? `${old.generation.slice(0, 20)}…` : "direct"})` : ""}\n`,
      );
      if (old) {
        old.retired = true;
        if (old.leases === 0) await old.store.close().catch(() => {});
        // else: the last draining lease closes it (release() below)
      }
      // P1.6d: record the ack (the generation this principal now serves) so the publisher's GC can
      // retain-until-ack. Best-effort inside writePrincipalStatus — never blocks the swap.
      this.opts.onServe?.(opened.generation);
    })();
    try {
      await this.swapping;
    } finally {
      this.swapping = null;
    }
  }

  /** Open the swap target, retrying ONCE against a freshly re-read manifest when the db VANISHED
   *  under us (F4 TOCTOU: the publisher swapped + POSIX-unlinked the old generation between our
   *  manifest read in maybeSwap and this open, so the path we hold now ENOENTs). One retry only —
   *  a still-failing open, or nothing newer to point at, surfaces the real error. */
  private async openTarget(
    manifest: GenerationManifest | null,
  ): Promise<{ store: FunesIndexStore; generation: string | null; db: string | null; path: string }> {
    const path = manifest ? join(this.home, manifest.db) : this.opts.fallbackDbPath!;
    try {
      return { store: await this.open(path), generation: manifest?.generation ?? null, db: manifest?.db ?? null, path };
    } catch (e) {
      if (!isVanishedDb(e)) throw e;
      const fresh = readGenerationManifest(this.home);
      const freshPath = fresh ? join(this.home, fresh.db) : this.opts.fallbackDbPath;
      if (!freshPath || freshPath === path) throw e; // nothing newer to retry against — the real failure stands
      return { store: await this.open(freshPath), generation: fresh?.generation ?? null, db: fresh?.db ?? null, path: freshPath };
    }
  }

  /** Lease the current generation's store for ONE op. The lease pins the handle for fn's whole
   *  duration — a concurrent republish swaps the pointer but never closes a leased store.
   *  `generation` is null while serving the DIRECT fallback (nothing published yet). */
  async with<T>(fn: (store: FunesIndexStore, generation: string | null) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("PublishedIndex: closed");
    await this.maybeSwap();
    const handle = this.current;
    if (!handle) throw new Error("PublishedIndex: no live generation"); // unreachable after maybeSwap
    handle.leases++;
    try {
      return await fn(handle.store, handle.generation);
    } finally {
      handle.leases--;
      if (handle.retired && handle.leases === 0) {
        await handle.store.close().catch(() => {});
        handle.onDrained?.(); // unblocks a close() that is waiting on this lease
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const cur = this.current;
    this.current = null;
    if (!cur) return;
    if (cur.leases === 0) { await cur.store.close().catch(() => {}); return; }
    // With a lease in flight this used to mark the handle retired and RESOLVE — so `await
    // index.close()` returned while the db was still open, and callers that then delete the
    // generation file (the GC does exactly that) raced a live reader. The draining lease still does
    // the closing; close() now waits for it rather than reporting a shutdown that has not happened.
    cur.retired = true;
    await new Promise<void>((resolve) => { cur.onDrained = resolve; });
  }
}

/** Whether a generation manifest is published at this index home (the face's mode switch). */
export function hasPublishedGeneration(home: string): boolean {
  try {
    statSync(manifestPath(home));
    return readGenerationManifest(home) != null;
  } catch {
    return false;
  }
}
