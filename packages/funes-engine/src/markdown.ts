// The node half of the page codec (RAI-313): read a markdown FILE into a MemoryItem. The codec itself
// (parseFrontmatter, textToItemWithMeta) is the kernel's (funes-core).
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import type { MemoryItem, MemoryMeta } from "funes-core/internal";
import { textToItemWithMeta } from "funes-core/internal";

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
  return textToItemWithMeta(readFileSync(absPath), relative(vaultRoot, absPath));
}

/** Map a markdown file to a MemoryItem (PLAN §3a). */
export function fileToItem(absPath: string, vaultRoot: string): MemoryItem {
  return fileToItemWithMeta(absPath, vaultRoot).item;
}
