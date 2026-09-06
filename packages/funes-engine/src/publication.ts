// The cross-process index publication protocol (canon re-homing plan Rev 6, R3#6/R4#6/R5#2;
// conformance review major #2). Index consumers are separate PRINCIPALS (tailnet reader, remember
// broker, git sidecar) — an in-process handle swap cannot replace THEIR open handles, so
// publication goes through the filesystem:
//
//   writer (publishReindex, under the PUBLICATION FENCE — see withPublicationFence, item 9):
//     1. compute the TARGET generation-v1 from the vault content (generation.ts — cheap, no
//        embedding), SKIP when the published generation already equals it;
//     2. build the new index OFF-PATH (a fresh gen-<hex>.db beside the manifest — never the file
//        a consumer is serving from), SEEDED by a clone of the prior generation when that one is
//        servable (item 14) so unchanged pages hash-skip instead of re-embedding;
//     3. validate the build (not dirty, and its stamped generation EQUALS the target — a vault
//        mutated mid-build fails validation instead of publishing a mislabeled index);
//     4. RECOMPUTE the target from the vault, under the fence, immediately before the swap, and
//        refuse unless it still equals the built database's content generation (item 10);
//     5. FINALIZE the build for read-only consumers (wal_checkpoint(TRUNCATE) + journal_mode=
//        DELETE — an RO-mounted reader can't map WAL's -shm), then atomically publish the
//        generation manifest (temp file + rename on one filesystem);
//     6. best-effort retire the previous generation's db files (POSIX unlink — a consumer still
//        holding the old handle keeps its fd; new opens land on the new generation), honouring any
//        stored `retainUntil` rollback pin (item 38).
//
//   consumer (PublishedIndex): stats the manifest per op (or a short checkIntervalMs), opens +
//     swaps ITS OWN handle when the generation moved, and retires the old handle only after the
//     ops leasing it drain — a reader mid-op can never have its store closed under it (no torn
//     read), and a writer-broker resolving per op can never resume writing into a retired
//     generation.
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import type { ContentIdentity, Embedder, ScopeSignature } from "funes-core";
import { embeddingSignature, isTombstoned } from "funes-core";
import { CHUNK_SIG } from "./embedder.ts";
import { indexDir, walkResolvedItems, type IndexResult } from "./reindex.ts";
import { encodeGeneration, generationRecord, GENERATION_VERSION, INDEX_SCHEMA_VERSION, type GenerationRecord } from "funes-shared";
import { withCoordinationOrLock } from "./coordination.ts";
import { assertIndexNotInSyncRoot } from "./sync-root.ts";
import { FUNES_VERSION } from "./version.ts";
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
  /** PLAN-0.3.0 item 8: the IMMUTABLE name of this published artefact, generated before the build
   *  is finalized and stamped in BOTH this manifest and the database it points at, so the two can
   *  be validated as a pair on every open. Local state (a principal's ack, a retention decision)
   *  binds to THIS, never to `generation` — which is a content generation, moves with the rows, and
   *  is answered only by the database. Additive, so the manifest stays `version: 1`: an older
   *  consumer ignores it, and this build treats its ABSENCE as legacy (see `publicationIdOf`). */
  publicationId?: string;
  /** OPTIONAL (PLAN-0.2.1 step 12): the identity of the star this generation was built from. The
   *  manifest stays `version: 1` on purpose — the field is additive, an older consumer ignores it,
   *  and a newer one treats its ABSENCE as "unknown", never as "matches". */
  starId?: string;
}

export const manifestPath = (home: string): string => join(home, GENERATION_MANIFEST);

/** PLAN-0.3.0 item 9 — THE per-publication-home mutation fence, and the only one.
 *
 *  What it replaces, and why the previous arrangement fenced nothing: the store's own write lock is
 *  keyed by DATABASE PATH, and a publication home holds at least three of those — the off-path
 *  builder's `gen-*.building.db`, the currently published `gen-*.db` a broker is mutating, and the
 *  replacement about to take its place. Three keys, so a broker write and a publish were serialized
 *  by nothing at all; meanwhile `<home>/.publish-lock` serialized publishers against each other and
 *  the broker never touched it. The result was the exact race item 10 also guards: a broker commits
 *  markdown + index rows AFTER the publisher's validation and BEFORE its manifest swap, and the
 *  published artefact silently omits them.
 *
 *  The key is the HOME (or, when a composition configures one, the shared coordination dir — a
 *  strictly coarser fence over the same participants), so both sides contend on ONE lock whatever
 *  database path they happen to be holding. Reentrant per async owner, so the publisher's nested
 *  `indexDir` and the broker's nested `funes.remember` still pass straight through.
 *
 *  Ceiling: this fences funes writers. A process that predates the fence — a 0.2.x broker — does not
 *  acquire it, which is why the rollout (step 31) stops legacy writers BEFORE any v4 artefact
 *  exists rather than trusting the fence to hold them out. */
export async function withPublicationFence<T>(home: string, fn: () => Promise<T>): Promise<T> {
  return withCoordinationOrLock(join(home, PUBLISH_LOCK_DIR), fn);
}

/** The publication id a manifest names. A LEGACY manifest (published before item 8) names none, so
 *  one is DERIVED from `(generation, db)` — never from the generation alone, because a forced
 *  republish keeps the generation and moves the db, and the pair is what identity meant then
 *  (Codex R4#2). `legacy:`-prefixed and unvalidatable on purpose: the old database carries no
 *  stamp to compare it against, so it exists only to give local state a stable name to bind to
 *  until a rebuild establishes a real one. */
export function publicationIdOf(m: GenerationManifest): string {
  return m.publicationId ?? `legacy:${createHash("sha256").update(`${m.generation}\u0000${m.db}`).digest("hex").slice(0, 32)}`;
}

/** A fresh publication id. RANDOM, not derived from the content: a `--force` republish of identical
 *  rows is a DIFFERENT publication of the same content generation, and the two must be tellable
 *  apart by anything that binds to the id. */
const newPublicationId = (): string => `pub:${randomBytes(16).toString("hex")}`;

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

/** PLAN-0.3.0 item 8 (fourth bullet) + item 33 + RAI-143 clause 3 — the status file's shape.
 *
 *  `{ publicationId, contentGeneration, principal, protocolVersion, softwareVersion, at }`.
 *
 *  - **publicationId** — the ONLY thing retention and collection key on. IMMUTABLE: an artefact
 *    answers with the id it was stamped with for as long as it exists, while `contentGeneration` is
 *    nullable and MUTATES — an incremental broker write invalidates it in the very database the
 *    principal is still serving. Keying retention on the mutating half meant a live principal's ack
 *    silently stopped matching and pinned a retired db forever, or (the other direction) a re-stamp
 *    made a still-serving principal look acked.
 *  - **contentGeneration** — DIAGNOSTIC only. It was named `generation` before item 33; a status
 *    written by an older build still uses that key and is read back through it (below), because a
 *    rollout that cannot read the fleet it is migrating cannot gate on it.
 *  - **protocolVersion / softwareVersion** (item 33) — what this process SPEAKS, not what the
 *    artefact is. Rollout step 33 has to prove POSITIVELY that no legacy process remains, and the
 *    absence of a status proves nothing (a v3 process emits no heartbeat, so silence is
 *    indistinguishable from death). A fresh status advertising v4 is the only positive evidence a
 *    principal can produce about itself; `null` here means "a build too old to say", which the fleet
 *    gate must treat as legacy rather than as unknown. */
