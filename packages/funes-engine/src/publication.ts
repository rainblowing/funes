// The published index (RAI-306, S1): ONE file, `<home>/published.db`, built off-path and swapped in
// whole. It replaces the 0.3.0-0.5.0 protocol (a generation manifest naming one of several per-build
// files, publication ids, consumer acks, retention pins, collection).
//
//   publish (publishReindex), under the publish lock `<home>/.publish.lock/` (fail-fast):
//     1. compute the TARGET content generation from the vault (a parse walk, no embedding), and SKIP
//        when `published.db` is servable, carries that generation, and its stat record agrees with
//        the vault (ADR-0007);
//     2. build into `published.db.building.<pid>.<rand>`, SEEDED by a clone of `published.db` when it
//        is servable, so unchanged pages hash-skip instead of re-embedding (`--force`: from empty);
//     3. validate: not dirty, and the built content generation EQUALS the target — an edit to a page
//        the walk has not read yet refuses here (an edit to a page already read gives a stale build
//        with a correct label, which the next run heals);
//     4. finalize to DELETE journal, chmod 0444, F_FULLFSYNC, keep the outgoing file as
//        `published.db.prev`, and rename the build over `published.db`.
//
// The live index (`index.db`, held read-write in WAL mode by the surface and every stdio MCP session)
// is never opened, locked or dirtied by publish, and no writer of `index.db` takes the publish lock
// (Q18-6). `published.db` names a complete file at every instant: a reader that holds the old fd keeps
// its snapshot; a new open sees the new build.
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { Embedder } from "funes-core";
import type { ScopeSignature } from "funes-core/internal";
import { embeddingSignature, isTombstoned, mayClaimIndex, ownerClaimRefused } from "funes-core/internal";
import { CHUNK_SIG } from "funes-core/internal";
import { indexDir, walkResolvedItems, type IndexResult } from "./reindex.ts";
import { statParity } from "funes-core/internal";
import { FolderVault } from "./folder-vault.ts";
import { assertIndexOwner, readStarIdentity } from "./factory.ts";
import { encodeGeneration, generationRecord, GENERATION_VERSION, SCHEMA_VERSIONS, type GenerationRecord } from "funes-core/internal";
import { withScopedWriteLock } from "./write-lock.ts";
import { assertIndexNotInSyncRoot } from "./sync-root.ts";

/** The published index's one fixed name in a publication home. */
export const PUBLISHED_DB = "published.db";
export const publishedDbPath = (home: string): string => join(home, PUBLISHED_DB);
const BUILDING = `${PUBLISHED_DB}.building`; // each run builds into `${BUILDING}.<pid>.<rand>`
const PREV = `${PUBLISHED_DB}.prev`;
const SIDECARS = ["-journal", "-wal", "-shm"];
const PUBLISH_LOCK_DIR = ".publish.lock";

/** The remedy when nothing is published (RAI-306 Q3); an unservable file's is `funes publish --force`. */
export const remedyPublish = (vault: string): string => `run \`funes publish --vault ${vault}\``;

/** The CLI's one duration grammar, `24h|90m|7d|5s|<ms>` — `watch`'s `--interval`/`--min-interval` and
 *  `replica`'s `--interval`. The error names the flag the operator typed; absent is undefined, so each
 *  caller chooses its default. Here rather than in cli.ts because cli.ts runs on import. */
export function parseDuration(name: string, raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(raw.trim());
  if (!m) throw new Error(`${name} "${raw}" is not a duration — use 24h, 90m, 7d, or a plain number of milliseconds`);
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] ?? "ms"]!;
  return Number(m[1]) * unit;
}

