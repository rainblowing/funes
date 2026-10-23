import { readFileSync, type Stats } from "node:fs";
import { basename, relative } from "node:path";
import type { Embedder, FunesIndexStore } from "funes-core";
import type { BuildResult, OkfCounts, ScopeSignature } from "funes-core/internal";
import { countOkf, corpusOf, isPagePath, textToItemWithMeta } from "funes-core/internal";
import { parseFrontmatter } from "funes-core";
import { fileToItemWithMeta } from "./markdown.ts";
import { readIndexScopeExcludes } from "./scope.ts";
import { openStore, readStarIdentity, rebuildFresh } from "./factory.ts";
import { E5Embedder } from "./embedder.ts";
import { FolderVault, walkFolder } from "./folder-vault.ts";
import { indexedFileExclude, referenceMaps, resolveEdgeTargets } from "funes-core/internal";
import { type ReferenceMaps } from "funes-core";

/** Walk options (vault-v2 brief, T1): `exclude` is an index-scope predicate over root-relative
 *  paths — called with `<relDir>/` (trailing slash) before descending into a directory (a true
 *  return prunes the subtree) and with `<relFile>` for each candidate file. Symlinks (files AND
 *  directories) are never followed: symlinked asset trees are structurally invisible to the
 *  index, not configuration-dependent. */
export interface WalkOpts {
  exclude?: (rel: string) => boolean;
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

/** What one full build reports (funes-core's BuildResult; the Library's name for it). */
export type IndexResult = BuildResult;

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
export function referenceMapsOf(vaultRoot: string, opts: WalkOpts = {}): ReferenceMaps {
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

/** The Library's reference maps (RAI-315 Q6): the pages the walk sees — the star's own
 *  `index_scope.exclude` applied as reindex applies it — so lint and reindex resolve one set. An
 *  invalid star.yaml refuses, as reindex refuses. */
export async function buildReferenceMaps(root: string): Promise<ReferenceMaps> {
  return referenceMapsOf(root, { exclude: corpusOf(readIndexScopeExcludes(root)).exclude });
}

/** The ONE resolved-item walk shared by the indexer and the generation-target computation
 *  (Codex R1#4). Build the reference maps once, then yield each file's item with edge targets
 *  resolved EXACTLY as the index build resolves them (resolveTarget). Before this, publication's
 *  computeTargetGeneration resolved basenames ONLY while indexDir resolved
 *  basenames AND aliases — so any alias-resolved edge hashed differently in the target than in the
 *  build, and an alias-using vault failed every publish with a target/built generation mismatch.
 *  Tombstoned files are yielded too (with their meta) so the caller can count + skip them without a
 *  second walk; resolution on a to-be-skipped item is harmless. */
export function* walkResolvedItems(
  vaultRoot: string,
  dir: string,
  opts: WalkOpts = {},
): Generator<ReturnType<typeof textToItemWithMeta> & { stat: Stats; bytes: Uint8Array }> {
  const maps = referenceMapsOf(vaultRoot, opts);
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

export interface ReindexOpts {
  /** Defaults to E5. The signature the build stamps is this embedder's. */
  embedder?: Embedder;
  /** Rebuild the live index in place (RAI-307): a changed model or schema needs it. */
  fresh?: boolean;
  /** Called per batch with the running counts. */
  onProgress?: (r: IndexResult) => void;
}

/** THE contract walk (RAI-314, RAI-315 Q5): build or refresh `vault`'s live index. It opens its own
 *  builder store at `funesDbDir(vault)`, holds the star's write lock for the run (RAI-309), walks the
 *  star's own scope once, stamps scope, owner and generation, and closes the store. An interrupted
 *  build resumes at its cursor. An invalid star.yaml scope refuses, and so does a lost one: no
 *  star.yaml over an index built under a declared scope (RAI-318; `fresh` rebuilds without it). */
export async function reindex(vault: string, opts: ReindexOpts = {}): Promise<IndexResult> {
  const scope = readIndexScopeExcludes(vault);
  const { exclude, scopeSignature } = corpusOf(scope);
  const identity = readStarIdentity(vault);
  const embedder = opts.embedder ?? new E5Embedder();
  const walk = (store: FunesIndexStore) => indexDir(store, vault, {
    exclude,
    scopeSignature,
    // …and the star's identity on the same gate, so the LIVE index carries `owner_star_id` too.
    starId: identity.id ?? undefined,
    starIdWas: identity.idWas,
    okf: identity.capabilities.okf !== false, // item 20: `memory.okf: false` counts nothing
    onProgress: opts.onProgress,
  });
  if (opts.fresh) return rebuildFresh({ vault, embedder }, walk);
  // reindex is the repair path: it opens a dirty index (H2). A mismatched one names `reindex --fresh`.
  const store = await openStore({ vault, allowDirty: true, embedder });
  try {
    // RAI-318 Q1c: an absent star.yaml over an index built under a declared scope is a lost scope (a
    // rename, a TCC denial), never a configless star: the walk would re-admit every excluded file.
    if (scope.kind === "absent" && (await store.getScopeSignature()) != null) {
      throw new Error("reindex: the scope declared at the last build is gone; restore star.yaml, or run `funes reindex --fresh` to rebuild without it");
    }
    return await walk(store);
  } finally { await store.close(); }
}

/** The folder host of the one build walk (funes-core sql-index.ts): the vault as a FolderVault, the
 *  reserved files' OKF counts (the port never lists `index.md`, `log.md`), the owner claim. */
export function indexDir(
  store: FunesIndexStore,
  vault: string,
  opts: {
    batch?: number;
    onProgress?: (r: IndexResult) => void;
    /** Index-scope predicate (star.yaml memory.index_scope): excluded paths are invisible to the
     *  build, and the finalize prunes rows under a newly excluded path — exclusion is reversible. */
    exclude?: (rel: string) => boolean;
    /** The index_scope signature to stamp at finalize: `null` CLEARS it (a configless rebuild must
     *  not re-bless re-admitted files), `undefined` leaves the prior one. */
    scopeSignature?: ScopeSignature | null;
    /** The owning star's identity (`star.yaml meta.id`), claimed by compare-and-set (RAI-157); PASSED
     *  IN, never read from star.yaml here. `starIdWas` is its declared previous id. */
    starId?: string;
    starIdWas?: string | null;
    /** PLAN-0.5.0 item 20: count the OKF floor's drift (false for `memory.okf: false`). Default true. */
    okf?: boolean;
  } = {},
): Promise<IndexResult> {
  return store.build({
    vault: new FolderVault(vault),
    exclude: opts.exclude,
    scope: opts.scopeSignature,
    owner: opts.starId ? { id: opts.starId, was: opts.starIdWas } : undefined,
    okf: opts.okf !== false,
    // The reserved half of the check (ADR-0012): `index.md`/`log.md` are checked, never indexed.
    reserved: async () => {
      const okf: OkfCounts = { nonconformant: 0, malformed: 0 };
      for (const { path, rel } of walkFolder(vault, vault, isReservedFile, opts.exclude)) countOkf(okf, rel, readFileSync(path));
      return okf;
    },
    batch: opts.batch,
    onBatch: opts.onProgress,
  });
}