export interface PrincipalStatus {
  publicationId: string | null;
  contentGeneration: string | null;
  principal: string;
  protocolVersion: string | null;
  softwareVersion: string | null;
  at: number;
}

/** A principal records the publication it is now serving, its content generation as diagnostics, and
 *  the protocol + software it speaks (atomic temp+rename).
 *
 *  DEFECT RAI-144 — this used to fire ONLY on a publication swap, and its one caller was the face's
 *  `onServe`. A face that swapped once at boot and then served quietly for 15 minutes crossed
 *  DEFAULT_STALE_ACK_MS, read as DEAD, stopped blocking collection, and had the artefact it was
 *  still open on retired under it. Item 8 already names the fix — status is "refreshed on a
 *  heartbeat and after mutations, not only after publication swaps" — see startPrincipalHeartbeat. */
export function writePrincipalStatus(home: string, principal: string, publicationId: string | null, contentGeneration: string | null): void {
  try {
    mkdirSync(join(home, STATUS_DIR), { recursive: true });
    const p = statusPath(home, principal);
    const tmp = `${p}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify({
      publicationId, contentGeneration, principal,
      protocolVersion: INDEX_SCHEMA_VERSION, softwareVersion: FUNES_VERSION, at: Date.now(),
    } satisfies PrincipalStatus));
    renameSync(tmp, p);
  } catch {
    /* best-effort: a status write must never break serving a request */
  }
}

export function readPrincipalStatuses(home: string): PrincipalStatus[] {
  let names: string[];
  try { names = readdirSync(join(home, STATUS_DIR)); } catch { return []; }
  const out: PrincipalStatus[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const s = JSON.parse(readFileSync(join(home, STATUS_DIR, n), "utf8")) as Partial<PrincipalStatus> & { generation?: string | null };
      if (!s || typeof s.at !== "number") continue;
      out.push({
        // A pre-item-33 status names none of the three new fields. Normalize rather than widen the
        // type: every consumer below then reads ONE shape, and "written by a build that could not
        // say" is expressed as null — which is what makes the fleet gate's refusal correct.
        publicationId: typeof s.publicationId === "string" ? s.publicationId : null,
        contentGeneration: (typeof s.contentGeneration === "string" ? s.contentGeneration : s.generation) ?? null,
        principal: typeof s.principal === "string" ? s.principal : n.replace(/\.json$/, ""),
        protocolVersion: typeof s.protocolVersion === "string" ? s.protocolVersion : null,
        softwareVersion: typeof s.softwareVersion === "string" ? s.softwareVersion : null,
        at: s.at,
      });
    } catch { /* skip unreadable/torn status */ }
  }
  return out;
}

/** How often a principal re-stamps its status file. Well under DEFAULT_STALE_ACK_MS on purpose: the
 *  liveness signal must survive a dozen missed beats before a publisher concludes the principal died
 *  and collects the artefact it is serving. */
export const DEFAULT_HEARTBEAT_MS = 60_000;

export interface PrincipalHeartbeat {
  /** Re-stamp NOW. Called after a mutation as well as on the timer — a broker write invalidates the
   *  content generation in the database it is serving, and the plan requires the diagnostic half to
   *  follow the mutation rather than wait for the next swap. */
  refresh(): Promise<void>;
  stop(): void;
}

/** DEFECT RAI-144 — the heartbeat. `sample` is asked for the CURRENT identity each beat rather than
 *  handed a snapshot, because both halves move underneath a long-lived principal: the publication id
 *  on a swap, and the content generation on every incremental write. Failures are swallowed: a
 *  status write must never take down a serving process, and a missed beat costs liveness, not
 *  safety (the publisher's fail-safe is to RETAIN, not to collect). */
export function startPrincipalHeartbeat(
  home: string,
  principal: string,
  sample: () => Promise<{ publicationId: string | null; contentGeneration: string | null }>,
  opts: { intervalMs?: number } = {},
): PrincipalHeartbeat {
  const refresh = async (): Promise<void> => {
    try {
      const s = await sample();
      writePrincipalStatus(home, principal, s.publicationId, s.contentGeneration);
    } catch { /* best-effort — never break serving */ }
  };
  const timer = setInterval(() => void refresh(), Math.max(1_000, opts.intervalMs ?? DEFAULT_HEARTBEAT_MS));
  timer.unref?.(); // a heartbeat must never be the reason a process refuses to exit
  return { refresh, stop: () => clearInterval(timer) };
}

// ── PLAN-0.3.0 item 38: rollback retention is a STORED PIN, not an adjective ─────────────────────
// "Retain the prior artefact for the rollback window" was a sentence in a plan and nothing in the
// code: the GC's only retention inputs were live acks and a 60s grace, so on a home with no live
// consumer recorded — a CLI publish, a face that had just restarted, any home mid-rollout — the
// prior artefact was unlinked IMMEDIATELY, which is exactly the moment a rollback needs it. A pin is
// a file beside the db it protects, so it survives the publishing process, is visible to an operator
// with `ls`, and is honoured by whichever process happens to run the next collection.
const RETAIN_SUFFIX = ".retain";

/** Pin a generation db against collection until `retainUntilMs`. Throws on failure BY DESIGN and is
 *  written BEFORE the manifest swap: a rollback plan that silently failed to retain its rollback
 *  target is worse than a publish that refused. */
export function pinRetention(home: string, db: string, retainUntilMs: number): void {
  writeFileSync(join(home, db + RETAIN_SUFFIX), JSON.stringify({ db, retainUntil: retainUntilMs, pinnedAt: Date.now() }) + "\n");
}

/** The pin on a generation db, or null when it carries none / an unreadable one. An unreadable pin
 *  reads as ABSENT rather than as infinite: a corrupt file must not retain an artefact forever. */
export function retainUntilOf(home: string, db: string): number | null {
  try {
    const v = (JSON.parse(readFileSync(join(home, db + RETAIN_SUFFIX), "utf8")) as { retainUntil?: unknown }).retainUntil;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
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
 *  staleAckMs) but serving an OLD PUBLICATION — retain-until-ack — or while it is younger than
 *  `graceMs` (the floor that covers a consumer which read the manifest but hasn't opened yet, even
 *  with no inventory). A DEAD principal (no fresh status) never blocks GC. Older orphans (2+ behind
 *  or a crashed build's leftover) are removed once past the grace. POSIX unlink keeps any open fd
 *  valid regardless, so this only bounds disk + removes the manifest-read-then-open race. */
export function gcRetiredGenerations(
  home: string,
  opts: { currentDb: string; currentPublicationId: string; priorDb?: string | null; graceMs?: number; staleAckMs?: number; now?: number },
): void {
  const now = opts.now ?? Date.now();
  const graceMs = opts.graceMs ?? DEFAULT_RETIRE_GRACE_MS;
  const staleAckMs = opts.staleAckMs ?? DEFAULT_STALE_ACK_MS;
  const fresh = readPrincipalStatuses(home).filter((s) => now - s.at <= staleAckMs);
  const inventory = readPrincipalInventory(home);
  // The grace window only matters when there ARE live consumers to protect: with no face running
  // (CLI publish, dev) the prior is removed immediately, exactly as before the ack channel.
  const hasLiveConsumers = fresh.length > 0;
  // A principal blocks GC of the prior only if it is ALIVE and serving a different PUBLICATION;
  // a dead/absent principal (no fresh status) does not block (else a crash would retain forever).
  //
  // The comparison is on `publicationId` alone (item 8): it is the immutable name of the artefact,
  // and the content generation moves underneath a principal that never swapped. A LEGACY status
  // written before this build carries no id at all, and `undefined !== <the current id>` makes it
  // BLOCK — deliberately fail-safe. We cannot tell which publication such a principal opened, and
  // collecting an artefact a live principal might still serve is the one outcome this channel
  // exists to prevent; the staleAckMs TTL still bounds the retention when that principal dies.
  const blocked = inventory != null && inventory.some((p) => {
    const s = fresh.find((x) => x.principal === p);
    return s != null && s.publicationId !== opts.currentPublicationId;
  });
  let files: string[];
  try { files = readdirSync(home); } catch { return; }
  for (const f of files) {
    if (!/^gen-.*\.db$/.test(f)) continue;
    if (f === opts.currentDb) continue; // never remove the live generation
    // item 38: the stored pin outranks every other input, INCLUDING "no live consumer is recorded"
    // — that case is precisely the one that used to unlink the rollback target immediately.
    const pin = retainUntilOf(home, f);
    if (pin != null && now < pin) continue;
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
  /** PLAN-0.2.1 step 12: the identity of the star being published (star.yaml `meta.id`). Stamped
   *  into the built db's `meta` table AND into the manifest, and folded into the skip predicate —
   *  a published generation whose identity is missing or wrong forces a REBUILD instead of being
   *  skipped forever while the hub refuses it. */
  starId?: string;
  /** Republish even when the published generation equals the target (repair path). */
  force?: boolean;
  /** PLAN-0.3.0 item 14: clone the prior generation off-path and build INCREMENTALLY into the copy
   *  instead of from empty. Default ON; `force` overrides it (see `clonePriorGeneration`). */
  clonePrior?: boolean;
  /** item 38: how long the PRIOR publication's db is pinned against collection, in ms. 0 (the
   *  default) keeps today's behaviour — acks and the grace floor alone. A rollout sets it, because
   *  "quiesce, restore the retained artefact, rebuild" needs the artefact to still be there. */
  retainPriorMs?: number;
  batch?: number;
  onProgress?: (r: IndexResult) => void;
}

export interface PublishReindexResult {
  generation: string;
  /** The publication now current in the home (item 8): the id this build stamped, or — when skipped
   *  — the id of the publication that was left standing (`publicationIdOf`, so a legacy manifest
   *  still answers). Reported rather than re-read from the manifest: by the time a caller reads it
   *  back a concurrent publish may have moved it, and `funes republish` prints THIS artefact's id. */
  publicationId: string;
  /** true ⇒ the published generation already equalled the target; nothing was built or moved. */
  skipped: boolean;
  /** Absolute path of the newly built db (null when skipped). */
  dbPath: string | null;
  /** item 14: the manifest.db this build was CLONED from, or null when it started empty. Reported
   *  rather than inferred — "why did this republish take eleven seconds" is the question the flag
   *  answers, and a silent fallback to empty is exactly the thing worth seeing. */
  clonedFrom?: string | null;
}

const rmDbFiles = (p: string): void => {
  // `.retain` rides along (item 38): the pin has already been honoured by the time we get here, and
  // a pin outliving the db it names would sit in the home forever, unread and misleading.
  for (const suffix of ["", "-wal", "-shm", "-journal", RETAIN_SUFFIX]) rmSync(p + suffix, { recursive: true, force: true });
};

/** F5/R2-2: may we SKIP re-publishing this equal-generation manifest? Only if its target is fully
 *  servable to a read face RIGHT NOW. A pglite dir home has no RO-mount finalization concept, so it
 *  stays skippable-on-generation. A libsql single-file target must: exist, carry NO hot sidecar
 *  (-wal/-shm/-journal), have a DELETE-journal header, AND pass the read face's OWN zero-write RO
 *  validation (meta + core tables + embedding sig + NOT dirty) with an internal generation matching
 *  the manifest. Any failure ⇒ NOT servable ⇒ don't skip, rebuild — this catches the NAS's legacy
 *  WAL publication AND a dirty / partial / mislabeled one a header check alone would wave through. */
async function publishedTargetIsServable(home: string, manifest: GenerationManifest, embedder: Embedder, starId?: string): Promise<boolean> {
  // Identity is part of "servable" (step 12). A generation published before the identity landed
  // matches on content and would be skipped forever, while the hub refuses it for having no id —
  // a stall that reads as "nothing to do". Missing or wrong ⇒ not servable ⇒ rebuild.
  if (starId !== undefined && manifest.starId !== starId) return false;
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
    try {
      // The RO open DUAL-READS "3" and "4" (rollout step 30), so it alone no longer proves the
      // artefact is current. Rollout step 32 is "publish the v4 artefact", and both things this
      // predicate gates would defeat it: a SKIP on equal content leaves the "3" artefact published
      // forever, and a CLONE (item 14) copies a "3" file that the builder's own read-write open then
      // refuses. A stale schema is not servable; the next publish builds from empty and stamps "4".
      if ((await ro.stats()).schemaVersion !== INDEX_SCHEMA_VERSION) return false;
      const identity = await ro.contentIdentity();
      if (identity.contentGeneration !== manifest.generation) return false;
      // item 8: when the manifest names a publication id the database must carry the SAME one —
      // the two are written together, so a disagreement means this manifest was paired with a
      // foreign db. A legacy manifest names none and its db stamps none: nothing to compare.
      if (manifest.publicationId != null && identity.publicationId !== manifest.publicationId) return false;
      // The db's OWN stamp, not just the manifest's: the two are written together, so a disagreement
      // means the manifest was paired with a foreign db, which is the exact swap the hub refuses.
      return starId === undefined || (await ro.getOwnerStarId?.()) === starId;
    } finally { await ro.close(); }
  } catch {
    return false; // any RO-open / validation failure ⇒ rebuild, never skip
  }
}

// ── PLAN-0.3.0 item 14: clone-and-incremental off-path build ─────────────────────────────────────
// MEASURED, not assumed. On this repo's own wiki (104 pages) with the real E5 embedder, on an M-series
// Mac: a republish after a ONE-PAGE edit costs 10.8s from empty and 1.9s from a clone (file copy
// 0ms + incremental walk, indexed=1 skipped=102) — 83% off. The build was already off-path, but it
// always started EMPTY, so every republish re-embedded every page on every home; that is the
// eight-home re-embed the plan lists as a standing risk, and the reason automatic recovery was out
// of scope. The saving scales with the unchanged fraction, so it is larger, not smaller, on the
// 8.8k-page vault.
//
// The clone is only taken when the prior artefact passes the read face's OWN servability check —
// which already means: it exists, is a single file, carries no hot -wal/-shm/-journal sidecar, has a
// DELETE-journal header, opens read-only, is NOT dirty, its schema version is current, its
// EMBEDDING SIGNATURE matches this embedder, and its stamps pair with the manifest. That last one
// closes the stale-derivation hazard for free: the stored signature is `<embedder>:<CHUNK_SIG>`, so
// a chunking change fails the check and the build falls back to empty rather than mixing chunkings.
// A parser change is caught a layer up — it changes the parsed item, so its content hash changes and
// `remember` re-indexes instead of hash-skipping.
//
// `--force` never clones. It is the repair verb, and a repair that starts from the bytes it is
// repairing is not a repair.

/** Migrate the identity metadata a CLONE must not inherit, before the store is opened.
 *
 *  The copied bytes carry the PRIOR publication's identity, and `setPublicationId` is
 *  immutable-BY-DESIGN — it throws rather than rename an artefact that principals' acks and
 *  retention pins are bound to — so the clone's id is cleared here and the publisher stamps the new
 *  one exactly as it does on an empty build. The content generation and its invalidation go with
 *  it: the rows are about to change, and `finalizeReindex` restamps all of it atomically at the end
 *  of the full run. (Recall telemetry rides along in the clone and is not cleared — it is advisory
 *  by contract, nothing may depend on it, and preserving hit counts across a republish is if
 *  anything the friendlier behaviour.)
 *
 *  ponytail: raw `bun:sqlite`, dynamically imported, same ceiling as `readPublishedMeta` — there is
 *  no `clearPublicationId` on `FunesIndexStore`, and adding one to make a clone possible would put
 *  a "forget who you are" verb on the interface whose immutability is the point. A failure here is
 *  caught by the caller and degrades to an empty build. */
async function stripClonedIdentity(dbPath: string): Promise<void> {
  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath);
  try {
    db.run("delete from meta where key in ('publication_id','generation','generation_invalidated_at','generation_invalidated_reason')");
  } finally {
    db.close();
  }
}

/** Try to seed `buildPath` from the currently published generation. Returns the manifest.db it
 *  cloned, or null — and null is always fine: it just means this publish builds from empty, which
 *  is what every publish did before item 14. */
async function clonePriorGeneration(
  home: string, current: GenerationManifest | null, buildPath: string, embedder: Embedder, starId?: string,
): Promise<string | null> {
  if (!current) return null;
  const src = join(home, current.db);
  try {
    if (!statSync(src).isFile()) return null; // a pglite pgdata DIR is not a file to copy
    if (!(await publishedTargetIsServable(home, current, embedder, starId))) return null;
    copyFileSync(src, buildPath);
    await stripClonedIdentity(buildPath);
    return current.db;
  } catch {
    rmDbFiles(buildPath); // a half-copied seed must never become the build
    return null;
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
  // 0.3.0 item 23, at the publisher's entry rather than at each open below it: `makeStore` is NOT
  // the only construction point, and this module has two openers that skip it — the caller's
  // `open(dbPath)` closure (cli.ts hands it a bare LibsqlStore.create) and the servability RO open
  // in publishedTargetIsServable. Both target paths INSIDE this home, so guarding the home dominates
  // both, and it also guards the manifest and the -wal/-shm sidecars a provider would copy
  // independently. Before mkdirSync on purpose: a refused home is not a home to create.
  assertIndexNotInSyncRoot(opts.home);
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
  // item 9: the SAME fence the broker's canonical-markdown-plus-index commit takes (face.ts), held
  // across validation and the manifest swap — not a publisher-only lock.
  return withPublicationFence(opts.home, async () => {
    const scope = opts.scopeSignature ?? null;
    const target = computeTargetGeneration(opts.vault, { embedder: opts.embedder, scopeSignature: scope, exclude: opts.exclude });
    const current = readGenerationManifest(opts.home);
    // SKIP when the published generation equals the target (R3#6: reindex is CONDITIONAL — a
    // clean-tree sync pass costs a parse walk, not an embed pass) — UNLESS that publication is not
    // fully servable to a read face (F5/R2-2): a legacy WAL, dirty, partial, or mislabeled target
    // matches on generation but can't be served RO, so we rebuild instead of skipping.
    if (!opts.force && current?.generation === target && (await publishedTargetIsServable(opts.home, current, opts.embedder, opts.starId))) {
      return { generation: target, publicationId: publicationIdOf(current), skipped: true, dbPath: null, clonedFrom: null };
    }
    const hex = target.split(":")[1] ?? target;
    let finalDbName = `gen-${hex.slice(0, 12)}.db`;
    if (current?.db === finalDbName) finalDbName = `gen-${hex.slice(0, 12)}-${Date.now()}.db`; // force/rebuild: never onto the live file a consumer may hold
    const finalDbPath = join(opts.home, finalDbName);
    // Build into a COLLISION-PROOF temp name (F1), never the deterministic final path a concurrent
    // or crashed build might share — renamed atomically into place only after validate+finalize.
    const buildPath = join(opts.home, `gen-${hex.slice(0, 12)}.${process.pid}-${randomBytes(6).toString("hex")}.building.db`);
    const publicationId = newPublicationId(); // item 8: generated BEFORE finalization (see below)
    rmDbFiles(buildPath);
    // item 14: seed the off-path build from the prior generation so unchanged pages hash-skip
    // instead of re-embedding. `force` never clones — see the section header.
    const clonedFrom = opts.force || opts.clonePrior === false
      ? null
      : await clonePriorGeneration(opts.home, current, buildPath, opts.embedder, opts.starId);
    const store = await opts.open(buildPath);
    // Hoisted so item 10's pre-swap recheck below can compare against the BUILT database's own
    // content generation rather than against the pre-build target it happens to equal.
    let built: string | null = null;
    try {
      await indexDir(store, opts.vault, opts.vault, {
        exclude: opts.exclude,
        scopeSignature: scope,
        batch: opts.batch,
        onProgress: opts.onProgress,
        starId: opts.starId,   // stamped by the BUILD, on the same full-run gate as the generation
      });
      // Validate BEFORE publishing: the built index must be clean and stamped with EXACTLY the
      // target generation — a vault that mutated between target computation and build walk stamps
      // a different generation and fails here instead of publishing a mislabeled index.
      const stats = await store.stats();
      built = stats.contentGeneration; // null ⇒ never stamped, legacy v1, or invalidated mid-build
      if (stats.reindexDirty) throw new Error("publishReindex: built index is dirty — refusing to publish");
      if (built !== target) {
        throw new Error(
          `publishReindex: generation moved during the build (target ${target}, built ${built ?? "null"}) — vault mutated mid-build; not published, retry`,
        );
      }
      // The publication id (item 8) goes into the DATABASE before it is finalized, so the manifest
      // below and the bytes it points at name one artefact and every open can check the pair. It is
      // immutable in the store, and that immutability is what makes a principal's ack safe to bind
      // to — which is why a CLONED build (item 14) has the prior id CLEARED before this line rather
      // than restamped over: see stripClonedIdentity.
      await store.setPublicationId(publicationId);
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
    // PLAN-0.3.0 item 10: RECOMPUTE the target under the fence, immediately before the swap.
    //
    // The check above compares the build's stamp against a target computed BEFORE the build walk, so
    // a page that changed after the walker read it leaves `built === oldTarget` and the validation
    // waves a stale artefact through. The fence (item 9) narrows the window to writers that do not
    // take it — an editor, a sync transport, a legacy process — it does not close it, because funes
    // does not own the vault's filesystem. So the vault is re-read here, at the last moment the
    // manifest can still be refused, and publication is refused unless the recomputed target STILL
    // equals the built database's content generation. Cheap by construction: a parse walk, no
    // embedding (the same walk the skip predicate already runs on every publish).
    const recomputed = computeTargetGeneration(opts.vault, { embedder: opts.embedder, scopeSignature: scope, exclude: opts.exclude });
    if (recomputed !== built) {
      rmDbFiles(buildPath); // never leave a build the next publish might trust
      throw new Error(
        `publishReindex: the vault moved between the build and the swap (built ${built}, vault now ${recomputed}) — not published, retry. ` +
        "The publication fence serializes funes writers; a change from OUTSIDE funes (an editor, a sync transport, a pre-fence process) lands here.",
      );
    }
    // Durability order (Codex R3#3): fsync the built db, rename it into the served path, fsync the
    // dir so that rename survives a crash — all BEFORE the manifest is published to point at it. A
    // crash after this but before the manifest swap leaves an orphan gen db (harmless; the next
    // publish rebuilds), never a manifest pointing at a half-written or lost db.
    fsyncPath(buildPath);
    renameSync(buildPath, finalDbPath);
    fsyncPath(opts.home);
    // item 38: pin the OUTGOING publication BEFORE the manifest names its replacement, so no
    // collection — this publish's own, or a concurrent one's — can reach it unpinned. Deliberately
    // not wrapped: a rollback window that failed to open is a publish that must not report success.
    if (current?.db && (opts.retainPriorMs ?? 0) > 0) pinRetention(opts.home, current.db, Date.now() + opts.retainPriorMs!);
    publishGenerationManifest(opts.home, {
      version: 1, generation: target, publicationId, db: finalDbName, publishedAt: new Date().toISOString(),
      ...(opts.starId !== undefined ? { starId: opts.starId } : {}),
    });
    // Retire retired generations under the ack channel (P1.6d): the immediately-previous db is kept
    // until every inventoried principal has acked the new PUBLICATION (or a TTL/grace passes), so a
    // consumer that read the old manifest but hasn't opened yet never races the unlink. Consumers
    // still holding an old handle keep their fd regardless (POSIX unlink semantics).
    gcRetiredGenerations(opts.home, { currentDb: finalDbName, currentPublicationId: publicationId, priorDb: current?.db ?? null });
    return { generation: target, publicationId, skipped: false, dbPath: finalDbPath, clonedFrom };
  });
}

// ── RAI-143 clause 1: `funes republish`, the manual recovery verb ────────────────────────────────
// Item 13 made recovery MANUAL and `publish --force` was the whole of the instruction; nothing
// classified WHY a home needed it. openPaired's refusal says "republish that home", the fleet report
// says "republish this home", and the verb they named did not exist. This is the decision behind it,
// and its ORDER is the point: integrity and pairing BEFORE validity. A content stamp is read out of
// the bytes, so a database that is dirty, unreadable, foreign to this embedder, or not the pair its
// manifest names is classified by that fault first — asking such a database whether its content
// generation is valid answers a question about the wrong artefact, and the pairing refusal that
// sent the operator here would be the one thing the verb never looked at.

export type RepublishVerdict =
  | { action: "refuse"; why: "no-manifest" | "valid"; detail: string }
  | { action: "rebuild"; why: "integrity" | "invalidated" | "legacy-stamp" | "forced"; detail: string };

/** Decide, UNDER the publication fence, whether `home` must be rebuilt and why — in this order:
 *
 *    1. no manifest          → refuse: there is nothing to repair, and a first publication is
 *                              `funes publish`'s job, not a republish's;
 *    2. integrity or pairing → rebuild, naming the fault. The read face's OWN zero-write validation
 *                              (LibsqlStore.validateReadonly — the check the skip predicate and the
 *                              clone already ride on): not a funes index, a missing core table,
 *                              embedding drift, a foreign schema_version, the dirty marker; then the
 *                              manifest's publicationId against the one stamped in the bytes. An
 *                              artefact a manifest names but which was never finalized carries the
 *                              dirty marker, so it lands HERE — there is no never-finalized case;
 *    3. invalidated          → rebuild, naming the instant and the mutation (item 13);
 *    4. legacy stamp         → rebuild, naming it (a v1 stamp is never reinterpreted — item 8);
 *    5. valid and paired     → refuse, unless forced.
 *
 *  A legacy manifest names no id, and its derived id is unvalidatable against the bytes by design
 *  (publicationIdOf), so a legacy manifest over a sound database is NOT a pairing failure — it is
 *  whichever of 3-5 its stamp says.
 *
 *  The fence is held for the decision alone; a caller that acts on the verdict takes the SAME fence
 *  around decision AND rebuild — it is reentrant per async owner, so republishDecision and the
 *  publishReindex inside pass straight through — and then no concurrent publisher can repair the
 *  home between the two. That is how cli.ts runs it, and the test at the publication-home seam
 *  drives that exact shape.
 *
 *  ponytail: the -wal/-shm/-journal sidecar and header pre-filter stay in publishedTargetIsServable
 *  (the skip predicate's concern). This matrix classifies on the RO validation only: a WAL-mode
 *  artefact opens read-only on a writable mount, and one carrying a valid CURRENT stamp cannot come
 *  out of any publisher that ever stamped one. Upgrade path if a finalize-only fault ever needs its
 *  own arm: have publishedTargetIsServable return the fault it found instead of a boolean. */
export async function republishDecision(home: string, opts: { embedder: Embedder; force?: boolean }): Promise<RepublishVerdict> {
  return withPublicationFence(home, async () => {
    const manifest = readGenerationManifest(home);
    if (!manifest) {
      return {
        action: "refuse", why: "no-manifest",
        detail: `nothing is published in ${home} — there is no ${GENERATION_MANIFEST} to repair. A first publication is \`funes publish\`, not a republish.`,
      };
    }
    const dbPath = join(home, manifest.db);
    let identity: ContentIdentity;
    try {
      const { LibsqlStore } = await import("funes-libsql");
      const ro = await LibsqlStore.create(opts.embedder, dbPath, { readonly: true });
      try { identity = await ro.contentIdentity(); } finally { await ro.close(); }
    } catch (e) {
      return { action: "rebuild", why: "integrity", detail: (e as Error).message };
    }
    if (manifest.publicationId != null && identity.publicationId !== manifest.publicationId) {
      return {
        action: "rebuild", why: "integrity",
        detail: `manifest publicationId ${manifest.publicationId} != database ${identity.publicationId ?? "none"} — ${manifest.db} is not the artefact the manifest names`,
      };
    }
    if (identity.invalidatedAt != null) {
      return {
        action: "rebuild", why: "invalidated",
        detail: `content generation invalidated at ${identity.invalidatedAt} — ${identity.invalidatedReason ?? "reason not recorded"}`,
      };
    }
    if (identity.contentGeneration == null) {
      return { action: "rebuild", why: "legacy-stamp", detail: identity.invalidatedReason ?? "no content generation is stamped at all" };
    }
    const standing = `publication ${publicationIdOf(manifest)} is valid and paired (content generation ${identity.contentGeneration})`;
    if (opts.force) return { action: "rebuild", why: "forced", detail: `${standing} — rebuilding because --force says so` };
    return { action: "refuse", why: "valid", detail: `${standing} — nothing to repair; pass --force to rebuild it anyway` };
  });
}