// ── durability (Q18-1) ───────────────────────────────────────────────────────────────────────────
// Bun's fsyncSync is fsync(2), which on macOS does not flush the drive cache: after a power cut the
// rename can survive while the build's bytes do not. F_FULLFSYNC through bun:ffi on darwin; fsync
// elsewhere. A failed sync THROWS: a name must never point at bytes we could not make durable.
const F_FULLFSYNC = 51;
type Fcntl = (fd: number, cmd: number, arg: number) => number;
let fcntl: Promise<Fcntl | null> | undefined;
const loadFcntl = (): Promise<Fcntl | null> => (fcntl ??= (async () => {
  if (process.platform !== "darwin" || !process.versions.bun) return null;
  const { dlopen, FFIType } = await import("bun:ffi");
  return dlopen("libc.dylib", { fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols.fcntl as unknown as Fcntl;
})());

/** The file operations a swap stands on, as an object so a test can spy on them (p-fullfsync) or
 *  hand the build a corrupt seed (pd-tornfts): `sync` runs on the build and on the home directory. */
export const publishIo = { sync: fullFsync, clone: cloneInto };

export async function fullFsync(path: string): Promise<void> {
  const f = await loadFcntl();
  const fd = openSync(path, "r");
  try {
    if (f) {
      if (f(fd, F_FULLFSYNC, 0) !== 0) throw new Error(`publish: F_FULLFSYNC failed on ${path} — not swapping in bytes that may not be durable`);
    } else {
      fsyncSync(fd);
    }
  } finally {
    closeSync(fd);
  }
}

// ── the publish lock (RAI-309 Q4) ──────────────────────────────────────────────────────────────
/** The publish lock is held by another run: `publish` and `publish --rollback` exit 75 on it, apart
 *  from a failed build's 1 (RAI-317: the code `busy`, as the write lock's). */
export class PublishBusyError extends Error {
  readonly code = "busy";
}

/** Publish-vs-publish only: the write lock's mkdir/pid primitive at the fixed directory
 *  `<home>/.publish.lock`, so FUNES_HOME never splits it, and NEVER a lock a writer of `index.db`
 *  takes (Q18-6). Fail-fast: a second publisher refuses at once. A dead holder is reclaimed at once,
 *  and a torn or absent `owner.json` after the 30 s ownerless grace. */
export async function withPublishLock<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = join(home, PUBLISH_LOCK_DIR);
  let entered = false;
  try {
    return await withScopedWriteLock(home, () => { entered = true; return fn(); }, { lockPath, timeoutMs: 0 });
  } catch (e) {
    if (entered) throw e; // fn's own failure, not the lock's
    if ((e as { code?: unknown }).code === "busy") {
      throw new PublishBusyError(`publish: another publish is already running on ${home} (${lockPath}) — not waiting; rerun after it finishes`);
    }
    throw diskFull(home, e) ?? e;
  }
}

const sqliteCode = (e: unknown): string => String((e as { code?: unknown })?.code ?? "");

/** ENOSPC named as ENOSPC (§3b-12): SQLite says "database or disk is full", and with zero free bytes
 *  even the lock open fails as "unable to open database file". null when the disk is not the cause. */
function diskFull(home: string, e: unknown): Error | null {
  const msg = (e as Error)?.message ?? String(e);
  let free: number | null = null;
  try { const s = statfsSync(home); free = s.bavail * s.bsize; } catch { /* unknown */ }
  if (/ENOSPC/.test(msg)) return null; // already named
  if (sqliteCode(e) === "SQLITE_FULL" || /disk is full/i.test(msg) || free === 0) {
    return new Error(`publish: ENOSPC — no space left on the disk holding ${home}; nothing was swapped in (${msg})`);
  }
  return null;
}

// ── the target content generation ────────────────────────────────────────────────────────────────
/** The records a FULL build over this vault would index — indexDir's exact resolved-item walk
 *  (walkResolvedItems), so the target and the build's stamp cannot disagree. Embeds nothing. */
export function collectGenerationRecords(vault: string, opts: { exclude?: (rel: string) => boolean } = {}): GenerationRecord[] {
  const records: GenerationRecord[] = [];
  for (const { item, meta, parseError } of walkResolvedItems(vault, vault, { exclude: opts.exclude })) {
    if (parseError !== undefined || isTombstoned(meta)) continue; // malformed: skipped as indexDir skips it (0.5.0 item 20)
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
    indexSchemaVersion: SCHEMA_VERSIONS.libsql,
  });
}

// ── servability ─────────────────────────────────────────────────────────────────────────────────
/** The published file's own meta, read raw and read-only WITHOUT an embedder — so a build whose
 *  embedder does not match this process's can be described. Runs under bun and node alike. */
