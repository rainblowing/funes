// content-generation-v2 — THE one encoding module for the CONTENT GENERATION: the canonical identity
// of the rows an index currently holds (PLAN-0.3.0 item 6; Codex R2#6). It names WHAT an index was
// built from, independent of WHERE it was built:
//
//   content generation = "v2:" + sha256(
//       "v2"
//     ‖ sorted per-row records: normalized indexed path, embedding-content fingerprint,
//       effective trust label, declared source/authored, type, description, resource,
//       volatile, freshness (epoch)
//     ‖ index scope (the ScopeSignature the build stamped, or null)
//     ‖ parser version ‖ embedding spec ‖ index schema version
//   )
//
// THREE SIGNATURES, NOT ONE (PLAN-0.3.0 P1). One hash used to answer three questions and could
// answer none of them honestly:
//   1. embedding-content fingerprint — `hashItem()`, below. Title+body+edges. The ONLY trigger for
//      a re-embed, and its inputs do NOT widen with this encoding (item 5). Widening the content
//      generation must never cost a vault its embeddings.
//   2. content generation — this module. Every field that changes a SERVED ROW, including the
//      metadata-only fields the fingerprint deliberately ignores.
//   3. serving signature — serving-signature.ts. Everything OUTSIDE the rows that changes what a
//      query returns. Process-local, so it is computed per serving process and never published.
//
// Deterministic across loci: two FULL builds over byte-identical content in DIFFERENT directories
// stamp the SAME content generation (paths are vault-relative + normalized), so canon/follower
// divergence is observable and the publication protocol (publication.ts) can SKIP a rebuild whose
// target is already published. Any single changed page, trust flip, metadata edit, scope change,
// parser bump, embedder swap, or index-schema bump produces a DIFFERENT value — never a silent
// "generation-matched" over semantically different corpora (Codex R5#1).
//
// This module is PURE (node:crypto + funes-core types only) so both backends and the twinkling
// harness can share it without loading PGLite-WASM or libsql. The stamping call sites are
// reindex.ts (FULL runs only — the same gate as the scope signature) and publication.ts.
import { createHash } from "node:crypto";
import type { MemoryItem, ScopeSignature } from "funes-core";

/** The encoding version — the FIRST hash input, so "v1" can never collide with a "v2" that happens
 *  to hash the same field set differently. Also the visible prefix of the value.
 *
 *  "v2" (PLAN-0.3.0 item 6): the record widened from (path, fingerprint, trust, source, authored)
 *  to include `type`, `description`, `resource`, `volatile` and `freshness` — metadata-only fields
 *  that change a served row while leaving the embedding-content fingerprint untouched. A v1 value
 *  therefore CANNOT be reinterpreted as a content generation: it was computed over a narrower field
 *  set, and incremental writes never invalidated it. Legacy v1 stamps are reported invalid until a
 *  rebuild establishes a v2 (item 8). */
export const GENERATION_VERSION = "v2";

/** Version of the markdown→MemoryItem parse (markdown.ts frontmatter + wikilink-edge extraction
 *  + reindex.ts basename edge resolution). BUMP whenever a parsing change alters what a byte-
 *  identical vault indexes to — otherwise two loci on different code report equal generations
 *  over different index contents.
 *
 *  "2" (PLAN-0.2.1 step 6): TWO parse changes since "1". `f058e89` added three deterministic edge
 *  producers (`mem:` refs, OKF `sources`, OKF `resource`), so a byte-identical page yields more
 *  edges. Step 5 then moved the default trust of every `out_*` page to untrusted, and the trust
 *  label is a generation-record field. Both land before the single baseline build, on purpose. */
export const PARSER_VERSION = "fm-wikilinks/2";

