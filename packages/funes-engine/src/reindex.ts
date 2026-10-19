import { readFileSync, type Stats } from "node:fs";
import { basename, posix, relative } from "node:path";
import type { MemoryItem, OkfCounts, PageStat, PageStatRecord, ScopeSignature, Store, Vault } from "funes-core";
import { isPagePath, isTombstoned, mayClaimIndex, ownerClaimRefused, zoneOfFile } from "funes-core";
import { fileToItemWithMeta, normalizePage, parseFrontmatter, textToItemWithMeta } from "./markdown.ts";
import { encodeGeneration, generationRecord, lstatVersion, type GenerationRecord } from "funes-shared";
import { withCoordination } from "./coordination.ts";
import { anyExclude, buildScopeExclude, configlessExclude, readIndexScopeExcludes, type ScopeExcludesResult } from "./scope.ts";
import { FolderVault, walkFolder } from "./folder-vault.ts";

/** Walk options (vault-v2 brief, T1): `exclude` is an index-scope predicate over root-relative
 *  paths — called with `<relDir>/` (trailing slash) before descending into a directory (a true
 *  return prunes the subtree) and with `<relFile>` for each candidate file. Symlinks (files AND
 *  directories) are never followed: symlinked asset trees are structurally invisible to the
 *  index, not configuration-dependent. */
export interface WalkOpts {
  exclude?: (rel: string) => boolean;
}

/** The corpus predicate a reindex actually applies, resolved from the vault's own manifest — so a
 *  staleness check walks the SAME files the index covers. Without it, an edit to an
 *  index_scope-excluded path (or any `.md` under `node_modules/` in a configless vault, which the
 *  quickstart invites by pointing funes at a code repo) reports the index stale forever, and a
 *  warning that cries wolf is one a reader learns to skip. An invalid manifest falls back to the
 *  configless defaults instead of refusing the way reindex does: this answers an advisory question,
 *  and it must never be the reason recall or health fails. */
function indexedFileExclude(scope: ScopeExcludesResult): ((rel: string) => boolean) | undefined {
  return anyExclude(
    buildScopeExclude(scope.kind === "valid" ? scope.excludes : []),
    scope.kind === "valid" ? undefined : configlessExclude(),
  );
}

/** `doctor`'s `vault.unparsed` (PLAN-0.4.0 item 11, RAI-134): the ids of the pages in the indexed
 *  scope whose frontmatter does not parse — the same read reindex takes (fileToItemWithMeta), so the
 *  two can only disagree on a vault that changed between them. A VAULT fact, measured now, never a
 *  row fact (ADR-0003: facts that describe the rows stay with the rows): a published generation
 *  built before the tolerant parser recovered a page still serves it metadata-less, and this walk
 *  will not say so. Walk order, so two runs diff clean. A page that cannot be read is not a page
 *  whose YAML failed, and is skipped rather than allowed to cost the report. Nor may the WALK cost
 *  it (statParity's rule): a directory it cannot list, or a file a sync client removes between
 *  readdir and lstat, stops the walk — `ids` holds what was read before it and `walkError` says so.
 *  walkMd itself stays strict; a reindex must fail on the same error. */
export function unparsedPages(vault: string): { ids: string[]; walkError?: string } {
  const ids: string[] = [];
  try {
    for (const f of walkMd(vault, { exclude: indexedFileExclude(readIndexScopeExcludes(vault)) })) {
      try {
        const { item, parseError } = fileToItemWithMeta(f, vault);
        if (parseError !== undefined) ids.push(item.id);
      } catch { /* unreadable — see above */ }
    }
  } catch (e) {
    return { ids, walkError: (e as Error).message };
  }
  return { ids };
}

/** What a freshness answer stands on (PLAN-0.4.0 item 6, ADR-0007). `stat`: the vault was walked
 *  and compared against the index's own stat record, so `changed` is a real true/false. `none`: there
 *  is no record to compare against — never reindexed, an index built before the record existed, or
 *  a record some other build wrote. `unreadable`: the vault or the index could not be read. The last
 *  two both answer `changed: null`, and a reader needs to tell them apart: "republish to enable
 *  freshness" and "the vault could not be read" are different instructions. */
