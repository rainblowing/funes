// The page codec's writer half (RAI-313): the bytes a write puts in a page. The file helpers that
// write them to a folder stay in the engine (funes-engine/src/write.ts).
import { createHash } from "node:crypto";
import { Document, visit } from "yaml";
import type { MemoryEdge, MemoryMeta, RememberInput } from "./types.ts";

/** title -> filesystem-safe slug. */
export function slugify(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 60) || "item";
}

/** Deterministic id under `memoryDir` (no timestamp -> stable for tests). `out_memory/<slug>-<hashN>`,
 *  hash = sha256 over title+body — ids persist in filenames forever, so the hash must be
 *  contractually stable (S0: was Bun.hash, which may change across Bun releases).
 *
 *  NOT collision-safe at the default width, whatever the previous version of this comment claimed:
 *  6 hex chars is 24 bits, so among ~5,000 distinct bodies sharing one slug the birthday
 *  probability of a clash passes 50%. "Meeting notes" is not a hypothetical slug. The caller
 *  (FunesStore.remember) probes for a real clash and re-derives at a wider `hashLen`, so ids
 *  already on disk keep their names and only an actual collision costs anything. */
export function memoryId(input: RememberInput, memoryDir: string, hashLen = 6): string {
  if (input.id) return input.id;
  const h = createHash("sha256").update(`${input.title}\n${input.body}`).digest("hex").slice(0, hashLen);
  return `${memoryDir}/${slugify(input.title)}-${h}`;
}

/** Render frontmatter (stable key order) + body into a markdown string. A contract symbol on
 *  the kernel entry (0.5.0 item 16): the taste bot renders its `put_page` bytes with it. */
export function render(data: Record<string, unknown>, body: string): string {
  // drop null/undefined so the frontmatter stays clean
  const clean: Record<string, unknown> = {};
  // NOTE: this list is key ORDER, not a filter — every other key in `data` is appended below, so a
  // frontmatter key funes does not know about survives a rewrite untouched.
  for (const k of ["title", "type", "created", "updated", "trust", "volatile", "as_of", "tags",
    "sources", "superseded_by", "valid_until", "forgotten", "edges"]) {
    if (data[k] != null) clean[k] = data[k];
  }
  for (const k of Object.keys(data)) if (!(k in clean) && data[k] != null) clean[k] = data[k];
  // yaml writes YAML 1.2, where `on`, `no` or `y` is a plain string; a YAML 1.1 reader (Obsidian's
  // Properties, PyYAML) takes it bare as a boolean. Quote those strings so both readers agree
  // (0.5.0 item 47, scenario R12); every other scalar is written exactly as before.
  const doc = new Document(clean);
  visit(doc, { Scalar: (_, n) => { if (typeof n.value === "string" && YAML11_BOOL.test(n.value)) n.type = "QUOTE_DOUBLE"; } });
  const fm = doc.toString({ lineWidth: 0 }).trimEnd();
  return `---\n${fm}\n---\n${body}`;
}

/** The YAML 1.1 bool words (yaml.org/type/bool) that YAML 1.2's core schema leaves plain. */
const YAML11_BOOL = /^(?:y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF)$/;

function edgesToFm(edges: MemoryEdge[] | undefined): unknown[] | undefined {
  if (!edges?.length) return undefined;
  return edges.map((e) => (e.weight != null
    ? { type: e.type, target: e.target, weight: e.weight }
    : { type: e.type, target: e.target }));
}

/** Build the frontmatter object for an item from input + lifecycle meta + timestamps. */
export function frontmatterFor(input: RememberInput, meta: MemoryMeta): Record<string, unknown> {
  return {
    title: input.title,
    type: input.type ?? "memory",
    created: meta.created,
    updated: meta.updated,
    trust: meta.trust,
    tags: meta.tags?.length ? meta.tags : undefined,
    sources: meta.sources?.length ? meta.sources : undefined,
    superseded_by: meta.superseded_by,
    // `valid_until` is deliberately NOT emitted. It was written here and read by NOTHING — no op
    // could set it, and no ranking, filter or audit consulted it — so its presence implied expiry
    // semantics that existed in neither direction, and every write carrying it accrued data under a
    // contract nobody had chosen. It returns with the contradiction audit, when a reader exists to
    // define what it means. Reading stays tolerant (markdown.ts still parses it, render() still
    // orders it), so a file that already declares it keeps it.
    // P5.19: without these two in the allowlist an agent could not mark its own write as STATE —
    // the mechanism existed in frontmatter and was reachable only by a human editing the file.
    volatile: meta.volatile || undefined,
    as_of: meta.as_of,
    forgotten: meta.forgotten || undefined,
    edges: edgesToFm(input.edges),
  };
}

/** A memory item's page, as writeMemoryFile writes it (FunesStore swaps these bytes in). */
export function memoryPageText(input: RememberInput, meta: MemoryMeta): string {
  return render(frontmatterFor(input, meta), `\n${input.body.trim()}\n`);
}

/** The page `patch` makes of a parsed page: patchFrontmatter's rewrite, without the write. */
export function patchedPageText(f: { data: Record<string, unknown>; body: string; malformed?: string }, id: string, patch: Record<string, unknown>): string {
  if (f.malformed !== undefined) {
    throw new Error(`patchFrontmatter: the frontmatter of "${id}" does not parse (${f.malformed}) — fix the page's YAML first; rewriting it would fold the old frontmatter into the body`);
  }
  return render({ ...f.data, ...patch }, f.body);
}
