import { readFileSync } from "node:fs";
import { basename, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type { MemoryEdge, MemoryItem, MemoryMeta } from "funes-core";
import { normalizeRelationType } from "funes-core";
import type { FreshnessFields } from "./store.ts";
import { trustDefaultOfFile } from "funes-shared";

const FENCE = "---";

// PLAN-0.4.0 item 11(a), RAI-134: the two Obsidian conventions that are not YAML. 41 of the funes
// star's 134 pages carried one or both, and each failed the WHOLE frontmatter parse — no type, no
// title, no tags, and `related:` edges harvested only because the failed parse dumped the
// frontmatter into the body, where the body scan saw it:
//   `tags: [#a, #b]`     — `#` opens a YAML comment, so the flow sequence never closes;
//   `key: [[a]], [[b]]`  — a flow sequence followed by `, [[b]]` is a syntax error.
// Rule 1 drops the `#` from each item; rule 2 quotes each link into a list of strings, so the
// generic frontmatter edge source below sees `"[[a]]"` where the body scan saw `[[a]]`. Any key —
// `compared_items:` carries 20 links on one line. Rule 2 takes ONE link too (`supersedes: [[x]]`):
// alone that line is valid YAML, a nested list `[["x"]]` with no `[[` left in it, and on a page the
// retry is already rewriting it would lose the edge today's failed parse gives it.
const LINK_LIST = /^(\s*[^\s#:][^:]*:\s+)((?:\[\[[^\]\n]+\]\]\s*,\s*)*\[\[[^\]\n]+\]\])\s*$/;
const HASH_LIST = /^(\s*[^\s#:][^:]*:\s+)\[([^[\]]*#[^[\]]*)\]\s*$/;
function obsidianYamlLine(line: string): string {
  const links = LINK_LIST.exec(line);
  if (links) return `${links[1]}[${links[2]!.match(/\[\[[^\]\n]+\]\]/g)!.map((l) => JSON.stringify(l)).join(", ")}]`;
  const tags = HASH_LIST.exec(line);
  if (tags) return `${tags[1]}[${tags[2]!.split(",").map((s) => s.replace(/^(\s*)#/, "$1")).join(",")}]`;
  return line;
}

// A `key: |` / `key: >-` / `- |` header opens a block scalar: every following line that is blank or
// indented deeper than the header is the scalar's TEXT, never YAML, so the rules must not touch it —
// `Related: [[a]], [[b]]` inside a `description: |` is prose. (A multi-line quoted scalar has the same
// exposure; no page has needed it yet.)
const BLOCK_SCALAR = /(?:^\s*-|:)\s+[|>][-+1-9]*\s*(?:#.*)?$/;

/** The two rules over a frontmatter's lines, block-scalar text passed through. Exported because
 *  scripts/fix-frontmatter.ts must apply exactly what the retry applies, not a copy (item 12). */
export function obsidianYaml(fm: string[]): string[] {
  let block = -1; // the indent of the block scalar's header while inside its text, else -1
  return fm.map((line) => {
    const indent = line.search(/\S/);
    if (block >= 0 && (indent === -1 || indent > block)) return line;
    block = BLOCK_SCALAR.test(line) ? indent : -1;
    return obsidianYamlLine(line);
  });
}

/** Split markdown into frontmatter + body, and say when the frontmatter could not be read.
 *
 *  A strict YAML parse first; when it throws, ONE retry over the same lines with obsidianYaml
 *  applied — so a page the strict parse reads is never rewritten (`related: [[a]]` alone keeps the
 *  meaning YAML gives it). A page the retry recovers is an ordinary page: no `error`, and `data`/
 *  `body` deep-equal to the same page with its YAML fixed by those rules (markdown.test.ts).
 *
 *  `error` marks exactly three degrades, each of which still yields `{ data: {}, body: <the whole
 *  text> }` as before — silently, until 0.4.0: the strict AND the tolerant parse both fail; the fence
 *  opens and never closes; the YAML is not a map. The caller decides what an error costs (reindex
 *  counts it, doctor names it, patchFrontmatter refuses). `strict` skips the retry — for
 *  scripts/fix-frontmatter.ts, which fixes exactly the pages the retry is needed for. */
export function parseFrontmatter(raw: string, opts: { strict?: boolean } = {}): { data: Record<string, unknown>; body: string; error?: string } {
  // CRLF files fell straight through this function: '---\r\n' fails the fence test, so EVERY key
  // was dropped — trust, superseded_by, forgotten, volatile. A tombstoned note written on Windows
  // (or edited by a tool that normalizes line endings) silently kept answering recall, which is a
  // correctness failure disguised as a parsing nicety. Normalize first, and strip a BOM while here.
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith(FENCE + "\n") && text.trimEnd() !== FENCE) return { data: {}, body: text };
  const lines = text.split("\n");
  const end = lines.indexOf(FENCE, 1);
  if (end === -1) return { data: {}, body: text, error: "the frontmatter fence opens and never closes" };
  const fm = lines.slice(1, end);
  let data: unknown;
  try {
    data = parseYaml(fm.join("\n"));
  } catch (strict) {
    try {
      if (opts.strict) throw strict;
      data = parseYaml(obsidianYaml(fm).join("\n"));
    } catch {
      return { data: {}, body: text, error: (strict as Error).message.split("\n")[0]!.replace(/:$/, "") };
    }
  }
  data ??= {};
  if (typeof data !== "object" || Array.isArray(data)) return { data: {}, body: text, error: "the frontmatter is not a YAML map" };
  return { data: data as Record<string, unknown>, body: lines.slice(end + 1).join("\n") };
}

function toEdges(raw: unknown): MemoryEdge[] {
  if (!Array.isArray(raw)) return [];
  const out: MemoryEdge[] = [];
  for (const e of raw) {
    if (e && typeof e === "object" && "target" in e && (e as any).target) {
      out.push({
        type: String((e as any).type ?? "related_to"),
        target: String((e as any).target),
        weight: typeof (e as any).weight === "number" ? (e as any).weight : undefined,
      });
    }
  }
  return out;
}

// A page's real structure is its WIKILINKS, not just explicit `edges:` frontmatter — so the typed
// knowledge graph (recall edge-walk, neighbors, the graph-viz bake) is materialized from them too:
//   frontmatter `sources:` ([[id]] strings AND OKF {resource} objects, in list order) -> cites
//   frontmatter `people:`  ([[id]] mentions)   -> mentions
//   frontmatter OKF `resource:` (local page)   -> derived-from
//   any other frontmatter string `[[id]]`      -> related-to  (0.4.0 item 11(b))
//   body `[[id]]` / `[[id|alias]]` / `[[id#h]]` -> related-to  (code stripped, item 11)
//   body `mem:name` (serena)                   -> references  (fenced code stripped)
// in that order — edge ORDER is inside hashItem, so it is part of the contract, not a detail.
// Targets are authored strings; reindex's resolveTarget() qualifies them to ids, and unmatched
// (dangling) targets are harmlessly skipped downstream.
const WIKILINK = /\[\[([^\]|#\n]+?)(?:[#|][^\]\n]*)?\]\]/g;

// serena writes its project memories as plain markdown and cross-references them as `mem:NAME`
// (its own convention, docs 02-usage/045_memories) — neither a wikilink nor a markdown link, so
// until now a memory graph that already existed on disk contributed zero edges. Topic paths use
// `/`; the producer emits the last segment, which is what the resolver of its day could qualify
// (basenames only). fm-wikilinks/3's resolveTarget would take the full path by suffix, but the
// producer is unchanged: moving it would move every serena page's edges outside what item 11
// measured. Ambiguity stays safe: a contested basename maps to null and the edge is left dangling
// rather than pointed at the wrong page.
const MEMREF = /(?:^|[\s`("[])mem:([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)/g;

// PLAN-0.4.0 item 11: code is not a link. Fenced blocks (``` or ~~~, up to three spaces of indent,
// through the closing fence of the same run or to the end of the text, as CommonMark closes an
// unclosed one; a backtick opener carries no backtick in its info string, or it is inline code) and
// inline spans, which may wrap a line but never cross a blank one (a span lives in one paragraph).
// On the funes star the strip drops about 40 edges on 11 pages — wrangler TOML `[[kv_namespaces]]`,
// placeholders, and the syntax examples in SCHEMA.md. The `mem:` scan strips FENCED blocks only:
// serena writes `mem:x` inside backticks by convention (out_serena/memory_maintenance.md), so
// inline code there IS the link.
const FENCED_CODE = /^ {0,3}(`{3,}(?=[^`\n]*$)|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm;
const INLINE_CODE = /(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/g;

/** Frontmatter keys another producer above owns, skipped by the generic `related-to` scan. */
const FM_PRODUCERS = new Set(["sources", "people", "resource", "edges"]);

/** A path-valued OKF field (`resource`, `sources[].resource`) that names a concept IN the bundle —
 *  not an external URL and not a scope descriptor. OKF v0.2 §6.2 allows an absolute URL, a
 *  bundle-relative path (leading `/`), or a relative path; only the last two can be a funes id. */
function okfConceptTarget(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || /^[a-z][a-z0-9+.-]*:/i.test(s)) return null; // scheme ⇒ external (http:, mailto:, …)
  if (!s.endsWith(".md")) return null;                   // a data pointer, not a concept document
  return s.replace(/^\/+/, "").replace(/^\.\//, "");
}

function wikilinkEdges(data: Record<string, unknown>, body: string): MemoryEdge[] {
  const out: MemoryEdge[] = [];
  const seen = new Set<string>();
  const push = (rawTarget: string, type: string) => {
    const t = rawTarget.trim().replace(/\.md$/, "");
    if (!t) return;
    const key = `${type}\x00${t}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ type, target: t });
  };
  const fmLinks = (v: unknown, type: string) => {
    if (!Array.isArray(v)) return;
    for (const x of v) {
      // Two shapes live in `sources:` — funes' own "[[id]]" strings, and OKF v0.2's list of
      // {id, resource, …} objects (§5.1). String(x) on an object is "[object Object]", so the
      // OKF form matched nothing and was silently dropped before this branch existed.
      if (x != null && typeof x === "object") {
        const t = okfConceptTarget((x as Record<string, unknown>).resource);
        if (t) push(t, type);
        continue;
      }
      const m = String(x).match(/\[\[([^\]|#]+)/);
      if (m) push(m[1]!, type);
    }
  };
  fmLinks(data.sources, "cites");
  fmLinks(data.people, "mentions");
  // OKF v0.2 §5.1: "When a `resource` points at another OKF concept, the derivation edge already
  // exists in the bundle graph." An external URI stays metadata-only (MemoryItem.resource) — there
  // is no node to point at. NOT harvested: per-claim footnote attribution ([^label] -> sources[].id).
  // It resolves to the SAME source the `sources` entry above already emits `cites` for, and funes'
  // graph is page-granular, so it would only duplicate an edge that exists.
  { const t = okfConceptTarget(data.resource); if (t) push(t, "derived-from"); }
  // NOTE: `superseded_by:` is NOT materialized as an edge — a superseded page is TOMBSTONED
  // (isTombstoned in funes-core: superseded ⇒ excluded from the index), so its edges never reach the
  // store. "Supersede, don't delete" is enforced by tombstone-skip (reindex.ts), not a graph edge.
  //
  // 0.4.0 item 11(b): every other frontmatter string, recursively, is a wikilink source — not
  // `related:` alone. The pages whose YAML failed carried links in `related_concepts`,
  // `compared_items`, `supersedes`, `status`, `self_host` and three more keys, all harvested until
  // now only because the failed parse put them in the body; a one-key harvester would delete those
  // edges the day the parse succeeds. Global match: a quoted `related: "[[a]] [[b]]"` holds two.
  // `visited`: a YAML alias can point at its own parent (`meta: &m` / `self: *m`), and one such page
  // must not throw out of a whole-vault reindex. A shared node seen twice adds nothing — push dedupes.
  const visited = new Set<object>();
  const fmStrings = (v: unknown): void => {
    if (typeof v === "string") { for (const m of v.matchAll(WIKILINK)) push(m[1]!, "related-to"); return; }
    if (v == null || typeof v !== "object" || visited.has(v)) return;
    visited.add(v);
    (Array.isArray(v) ? v : Object.values(v)).forEach(fmStrings);
  };
  for (const [k, v] of Object.entries(data)) if (!FM_PRODUCERS.has(k)) fmStrings(v);
  const unfenced = body.replace(FENCED_CODE, "");
  for (const m of unfenced.replace(INLINE_CODE, " ").matchAll(WIKILINK)) push(m[1]!, "related-to");
  for (const m of unfenced.matchAll(MEMREF)) push(m[1]!.split("/").pop()!, "references"); // last segment, see MEMREF
  return out;
}

/** Explicit `edges:` first, then wikilink-derived edges that don't duplicate an explicit
 *  (type,target). Dedupe keys compare through normalizeRelationType (N4, 2026-07-13) so an
 *  explicit `related_to` suppresses a derived `related-to` to the same target — AND the explicit
 *  list itself is deduplicated (N3: duplicate explicit edges used to reach storage; the stores
 *  now also carry a unique index as the last line of defense). Stored `type` strings stay as
 *  authored — normalization is comparison-only, never a storage rewrite. */
function allEdges(data: Record<string, unknown>, body: string): MemoryEdge[] | undefined {
  const key = (e: MemoryEdge) => `${normalizeRelationType(e.type)}\x00${e.target}`;
  const have = new Set<string>();
  const merged: MemoryEdge[] = [];
  for (const e of [...toEdges(data.edges), ...wikilinkEdges(data, body)]) {
    const k = key(e);
    if (have.has(k)) continue; // explicit-first order makes explicit win over derived duplicates
    have.add(k);
    merged.push(e);
  }
  return merged.length ? merged : undefined;
}

/** Extract lifecycle/provenance meta from parsed frontmatter (drives tombstone skipping). */
export function metaFromData(data: Record<string, unknown>): MemoryMeta {
  const m: MemoryMeta = {};
  if (data.created != null) m.created = String(data.created);
  if (data.updated != null) m.updated = String(data.updated);
  if (Array.isArray(data.sources)) m.sources = data.sources.map(String);
  if (Array.isArray(data.tags)) m.tags = data.tags.map(String);
  if (data.trust != null) m.trust = String(data.trust) as MemoryMeta["trust"];
  if (data.superseded_by != null) m.superseded_by = String(data.superseded_by);
  if (data.valid_until != null) m.valid_until = String(data.valid_until);
  if (data.forgotten === true) m.forgotten = true;
  return m;
}

/** Map a markdown file to a MemoryItem + its lifecycle meta. id = vault-relative path w/o `.md`.
 *  NUL bytes are stripped at this boundary: Postgres `text` can never store \u0000 (PGLite
 *  rejects with "invalid byte sequence for encoding UTF8"), and real vaults contain binary-ish
 *  imports (e.g. PDF-extraction artifacts) — one such file must not abort a whole-vault reindex.
 *  (Agent-written `remember` input gets the same treatment from the S3 sanitizer.)
 *
 *  `parseError` (0.4.0 item 11) is the frontmatter parse error, when there is one — a THIRD field,
 *  engine-local, and never a key on `meta`: MemoryMeta is funes-core's portable contract, and "this
 *  file's YAML did not parse" is a fact about one engine's read of one file. walkResolvedItems
 *  carries it to IndexResult.unparsed. */
export function fileToItemWithMeta(absPath: string, vaultRoot: string): { item: MemoryItem; meta: MemoryMeta; parseError?: string } {
  const { data, body, error: parseError } = parseFrontmatter(readFileSync(absPath, "utf8").replace(/\u0000/g, ""));
  const rel = relative(vaultRoot, absPath);
  const meta = metaFromData(data);
  const item: MemoryItem & FreshnessFields = {
    id: rel.replace(/\.md$/, ""),
    path: rel,
    title: String(data.title ?? basename(absPath).replace(/\.md$/, "")),
    type: data.type != null ? String(data.type) : undefined,
    body,
    edges: allEdges(data, body),
    // H4 zone default, widened by PLAN-0.2.1 step 5: explicit frontmatter trust wins; else the
    // grammar in funes-shared decides — INCOMING (in_*, raw/) and GENERATED (`out_*` at any
    // depth) default untrusted, everything else trusted. Frontmatter is canonical; the index
    // column is derived from it on every reindex.
    trust: meta.trust ?? trustDefaultOfFile(rel),
    // Rev 7 freshness (a): volatile/freshness ride the item like trust (metadata-only, synced
    // even on hash-skipped rows). `as_of:` (validity time) beats `updated:` (edit time).
    volatile: data.volatile === true,
    freshness: data.as_of != null ? String(data.as_of) : meta.updated ?? null,
    // OKF-aligned enrichment (2026-07): a short queryable description + the URI of the described
    // asset, indexed into the store and surfaced in recall. Metadata-only, like trust/volatile.
    description: data.description != null ? String(data.description) : undefined,
    resource: data.resource != null ? String(data.resource) : undefined,
    // Provenance schema-v1 (2026-07-22): DECLARED origin + authoring time. `source:` (singular string)
    // is the origin claim — distinct from `sources:` (plural [[id]] array → cites edges). NOTHING here
    // maps to `write_actor` — the stamped actor is never frontmatter-declared (self-assertion guard).
    source: data.source != null ? String(data.source) : undefined,
    authored: data.authored != null ? String(data.authored) : undefined,
  };
  return { item, meta, parseError };
}

/** Map a markdown file to a MemoryItem (PLAN §3a). */
export function fileToItem(absPath: string, vaultRoot: string): MemoryItem {
  return fileToItemWithMeta(absPath, vaultRoot).item;
}