export type FreshnessBasis = "stat" | "none" | "unreadable";
export interface Freshness {
  changed: boolean | null;
  basis: FreshnessBasis;
}

/** STAT PARITY, uncached (PLAN-0.4.0 item 6, ADR-0007): does every file in the indexed scope carry
 *  exactly the `lstat` the last full reindex recorded for it, and is every recorded file still there?
 *  The one comparison both the freshness signal (vaultChangedSince, memoized) and the publish skip
 *  (publication.ts, uncached) take.
 *
 *  Why parity and never ordering. The mtime-versus-stamp rule this replaced compared a file's mtime
 *  against the REINDEXING machine's wall clock — and Syncthing preserves the WRITER's mtime, so a page
 *  edited on one host before the other host's reindex and delivered after it read as older than the
 *  stamp: a stale replica reported fresh. So nothing here orders anything; a recorded value either
 *  equals the one on disk or the page changed. All three fields, strictly (one string, `lstatVersion`,
 *  over the very `lstat().mtimeMs` the walk takes — no flooring, no Date round-trip):
 *    - `ctimeMs` closes the same-size, same-mtime hole. Syncthing's temp-rename-then-utimes delivery,
 *      and any rewrite that restores the mtime, still move the inode change time, and nothing in user
 *      space can set it back. The price: a metadata-only change (chmod, an xattr, a Finder tag) moves
 *      it too, so it OVER-reports stale until the next full run — never under-reports;
 *    - `size` and `mtimeMs` are the ordinary edit.
 *  An absent row is a page the build never walked (new, or written by `remember` after it); a
 *  recorded row nothing on disk matches is a deletion — or a narrowed index_scope, whose rows are
 *  still served and out of policy, which is a change worth naming too.
 *
 *  `null` (basis "none") when there is no stamp, no record, or the record's `page_stat_at` is not the
 *  index's `last_reindex_at` — a record from some other build is not a record of this one.
 *
 *  Version parity by listing (PLAN-0.5.0 item 12, ADR-0011 "Freshness"): the vault's `list` versions
 *  against the recorded ones, by equality only (at a folder both are `lstatVersion`). A recorded row that is not a page by
 *  `isPagePath` is not compared: a record a pre-/4 build wrote still holds `log.md`, and `list`
 *  never yields it (item 20 took it out of the build). */
export async function statParity(
  vault: Vault,
  stampedAt: string | null,
  record: PageStatRecord | null,
  exclude?: (rel: string) => boolean,
): Promise<Freshness> {
  if (stampedAt == null || record == null || record.at !== stampedAt) return { changed: null, basis: "none" };
  const recorded = new Map(record.rows.filter((r) => isPagePath(`${r.id}.md`)).map((r) => [`${r.id}.md`, r.version]));
  let matched = 0;
  try {
    for await (const { path, version } of vault.list({ exclude })) {
      // ADR-0015: a version is opaque and compared for equality; at a folder both sides are lstatVersion
      if (recorded.get(path) !== version) return { changed: true, basis: "stat" };
      matched++;
    }
  } catch {
    return { changed: null, basis: "unreadable" };
  }
  return { changed: matched !== recorded.size, basis: "stat" };
}

const STALE_TTL_MS = 30_000;
const staleMemo = new Map<unknown, { stamp: string; at: number; value: Promise<Freshness> }>();

/** Has the vault changed since the last full reindex? Stat parity (see statParity) behind a 30s
 *  memo. Never throws — a freshness hint must not be the reason a recall fails.
 *
 *  Both accessors are thunks: `stampedAt` (the index's `last_reindex_at`) is read on EVERY call,
 *  because it is half the memo key; `pageStats` only on a miss.
 *
 *  ponytail: 30s TTL, one entry per vault, keyed by (vault, last_reindex_at) and holding the walk's
 *  PROMISE. A clean walk of the 8.8k-file personal vault is ~80-150ms and recall is the daemon's hot
 *  path, so an uncached check would tax every query. What the key buys:
 *    - a reindex in ANY process — `funes reindex` at a terminal while `funes mcp` answers, a
 *      watcher's child publish — moves the stamp, so the next call misses and walks again at once.
 *      The in-process `forgetVaultFreshness` hook this replaced covered only its own process, and
 *      its objection to the key (a stats() round-trip per recall) is moot: comparing `page_stat_at`
 *      against the stamp needs that round-trip anyway;
 *    - concurrent cold calls await ONE walk instead of each running their own.
 *  What it still costs: an edit made in the last 30 seconds can be hidden. Advisory signal,
 *  acceptable. DECIDED (Codex R2 #17): health and the surface's freshness chip share this memo — the
 *  chip polls, and its signal's own remedy (reindex) takes minutes.
 *
 *  Note for tests: the memo is module state, so a test that edits a vault WITHOUT reindexing it
 *  sees the cached answer inside the window — use a fresh temp vault per case, or statParity. */