/** Version of the LOGICAL index schema (what recall is computed over: nodes+chunks+edges+FTS).
 *  BUMP on index-breaking schema changes. "2" = P2.10 (libSQL fts5 title/description/body split).
 *  "3" = provenance schema-v1 (2026-07-22): nodes gains `source`/`authored` (declared) + `write_actor`
 *  (stamped) columns. See [[wiki/synthesis/2026-07-22-provenance-schema-v1]].
 *
 *  "4" (PLAN-0.3.0, "What review changed" R1#11 → R2#2) changes NO row layout. It is a FENCE: the
 *  rollout matrix (PLAN-0.3.0.md "Rollout and rollback") needs an exact-equality check that a 0.2.x
 *  process trips when it opens a 0.3.0 artefact — a v3 reader refuses a v4 index, a v4 writer refuses
 *  a v3 one — because a legacy writer that kept mutating a new index would do so without the
 *  evidence-driven invalidation of item 11, and no lock this release adds binds a process that
 *  predates it. With that, the in-place migration ladder is retired: a libsql writer no longer
 *  upgrades an older index on open, it refuses and names the rebuild (`funes reindex --fresh` for a
 *  live index, `funes publish` for a served home). Read-only opens dual-read "3" and "4" (rollout
 *  step 30) so a v4 reader can serve a not-yet-republished home. */
export const INDEX_SCHEMA_VERSION = "4";

/** THE embedding-content fingerprint (PLAN-0.3.0 item 5) — the ONLY trigger for a re-embed. sha256
 *  (stable across Bun releases, unlike Bun.hash) over title+body+edges, truncated to 16 hex chars.
 *  THE one definition: both backends use it for incremental change detection and every generation
 *  record carries it, so change detection and content generation can never disagree about what
 *  "the embedded content" is.
 *
 *  ITS INPUTS DO NOT WIDEN WITH THE CONTENT GENERATION. The fingerprint answers "must this page be
 *  re-embedded", and `description`/`resource`/`type`/`volatile`/`freshness`/`trust`/`source`/
 *  `authored` never reach the embedder (chunkText embeds `title\nbody` only) — folding them in here
 *  would re-embed a whole vault for a frontmatter edit that cannot move a single vector. They move
 *  the CONTENT GENERATION instead: same rows re-published, no re-embedding. The separation is
 *  structural, not incidental — encodeGeneration carries those fields as record columns of their
 *  own rather than by widening this hash. */
export function hashItem(it: MemoryItem): string {
  // NUL-delimited, not space-delimited. With a space, ('Northwind retainer','9500/mo') and
  // ('Northwind','retainer 9500/mo') hash identically — a title/body edit that moves a word across
  // the boundary reads as UNCHANGED, so incremental reindex skips it and the generation hash claims
  // two different vaults are the same. NUL cannot occur in either field (markdown.ts strips it).
  // VERSIONED: this changes every content hash, so the first reindex after it re-embeds the vault.
  return createHash("sha256").update(`${it.title}\u0000${it.body}\u0000${JSON.stringify(it.edges ?? [])}`).digest("hex").slice(0, 16);
}

/** One generation record: the canonical identity of ONE indexed row. An EPHEMERAL projection of the
 *  row — never a persisted column, so widening it costs no schema migration (Codex R3#7).
 *
 *  INCLUDED: the normalized indexed path, the embedding-content fingerprint, the effective trust
 *  label, declared provenance (`source`/`authored`, schema-v1) and — v2, PLAN-0.3.0 item 6 — the
 *  metadata-only fields `type`, `description`, `resource`, `volatile` and `freshness`. All of them
 *  are frontmatter-declared and deterministic across loci, and every one of them changes a SERVED
 *  row: `description` is an FTS column, `type`/`resource` are returned by `indexed_page`, and
 *  `volatile`/`freshness` drive the recency tiebreak. Before v2 they were invisible to the identity,
 *  so two loci could hold demonstrably different rows and claim one generation.
 *
 *  EXCLUDED, deliberately — the ADVISORY fields (CONTEXT.md: index-only, lost on a rebuild, nothing
 *  may depend on them):
 *    - `write_actor` — STAMPED, not declared. It depends on who ran the write, so folding it in
 *      would break the same-content-same-generation invariant that makes loci comparable at all.
 *    - `recall_stats` — telemetry. It moves on every query, on each locus independently; a
 *      generation that moved when someone READ the index would name nothing. */
