import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import type { MemoryEdge, MemoryItem, MemoryMeta } from "./types.ts";
import { normalizeRelationType } from "./relations.ts";
import type { FreshnessFields } from "./index-store.ts";
import { trustDefaultOfFile } from "./vault.ts";

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
 *  the one-shot scripts/fix-frontmatter.ts (deleted in 0.6.0) had to apply exactly what the retry applies, not a copy (item 12). */
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
 *  meaning YAML gives it). A page the retry recovers is an ordinary page: no `malformed`, and `data`/
 *  `body` deep-equal to the same page with its YAML fixed by those rules (markdown.test.ts).
 *
 *  `malformed` (0.4.0 item 11 named it `error`; 0.5.0 item 18, ADR-0012) marks exactly four degrades,
 *  each of which still yields `{ data: {}, body: <the whole text> }`: the strict AND the tolerant
 *  parse both fail; the fence opens and never closes; the YAML is not a map; the bytes are not UTF-8
 *  (only bytes can say so — a string is already decoded). The caller decides what it costs (reindex
 *  counts it, doctor names it, patchFrontmatter and the normalizer refuse). `strict` skips the
 *  retry — for the one-shot scripts/fix-frontmatter.ts (deleted in 0.6.0), which fixed exactly the pages the retry is needed for. */
export function parseFrontmatter(raw: string | Uint8Array, opts: { strict?: boolean } = {}): { data: Record<string, unknown>; body: string; malformed?: string } {
  if (typeof raw !== "string") {
    const bytes = raw;
    try {
      raw = UTF8.decode(bytes);
    } catch {
      return { data: {}, body: new TextDecoder().decode(bytes), malformed: "the page is not UTF-8" };
    }
  }
  // CRLF files fell straight through this function: '---\r\n' fails the fence test, so EVERY key
  // was dropped — trust, superseded_by, forgotten, volatile. A tombstoned note written on Windows
  // (or edited by a tool that normalizes line endings) silently kept answering recall, which is a
  // correctness failure disguised as a parsing nicety. Normalize first, and strip a BOM while here.
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith(FENCE + "\n") && text.trimEnd() !== FENCE) return { data: {}, body: text };
  const lines = text.split("\n");
  const end = lines.indexOf(FENCE, 1);
  if (end === -1) return { data: {}, body: text, malformed: "the frontmatter fence opens and never closes" };
  const fm = lines.slice(1, end);
  let data: unknown;
  try {
    data = parseYaml(fm.join("\n"));
  } catch (strict) {
    try {
      if (opts.strict) throw strict;
      data = parseYaml(obsidianYaml(fm).join("\n"));
    } catch {
      return { data: {}, body: text, malformed: (strict as Error).message.split("\n")[0]!.replace(/:$/, "") };
    }
  }
  data ??= {};
  if (typeof data !== "object" || Array.isArray(data)) return { data: {}, body: text, malformed: "the frontmatter is not a YAML map" };
  return { data: data as Record<string, unknown>, body: lines.slice(end + 1).join("\n") };
}
/** Fatal on bad bytes; `ignoreBOM` hands the BOM through, so the parser strips it and the normalizer keeps it. */
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The one pin of the OKF text the floor is (ADR-0012 "The pin"): OKF 0.2 at open-knowledge-format
 *  commit `ad30107c`, the amended text OKF issue #24 distinguishes. star.yaml keeps `memory.okf: "0.2"`,
 *  because twinkl.ing validates that key against "0.1" | "0.2" | false; the commit lives only here. */
export const OKF_PIN = { version: "0.2", commit: "ad30107c" } as const;

/** What a star's `memory.okf` asks of the floor: null for `false` (no normalization, no counters),
 *  else the pin — with a mismatch line for "0.1", which is normalized to the pinned text anyway. */
export function okfFloor(declared: "0.1" | "0.2" | false): { pin: typeof OKF_PIN; mismatch?: string } | null {
  if (declared === false) return null;
  if (declared === OKF_PIN.version) return { pin: OKF_PIN };
  return { pin: OKF_PIN, mismatch: `star.yaml memory.okf ${JSON.stringify(declared)}: normalized to the pinned OKF ${OKF_PIN.version} at ${OKF_PIN.commit}` };
}

/** The OKF floor's normalizer (PLAN-0.5.0 item 18; ADR-0012 §The decision; record 20). The edit it
 *  made, for the dry run's report (item 21), or why it refused: the write answers `invalid` with it. */