export async function vaultChangedSince(
  vault: Vault,
  scope: ScopeExcludesResult,
  stampedAt: () => Promise<string | null>,
  pageStats: () => Promise<PageStatRecord | null>,
): Promise<Freshness> {
  let stamp: string | null;
  try { stamp = await stampedAt(); } catch { return { changed: null, basis: "unreadable" }; }
  if (stamp == null) return { changed: null, basis: "none" }; // never reindexed: no record, and nothing to walk for
  // A folder keys on its path, so the hub's per-request contexts share one walk; any other vault on itself.
  const key: unknown = vault instanceof FolderVault ? vault.root : vault;
  const now = Date.now();
  const hit = staleMemo.get(key);
  if (hit && hit.stamp === stamp && now - hit.at < STALE_TTL_MS) return hit.value;
  const value = (async (): Promise<Freshness> => {
    try { return await statParity(vault, stamp, await pageStats(), indexedFileExclude(scope)); }
    catch { return { changed: null, basis: "unreadable" }; } // unreadable index — unknown, never a failure
  })();
  staleMemo.set(key, { stamp, at: now, value });
  return value;
}

/** Yield content `.md` files under a dir (skip dot-dirs, symlinks, index.md, log.md, *.summary.md, and
 *  Syncthing conflict copies — 0.4.0 item 7: a copy is a stale fork of a page, and every consumer
 *  of this walk — freshness, the reference maps, indexing, publication's target — must not see it). */
export function* walkMd(dir: string, opts: WalkOpts = {}, root: string = dir): Generator<string> {
  for (const { path } of walkMdStats(dir, opts, root)) yield path;
}

/** walkMd, with the `lstat` it already takes to classify each entry (RAI-124). That stat is taken
 *  BEFORE anything reads the file, which is the direction that matters: a write landing between the
 *  stat and the read leaves the recorded stat OLDER than the indexed content, so freshness
 *  over-reports that page once — it can never record a stat newer than the rows it describes. */
function walkMdStats(dir: string, opts: WalkOpts, root: string): Generator<{ path: string; rel: string; stat: Stats }> {
  // One page rule with FolderVault.list: `log.md` left the build with fm-wikilinks/4 (0.5.0 item 20,
  // ADR-0011 §Consequences), as `index.md` always had.
  return walkFolder(root, dir, isPagePath, opts.exclude);
}

export const isReservedFile = (rel: string): boolean => basename(rel) === "index.md" || basename(rel) === "log.md";

/** PLAN-0.5.0 item 20 (ADR-0012 §What keeps it true): count one walked file against the OKF floor,
 *  in memory — reindex never writes the vault. The OKF scope is the index scope (the walk's exclude)
 *  minus the incoming zone; a file the normalizer would edit or refuse is nonconformant. */
function countOkf(okf: OkfCounts, rel: string, bytes: Uint8Array): void {
  if (zoneOfFile(rel) === "incoming") return;
  const n = normalizePage(bytes, { path: rel });
  if ("invalid" in n || n.edit !== "none") okf.nonconformant++;
  if ("invalid" in n && n.invalid === "malformed") okf.malformed++;
}

