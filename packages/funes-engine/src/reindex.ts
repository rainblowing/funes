import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { MemoryItem, ScopeSignature, Store } from "funes-core";
import { isTombstoned } from "funes-core";
import { fileToItemWithMeta, parseFrontmatter } from "./markdown.ts";
import { encodeGeneration, generationRecord, type GenerationRecord } from "funes-shared";
import { withCoordination } from "./coordination.ts";
import { anyExclude, buildScopeExclude, configlessExclude, readIndexScopeExcludes } from "./scope.ts";

/** Walk options (vault-v2 brief, T1): `exclude` is an index-scope predicate over root-relative
 *  paths — called with `<relDir>/` (trailing slash) before descending into a directory (a true
 *  return prunes the subtree) and with `<relFile>` for each candidate file. Symlinks (files AND
 *  directories) are never followed: symlinked asset trees are structurally invisible to the
 *  index, not configuration-dependent. */
export interface WalkOpts {
  exclude?: (rel: string) => boolean;
}

/** ONE walk answering both halves of "did the vault move under the index": is any surviving file
 *  newer than `sinceMs`, and which ids does the vault still offer. Early-exits on the first newer
 *  file, so the STALE case (the one that needs a warning) is cheap and the caller can skip the
 *  index round-trip entirely — which is why `ids` is complete ONLY when `newer` is false, the
 *  single case that reads it. The id is the one `fileToItemWithMeta` derives (rel path minus
 *  `.md`), so it compares directly against index rows. */
function scanCorpus(dir: string, sinceMs: number, opts: WalkOpts = {}): { newer: boolean; ids: Set<string> } {
  const ids = new Set<string>();
  for (const f of walkMd(dir, opts)) {
    try { if (lstatSync(f).mtimeMs > sinceMs) return { newer: true, ids }; } catch { continue; } // vanished mid-walk
    ids.add(relative(dir, f).replace(/\.md$/, ""));
  }
  return { newer: false, ids };
}

/** Is any indexable file under `dir` newer than `sinceMs`? Answers the only staleness question a
 *  user cares about — "did I change notes since the last reindex?" — instead of nagging about age,
 *  which fires on a vault nobody has touched. Half the answer: see vaultChangedSince for deletions,
 *  which leave no file behind to be newer. */
export function vaultNewerThan(dir: string, sinceMs: number, opts: WalkOpts = {}): boolean {
  return scanCorpus(dir, sinceMs, opts).newer;
}

/** The corpus predicate a reindex actually applies, resolved from the vault's own manifest — so a
 *  staleness check walks the SAME files the index covers. Without it, an edit to an
 *  index_scope-excluded path (or any `.md` under `node_modules/` in a configless vault, which the
 *  quickstart invites by pointing funes at a code repo) reports the index stale forever, and a
 *  warning that cries wolf is one a reader learns to skip. An invalid manifest falls back to the
 *  configless defaults instead of refusing the way reindex does: this answers an advisory question,
 *  and it must never be the reason recall or health fails. */
function indexedFileExclude(vault: string): ((rel: string) => boolean) | undefined {
  const scope = readIndexScopeExcludes(vault);
  return anyExclude(
    buildScopeExclude(scope.kind === "valid" ? scope.excludes : []),
    scope.kind === "valid" ? undefined : configlessExclude(),
  );
}

const STALE_TTL_MS = 30_000;
const staleMemo = new Map<string, { at: number; value: boolean | null }>();