export type OkfEdit = "none" | "prepend" | "insert-type" | "fill-type" | "rename-type";
export type OkfRefusal = "malformed" | "reserved-concept" | "reserved-shape" | "unsafe-edit";
export type Normalized = { text: string; edit: OkfEdit } | { invalid: OkfRefusal; reason: string };

const TYPE_KEY = /^type[ \t]*:(?=[ \t]|$)/;
const LOG_DAY = /^## (\d{4}-\d{2}-\d{2})[ \t]*$/;

/** A reserved file (§8 `index.md`, §9 `log.md`) is checked, never normalized (ADR-0012 "Reserved
 *  files"): null when it is in shape, else the refusal. A non-empty `type` makes it a concept, which
 *  §3.1 keeps off a reserved name. Otherwise it carries no frontmatter (a bundle-root `index.md` may
 *  carry only `okf_version`, §12); an index has a heading-sectioned body — read by shape, not as
 *  "lists every entry"; a log has `## YYYY-MM-DD` sections, newest first, and only those at level 2. */
function reservedShape(name: "index.md" | "log.md", atRoot: boolean, hasFm: boolean, page: { data: Record<string, unknown>; body: string }): [OkfRefusal, string] | null {
  const t = page.data.type;
  if (t != null && !(typeof t === "string" && t.trim() === "")) return ["reserved-concept", `a concept (type ${JSON.stringify(t)}) at the reserved name ${name}`];
  const rootIndex = name === "index.md" && atRoot && Object.keys(page.data).every((k) => k === "okf_version");
  if (hasFm && !rootIndex) return ["reserved-shape", `${name} carries no frontmatter${name === "index.md" ? " (a bundle-root index.md only okf_version)" : ""}`];
  const lines = page.body.split("\n");
  if (name === "index.md") return lines.some((l) => /^#{1,6}[ \t]/.test(l)) ? null : ["reserved-shape", "index.md has no heading"];
  const days = lines.filter((l) => l.startsWith("## ")).map((l) => LOG_DAY.exec(l)?.[1]);
  if (days.length === 0 || days.includes(undefined)) return ["reserved-shape", "log.md sections are `## YYYY-MM-DD` headings"];
  return days.every((d, i) => i === 0 || d! <= days[i - 1]!) ? null : ["reserved-shape", "log.md sections run newest first"];
}

/** `type: <v>` as a line YAML reads back as the string `v`: plain when it round-trips, else JSON-quoted. */
function typeLine(v: string): string {
  try {
    if ((parseYaml(`type: ${v}`) as { type?: unknown } | null)?.type === v) return `type: ${v}`;
  } catch { /* quote it */ }
  return `type: ${JSON.stringify(v)}`;
}

/** Bring one page to OKF 0.2 §11 (`OKF_PIN`) by editing lines, never by re-serializing YAML: yaml 2.9's
 *  `Document.toString()` rewrote 65 of 72 unchanged funes-star frontmatters (record 20). Exactly one
 *  edit — prepend `---`/`type: <t>`/`---` to a page with no frontmatter; insert `type` as the first
 *  frontmatter line, or fill an empty one in place; or rename a non-string `type` key to `funes_type`
 *  and insert `type`. `<t>` is `baseType` (a put_page replace keeps its base's) or `note`. No other
 *  key is touched, every line it does not edit keeps its bytes, the BOM and line endings stay, and
 *  normalize(normalize(p)) === normalize(p). It checks itself: the output must re-parse to the input's
 *  data plus the `type` change and the same body, or the edit is refused as unsafe.
 *
 *  Pure: `path` (vault-relative) only names the file; which files are in the OKF scope is the caller's
 *  (ADR-0012: the index scope minus the incoming zone). */
export function normalizePage(page: string | Uint8Array, opts: { path: string; baseType?: string }): Normalized {
  const before = parseFrontmatter(page);
  if (before.malformed !== undefined) return { invalid: "malformed", reason: before.malformed };
  const raw = typeof page === "string" ? page : UTF8.decode(page); // parseFrontmatter proved it decodes
  const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = raw.slice(bom.length);
  const eol = /\r?\n/.exec(text)?.[0] ?? "\n"; // the inserted lines take the file's first line ending
  const want = opts.baseType?.trim() ? opts.baseType : "note";
  const hasFm = text.replace(/\r\n/g, "\n").startsWith(FENCE + "\n");
  const name = opts.path.split("/").pop();
  if (name === "index.md" || name === "log.md") {
    const shape = reservedShape(name, opts.path === name, hasFm, before);
    return shape ? { invalid: shape[0], reason: `${opts.path}: ${shape[1]}` } : { text: raw, edit: "none" };
  }

  if (!hasFm) return checked(`${bom}${FENCE}${eol}${typeLine(want)}${eol}${FENCE}${eol}${text}`, "prepend", { type: want });
  const t = before.data.type;
  if (typeof t === "string" && t.trim() !== "") return { text: raw, edit: "none" };

  const lines = text.split("\n"); // a line keeps its \r, so an untouched line keeps its bytes
  const end = lines.findIndex((l, i) => i > 0 && l.replace(/\r$/, "") === FENCE);
  const at = lines.slice(0, end).flatMap((l, i) => (i > 0 && TYPE_KEY.test(l.replace(/\r$/, "")) ? [i] : []));
  const cr = (l: string) => (l.endsWith("\r") ? "\r" : "");
  const insert = (ls: string[]) => [ls[0]!, typeLine(want) + cr(ls[0]!), ...ls.slice(1)].join("\n");

  if (!("type" in before.data)) return checked(bom + insert(lines), "insert-type", { type: want });
  if (at.length !== 1) return { invalid: "unsafe-edit", reason: "the `type` key is not on one top-level line the editor can find" };
  const k = at[0]!;
  if (t == null || typeof t === "string") {
    const filled = [...lines];
    filled[k] = typeLine(want) + cr(lines[k]!);
    return checked(bom + filled.join("\n"), "fill-type", { type: want });
  }
  if ("funes_type" in before.data) return { invalid: "unsafe-edit", reason: "a non-string `type` meets an existing `funes_type`" };
  const renamed = [...lines];
  renamed[k] = "funes_" + lines[k];
  return checked(bom + insert(renamed), "rename-type", { type: want, funes_type: t });

  function checked(out: string, edit: OkfEdit, change: Record<string, unknown>): Normalized {
    const after = parseFrontmatter(out);
    const same = after.malformed === undefined && after.body === before.body && isDeepStrictEqual(after.data, { ...before.data, ...change });
    return same ? { text: out, edit } : { invalid: "unsafe-edit", reason: `the ${edit} edit does not re-parse to the page plus the \`type\` change` };
  }
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

/** A page's bytes, already in hand, as a MemoryItem + its lifecycle meta (the engine's fileToItemWithMeta reads a file into it): `rel` is the vault-relative path. A writer indexes
 *  the bytes it wrote through this, never by reading the page back (0.5.0 item 14, record 24 §4: at
 *  the edge a write is only staged until its frame commits). Bytes that are not UTF-8 are malformed
 *  (0.5.0 item 20): they reach parseFrontmatter undecoded, which says so. */
export function textToItemWithMeta(page: string | Uint8Array, rel: string): { item: MemoryItem; meta: MemoryMeta; parseError?: string } {
  let text = page;
  if (typeof text !== "string") try { text = UTF8.decode(text); } catch { /* parseFrontmatter names it */ }
  const { data, body, malformed: parseError } = parseFrontmatter(typeof text === "string" ? text.replace(/\u0000/g, "") : text);
  const meta = metaFromData(data);
  const item: MemoryItem & FreshnessFields = {
    id: rel.replace(/\.md$/, ""),
    path: rel,
    title: String(data.title ?? rel.slice(rel.lastIndexOf("/") + 1).replace(/\.md$/, "")),
    type: data.type != null ? String(data.type) : undefined,
    body,
    edges: allEdges(data, body),
    // H4 zone default, widened by PLAN-0.2.1 step 5: explicit frontmatter trust wins; else the
    // grammar in vault.ts decides — INCOMING (in_*, raw/) and GENERATED (`out_*` at any
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
    // ADR-0013: every scalar frontmatter value, filled HERE so every producer — reindex, remember,
    // supersede, link, elevate, a put_page apply — fills `nodes.frontmatter`. No star.yaml is read:
    // the declaration only checks a `where` at recall. A page with no frontmatter stores `{}`.
    frontmatter: Object.fromEntries(Object.entries(data).filter(([, v]) =>
      typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)))) as MemoryItem["frontmatter"],
  };
  return { item, meta, parseError };
}
