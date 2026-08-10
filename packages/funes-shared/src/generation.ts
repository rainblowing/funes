// generation-v1 — THE one encoding module for the content-defined index generation (canon host
// re-homing plan Rev 6, R5#1; conformance review major #2). A generation names WHAT an index was
// built from, independent of WHERE it was built:
//
//   generation = "v1:" + sha256(
//       "v1"
//     ‖ sorted (normalized indexed path, content hash, effective trust label) records
//     ‖ index scope (the ScopeSignature the build stamped, or null)
//     ‖ parser version ‖ embedding spec ‖ index schema version
//   )
//
// Deterministic across loci: two FULL builds over byte-identical content in DIFFERENT directories
// stamp the SAME generation (paths are vault-relative + normalized), so canon/follower divergence
// is observable and the publication protocol (publication.ts) can SKIP a rebuild whose target
// generation is already published. Any single changed page, trust flip, scope change, parser bump,
// embedder swap, or index-schema bump produces a DIFFERENT generation — never a silent
// "generation-matched" over semantically different corpora (Codex R5#1).
//
// This module is PURE (node:crypto + funes-core types only) so both backends and the twinkling
// harness can share it without loading PGLite-WASM or libsql. The stamping call sites are
// reindex.ts (FULL runs only — the same gate as the scope signature) and publication.ts.
import { createHash } from "node:crypto";
import type { MemoryItem, ScopeSignature } from "funes-core";

/** The encoding version — the FIRST hash input, so "v1" can never collide with a future "v2"
 *  that happens to hash the same field set differently. Also the visible prefix of the value. */
export const GENERATION_VERSION = "v1";

/** Version of the markdown→MemoryItem parse (markdown.ts frontmatter + wikilink-edge extraction
 *  + reindex.ts basename edge resolution). BUMP whenever a parsing change alters what a byte-
 *  identical vault indexes to — otherwise two loci on different code report equal generations
 *  over different index contents. */
export const PARSER_VERSION = "fm-wikilinks/1";

/** Version of the LOGICAL index schema (what recall is computed over: nodes+chunks+edges+FTS).
 *  BUMP on index-breaking schema changes. "2" = P2.10 (libSQL fts5 title/description/body split).
 *  "3" = provenance schema-v1 (2026-07-22): nodes gains `source`/`authored` (declared) + `write_actor`
 *  (stamped) columns; libSQL auto-migrates v2→v3 additively on a writer open (add columns, existing
 *  rows null/`unknown`). See [[wiki/synthesis/2026-07-22-provenance-schema-v1]]. */
export const INDEX_SCHEMA_VERSION = "3";

/** Content hash for incremental reindex — re-embed only when title/body/edges change. sha256
 *  (stable across Bun releases, unlike Bun.hash), truncated to 16 hex chars. THE one definition:
 *  both backends and the generation records use it, so change detection and generation records
 *  can never disagree about what "the content" is. */
export function hashItem(it: MemoryItem): string {
  return createHash("sha256").update(`${it.title} ${it.body} ${JSON.stringify(it.edges ?? [])}`).digest("hex").slice(0, 16);
}

/** One generation record: what the plan calls a "(normalized indexed path, content hash,
 *  effective trust label)" tuple, plus declared provenance (schema-v1) — `source`/`authored` are
 *  frontmatter-declared and deterministic across loci, so folding them in makes a provenance edit
 *  move the generation (re-publish) while staying cross-locus comparable. The STAMPED `write_actor`
 *  is deliberately excluded — it is non-deterministic (depends who ran the write) and would break the
 *  same-content-same-generation invariant. */
export interface GenerationRecord {
  path: string;
  contentHash: string;
  trust: string;
  source?: string;
  authored?: string;
}

/** Normalize an indexed path for the generation encoding: vault-relative, forward slashes,
 *  no leading "./", Unicode NFC — so the same file on macOS (NFD-y filesystems) and Linux
 *  (the canon host) encodes identically. */
export function normalizeGenerationPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").normalize("NFC");
}

/** Project a to-be-indexed item (AFTER edge-target resolution — resolved edges are what the
 *  store hashes) onto its generation record. */
export function generationRecord(it: MemoryItem): GenerationRecord {
  return {
    path: normalizeGenerationPath(it.path ?? `${it.id}.md`),
    contentHash: hashItem(it),
    trust: it.trust ?? "untrusted",
    ...(it.source != null ? { source: it.source } : {}),
    ...(it.authored != null ? { authored: it.authored } : {}),
  };
}

export interface GenerationInputs {
  /** Records of every non-tombstoned item the FULL build indexed (any order; sorted here). */
  records: GenerationRecord[];
  /** The index-scope signature the build stamped; null = no scope (absent-manifest rebuild). */
  scope: ScopeSignature | null;
  /** The embedding spec the index enforces (H1): `<model-id>:<dim>:<chunk-sig>` — the same
   *  string persisted as the store's embedding_signature meta. */
  embeddingSpec: string;
  parserVersion?: string;
  indexSchemaVersion?: string;
}

/** Canonical encoding + hash. Records are serialized as JSON triples (unambiguous escaping —
 *  no in-band separator can be forged by a hostile path/title), sorted BYTEWISE after
 *  serialization (so ordering is defined even for duplicate paths), newline-joined; the scope/
 *  parser/embedding/schema tail is one fixed-key-order JSON object. */
export function encodeGeneration(inputs: GenerationInputs): string {
  const lines = inputs.records
    .map((r) => JSON.stringify([normalizeGenerationPath(r.path), r.contentHash, r.trust, r.source ?? null, r.authored ?? null]))
    .sort();
  const tail = JSON.stringify({
    scope: inputs.scope ? { hash: inputs.scope.hash, ignoreScope: inputs.scope.ignoreScope } : null,
    parser: inputs.parserVersion ?? PARSER_VERSION,
    embedding: inputs.embeddingSpec,
    schema: inputs.indexSchemaVersion ?? INDEX_SCHEMA_VERSION,
  });
  const h = createHash("sha256");
  h.update(GENERATION_VERSION + "\n");
  for (const line of lines) h.update(line + "\n");
  h.update(tail);
  return `${GENERATION_VERSION}:${h.digest("hex")}`;
}