/** Has the vault changed since the last full reindex? `null` = unknown: no reindex stamp, or the
 *  vault could not be walked. Never throws — a freshness hint must not be the reason a recall fails.
 *
 *  ADDITIONS and EDITS show up as an mtime newer than the stamp. DELETIONS do not — a note that is
 *  gone leaves nothing behind to be newer, so an mtime-only walk answered "ok" for an index that
 *  can still serve the deleted row, forever, which is the exact failure this signal exists to
 *  catch. `indexedIds` closes it: the index's own id set IS the record of the corpus the last full
 *  reindex covered, so nothing new has to be persisted to compare against. Optional — a store that
 *  cannot enumerate (a test fake) keeps the mtime-only answer rather than degrading to `null`,
 *  which would turn "I checked, and edits are invisible" into "I don't know" for every caller.
 *
 *  The comparison is ONE-directional on purpose — an indexed id with no file — and that is what
 *  makes it noise-free: a tombstoned or index_scope-excluded file sits on disk with no index row
 *  and must NOT count, while a brand-new file is an index row short and is already caught by its
 *  mtime above. Narrowing index_scope without reindexing DOES now report changed: those rows are
 *  live in recall and out of policy, which is a change worth naming.
 *
 *  Both accessors are thunks because each costs a store round-trip and this runs once per recall:
 *  on a memo hit neither query nor the stat walk happens, and `indexedIds` is skipped entirely
 *  whenever the walk already found a newer file.
 *
 *  ponytail: 30s TTL, one entry per vault. A clean walk of the 8.8k-file personal vault is
 *  ~80-150ms and recall is the daemon's hot path, so an uncached check would tax every query. The
 *  TTL cuts BOTH ways:
 *    - it can hide an edit made in the last 30 seconds — advisory signal, acceptable; and
 *    - it can keep serving a stale TRUE for up to 30 seconds AFTER a reindex, so the warning cries
 *      wolf at the user who just did the thing it asked for. A full reindex in THIS process now
 *      clears the entry (indexDir, on completion). A reindex in ANOTHER process — `funes reindex`
 *      at a terminal while `funes mcp` answers — cannot, and stays bounded by the TTL alone.
 *  Upgrade path for that last case: fold the reindex stamp into the memo key. Not taken, because
 *  the key would then need a stats() round-trip on EVERY recall, which is the exact cost the thunks
 *  below exist to avoid, to buy a 30s bound that is already there.
 *  DECIDED (Codex R2 #17): health and the surface's freshness chip share this memo rather than
 *  taking an uncached scan. The chip polls; an uncached health would hand a poller a full 8.8k-file
 *  stat walk plus an id enumeration per refresh, to sharpen a signal whose own remedy (reindex)
 *  takes minutes. 30s of lag in either direction is under the noise floor of the thing it reports.
 *
 *  Note for tests: the memo is module state keyed by vault path, so a test that reindexes and then
 *  edits the SAME vault inside the window sees the cached answer — use a fresh temp vault per case. */
export async function vaultChangedSince(
  vault: string,
  stampedAt: () => Promise<string | null>,
  indexedIds?: () => Promise<string[] | null | undefined>,
): Promise<boolean | null> {
  const now = Date.now();
  const key = resolve(vault); // so the reindex-side invalidation below can never silently miss
  const hit = staleMemo.get(key);
  if (hit && now - hit.at < STALE_TTL_MS) return hit.value;
  let value: boolean | null = null;
  try {
    const at = Date.parse((await stampedAt()) ?? "");
    if (!Number.isNaN(at)) {
      const { newer, ids } = scanCorpus(vault, at, { exclude: indexedFileExclude(vault) });
      value = newer || ((await indexedIds?.()) ?? []).some((id) => !ids.has(id));
    }
  } catch { /* unreadable vault or index — unknown, never a failure */ }
  staleMemo.set(key, { at: now, value });
  return value;
}

/** Drop a vault's memoized freshness answer. Called when a full reindex completes: that answer was
 *  computed against the PREVIOUS reindex stamp, so keeping it tells the user their index is stale
 *  for up to 30 more seconds after they already fixed it. Same-process only — module state. */
export function forgetVaultFreshness(vault: string): void {
  staleMemo.delete(resolve(vault));
}

/** Yield content `.md` files under a dir (skip dot-dirs, symlinks, index.md, *.summary.md). */
export function* walkMd(dir: string, opts: WalkOpts = {}, root: string = dir): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue; // v2: never follow symlinks (assets live outside the vault)
    if (st.isDirectory()) {
      if (opts.exclude?.(relative(root, p) + "/")) continue;
      yield* walkMd(p, opts, root);
    } else if (name.endsWith(".md") && name !== "index.md" && !name.endsWith(".summary.md")) {
      if (opts.exclude?.(relative(root, p))) continue;
      yield p;
    }
  }
}

export interface IndexResult {
  files: number;
  indexed: number;
  skipped: number;
  tombstoned: number;
  /** Stale index rows removed (deleted/tombstoned files) on a full-vault reindex (H2/D7). */
  pruned: number;
}

/** I2 pass 1: map basename (no .md) → unique vault-relative id; `null` marks an ambiguous
 *  basename (same name in 2+ folders). Paths only — no file reads, so it stays cheap even
 *  on a bounded/subdir run (targets may point anywhere in the vault, hence vault-wide). */