export interface IndexResult {
  files: number;
  indexed: number;
  skipped: number;
  tombstoned: number;
  /** Stale index rows removed (deleted/tombstoned files) on a full-vault reindex (H2/D7). */
  pruned: number;
  /** 0.4.0 item 11 (RAI-134): ids of the walked pages whose frontmatter is `malformed`. Since 0.5.0
   *  item 20 (ADR-0012) each is skipped, fail-closed, and still stat-recorded; until then it was
   *  indexed with no metadata and the whole file as body. */
  unparsed: string[];
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

/** The reference maps every edge target resolves against (resolveTarget). `ids` is the exact-id
 *  set; `bySuffix` maps every segment-aligned suffix of every id (`wiki/entities/x` → itself,
 *  `entities/x`, `x`) to that id, a collision to null; `byBase` is its one-segment slice — the
 *  basenames — kept as its own map because twinkling's lint reads it (funes-binding.ts:21);
 *  `byAlias` maps each slash-less frontmatter alias, a collision to null. */
export interface ReferenceMaps {
  ids: Set<string>;
  bySuffix: Map<string, string | null>;
  byBase: Map<string, string | null>;
  byAlias: Map<string, string | null>;
}

/** Build the maps from ids and their `aliases:` — the ONE builder, so every resolver over the index
 *  (buildReferenceMaps) resolves by the same rules. */
export function referenceMaps(pages: Iterable<{ id: string; aliases?: unknown }>): ReferenceMaps {
  const ids = new Set<string>();
  const bySuffix = new Map<string, string | null>();
  const byAlias = new Map<string, string | null>();
  const claim = (m: Map<string, string | null>, k: string, id: string) => m.set(k, m.has(k) ? null : id);
  for (const { id, aliases } of pages) {
    ids.add(id);
    const segs = id.split("/");
    for (let i = 0; i < segs.length; i++) claim(bySuffix, segs.slice(i).join("/"), id);
    if (!Array.isArray(aliases)) continue;
    for (const a of aliases) {
      const alias = String(a).trim().replace(/\.md$/, "");
      if (!alias || alias.includes("/")) continue; // path-qualified aliases: out of scope (grill #12)
      claim(byAlias, alias, id);
    }
  }
  const byBase = new Map([...bySuffix].filter(([k]) => !k.includes("/")));
  return { ids, bySuffix, byBase, byAlias };
}

/** The unified reference maps (N5, graph research 2026-07-13; the suffix map since 0.4.0 item 11):
 *  THE canonical resolution semantics. twinkling's lint imports this (funes-binding.ts:21) so lint
 *  and reindex agree — EXCEPT, for now, on slash-qualified `edges:` targets: lint.ts:231 still
 *  resolves those by basename stem, looser than resolveTarget, until a twinkling ticket (blocked by
 *  RAI-127) points it at resolveTarget through the same binding. That window is 26 pages on the
 *  personal star and none on the funes star (PLAN-0.4.0 item 11). Collisions → null (never guess):
 *  alias-vs-alias collides to null, and an alias whose string exists in the basename map is shadowed
 *  (the basename map owns that string, even when itself ambiguous/null). Reading aliases costs one
 *  frontmatter parse per file — indexDir reads every file anyway in pass 2; on bounded runs pass 1
 *  becomes a full-vault read (accepted: targets may point anywhere; correctness beats the --max
 *  fast path). NOTE (grill #12, honesty): alias resolution helps LOOKUP of slash-less authored
 *  targets; it is NOT move-survival. */
export function buildReferenceMaps(vaultRoot: string, opts: WalkOpts = {}): ReferenceMaps {
  const pages: Array<{ id: string; aliases?: unknown }> = [];
  for (const f of walkMd(vaultRoot, opts)) {
    const id = relative(vaultRoot, f).replace(/\.md$/, "");
    let aliases: unknown;
    try {
      aliases = parseFrontmatter(readFileSync(f, "utf8")).data.aliases;
    } catch { /* unreadable file — its id and suffixes stand, aliases skipped */ }
    pages.push({ id, aliases });
  }
  return referenceMaps(pages);
}

/** Resolve ONE authored edge target to an id, or null when it does not resolve (the caller keeps
 *  the authored string). PLAN-0.4.0 item 11(c), RAI-127: until 0.4.0 only slash-less targets were
 *  resolved, so every zone-relative link — `[[entities/cognee]]` for the id `wiki/entities/cognee`
 *  — dangled: 726 of the funes star's 739 edges. Normalize first: trim, strip one trailing `.md`.
 *
 *  Rooted (`/x`) and relative (any `.` or `..` segment) targets are PATHS, and match as an exact id
 *  only — never suffix, basename or alias, so `[[../../secret/beta]]` can never land on an
 *  unrelated `beta`. A rooted target is matched from the vault root, never joined to the linking
 *  page's directory (`posix.join("wiki/y", "/entities/x")` is `wiki/y/entities/x`, a different
 *  page); a relative one is joined to `dirname(fromId)`. Either, normalized to something that
 *  begins with `..`, has escaped the vault root and stays authored.
 *
 *  Otherwise, in order: exact id; unique segment-aligned suffix (`X === t || X.endsWith("/" + t)`);
 *  unique basename of the target; unique alias (slash-less targets only). A stage with no hit falls
 *  to the next; a stage with a COLLISION stops and keeps the authored string — an ambiguous name is
 *  never guessed, and a null suffix or basename blocks the alias of the same string. Chosen over
 *  the stem rule (exact id, else basename) the lint and the retired OKF exporter used: the basename stage makes
 *  it a superset of that rule, same id for every target the stem rule resolved, and the 13
 *  differences on the funes star are all `sources/<x>` targets whose basename collides in another
 *  zone — which the suffix disambiguates and the stem rule left dangling. */
export function resolveTarget(target: string, fromId: string, maps: ReferenceMaps): string | null {
  const t = target.trim().replace(/\.md$/, "");
  if (t.startsWith("/") || t.split("/").some((s) => s === "." || s === "..")) {
    const p = t.startsWith("/") ? posix.normalize(t.slice(1)) : posix.join(posix.dirname(fromId), t);
    return p !== ".." && !p.startsWith("../") && maps.ids.has(p) ? p : null;
  }
  if (maps.ids.has(t)) return t;
  const base = t.slice(t.lastIndexOf("/") + 1);
  for (const key of base === t ? [t] : [t, base]) {
    if (maps.bySuffix.has(key)) return maps.bySuffix.get(key) ?? null; // unique hit, or a collision that stops
  }
  return base === t ? (maps.byAlias.get(t) ?? null) : null;
}

/** I2 pass 2 (per item, before remember): rewrite EVERY edge target that resolveTarget resolves;
 *  an unresolved target passes through as authored. Without this, twinkling's basename targets
 *  (`target: rag`) never match funes' path ids (`ai/rag`), and — until 0.4.0 item 11 — no
 *  zone-relative `[[entities/x]]` matched `wiki/entities/x`: the edge-walk recall arm was a no-op
 *  for nested pages. */
export function resolveEdgeTargets(item: MemoryItem, maps: ReferenceMaps): void {
  for (const e of item.edges ?? []) e.target = resolveTarget(e.target, item.id, maps) ?? e.target;
}

/** The ONE resolved-item walk shared by the indexer and the generation-target computation
 *  (Codex R1#4). Build the reference maps once, then yield each file's item with edge targets
 *  resolved EXACTLY as the index build resolves them (resolveTarget). Before this, publication's
 *  computeTargetGeneration resolved basenames ONLY (buildBasenameMap) while indexDir resolved
 *  basenames AND aliases — so any alias-resolved edge hashed differently in the target than in the
 *  build, and an alias-using vault failed every publish with a target/built generation mismatch.
 *  Tombstoned files are yielded too (with their meta) so the caller can count + skip them without a
 *  second walk; resolution on a to-be-skipped item is harmless. */
export function* walkResolvedItems(
  vaultRoot: string,
  dir: string,
  opts: WalkOpts = {},
): Generator<ReturnType<typeof textToItemWithMeta> & { stat: Stats; bytes: Uint8Array }> {
  const maps = buildReferenceMaps(vaultRoot, opts);
  // `stat` is ADDITIVE (RAI-124): the lstat this walk took BEFORE the read below, which a full build
  // records as the page's stat. Taken from THIS pass, not buildReferenceMaps' first one — that stat
  // predates this read by a whole vault walk. Consumers that do not record stats ignore it.
  // `bytes` (0.5.0 item 20): what was read, for the full build's OKF check — one read per page.
  for (const { path: f, rel, stat } of walkMdStats(dir, opts, vaultRoot)) {
    const bytes = readFileSync(f);
    const read = textToItemWithMeta(bytes, rel); // + parseError, 0.4.0 item 11: rides to IndexResult.unparsed
    resolveEdgeTargets(read.item, maps);
    yield { ...read, stat, bytes };
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
    /** The star's declared previous id (`meta.id_was`). RAI-157: the owner claim is a
     *  compare-and-set, and a re-identified star may claim an index stamped with its old id. */
    starIdWas?: string | null;
    /** PLAN-0.5.0 item 20: whether a FULL run counts the OKF floor's drift — false for a star whose
     *  `memory.okf` is `false`, which also clears an older count. Passed in, like `starId`. Default true. */
    okf?: boolean;
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
    starIdWas?: string | null;
    okf?: boolean;
  } = {},
): Promise<IndexResult> {
  const batchSize = opts.batch ?? 32;
  const walkOpts: WalkOpts = { exclude: opts.exclude };
  const res: IndexResult = { files: 0, indexed: 0, skipped: 0, tombstoned: 0, pruned: 0, unparsed: [] };
  let batch: MemoryItem[] = [];
  const seen: string[] = []; // non-tombstoned ids present on disk this pass (for H2 prune)
  const records: GenerationRecord[] = []; // generation-v1 (R5#1): (path, content-hash, trust) per indexed item
  // H2 dirty-epoch applies to FULL runs only (the ones that prune): mark in-progress so a crash
  // is detected on the next open. Bounded/subdir runs are incremental top-ups — no marker.
  const full = dir === vaultRoot && !opts.maxFiles;
  const okf: OkfCounts | null = full && opts.okf !== false ? { nonconformant: 0, malformed: 0 } : null;
  // RAI-157 (spike F5): the owner claim is checked BEFORE the run touches a row — full or bounded,
  // because a bounded run into another star's index writes rows too. The stamp at the end of a full
  // run is itself a compare-and-set; this is the check that makes a refusal cost nothing.
  if (opts.starId) {
    const stamped = (await (store as { getOwnerStarId?: () => Promise<string | null> }).getOwnerStarId?.()) ?? null;
    if (!mayClaimIndex(stamped, opts.starId, opts.starIdWas)) throw ownerClaimRefused(stamped!, opts.starId);
  }
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
  // (edge resolution, resolveTarget) identically to publication's target computation, so a
  // full build and its target generation can never disagree on aliased edges (Codex R1#4).
  const pageStats: PageStat[] = []; // RAI-124: EVERY walked file, tombstones included — written only by a full run
  for (const { item, meta, stat, parseError, bytes } of walkResolvedItems(vaultRoot, dir, walkOpts)) { // root = vaultRoot: excludes are vault-relative even on subdir runs
    res.files++;
    if (okf) countOkf(okf, item.path!, bytes);
    pageStats.push({ id: item.id, version: lstatVersion(stat) });
    // 0.5.0 item 20 (ADR-0012): a malformed page is skipped fail-closed — its trust and tombstone are
    // unknowable — after its stat is recorded. A full run prunes a row it left; a bounded run removes it.
    if (parseError !== undefined) { res.unparsed.push(item.id); continue; }
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
  if (!full && res.unparsed.length) await store.remove(res.unparsed);
  // The reserved half of the check (ADR-0012): `index.md`/`log.md` are checked, never indexed. A
  // folder walk — the port's `list` never yields them.
  if (okf) for (const { path, rel } of walkFolder(vaultRoot, vaultRoot, isReservedFile, opts.exclude)) countOkf(okf, rel, readFileSync(path));
  // H2/D7: a FULL, unbounded reindex of the whole vault is authoritative — prune index rows whose
  // file is gone or tombstoned. Skipped for a bounded run or a subdir reindex (would nuke the rest).
  if (full) {
    res.pruned = await store.prune(seen);
    // Identity, on the same full-run gate: a bounded or subdir run has not built the whole index
    // and must not claim it. Absent `starId` leaves any prior stamp alone rather than clearing it —
    // an unmanifested vault (no star.yaml id) must not silently un-stamp an index that has one.
    if (opts.starId) await (store as { setOwnerStarId?: (id: string, o?: { was?: string | null }) => Promise<void> }).setOwnerStarId?.(opts.starId, { was: opts.starIdWas });
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
        // RAI-124: a tombstone is walked and recorded — it sits on disk with no row, and without a
        // stat of its own it would read as a page the build never saw. No memo to clear after this:
        // vaultChangedSince keys on the stamp this commit advances.
        pageStats,
        okf,
      });
    }
  }
  return res;
}