// ── the consumer half ─────────────────────────────────────────────────────────────────────────────

interface LiveHandle {
  /** THE identity this handle is bound to (item 8): the publication id the manifest named, or the
   *  `legacy:` id derived from `(generation, db)` when it named none. It replaced the raw
   *  `(generation, db)` pair as the swap key — a strict improvement in both directions, because the
   *  derivation makes it EQUAL to the pair for a legacy manifest, while for a v4 manifest a --force
   *  republish of byte-identical content is a new publication the pair could not see. */
  publicationId: string;
  /** The published generation this handle serves. Never null: since 0.3.0 item 15 a consumer only
   *  ever holds a PUBLISHED generation (see PublishedIndexOpts). DIAGNOSTIC — local state binds to
   *  `publicationId`, never to this. */
  generation: string;
  /** The manifest.db this handle was opened from — reported, no longer part of the swap key. */
  db: string;
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
  /** P1.6d: called after each swap with the now-served PUBLICATION id and its content generation.
   *  A face wires it to write its status file — the ack the publisher's retain-until-ack GC reads,
   *  and that GC keys on the id (item 8), so the id is first and the generation is diagnostic. */
  onServe?(publicationId: string, generation: string): void;
}

/** Open a database and VALIDATE the manifest-to-database pairing (PLAN-0.3.0 item 8): the id the
 *  manifest names must be the id stamped inside the bytes. They are written together, so a
 *  mismatch means a foreign db was moved under this manifest — the swap the hub refuses — and
 *  serving it would answer for a different artefact than the one every principal acked. A legacy
 *  manifest names no id (and its db stamps none), so there is nothing to check; a null manifest
 *  (doctor --live, a working index) has nothing to pair against. The handle is closed before
 *  throwing: a read face retry-looping on a bad home would otherwise exhaust its fds.
 *
 *  A free function rather than PublishedIndex's private method it used to be (0.3.0 close-out,
 *  RAI-148): `funes eval` and `funes doctor` open a manifest-named database too, and they opened
 *  `join(home, manifest.db)` bare — so "publication id equality holds on every open that names a
 *  manifest" was true of the read faces only. Every such open now takes this one check. */
