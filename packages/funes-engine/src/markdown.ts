import { readFileSync } from "node:fs";
import { basename, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type { MemoryEdge, MemoryItem, MemoryMeta } from "funes-core";
import { normalizeRelationType } from "funes-core";
import type { FreshnessFields } from "./store.ts";
import { zoneOfFile } from "funes-shared";

const FENCE = "---";

/** Split markdown into frontmatter + body. Degrades to no-frontmatter on malformed YAML
 *  (mirrors the twinkling Python fix — essential across mixed imported files). */
export function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  // CRLF files fell straight through this function: '---\r\n' fails the fence test, so EVERY key
  // was dropped — trust, superseded_by, forgotten, volatile. A tombstoned note written on Windows
  // (or edited by a tool that normalizes line endings) silently kept answering recall, which is a
  // correctness failure disguised as a parsing nicety. Normalize first, and strip a BOM while here.
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith(FENCE + "\n") && text.trimEnd() !== FENCE) return { data: {}, body: text };
  const lines = text.split("\n");
  const end = lines.indexOf(FENCE, 1);
  if (end === -1) return { data: {}, body: text };
  try {
    const data = parseYaml(lines.slice(1, end).join("\n")) ?? {};
    if (typeof data !== "object" || Array.isArray(data)) return { data: {}, body: text };
    return { data: data as Record<string, unknown>, body: lines.slice(end + 1).join("\n") };
  } catch {
    return { data: {}, body: text };
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
//   frontmatter `sources:` ([[id]] provenance) -> cites  (epistemic family)
//   frontmatter `people:`  ([[id]] mentions)   -> mentions
//   body `[[id]]` / `[[id|alias]]` / `[[id#h]]` -> related-to
// Targets are basenames or path-ids; reindex's resolveEdgeTargets() qualifies basenames to ids,
// and unmatched (dangling) targets are harmlessly skipped downstream.
const WIKILINK = /\[\[([^\]|#\n]+?)(?:[#|][^\]\n]*)?\]\]/g;

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
    for (const x of v) { const m = String(x).match(/\[\[([^\]|#]+)/); if (m) push(m[1]!, type); }
  };
  fmLinks(data.sources, "cites");
  fmLinks(data.people, "mentions");
  // NOTE: `superseded_by:` is NOT materialized as an edge — a superseded page is TOMBSTONED
  // (isTombstoned in funes-core: superseded ⇒ excluded from the index), so its edges never reach the
  // store. "Supersede, don't delete" is enforced by tombstone-skip (reindex.ts), not a graph edge.
  for (let m: RegExpExecArray | null; (m = WIKILINK.exec(body)) !== null; ) push(m[1]!, "related-to");
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
 *  (Agent-written `remember` input gets the same treatment from the S3 sanitizer.) */
export function fileToItemWithMeta(absPath: string, vaultRoot: string): { item: MemoryItem; meta: MemoryMeta } {
  const { data, body } = parseFrontmatter(readFileSync(absPath, "utf8").replace(/\u0000/g, ""));
  const rel = relative(vaultRoot, absPath);
  const meta = metaFromData(data);
  const item: MemoryItem & FreshnessFields = {
    id: rel.replace(/\.md$/, ""),
    path: rel,
    title: String(data.title ?? basename(absPath).replace(/\.md$/, "")),
    type: data.type != null ? String(data.type) : undefined,
    body,
    edges: allEdges(data, body),
    // H4 zone default: explicit frontmatter trust wins; else the INCOMING zone (in_* at any
    // depth, or the raw/ container — vault-v2) is untrusted, everything else (wiki/output —
    // human-authored at lone-local, or funes-written with trust recorded in frontmatter) is
    // trusted. Frontmatter is canonical; the index column is derived from it on every reindex.
    trust: meta.trust ?? (zoneOfFile(rel) === "incoming" ? "untrusted" : "trusted"),
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
  return { item, meta };
}

/** Map a markdown file to a MemoryItem (PLAN §3a). */
export function fileToItem(absPath: string, vaultRoot: string): MemoryItem {
  return fileToItemWithMeta(absPath, vaultRoot).item;
}
