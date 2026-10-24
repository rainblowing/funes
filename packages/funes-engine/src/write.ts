// The page writer's folder half (RAI-313): crash-atomic file writes and the memory-file helpers over
// a folder. The bytes come from the kernel's codec (funes-core write.ts).
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { MemoryItem, MemoryMeta, RememberInput } from "funes-core/internal";
import { parseFrontmatter } from "funes-core";
import { memoryPageText, patchedPageText, textToItemWithMeta } from "funes-core/internal";

export const absFor = (root: string, id: string): string => join(root, `${id}.md`);

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
export function atomicWriteFile(abs: string, contents: string | Uint8Array, mode = 0o666): void {
  const dir = dirname(abs);
  const tmp = join(dir, `.${basename(abs)}.${process.pid}.${tmpSeq++}.tmp`);
  try {
    const fd = openSync(tmp, "wx", mode);
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

/** Hard delete an item's markdown file. */
export function deleteMemoryFile(root: string, id: string): boolean {
  const abs = absFor(root, id);
  if (!existsSync(abs)) return false;
  rmSync(abs);
  return true;
}
