import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { MemoryItem, ScopeSignature, Store } from "funes-core";
import { isTombstoned } from "funes-core";
import { fileToItemWithMeta, parseFrontmatter } from "./markdown.ts";
import { encodeGeneration, generationRecord, type GenerationRecord } from "funes-shared";
import { withCoordination } from "./coordination.ts";

/** Walk options (vault-v2 brief, T1): `exclude` is an index-scope predicate over root-relative
 *  paths — called with `<relDir>/` (trailing slash) before descending into a directory (a true
 *  return prunes the subtree) and with `<relFile>` for each candidate file. Symlinks (files AND
 *  directories) are never followed: symlinked asset trees are structurally invisible to the
 *  index, not configuration-dependent. */
export interface WalkOpts {
  exclude?: (rel: string) => boolean;
}

/** Is any indexable file under `dir` newer than `sinceMs`? Answers the only staleness question a
 *  user cares about — "did I change notes since the last reindex?" — instead of nagging about age,
 *  which fires on a vault nobody has touched.
 *
 *  Early-exits on the first newer file, so the STALE case (the one that needs a warning) is cheap;
 *  a clean vault costs one full stat walk. ponytail: no mtime cache — a 2,700-note walk is ~50ms
 *  and this runs once per CLI query, not per recall. Add a cache if a vault ever makes it hurt. */
export function vaultNewerThan(dir: string, sinceMs: number, opts: WalkOpts = {}): boolean {
  for (const f of walkMd(dir, opts)) {
    try { if (lstatSync(f).mtimeMs > sinceMs) return true; } catch { /* vanished mid-walk */ }
  }
  return false;
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
    // Advance the index_scope signature only HERE — after the authoritative prune, on a full run.
    // A bounded/subdir run never reaches this block, so its prior signature is left untouched.
    // H2: `null` INVALIDATES (an absent/invalid-manifest configless rebuild) so a stale clean
    // signature can't re-bless re-admitted files; a ScopeSignature stamps; undefined leaves as-is.
    if (opts.scopeSignature === null) await store.clearScopeSignature?.();
    else if (opts.scopeSignature) await store.setScopeSignature?.(opts.scopeSignature);
    // generation-v1 stamp (R5#1) — computed AT INDEX BUILD, persisted beside the index, on the
    // SAME full-run gate as the scope signature (a bounded/subdir run must not restamp a
    // generation it did not fully build). Skipped for minimal Store fakes that expose neither
    // setGeneration nor stats (the embedding spec comes from the store's own persisted signature,
    // so the generation pins the embedder/chunking the index actually enforces).
    const statsFn = (store as { stats?: () => Promise<{ embeddingSignature: string | null }> }).stats;
    if (store.setGeneration && statsFn) {
      const embeddingSpec = (await statsFn.call(store)).embeddingSignature ?? "";
      const scope = opts.scopeSignature !== undefined ? opts.scopeSignature : ((await store.getScopeSignature?.()) ?? null);
      await store.setGeneration(encodeGeneration({ records, scope, embeddingSpec }));
    }
    await store.endReindex?.(); // clear the dirty marker only after the prune (+ stamp/clear) commit
  }
  return res;
}