export async function readPublishedMeta(dbPath: string): Promise<Record<string, string>> {
  const { openRawIndex } = await import("./libsql/store.ts");
  const db = openRawIndex(dbPath, true);
  try {
    const rows = db.prepare("select key, value from meta").all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } finally {
    db.close();
  }
}

/** `PRAGMA quick_check` (Q18-2): torn FTS pages pass `stats()`, so without it the skip keeps a torn
 *  file forever and a clone copies the corruption into the next build. */
async function quickCheckOk(dbPath: string): Promise<boolean> {
  try {
    const { openRawIndex } = await import("./libsql/store.ts");
    const db = openRawIndex(dbPath, true);
    try {
      const rows = db.prepare("pragma quick_check").all() as Array<Record<string, string>>;
      return rows.length === 1 && Object.values(rows[0]!)[0] === "ok";
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/** A published file's (`published.db`, or a rollback target) content generation when a read-only
 *  reader may be served it, else null. Servable
 *  means: a single file, read-only on disk (Q18-3: a writable file may have been edited under its
 *  label), no -journal/-wal/-shm beside it, a DELETE-journal header, the read face's own zero-write
 *  validation (a funes index, embedding signature, not dirty), the current schema, a valid content
 *  generation and a clean quick_check. Any failure ⇒ not servable ⇒ never skipped onto, never
 *  cloned from. The owner is checked by the caller: the skip needs this star's own stamp, the clone
 *  only assertPublishedOwner's claim (a re-identified star clones and restamps). */
async function servableGeneration(p: string, embedder: Embedder): Promise<string | null> {
  let st;
  try { st = statSync(p); } catch { return null; }
  if (!st.isFile() || (st.mode & 0o222) !== 0) return null;
  for (const s of SIDECARS) if (existsSync(p + s)) return null;
  let fd: number | undefined;
  try {
    fd = openSync(p, "r");
    const head = Buffer.alloc(20);
    if (readSync(fd, head, 0, 20, 0) < 20) return null;
    if (head.toString("latin1", 0, 16) !== "SQLite format 3\0") return null;
    if (!(head[18] === 1 && head[19] === 1)) return null; // 1 = DELETE journal, 2 = WAL
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  try {
    const { LibsqlStore } = await import("./libsql/store.ts");
    const ro = await LibsqlStore.create(embedder, p, { readonly: true });
    let gen: string | null;
    try {
      const stats = await ro.stats();
      if (stats.schemaVersion !== SCHEMA_VERSIONS.libsql || stats.reindexDirty) return null;
      gen = (await ro.contentIdentity()).contentGeneration;
    } finally { await ro.close(); }
    return gen && (await quickCheckOk(p)) ? gen : null;
  } catch {
    return null;
  }
}

/** ADR-0007 stat parity: does `published.db`'s stat record still match the vault? The skip's last
 *  condition — a content-equal edit (a touch, a re-delivery) keeps the generation, and without this
 *  the served record would stay stale forever. Anything but a positive `false` counts as disagreement
 *  (one cloned parse-walk), because a wrong skip serves a stale record until the next content change. */
async function publishedStatsAgree(home: string, embedder: Embedder, vault: string, exclude?: (rel: string) => boolean): Promise<boolean> {
  try {
    const { LibsqlStore } = await import("./libsql/store.ts");
    const ro = await LibsqlStore.create(embedder, publishedDbPath(home), { readonly: true });
    try {
      return (await statParity(new FolderVault(vault), (await ro.stats()).lastReindexAt, await ro.pageStats(), exclude)).changed === false;
    } finally { await ro.close(); }
  } catch {
    return false;
  }
}

/** Q18-4, under the publish lock: the home belongs to this vault (the owner marker), and the published file,
 *  when one is there, is stamped by this star or by the id it declares it had. */
async function assertPublishedOwner(home: string, vault: string): Promise<void> {
  assertIndexOwner(home, vault);
  const p = publishedDbPath(home);
  if (!existsSync(p)) return;
  let stamped: string | null = null;
  try { stamped = (await readPublishedMeta(p)).owner_star_id ?? null; } catch { return; } // unreadable: not servable, rebuilt
  if (stamped === null) return;
  const me = readStarIdentity(vault);
  if (me.id === null || !mayClaimIndex(stamped, me.id, me.idWas)) throw ownerClaimRefused(stamped, me.id ?? "(none)");
}

// ── publish ─────────────────────────────────────────────────────────────────────────────────────
export interface PublishReindexOpts {
  vault: string;
  /** The publication home: `published.db`, its `.prev` and the publish lock live here. */
  home: string;
  /** The embedder the build enforces — also pins the target generation's embedding spec. */
  embedder: Embedder;
  exclude?: (rel: string) => boolean;
  scopeSignature?: ScopeSignature | null;
  /** The star being published (star.yaml `meta.id`): stamped by the build, and part of the skip
   *  predicate — a published file owned by another id is rebuilt, never skipped onto. */
  starId?: string;
  /** Build from empty: the repair for an unservable file. Never clones. */
  force?: boolean;
  batch?: number;
  onProgress?: (r: IndexResult) => void;
  /** Called at each named step of a build, under the publish lock: `target`, `finalized`, `prev-linked`,
   *  `swapped`. The crash and mid-walk tests stop or edit the run here. */
  onStep?: (step: "target" | "finalized" | "prev-linked" | "swapped") => void;
}

export interface PublishReindexResult {
  generation: string;
  /** true ⇒ `published.db` already carried the target and agreed with the vault; nothing moved. */
  skipped: boolean;
  /** `published.db` when a build was swapped in; null when skipped. */
  dbPath: string | null;
  /** The build was seeded from a clone of `published.db`. */
  cloned: boolean;
  /** Why a clone that was due did not seed the build (§3b-12: a silent fallback re-embeds everything). */
  cloneError: string | null;
  /** equal | stat-refresh | content | owner (a re-identified star restamps) | absent-or-unservable | force */
  reason: string;
}

/** Only under the publish lock: every `.building.*` then belongs to a run that is no longer running. */
function sweep(home: string): void {
  for (const f of readdirSync(home)) if (f.startsWith(BUILDING)) rmSync(join(home, f), { force: true });
}

export async function publishReindex(opts: PublishReindexOpts): Promise<PublishReindexResult> {
  // 0.3.0 item 23: a home in a sync root is a torn database with more copies. Before mkdir on purpose.
  assertIndexNotInSyncRoot(opts.home);
  mkdirSync(opts.home, { recursive: true });
  return withPublishLock(opts.home, async () => {
    await assertPublishedOwner(opts.home, opts.vault);
    sweep(opts.home); // a killed run's build and its sidecars
    const scope = opts.scopeSignature ?? null;
    // RAI-318 Q1c, as on reindex: no scope over a file built under one is a lost star.yaml (a rename,
    // a TCC denial), never a configless star. Only --force rebuilds without it.
    if (scope === null && !opts.force && existsSync(publishedDbPath(opts.home))) {
      let built: string | null = null;
      try { built = (await readPublishedMeta(publishedDbPath(opts.home))).index_scope_hash ?? null; } catch { /* unreadable: not servable, rebuilt */ }
      if (built !== null) throw new Error("publish: the scope declared at the last publish is gone; restore star.yaml, or run `funes publish --force` to rebuild without it");
    }
    const target = computeTargetGeneration(opts.vault, { embedder: opts.embedder, scopeSignature: scope, exclude: opts.exclude });
    opts.onStep?.("target");
    const current = await servableGeneration(publishedDbPath(opts.home), opts.embedder);
    // Q8: skip only onto this star's own stamp; after a re-id (`id_was`) the clone still seeds the build.
    const ownStamp = current === null || opts.starId === undefined || (await readPublishedMeta(publishedDbPath(opts.home))).owner_star_id === opts.starId;
    if (!opts.force && current === target && ownStamp && (await publishedStatsAgree(opts.home, opts.embedder, opts.vault, opts.exclude))) {
      return { generation: target, skipped: true, dbPath: null, cloned: false, cloneError: null, reason: "equal" };
    }
    const reason = opts.force ? "force" : !current ? "absent-or-unservable" : current !== target ? "content" : !ownStamp ? "owner" : "stat-refresh";
    // Per-run name: a publisher that somehow got past the publish lock can only rename its OWN build in.
    const buildPath = join(opts.home, `${BUILDING}.${process.pid}.${randomBytes(4).toString("hex")}`);
    let cloned = false;
    let cloneError: string | null = null;
    if (!opts.force && current !== null) {
      try {
        publishIo.clone(publishedDbPath(opts.home), buildPath);
        await stripClonedIdentity(buildPath);
        // Q18-2: a corrupt clone is not a seed — this run builds from empty instead.
        if (!(await quickCheckOk(buildPath))) throw new Error("the clone fails quick_check");
        cloned = true;
      } catch (e) {
        cloneError = `clone of ${PUBLISHED_DB} failed, built from empty: ${(e as Error).message}`;
        sweep(opts.home);
      }
    }
    try {
      await buildInto(buildPath, target, opts);
      opts.onStep?.("finalized");
      await swapIn(opts.home, buildPath, opts.onStep);
    } catch (e) {
      sweep(opts.home);
      throw diskFull(opts.home, e) ?? e;
    }
    return { generation: target, skipped: false, dbPath: publishedDbPath(opts.home), cloned, cloneError, reason };
  });
}

/** APFS/btrfs clone where the filesystem has one (instant, no extra blocks), else a copy. The clone
 *  inherits `published.db`'s 0444, and the build must write it. */
export function cloneInto(src: string, dst: string): void {
  copyFileSync(src, dst, constants.COPYFILE_FICLONE);
  chmodSync(dst, 0o644);
}

/** Delete the identity a clone must not inherit, before the store opens it: the content generation
 *  and its invalidation (the rows are about to change; the build's finalize restamps them), plus the dead `publication_id` row a cutover seed still carries. */
async function stripClonedIdentity(dbPath: string): Promise<void> {
  const { openRawIndex } = await import("./libsql/store.ts");
  const db = openRawIndex(dbPath, false);
  try {
    db.exec("delete from meta where key in ('publication_id','generation','generation_invalidated_at','generation_invalidated_reason')");
  } finally {
    db.close();
  }
}

/** Build, validate (not dirty; built === target) and finalize to DELETE journal. Throws, leaving the
 *  caller to sweep the build. */
async function buildInto(buildPath: string, target: string, opts: PublishReindexOpts): Promise<void> {
  const { LibsqlStore } = await import("./libsql/store.ts");
  const star = readStarIdentity(opts.vault);
  // A private build (RAI-309 Q2): it reads the vault and writes only its own off-path file, so it
  // takes no write lock — the index.db writers' lock is never publish's (Q18-6).
  const store = await LibsqlStore.create(opts.embedder, buildPath, { allowDirty: true, privateBuild: true });
  try {
    await indexDir(store, opts.vault, {
      exclude: opts.exclude,
      scopeSignature: opts.scopeSignature ?? null,
      batch: opts.batch,
      onProgress: opts.onProgress,
      starId: opts.starId,
      starIdWas: star.idWas, // a clone of a re-identified star's build carries the old stamp
      okf: star.capabilities.okf !== false, // item 20: the OKF counters, same gate
    });
    const stats = await store.stats();
    if (stats.reindexDirty) throw new Error("publish: built index is dirty — not published");
    // Q10: the only vault-moved guard. It refuses an edit to a page the walk had not read yet.
    if (stats.contentGeneration !== target) {
      throw new Error(`publish: the vault moved during the build (target ${target}, built ${stats.contentGeneration ?? "null"}) — not published, retry`);
    }
    await store.finalizeForPublish();
  } finally {
    await store.close().catch(() => {});
  }
}

/** Gap-free swap, under the publish lock: 0444 + durable build, `.prev` = the outgoing file, stray sidecars
 *  of the OLD inode removed, then one rename. `published.db` names a complete file at every instant. */
async function swapIn(home: string, buildPath: string, onStep?: PublishReindexOpts["onStep"]): Promise<void> {
  const pub = publishedDbPath(home);
  const prev = join(home, PREV);
  chmodSync(buildPath, 0o444); // a read-write opener can neither write, journal nor WAL-flip it
  await publishIo.sync(buildPath);
  if (existsSync(pub)) {
    // rm then link (Q7): `link .prev.tmp; rename .prev.tmp .prev` leaves a stray link after a crash,
    // because a rename between two names of ONE inode does nothing.
    rmSync(prev, { force: true });
    linkSync(pub, prev);
  }
  await publishIo.sync(home);
  onStep?.("prev-linked");
  // Nothing legitimately writes published.db, so a sidecar beside it belongs to the OLD inode (a dead
  // writer, a WAL flip). Left behind, the fixed name would pair it with the new one.
  for (const s of SIDECARS) rmSync(pub + s, { force: true });
  renameSync(buildPath, pub);
  onStep?.("swapped");
  await publishIo.sync(home);
}

// ── rollback (RAI-306 Q7/Q16/Q17; provisional verb `publish --rollback`, RAI-317 names it) ─────────
export interface RollbackOpts {
  vault: string;
  home: string;
  /** The embedder a reader opens the target with: a target under another signature is unservable. */
  embedder: Embedder;
  /** The live star.yaml scope signature (null: no valid scope); the target must carry the same hash. */
  scopeSignature: ScopeSignature | null;
  /** The file to serve, in the home: default `published.db.prev`; the walk passes its T0 copy. */
  from?: string;
}

export interface RollbackResult { generation: string; from: string; dbPath: string }

/** Serve an older build again: `from` (default `published.db.prev`) is checked and swapped in by the
 *  publish swap, under the publish lock, so the outgoing file becomes `.prev` (a rollback can be
 *  rolled back). It holds only while `publish` and `watch` are stopped: the next publish or watch tick
 *  rebuilds over it. There is no hold file, by design. */
export async function rollbackPublished(opts: RollbackOpts): Promise<RollbackResult> {
  const starId = readStarIdentity(opts.vault).id;
  if (starId === null) throw new Error(`rollback: ${opts.vault} declares no star.yaml meta.id — which star a published build belongs to cannot be proven; refusing`);
  const from = resolve(opts.home, opts.from ?? PREV);
  assertIndexNotInSyncRoot(opts.home);
  return withPublishLock(opts.home, async () => {
    assertIndexOwner(opts.home, opts.vault);
    const pub = publishedDbPath(opts.home);
    let src;
    try { src = statSync(from); } catch { throw new Error(`rollback: no rollback target — ${from} does not exist`); }
    // A rename only stays atomic, and the target only stays the operator's to name, inside the home.
    if (realpathSync(dirname(from)) !== realpathSync(opts.home)) throw new Error(`rollback: ${from} is not in the home ${opts.home} — name a file in the home`);
    const cur = existsSync(pub) ? statSync(pub) : null;
    if (cur && cur.ino === src.ino && cur.dev === src.dev) {
      throw new Error(`rollback: no rollback target — ${from} is the served file itself (a publish killed mid-swap leaves .prev as published.db); nothing older is kept`);
    }
    let meta: Record<string, string>;
    try { meta = await readPublishedMeta(from); } catch (e) { throw new Error(`rollback: ${from} is not servable — ${(e as Error).message}`); }
    if ((meta.owner_star_id ?? null) !== starId) throw new Error(`rollback: ${from} belongs to ${meta.owner_star_id ?? "no star"}, not ${starId} — refusing to serve another star's build`);
    if (meta.index_scope_ignored === "1") throw new Error(`rollback: ${from} was built with the index scope ignored — refusing to serve it`);
    const want = opts.scopeSignature?.hash ?? null;
    if ((meta.index_scope_hash ?? null) !== want) {
      throw new Error(`rollback: ${from} was built under index scope ${meta.index_scope_hash ?? "none"}, and star.yaml now says ${want ?? "none"} — refusing to serve files the scope excludes`);
    }
    chmodSync(from, 0o444); // Q18-3: a served file is never writable, and a 0644 copy would be unservable
    const generation = await servableGeneration(from, opts.embedder);
    if (!generation) {
      chmodSync(from, src.mode & 0o7777); // a refused target is left as it was found
      throw new Error(`rollback: ${from} is not servable (a sidecar, a WAL header, dirty, another schema or embedder, or it fails quick_check) — refusing to serve it`);
    }
    // A second name for the target, so the swap's `.prev` rewrite cannot remove the target itself.
    const staged = join(opts.home, `${BUILDING}.${process.pid}.${randomBytes(4).toString("hex")}`);
    linkSync(from, staged);
    try {
      await swapIn(opts.home, staged);
    } catch (e) {
      rmSync(staged, { force: true });
      throw diskFull(opts.home, e) ?? e;
    }
    return { generation, from, dbPath: pub };
  });
}