export function buildBasenameMap(vaultRoot: string, opts: WalkOpts = {}): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const f of walkMd(vaultRoot, opts)) {
    const id = relative(vaultRoot, f).replace(/\.md$/, "");
    const base = basename(id);
    map.set(base, map.has(base) ? null : id);
  }
  return map;
}

/** The unified reference maps (N5, graph research 2026-07-13): basenames + frontmatter
 *  `aliases:`. THE canonical resolution semantics — twinkling lint imports this so lint and
 *  reindex can never disagree again (lint's old basename-Set made ambiguous names look valid).
 *  Precedence: real path-ids (slash-qualified) are never rewritten > unique basename > unique
 *  alias. Collisions → null (never guess): alias-vs-alias collides to null, and an alias whose
 *  string exists in the basename map is shadowed (the basename map owns that string, even when
 *  itself ambiguous/null). Reading aliases costs one frontmatter parse per file — indexDir
 *  reads every file anyway in pass 2; on bounded runs pass 1 becomes a full-vault read
 *  (accepted: targets may point anywhere; correctness beats the --max fast path). NOTE (grill
 *  #12, honesty): alias resolution helps LOOKUP of slash-less authored targets; it is NOT
 *  move-survival — funes' own `link()` writes slash-qualified path-ids, which resolution never
 *  touches. */
export function buildReferenceMaps(
  vaultRoot: string,
  opts: WalkOpts = {},
): { byBase: Map<string, string | null>; byAlias: Map<string, string | null> } {
  const byBase = new Map<string, string | null>();
  const byAlias = new Map<string, string | null>();
  for (const f of walkMd(vaultRoot, opts)) {
    const id = relative(vaultRoot, f).replace(/\.md$/, "");
    const base = basename(id);
    byBase.set(base, byBase.has(base) ? null : id);
    let aliases: unknown;
    try {
      aliases = parseFrontmatter(readFileSync(f, "utf8")).data.aliases;
    } catch { continue; } // unreadable file — basename entry stands, aliases skipped
    if (!Array.isArray(aliases)) continue;
    for (const a of aliases) {
      const alias = String(a).trim().replace(/\.md$/, "");
      if (!alias || alias.includes("/")) continue; // path-qualified aliases: out of scope (grill #12)
      byAlias.set(alias, byAlias.has(alias) ? null : id);
    }
  }
  return { byBase, byAlias };
}

/** I2 pass 2 (per item, before remember): rewrite each edge target that (a) contains no `/`
 *  and (b) uniquely matches the basename map — or, failing that, uniquely matches a frontmatter
 *  alias (N5) — to the path-qualified id. Path-qualified targets, ambiguous matches, and
 *  unmatched targets pass through unchanged. Without this, twinkling's basename targets
 *  (`target: rag`) never match funes' path ids (`ai/rag`) and the edge-walk recall arm is a
 *  no-op for nested pages. Alias fallback fires ONLY when the string is completely absent from
 *  the basename map — a null (ambiguous) basename blocks alias resolution of the same string. */
export function resolveEdgeTargets(
  item: MemoryItem,
  byBase: Map<string, string | null>,
  byAlias?: Map<string, string | null>,
): void {
  for (const e of item.edges ?? []) {
    if (e.target.includes("/")) continue;
    if (byBase.has(e.target)) {
      const hit = byBase.get(e.target);
      if (hit) e.target = hit;
      continue; // ambiguous basename: leave the authored string, never fall through to aliases
    }
    const aliasHit = byAlias?.get(e.target);
    if (aliasHit) e.target = aliasHit;
  }
}

/** The ONE resolved-item walk shared by the indexer and the generation-target computation
 *  (Codex R1#4). Build the reference maps once, then yield each file's item with edge targets
 *  resolved EXACTLY as the index build resolves them (byBase + byAlias). Before this, publication's
 *  computeTargetGeneration resolved basenames ONLY (buildBasenameMap) while indexDir resolved
 *  basenames AND aliases — so any alias-resolved edge hashed differently in the target than in the
 *  build, and an alias-using vault failed every publish with a target/built generation mismatch.
 *  Tombstoned files are yielded too (with their meta) so the caller can count + skip them without a
 *  second walk; resolution on a to-be-skipped item is harmless. */
export function* walkResolvedItems(
  vaultRoot: string,
  dir: string,
  opts: WalkOpts = {},
): Generator<{ item: MemoryItem; meta: ReturnType<typeof fileToItemWithMeta>["meta"] }> {
  const { byBase, byAlias } = buildReferenceMaps(vaultRoot, opts);
  for (const f of walkMd(dir, opts, vaultRoot)) {
    const { item, meta } = fileToItemWithMeta(f, vaultRoot);
    resolveEdgeTargets(item, byBase, byAlias);
    yield { item, meta };
  }
}

