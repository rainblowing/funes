import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { MemoryEdge, MemoryItem, MemoryMeta, RememberInput } from "funes-core";
import { parseFrontmatter } from "./markdown.ts";

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

/** Render frontmatter (stable key order) + body into a markdown string. */
function render(data: Record<string, unknown>, body: string): string {
  // drop null/undefined so the frontmatter stays clean
  const clean: Record<string, unknown> = {};
  // NOTE: this list is key ORDER, not a filter — every other key in `data` is appended below, so a
  // frontmatter key funes does not know about survives a rewrite untouched.
  for (const k of ["title", "type", "created", "updated", "trust", "volatile", "as_of", "tags",
    "sources", "superseded_by", "valid_until", "forgotten", "edges"]) {
    if (data[k] != null) clean[k] = data[k];
  }
  for (const k of Object.keys(data)) if (!(k in clean) && data[k] != null) clean[k] = data[k];
  const fm = stringifyYaml(clean, { lineWidth: 0 }).trimEnd();
  return `---\n${fm}\n---\n${body}`;
}

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
export function atomicWriteFile(abs: string, contents: string): void {
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

/** Write a memory item to `out_memory/<id>.md` (canonical source) and return its MemoryItem. */
export function writeMemoryItem(root: string, input: RememberInput, meta: MemoryMeta): MemoryItem {
  const id = input.id!;
  const abs = absFor(root, id);
  mkdirSync(dirname(abs), { recursive: true });
  const body = `\n${input.body.trim()}\n`;
  atomicWriteFile(abs, render(frontmatterFor({ ...input, id }, meta), body));
  // P5.19: carry volatile/freshness on the RETURNED item, not just into the file. The store indexes
  // what this returns, so omitting them meant a fresh `remember` wrote correct frontmatter and left
  // the index columns null until the next full reindex — the state/event bit was on disk and
  // invisible to recall. `freshness` = as_of else updated, matching markdown.ts's read path exactly.
  return {
    id, path: `${id}.md`, title: input.title, type: input.type ?? "memory", body, edges: input.edges,
    ...(meta.volatile ? { volatile: true } : {}),
    freshness: meta.as_of ?? meta.updated ?? null,
  } as MemoryItem;
}

export interface MemoryFile {
  absPath: string;
  data: Record<string, unknown>;
  body: string;
}

/** Read an existing item file by id, or null if absent. */
export function readMemoryFile(root: string, id: string): MemoryFile | null {
  const abs = absFor(root, id);
  if (!existsSync(abs)) return null;
  const { data, body } = parseFrontmatter(readFileSync(abs, "utf8"));
  return { absPath: abs, data, body };
}

/** Merge `patch` into an existing item's frontmatter and rewrite the file (body preserved). */
export function patchFrontmatter(root: string, id: string, patch: Record<string, unknown>): void {
  const f = readMemoryFile(root, id);
  if (!f) throw new Error(`patchFrontmatter: no memory file for id "${id}"`);
  const merged = { ...f.data, ...patch };
  atomicWriteFile(f.absPath, render(merged, f.body));
}

/** Hard delete an item's markdown file. */
export function deleteMemoryFile(root: string, id: string): boolean {
  const abs = absFor(root, id);
  if (!existsSync(abs)) return false;
  rmSync(abs);
  return true;
}