export interface GenerationRecord {
  path: string;
  contentHash: string;
  trust: string;
  source?: string;
  authored?: string;
  type?: string;
  description?: string;
  resource?: string;
  volatile?: boolean;
  /** Epoch SECONDS, not the declared string — the row stores the parsed instant, so "2026-01-01"
   *  and "2026-01-01T00:00:00Z" are ONE identity. Unparsable/absent = null (what the row holds). */
  freshness?: number | null;
}

/** Frontmatter freshness (`as_of`, else `updated`) -> epoch SECONDS or null. A deliberate MIRROR of
 *  `freshnessEpoch` in funes-libsql/src/ranking.ts (and `freshnessIso` in funes-engine/src/store.ts)
 *  — funes-shared sits BELOW both backends in the package DAG and cannot import either. Same lenient
 *  parse: an unparsable date is null, exactly as the stores record it. */
function freshnessEpochOf(v: unknown): number | null {
  if (v == null) return null;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t / 1000;
}

/** Normalize an indexed path for the generation encoding: vault-relative, forward slashes,
 *  no leading "./", Unicode NFC — so the same file on macOS (NFD-y filesystems) and Linux
 *  (the canon host) encodes identically. */
export function normalizeGenerationPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").normalize("NFC");
}

/** Project a to-be-indexed item (AFTER edge-target resolution — resolved edges are what the
 *  store hashes) onto its generation record. `volatile`/`freshness` ride the item PAST the
 *  funes-core type (markdown.ts sets them; see FreshnessFields in funes-libsql/src/ranking.ts), so
 *  they are read structurally here rather than through MemoryItem. */
export function generationRecord(it: MemoryItem): GenerationRecord {
  const fresh = it as MemoryItem & { volatile?: boolean; freshness?: string | null };
  return {
    path: normalizeGenerationPath(it.path ?? `${it.id}.md`),
    contentHash: hashItem(it),
    trust: it.trust ?? "untrusted",
    ...(it.source != null ? { source: it.source } : {}),
    ...(it.authored != null ? { authored: it.authored } : {}),
    ...(it.type != null ? { type: it.type } : {}),
    ...(it.description != null ? { description: it.description } : {}),
    ...(it.resource != null ? { resource: it.resource } : {}),
    // Always present, never conditional: the row's `volatile` column defaults to 0/false, so an
    // absent field and a declared `volatile: false` ARE the same row and must encode identically.
    volatile: fresh.volatile === true,
    freshness: freshnessEpochOf(fresh.freshness),
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

/** Canonical encoding + hash. Records are serialized as fixed-arity JSON tuples (unambiguous
 *  escaping — no in-band separator can be forged by a hostile path/title), sorted BYTEWISE after
 *  serialization (so ordering is defined even for duplicate paths), newline-joined; the scope/
 *  parser/embedding/schema tail is one fixed-key-order JSON object.
 *
 *  The tuple is APPEND-ONLY: a new field goes on the end and bumps GENERATION_VERSION. Inserting
 *  one in the middle would leave two encodings sharing a version prefix, which is precisely what
 *  the version's position as the first hash input exists to prevent. */
export function encodeGeneration(inputs: GenerationInputs): string {
  const lines = inputs.records
    .map((r) => JSON.stringify([
      normalizeGenerationPath(r.path), r.contentHash, r.trust, r.source ?? null, r.authored ?? null,
      // v2 widening (item 6). `volatile` normalizes undefined to false — the row column's default.
      r.type ?? null, r.description ?? null, r.resource ?? null, r.volatile === true, r.freshness ?? null,
    ]))
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
