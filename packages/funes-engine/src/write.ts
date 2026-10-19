import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Document, visit } from "yaml";
import type { MemoryEdge, MemoryItem, MemoryMeta, RememberInput } from "funes-core";
import { parseFrontmatter, textToItemWithMeta } from "./markdown.ts";

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

export const absFor = (root: string, id: string): string => join(root, `${id}.md`);

/** Render frontmatter (stable key order) + body into a markdown string. A contract symbol on
 *  `funes-engine/portable` (0.5.0 item 16): the taste bot renders its `put_page` bytes with it. */
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

let tmpSeq = 0;

/** P3.15: crash-atomic write of the CANONICAL markdown — sibling temp -> fsync file -> rename ->
 *  fsync dir. `writeFileSync` truncates in place, so a crash or a full disk mid-write left a
 *  truncated or empty file where the SOURCE OF TRUTH used to be; in a markdown-canonical system the
 *  index is rebuildable and this file is not. The temp is a sibling so the rename is same-filesystem
 *  and therefore atomic, and the directory fsync is what makes the rename itself survive power loss
 *  (renaming durably is a two-part job: the inode, then the directory entry).
 *
 *  Readers never observe a partial file: they see either the whole old content or the whole new one.
 *  Not a substitute for the write lock — that governs WHO writes; this governs what a reader or a
 *  crash can see. */
export function atomicWriteFile(abs: string, contents: string | Uint8Array): void {
  const dir = dirname(abs);
  const tmp = join(dir, `.${basename(abs)}.${process.pid}.${tmpSeq++}.tmp`);
  try {
    const fd = openSync(tmp, "wx");
    try {
      writeFileSync(fd, contents, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, abs);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw e;
  }
  // The rename is only durable once the DIRECTORY entry is flushed too.
  const dfd = openSync(dir, "r");
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
}

/** Write a memory item's page to `<id>.md` (canonical source) and return the bytes written, which
 *  the caller indexes instead of reading the page back (0.5.0 item 14). */
export function writeMemoryFile(root: string, input: RememberInput, meta: MemoryMeta): string {
  const id = input.id!;
  const abs = absFor(root, id);
  mkdirSync(dirname(abs), { recursive: true });
  const text = memoryPageText(input, meta);
  atomicWriteFile(abs, text);
  return text;
}

/** A memory item's page, as writeMemoryFile writes it (FunesStore swaps these bytes in). */
export function memoryPageText(input: RememberInput, meta: MemoryMeta): string {
  return render(frontmatterFor(input, meta), `\n${input.body.trim()}\n`);
}

/** Write a memory item to `out_memory/<id>.md` (canonical source) and return its MemoryItem: the
 *  written bytes through the reindex parser, so the returned item and a rebuilt row cannot disagree
 *  (P5.19's volatile/freshness, trust, and every field the parser gains later). */
export function writeMemoryItem(root: string, input: RememberInput, meta: MemoryMeta): MemoryItem {
  return textToItemWithMeta(writeMemoryFile(root, input, meta), `${input.id!}.md`).item;
}

export interface MemoryFile {
  absPath: string;
  data: Record<string, unknown>;
  body: string;
  /** The frontmatter parse error (parseFrontmatter), when there is one: `data` is then `{}` and
   *  `body` is the whole file, frontmatter included. */
  malformed?: string;
}

/** Read an existing item file by id, or null if absent. */
export function readMemoryFile(root: string, id: string): MemoryFile | null {
  const abs = absFor(root, id);
  if (!existsSync(abs)) return null;
  const { data, body, malformed } = parseFrontmatter(readFileSync(abs, "utf8"));
  return { absPath: abs, data, body, malformed };
}

/** Merge `patch` into an existing item's frontmatter and rewrite the file (body preserved).
 *
 *  Refuses a page whose frontmatter does not parse (0.4.0 item 11, RAI-134). Its `data` is `{}` and
 *  its `body` the whole file, so the rewrite used to stack a fresh fence on top of the old one: the
 *  page's real metadata became body text under a frontmatter holding only the patch — a
 *  `superseded_by` on a page whose title, trust and tags were now prose. A page the tolerant parse
 *  recovered is rewritten normally, and the rewrite is valid YAML (render → yaml stringify). */
export function patchFrontmatter(root: string, id: string, patch: Record<string, unknown>): string {
  const f = readMemoryFile(root, id);
  if (!f) throw new Error(`patchFrontmatter: no memory file for id "${id}"`);
  const text = patchedPageText(f, id, patch);
  atomicWriteFile(f.absPath, text);
  return text; // the bytes written: a caller indexes these, never a read-back (0.5.0 item 14)
}

/** The page `patch` makes of a parsed page: patchFrontmatter's rewrite, without the write. */
export function patchedPageText(f: { data: Record<string, unknown>; body: string; malformed?: string }, id: string, patch: Record<string, unknown>): string {
  if (f.malformed !== undefined) {
    throw new Error(`patchFrontmatter: the frontmatter of "${id}" does not parse (${f.malformed}) — fix the page's YAML first; rewriting it would fold the old frontmatter into the body`);
  }
  return render({ ...f.data, ...patch }, f.body);
}

/** Hard delete an item's markdown file. */
export function deleteMemoryFile(root: string, id: string): boolean {
  const abs = absFor(root, id);
  if (!existsSync(abs)) return false;
  rmSync(abs);
  return true;
}
