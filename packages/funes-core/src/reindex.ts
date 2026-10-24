// The walk's portable half (RAI-313): freshness by stat parity over the Vault port, and the reference
// maps every edge target resolves against. The folder walk and the index build stay in the engine
// (funes-engine reindex.ts) until RAI-314's one walk.
import type { MemoryItem, PageStatRecord } from "./types.ts";
import { isPagePath, type Vault } from "./vault.ts";
import { anyExclude, buildScopeExclude, configlessExclude, type ScopeExcludesResult } from "./scope.ts";
import { sha256Hex } from "./funes-store.ts";

/** The corpus predicate a reindex actually applies, resolved from the vault's own manifest — so a
 *  staleness check walks the SAME files the index covers. Without it, an edit to an
 *  index_scope-excluded path (or any `.md` under `node_modules/` in a configless vault, which the
 *  quickstart invites by pointing funes at a code repo) reports the index stale forever, and a
 *  warning that cries wolf is one a reader learns to skip. An invalid manifest falls back to the
 *  configless defaults instead of refusing the way reindex does: this answers an advisory question,
 *  and it must never be the reason recall or health fails. */
export function indexedFileExclude(scope: ScopeExcludesResult): ((rel: string) => boolean) | undefined {
  return anyExclude(
    buildScopeExclude(scope.kind === "valid" ? scope.excludes : []),
    scope.kind === "valid" ? undefined : configlessExclude(),
  );
}

/** What a freshness answer stands on (PLAN-0.4.0 item 6, ADR-0007). `stat`: the vault was walked
 *  and compared against the index's own stat record, so `changed` is a real true/false. `none`: there
 *  is no record to compare against — never reindexed, an index built before the record existed, or
 *  a record some other build wrote. `unreadable`: the vault or the index could not be read. The last
 *  two both answer `changed: null`, and a reader needs to tell them apart: "rebuild to enable
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
 *  An absent row is a page the build never walked and no funes write recorded (an edit from outside); a
 *  recorded row nothing on disk matches is a deletion — or a narrowed index_scope, whose rows are
 *  still served and out of policy, which is a change worth naming too.
 *
 *  The content check behind the stat check (RAI-318, ADR-0007 as amended): on a version mismatch, a
 *  row with a hash reads that one file and compares the sha256 of its bytes; equal bytes are fresh. A
 *  sync client that adds xattrs after a write (Dropbox, 2 s to 298 s later) moves `ctime` and nothing
 *  else. Only mismatched files are read; a row with no hash keeps the stat rule.
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
  const recorded = new Map(record.rows.filter((r) => isPagePath(`${r.id}.md`)).map((r) => [`${r.id}.md`, r]));
  let matched = 0;
  try {
    for await (const { path, version } of vault.list({ exclude })) {
      // ADR-0015: a version is opaque and compared for equality; at a folder both sides are lstatVersion
      const r = recorded.get(path);
      if (r?.version !== version) {
        const bytes = r?.hash == null ? null : (await vault.read(path))?.bytes;
        if (bytes == null || sha256Hex(bytes) !== r!.hash) return { changed: true, basis: "stat" };
      }
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
  const root = (vault as { root?: unknown }).root;
  const key: unknown = typeof root === "string" ? root : vault;
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

/** `node:path`'s posix.normalize for a "/"-separated relative path, which is all an id is (RAI-313:
 *  the kernel imports no node:path): `.` and empty segments drop, `..` pops one, a leading `..` stays. */
function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else out.push(seg);
  }
  return out.join("/") || ".";
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
    const dir = fromId.includes("/") ? fromId.slice(0, fromId.lastIndexOf("/")) : ".";
    const p = normalizePath(t.startsWith("/") ? t.slice(1) : `${dir}/${t}`);
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