/** Index every markdown file under `dir` into `store`. Incremental (unchanged files skip
 *  re-embed). `maxFiles` bounds it; `onProgress` is called per batch. */
export async function indexDir(
  store: Store,
  vaultRoot: string,
  dir: string,
  opts: {
    maxFiles?: number;
    batch?: number;
    onProgress?: (r: IndexResult) => void;
    /** `reindex --fresh` (2026-07-16): wipe every index row INSIDE the dirty epoch, then walk
     *  normally — nothing to hash-skip against, so every file re-embeds and every DERIVED column
     *  (pg tsvectors: the ab95b13 setweight fix never reaches unchanged rows) is recomputed. The
     *  supported stale-derivation repair path; honored on FULL runs only. */
    fresh?: boolean;
    /** Index-scope predicate (star.yaml memory.index_scope): excluded paths are invisible to this
     *  run AND, because a full run prunes rows not seen on disk, previously indexed rows under a
     *  newly excluded path drop out automatically — exclusion is reversible. */
    exclude?: (rel: string) => boolean;
    /** The index_scope signature to STAMP on successful completion (closure sprint 3B). Persisted
     *  ONLY by a FULL run's authoritative prune — a bounded --max run leaves the prior signature
     *  untouched (R5 #1: a partial run doesn't prune, so stamping would falsely bless stale rows).
     *  H2: pass `null` to INVALIDATE (clear) the prior signature — a full rebuild from an absent/
     *  invalid manifest must not leave a stale clean signature the serve-time recompute could match.
     *  `undefined` leaves the prior signature as-is (no opinion). */
    scopeSignature?: ScopeSignature | null;
    /** The owning star's identity (`star.yaml meta.id`), stamped into the database's `meta` table
     *  on a FULL run — the same gate as the scope signature and the generation.
     *
     *  PASSED IN, never read from star.yaml here: reindex.ts is manifest-agnostic, and the caller
     *  already holds the identity (the CLI from `readStarIdentity`, the publisher from its own
     *  `starId` option). It is stamped at BUILD rather than at publish because the consumer is
     *  twinkling's publication gate, and what that gate inspects is the built `index.db`. */
    starId?: string;
  } = {},
): Promise<IndexResult> {
  // Cross-container coordination (re-homing plan item 12): a reindex is a funes WRITE path — when
  // FUNES_COORDINATION_DIR is set it runs under the shared vault transaction lock (no-op when
  // unset: Mac single-process behaviour unchanged). Reentrant, so publishReindex's outer hold nests.
  return withCoordination(() => indexDirInner(store, vaultRoot, dir, opts));
}