export async function openPaired(
  open: (dbPath: string) => Promise<FunesIndexStore>,
  path: string,
  manifest: GenerationManifest | null,
): Promise<FunesIndexStore> {
  const store = await open(path);
  if (!manifest?.publicationId) return store;
  const got = (await store.contentIdentity()).publicationId;
  if (got === manifest.publicationId) return store;
  await store.close().catch(() => {});
  throw new Error(
    `funes: ${path} is not publication ${manifest.publicationId} — it carries ${got ?? "no publication id"}. ` +
    "The manifest and the database it points at are not a pair; republish that home.",
  );
}

// 0.3.0 item 15: there is NO fallbackDbPath any more. A `fallbackDbPath` option let a consumer with
// nothing published serve the live `index.db` at a static path, on the theory that `funes reindex`
// rebuilding that file would be adopted by the running consumer. It is not: replacing index.db
// atomically does not move an already-open SQLite handle, and PublishedIndex adopts change ONLY
// through a manifest — so the "fallback" served a file the reindex had already detached it from,
// silently and for the process lifetime. A consumer serves published generations only; nothing
// published is an operator error, and it says so.

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

  /** The generation currently served (null before the first op). DIAGNOSTIC — see `publicationId`. */
  get generation(): string | null {
    return this.current?.generation ?? null;
  }

  /** The PUBLICATION this consumer is serving (null before the first op) — the immutable name local
   *  state binds to, and what a principal acks (item 8). A heartbeat reads it. */
  get publicationId(): string | null {
    return this.current?.publicationId ?? null;
  }

  private async maybeSwap(): Promise<void> {
    const interval = this.opts.checkIntervalMs ?? 0;
    const now = Date.now();
    if (this.current && interval > 0 && now - this.lastCheck < interval) return;
    this.lastCheck = now;
    const manifest = readGenerationManifest(this.home);
    if (!manifest) {
      if (this.current) return; // keep serving the handle we have; a vanished manifest is the writer's bug
      throw new Error(
        `funes: no published generation in ${this.home} — there is no ${manifestPath(this.home)} to serve from.\n` +
        "  A consumer serves PUBLISHED generations only (0.3.0 item 15): a live index cannot be served safely, " +
        "because replacing it does not move an already-open SQLite handle and this consumer adopts change only through a manifest.\n" +
        `  Publish one into this home first — funes publish --home ${this.home} — then reopen. There is no fallback and no override.`,
      );
    }
    // Identity is the PUBLICATION ID (item 8), not the (generation, db) pair this used to compare.
    // `publicationIdOf` derives `legacy:sha(generation, db)` for a manifest that names none, so for
    // a legacy home the two predicates are the same predicate; for a v4 home the id also catches a
    // --force republish of identical rows into an identically-named file, which the pair could not.
    if (this.current && this.current.publicationId === publicationIdOf(manifest)) return;
    if (this.swapping) return this.swapping; // one swap at a time; concurrent ops ride the same one
    this.swapping = (async () => {
      const opened = await this.openTarget(manifest);
      const old = this.current;
      this.current = { publicationId: opened.publicationId, generation: opened.generation, db: opened.db, store: opened.store, leases: 0, retired: false };
      // LOUD swap line: which generation, from which file — a home that never swaps is visible in
      // the log rather than inferred from stale answers.
      process.stderr.write(
        `funes index: serving published generation ${opened.generation.slice(0, 20)}… at ${opened.path}` +
        `${old ? ` (swapped from ${old.generation.slice(0, 20)}…)` : ""}\n`,
      );
      if (old) {
        old.retired = true;
        if (old.leases === 0) await old.store.close().catch(() => {});
        // else: the last draining lease closes it (release() below)
      }
      // P1.6d: record the ack (the PUBLICATION this principal now serves) so the publisher's GC can
      // retain-until-ack. Best-effort inside writePrincipalStatus — never blocks the swap.
      this.opts.onServe?.(opened.publicationId, opened.generation);
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
    manifest: GenerationManifest,
  ): Promise<{ store: FunesIndexStore; publicationId: string; generation: string; db: string; path: string }> {
    const path = join(this.home, manifest.db);
    try {
      // publicationIdOf, never manifest.publicationId: a LEGACY manifest names none, and the ack
      // this feeds still needs a stable name to bind to (the derived `legacy:` id).
      return { store: await openPaired(this.open, path, manifest), publicationId: publicationIdOf(manifest), generation: manifest.generation, db: manifest.db, path };
    } catch (e) {
      if (!isVanishedDb(e)) throw e;
      const fresh = readGenerationManifest(this.home);
      if (!fresh) throw e; // the manifest went away too — the real failure stands
      const freshPath = join(this.home, fresh.db);
      if (freshPath === path) throw e; // nothing newer to retry against
      return { store: await openPaired(this.open, freshPath, fresh), publicationId: publicationIdOf(fresh), generation: fresh.generation, db: fresh.db, path: freshPath };
    }
  }

  /** Lease the current generation's store for ONE op. The lease pins the handle for fn's whole
   *  duration — a concurrent republish swaps the pointer but never closes a leased store.
   *  `generation` is always a published generation — item 15 removed the null (DIRECT) case.
   *  `publicationId` is the LEASED handle's id, not `this.publicationId`: the getter reads whatever
   *  is current at the instant it is called, which a concurrent swap may already have moved off the
   *  store fn holds. Only the leased value describes the artefact fn is actually reading. */
  async with<T>(fn: (store: FunesIndexStore, generation: string, publicationId: string) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("PublishedIndex: closed");
    await this.maybeSwap();
    const handle = this.current;
    if (!handle) throw new Error("PublishedIndex: no live generation"); // unreachable after maybeSwap
    handle.leases++;
    try {
      return await fn(handle.store, handle.generation, handle.publicationId);
    } finally {
      handle.leases--;
      if (handle.retired && handle.leases === 0) {
        await handle.store.close().catch(() => {});
        handle.onDrained?.(); // unblocks a close() that is waiting on this lease
      }
    }
  }

  /** The heartbeat sample: BOTH halves of the status record, taken from ONE lease.
   *
   *  It exists because taking them separately is a race, and the race writes a status file that
   *  describes no artefact that ever existed. The two callers (the face and the hub) both used to
   *  build the sample as `{ publicationId: published.publicationId, contentGeneration: await
   *  published.with(...) }` — and an object literal evaluates the getter FIRST, synchronously,
   *  before the awaited `with()` that performs `maybeSwap`. So a beat that happened to be the one
   *  to discover a republish read the OLD publication id and then the NEW generation's content, and
   *  wrote that pair. Retention keys on `publicationId` (item 8), so the publisher then saw an ack
   *  for the retired artefact and kept it pinned, while the artefact this principal was really
   *  serving carried no ack at all — the exact inversion the ack exists to prevent.
   *
   *  Inside one lease the pair cannot come apart: the id is the leased handle's, and the content
   *  generation is read out of that same handle's store. */
  async sampleIdentity(): Promise<{ publicationId: string | null; contentGeneration: string | null }> {
    return this.with(async (store, _generation, publicationId) => ({
      publicationId,
      contentGeneration: (await store.contentIdentity()).contentGeneration,
    }));
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

// ── PLAN-0.3.0 items 33 + 39: the fleet gate ─────────────────────────────────────────────────────
// The rollout's hardest precondition is step 33 — prove POSITIVELY that no legacy process remains —
// and the code could not express it: status records carried no software or protocol version, and
// nothing inventoried a fleet at all. What follows is the reporting and gating half; the half funes
// cannot own (confirmation from the supervisor that owns the processes) stays with the operator, and
// the journal is where that attestation is recorded.
//
// There is NO discovery input, by design (item 39): homes are named with explicit repeated --home
// arguments. A rollout that guesses its own inventory can migrate six homes, miss two, and report
// success — and the two it missed are exactly the ones with a legacy process still on them.

/** The rollout ladder (steps 30-37), in order. A phase is recorded PER HOME, so an interrupted run
 *  resumes by re-running the same command: homes already at the phase are no-ops.
 *
 *  There is no `manifest-v2` rung. Rollout step 34 — rewrite the manifest to v2, naming the same
 *  artefact — is DROPPED (decided by Vlad, 2026-09-06; recorded in PLAN-0.3.0-AMENDMENTS.md): the
 *  manifest stays `version: 1` with the additive `publicationId`, which is the design item 8 shipped,
 *  and the rung that journaled a phase no code could perform goes with the step. The acceptance
 *  criterion under step 35 — ONE publication identity spans the whole transition — is therefore not
 *  a manifest-rewrite assertion but the pair check that already runs on every paired open
 *  (PublishedIndex.openPaired: the id the manifest names must be the id stamped in the bytes). A
 *  journal written while the rung existed may still name it; readFleetJournal filters unknown
 *  phases, so such an entry is ignored rather than read as a position on the ladder. */
export const FLEET_PHASES = ["readers", "quiesced", "published", "proven", "verified", "retired"] as const;
export type FleetPhase = (typeof FLEET_PHASES)[number];

/** The per-home phase journal — DURABLE and stored IN the home, so it survives the process that
 *  wrote it, travels with the home it describes, and is readable by whoever resumes the rollout. */
const FLEET_JOURNAL = "fleet-journal.json";
interface FleetJournalEntry { phase: FleetPhase; at: string; publicationId: string | null }

export function readFleetJournal(home: string): FleetJournalEntry[] {
  try {
    const j = JSON.parse(readFileSync(join(home, FLEET_JOURNAL), "utf8")) as { entries?: unknown };
    return Array.isArray(j?.entries)
      ? (j.entries as FleetJournalEntry[]).filter((e) => e != null && FLEET_PHASES.includes(e.phase))
      : [];
  } catch {
    return [];
  }
}

/** Append a phase. Atomic temp+rename + fsync like every other file this module publishes: a torn
 *  journal after a crash would make a resumed rollout re-run steps it had already taken. */
function appendFleetJournal(home: string, entry: FleetJournalEntry): void {
  const entries = [...readFleetJournal(home), entry];
  const p = join(home, FLEET_JOURNAL);
  const tmp = `${p}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify({ entries }, null, 2) + "\n");
  fsyncPath(tmp);
  renameSync(tmp, p);
  fsyncPath(home);
}

/** The furthest phase this home has reached, or null. */
export function fleetPhaseOf(home: string): FleetPhase | null {
  let best: FleetPhase | null = null;
  for (const e of readFleetJournal(home)) {
    if (best === null || FLEET_PHASES.indexOf(e.phase) > FLEET_PHASES.indexOf(best)) best = e.phase;
  }
  return best;
}

export interface FleetPrincipalReport {
  principal: string;
  publicationId: string | null;
  contentGeneration: string | null;
  /** item 33: null means "a build too old to say", which the gate reads as LEGACY, never unknown. */
  protocolVersion: string | null;
  softwareVersion: string | null;
  ageMs: number;
  /** A fresh status within staleAckMs. Only live principals gate; a dead one proves nothing either
   *  way, which is why the plan sends the operator to the supervisor rather than to this field. */
  live: boolean;
  /** Serving the publication the manifest currently names. */
  acked: boolean;
}

export interface FleetHomeReport {
  home: string;
  phase: FleetPhase | null;
  /** The database's own `schema_version` — the artefact's protocol, distinct from a principal's. */
  schemaVersion: string | null;
  publicationId: string | null;
  contentGeneration: string | null;
  invalidatedReason: string | null;
  principals: FleetPrincipalReport[];
  /** Empty ⇒ consistent. Every entry is a reason the fleet must not advance. */
  problems: string[];
}

/** Read the published database's own answers, WITHOUT constructing an embedder.
 *
 *  ponytail: raw `bun:sqlite`, dynamically imported, rather than `LibsqlStore.create(…, {readonly:
 *  true})`. That opener validates the embedding signature against a live embedder, so a fleet report
 *  would (a) load an E5 model to read four strings and (b) REFUSE to report on the one kind of home
 *  an operator most needs reported — one whose embedder does not match this process's. A rollout
 *  inventory must be able to describe a home it cannot serve. Ceiling: Bun-only, and `fleet` is a
 *  CLI verb, so the import sits inside the function and no serving path ever evaluates it. Upgrade
 *  path if funes ever runs this under Node: a meta-only reader exported from funes-libsql. */
async function readPublishedMeta(dbPath: string): Promise<Record<string, string>> {
  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.query("select key, value from meta").all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } finally {
    db.close();
  }
}

export interface FleetReportOpts {
  /** A principal whose status is older than this is DEAD and does not gate. */
  staleAckMs?: number;
  now?: number;
}

/** Inventory one home: schema version, publication id, content generation, validity, live
 *  principals. NEVER throws — an unreachable home is a REPORT with problems, because a fleet gate
 *  that dies on the first broken home tells the operator about one home instead of eight. */
export async function fleetReportHome(home: string, opts: FleetReportOpts = {}): Promise<FleetHomeReport> {
  const now = opts.now ?? Date.now();
  const staleAckMs = opts.staleAckMs ?? DEFAULT_STALE_ACK_MS;
  const problems: string[] = [];
  const manifest = readGenerationManifest(home);
  const manifestId = manifest ? publicationIdOf(manifest) : null;

  const principals: FleetPrincipalReport[] = readPrincipalStatuses(home).map((s) => ({
    principal: s.principal,
    publicationId: s.publicationId,
    contentGeneration: s.contentGeneration,
    protocolVersion: s.protocolVersion,
    softwareVersion: s.softwareVersion,
    ageMs: now - s.at,
    live: now - s.at <= staleAckMs,
    acked: manifestId != null && s.publicationId === manifestId,
  }));

  const report: FleetHomeReport = {
    home, phase: fleetPhaseOf(home), schemaVersion: null,
    publicationId: manifest?.publicationId ?? null,
    contentGeneration: null, invalidatedReason: null, principals, problems,
  };
  if (!manifest) {
    problems.push(`no ${GENERATION_MANIFEST} — nothing is published in this home`);
    return report;
  }
  if (manifest.publicationId == null) {
    // A legacy manifest names no id. `publicationIdOf` derives one so local state has something to
    // bind to, but a derived id is unvalidatable against the bytes, so it cannot carry a rollout.
    problems.push("legacy manifest — it names no publicationId, so the manifest-to-database pairing cannot be proven; republish this home");
  }
  let meta: Record<string, string>;
  try {
    meta = await readPublishedMeta(join(home, manifest.db));
  } catch (e) {
    problems.push(`cannot read ${manifest.db}: ${(e as Error).message}`);
    return report;
  }
  report.schemaVersion = meta.schema_version ?? null;
  const stamped = meta.generation ?? null;
  // The same rule contentIdentity() applies, and for the same reason: a legacy v1 stamp is reported
  // INVALID, never reinterpreted — incremental writes never cleared it.
  report.contentGeneration = stamped != null && stamped.startsWith(`${GENERATION_VERSION}:`) ? stamped : null;
  report.invalidatedReason = meta.generation_invalidated_reason
    ?? (stamped != null && report.contentGeneration == null ? `legacy ${stamped.split(":")[0]} stamp — not a content generation` : null)
    ?? null;

  if (report.schemaVersion !== INDEX_SCHEMA_VERSION) {
    problems.push(`schema_version ${report.schemaVersion ?? "absent"} != ${INDEX_SCHEMA_VERSION} — this home has not been rebuilt`);
  }
  if (meta.reindex_dirty === "1") problems.push("the published database is DIRTY (an interrupted full reindex)");
  if (report.contentGeneration == null) {
    problems.push(`no valid content generation${report.invalidatedReason ? ` (${report.invalidatedReason})` : ""} — republish this home`);
  }
  // Step 35's acceptance (step 34 is dropped — see FLEET_PHASES), checked here rather than asserted
  // in prose: the id the manifest names must be the id stamped in the bytes — one publication
  // identity spans the whole transition.
  const stampedId = meta.publication_id ?? null;
  if (manifest.publicationId != null && stampedId !== manifest.publicationId) {
    problems.push(`manifest publicationId ${manifest.publicationId} != database ${stampedId ?? "none"} — the manifest and the database are not a pair`);
  }
  for (const p of principals) {
    if (!p.live) continue;
    // item 33: the gate is POSITIVE. A live principal that cannot say what it speaks IS a legacy
    // principal — silence is not evidence of death, and a v3 process's status simply lacks the field.
    if (p.protocolVersion !== INDEX_SCHEMA_VERSION) {
      problems.push(`live principal "${p.principal}" advertises protocol ${p.protocolVersion ?? "none (a pre-item-33 build)"} != ${INDEX_SCHEMA_VERSION} — a legacy process is still on this home`);
    } else if (!p.acked) {
      problems.push(`live principal "${p.principal}" is serving publication ${p.publicationId ?? "none"}, not ${manifestId} — it has not swapped`);
    }
  }
  return report;
}

export async function fleetReport(homes: string[], opts: FleetReportOpts = {}): Promise<FleetHomeReport[]> {
  return Promise.all(homes.map((h) => fleetReportHome(h, opts)));
}

export interface FleetAdvanceResult {
  phase: FleetPhase;
  reports: FleetHomeReport[];
  /** Homes whose journal records `phase` after this call (including ones that already did). */
  advanced: string[];
  /** Why the fleet did not advance. Non-empty ⇒ NOTHING was written. */
  refusals: string[];
}

/** Advance every named home to `phase` — ALL of them or none. The all-or-none is the point: a
 *  partial advance is a fleet in two states, which is the condition the phase journal exists to make
 *  impossible to reach by accident.
 *
 *  Refuses when any home is inconsistent, when any LIVE principal is legacy or has not swapped, or
 *  when the phase would skip a rung on some home. Re-running the same phase after an interrupted run
 *  is an idempotent no-op per home — that is how the journal resumes. */
export async function fleetAdvance(homes: string[], phase: FleetPhase, opts: FleetReportOpts = {}): Promise<FleetAdvanceResult> {
  if (!FLEET_PHASES.includes(phase)) throw new Error(`funes fleet: unknown phase "${phase}" — one of ${FLEET_PHASES.join(", ")}`);
  if (homes.length === 0) throw new Error("funes fleet: name at least one --home — there is no discovery input, on purpose (item 39)");
  const reports = await fleetReport(homes, opts);
  const refusals: string[] = [];
  const want = FLEET_PHASES.indexOf(phase);
  for (const r of reports) {
    for (const p of r.problems) refusals.push(`${r.home}: ${p}`);
    const at = r.phase === null ? -1 : FLEET_PHASES.indexOf(r.phase);
    if (want > at + 1) {
      refusals.push(`${r.home}: is at phase ${r.phase ?? "none"} — "${phase}" would skip ${FLEET_PHASES.slice(at + 1, want).join(", ")}`);
    }
  }
  if (refusals.length) return { phase, reports, advanced: [], refusals };
  for (const r of reports) {
    const at = r.phase === null ? -1 : FLEET_PHASES.indexOf(r.phase);
    if (at < want) appendFleetJournal(r.home, { phase, at: new Date().toISOString(), publicationId: r.publicationId });
  }
  return { phase, reports, advanced: reports.map((r) => r.home), refusals };
}