async function indexDirInner(
  store: Store,
  vaultRoot: string,
  dir: string,
  opts: {
    maxFiles?: number;
    batch?: number;
    onProgress?: (r: IndexResult) => void;
    fresh?: boolean;
    exclude?: (rel: string) => boolean;
    scopeSignature?: ScopeSignature | null;
    starId?: string;
  } = {},
): Promise<IndexResult> {
  const batchSize = opts.batch ?? 32;
  const walkOpts: WalkOpts = { exclude: opts.exclude };
  const res: IndexResult = { files: 0, indexed: 0, skipped: 0, tombstoned: 0, pruned: 0 };
  let batch: MemoryItem[] = [];
  const seen: string[] = []; // non-tombstoned ids present on disk this pass (for H2 prune)
  const records: GenerationRecord[] = []; // generation-v1 (R5#1): (path, content-hash, trust) per indexed item
  // H2 dirty-epoch applies to FULL runs only (the ones that prune): mark in-progress so a crash
  // is detected on the next open. Bounded/subdir runs are incremental top-ups — no marker.
  const full = dir === vaultRoot && !opts.maxFiles;
  if (full) await store.beginReindex?.();
  // --fresh wipe: prune([]) — the store's own authoritative-wipe primitive, so both backends, the
  // write-mutex and the collision/daemon guards all just apply. Ordered AFTER beginReindex so a
  // crash mid-fresh leaves the dirty marker (never an empty-but-"clean" index). Full runs only —
  // the CLI rejects --fresh + --max, and a subdir run never reaches here with full=true.
  // CEILING (F6): --fresh WIPES IN PLACE — the index is unqueryable until the run completes (the
  // dirty marker refuses opens meanwhile), so it is an OFFLINE manual repair verb. A SERVED libsql
  // home must use `publish --force` instead: off-path rebuild + atomic manifest swap, zero downtime.
  if (full && opts.fresh) await store.prune([]);
  const flush = async () => {
    if (!batch.length) return;
    const r = await store.remember(batch);
    res.indexed += r.indexed;
    res.skipped += r.skipped;
    batch = [];
    opts.onProgress?.(res);
  };
  // The shared resolved-item walk (walkResolvedItems) does I2 pass 1 (reference maps) + pass 2
  // (edge resolution, byBase + N5 aliases) identically to publication's target computation, so a
  // full build and its target generation can never disagree on aliased edges (Codex R1#4).
  for (const { item, meta } of walkResolvedItems(vaultRoot, dir, walkOpts)) { // root = vaultRoot: excludes are vault-relative even on subdir runs
    res.files++;
    // superseded / forgotten items stay on disk (canonical) but never enter the index —
    // so soft-tombstones survive reindex deterministically (D7 / R7).
    if (isTombstoned(meta)) { res.tombstoned++; continue; }
    records.push(generationRecord(item)); // resolved edges are what the store hashes
    batch.push(item);
    seen.push(item.id);
    if (batch.length >= batchSize) await flush();
    if (opts.maxFiles && res.files >= opts.maxFiles) break;
  }
  await flush();
  // H2/D7: a FULL, unbounded reindex of the whole vault is authoritative — prune index rows whose
  // file is gone or tombstoned. Skipped for a bounded run or a subdir reindex (would nuke the rest).
  if (full) {
    res.pruned = await store.prune(seen);
    // Identity, on the same full-run gate: a bounded or subdir run has not built the whole index
    // and must not claim it. Absent `starId` leaves any prior stamp alone rather than clearing it —
    // an unmanifested vault (no star.yaml id) must not silently un-stamp an index that has one.
    if (opts.starId) await (store as { setOwnerStarId?: (id: string) => Promise<void> }).setOwnerStarId?.(opts.starId);
    // THE ATOMIC FINALIZATION (PLAN-0.3.0 item 12; Codex R4#5). Content generation, cleared
    // invalidation, advanced built scope and cleared dirty marker commit as ONE backend
    // transaction. Until 0.3.0 these were four statements in four implicit transactions —
    // setGeneration, the scope stamp/clear, and endReindex's timestamp + dirty delete — so
    // CLEARING the stamp was atomic while SETTING it was not, and a crash between them left a
    // generation naming rows the run had not finished building.
    //
    // Still on the SAME full-run gate as the built scope: a bounded/subdir run must not stamp a
    // generation it did not fully build, and never reaches this block. The built scope keeps its
    // tri-state — `null` INVALIDATES (an absent/invalid-manifest configless rebuild) so a stale
    // clean signature can't re-bless re-admitted files; a ScopeSignature stamps; undefined leaves.
    //
    // Gated on `finalizeReindex` ALONE, never on `stats()` as well. Since endReindex was retired
    // this block is the ONLY thing that clears `reindex_dirty`, and funes-core's `Store` permits a
    // store that implements `beginReindex` + `finalizeReindex` and no `stats()` — which the
    // contract note calls compliant. Under a `&& statsFn` gate such a store marked its index
    // mid-build and never unmarked it, so every later open refused a permanently dirty index.
    // A store with no `stats()` simply cannot report a persisted embedding signature, and
    // "unknown embedding spec" is exactly what the `?? ""` below has always encoded for a null one.
    const statsFn = (store as { stats?: () => Promise<{ embeddingSignature: string | null }> }).stats;
    if (store.finalizeReindex) {
      const embeddingSpec = statsFn ? ((await statsFn.call(store)).embeddingSignature ?? "") : "";
      const scope = opts.scopeSignature !== undefined ? opts.scopeSignature : ((await store.getScopeSignature?.()) ?? null);
      await store.finalizeReindex({
        contentGeneration: encodeGeneration({ records, scope, embeddingSpec }),
        scope: opts.scopeSignature,
      });
    }
    // finalizeReindex just advanced lastReindexAt, so any memoized "the vault changed since the reindex"
    // answer is now about a stamp that no longer exists. Ordered AFTER it, never before: a memo
    // cleared while the run could still fail would be refilled from the OLD stamp on the next query.
    forgetVaultFreshness(vaultRoot);
  }
  return res;
}
