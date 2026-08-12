/** Canonical memory-item + the contracts funes-core depends on (storage/embedder injected). */

export interface MemoryEdge {
  type: string;
  target: string;
  weight?: number;
}

/** A memory item. Maps 1:1 from a markdown page (id = path without suffix); `facts/notes/
 *  links` are higher-level projections over this, per PLAN.md §3a. */
/** H4: every memory item is trust-tagged (D11). "untrusted" = unvetted (default for all
 *  agent/remote writes and in_* ingest); "trusted" = human-authored or explicitly elevated;
 *  "derived" = machine-produced from trusted sources. */
export type Trust = "trusted" | "untrusted" | "derived";

export interface MemoryItem {
  id: string;
  path?: string;
  title: string;
  type?: string;
  body: string;
  edges?: MemoryEdge[];
  trust?: Trust;
  /** OKF-aligned enrichment (2026-07): a short queryable `description` (folded into FTS so it boosts
   *  recall) and `resource` — the URI of an external asset this item describes (OKF's `resource`
   *  field / the "Data pointer" node). Both are metadata-only: excluded from the content hash and
   *  synced every remember() pass like `trust`/`volatile` (a description-only edit needs no re-embed). */
  description?: string;
  resource?: string;
  /** Provenance schema-v1 (2026-07-22): DECLARED origin + authoring time (frontmatter `source:` /
   *  `authored:`). Metadata-only for change-detection (no re-embed) but — unlike description/resource
   *  — FOLDED INTO THE GENERATION RECORD, so a provenance edit re-publishes. The stamped `write_actor`
   *  is deliberately NOT here: it is never a writer-supplied field. */
  source?: string;
  authored?: string;
}

export interface RecallQuery {
  query: string;
  k?: number;
  /** S4: opt into the rerank stage over RRF output. A no-op unless the store was constructed
   *  with a Reranker — RRF order is the always-on baseline; rerank order is profile-specific. */
  rerank?: boolean;
}

export interface RecallResult {
  id: string;
  title: string;
  path?: string;
  score: number;
  /** H4: surfaced so consumers can weight/filter by trust; `path` doubles as provenance. */
  trust?: Trust;
  /** Move 5: near-duplicate collapse. When a recall slot stands in for N near-identical
   *  hits (same title OR near-identical fused score, same trust+zone), the kept (best) result
   *  carries the count of OTHER hits it absorbed. Absent/0 = a singleton, no collapse. The
   *  collapsed dupes are dropped from the returned k and distinct results backfill the slots. */
  duplicates?: number;
  /** OKF-aligned enrichment surfaced to consumers (2026-07): the item's `description` and the
   *  `resource` URI it points at. Absent when the source page declares neither. */
  description?: string;
  resource?: string;
  /** Provenance schema-v1 (2026-07-22): DECLARED origin (`source`) + authoring time (`authored`,
   *  ISO string as surfaced) — the author's claim, as trustworthy as `trust`. STAMPED `writeActor` —
   *  a server fact (the authenticated write principal), `"unknown"` for legacy/local writes; it is
   *  never sourced from a page's frontmatter. See [[wiki/synthesis/2026-07-22-provenance-schema-v1]]. */
  source?: string;
  authored?: string;
  writeActor?: string;
  /** P5.19 state/event: true when this item declares itself a STATE that later writes replace.
   *  Indexed and used by the tiebreak since P5.19, but dropped before reaching consumers until
   *  now — which is why agent-side supersession was inexpressible: nothing could see which hits
   *  were even superseding candidates. */
  volatile?: boolean;
  /** ISO date this item's claim was true (`as_of`, else `updated`). Pairs with `volatile`. */
  freshness?: string;
  /** 1-based position in THIS result set. `score` is the raw fused RRF value and is NOT the
   *  ordering key — order is trust × zone × entity-adjusted, then tiebroken, then optionally
   *  reranked, so re-sorting by `score` silently produces a different ranking than the one
   *  returned. `rank` is the authoritative order and survives filtering or merging. */
  rank?: number;
}

/** Embedding is a per-substrate plug-in behind a validated contract (PLAN.md §4a):
 *  pinned model + dimension; e5-style query/passage prefixes live in the impl. */
export interface Embedder {
  readonly dim: number;
  embedQuery(text: string): Promise<Float32Array>;
  embedPassage(text: string): Promise<Float32Array>;
  /** Batch passages in one inference call — the throughput path for reindex. */
  embedPassages(texts: string[]): Promise<Float32Array[]>;
}

/** Stable model identity for the embedding signature (H1 drift guard). All optional on the
 *  interface so test fakes need not set them; the pinned production embedder (E5) returns its full
 *  identity. The extended fields (Codex R3#4) make DISTINCT weights/quantization/pooling/truncation
 *  yield DISTINCT signatures — so two loci (Mac + NAS) can never publish "the same" generation from
 *  materially different embedders (a q8-vs-fp32 or upstream-reupload divergence the bare `<id>:<dim>`
 *  missed). A pinned immutable `revision` is the actual guarantee; the rest disambiguate config. */
export interface EmbedderId {
  readonly id?: string;
  /** Immutable model revision (e.g. an HF commit sha) the impl pins its download to. */
  readonly revision?: string;
  /** Quantization / weight dtype, e.g. "q8" vs "fp32" — same model name, different weights. */
  readonly dtype?: string;
  /** Pooling strategy, e.g. "mean" | "cls". */
  readonly pooling?: string;
  /** Max input length the impl feeds the model (chars or tokens per the impl's own unit). */
  readonly truncation?: number;
}

/** The embedding signature pinned into an index (H1, GBrain). Base `<model-id>:<dim>`; a real
 *  embedder appends its pinned identity (`rev=…:dt=…:pool=…:trunc=…`) in fixed order. A change is a
 *  hard stop on open — a same-dim model/weight/config swap would silently mis-recall otherwise.
 *  Backward-compatible: an embedder exposing only {id,dim} keeps its historical signature, so the
 *  golden fixtures' fakes are unaffected; only richer embedders (E5) get the extended tail. */
export function embeddingSignature(e: Embedder): string {
  const x = e as Embedder & EmbedderId;
  const base = `${x.id ?? "e"}:${e.dim}`;
  const extra = [
    x.revision != null ? `rev=${x.revision}` : null,
    x.dtype != null ? `dt=${x.dtype}` : null,
    x.pooling != null ? `pool=${x.pooling}` : null,
    x.truncation != null ? `trunc=${x.truncation}` : null,
  ].filter((s): s is string => s !== null);
  return extra.length ? `${base}:${extra.join(":")}` : base;
}

export interface RememberResult {
  indexed: number;   // newly embedded/written (new or content-changed)
  skipped: number;   // unchanged (content hash matched) — no re-embed
}

/** The persisted index_scope signature (closure sprint 3B): the sha256 of the exclude globs the
 *  index was BUILT with, plus whether that build bypassed scope (`--ignore-scope`). Advanced ONLY by
 *  a full reindex's authoritative prune — a bounded (`--max`) run leaves it untouched, so a partial
 *  run can never falsely bless stale excluded rows. Cross-star (`--ops`) reads refuse when the
 *  persisted hash differs from current policy, the signature is missing, or `ignoreScope` is set. */
export interface ScopeSignature {
  hash: string;
  ignoreScope: boolean;
}

/** The derived-index surface (substrate plug-in). `remember` here = *index* these items;
 *  it does NOT write canonical markdown. Used by `reindex` and by `MemoryStore`. */
export interface Store {
  remember(items: MemoryItem[]): Promise<RememberResult>;
  recall(q: RecallQuery): Promise<RecallResult[]>;
  /** Remove items from the derived index (used by supersede/forget). */
  remove(ids: string[]): Promise<number>;
  /** Prune the index to only `keepIds` — full-reindex GC so deleted/tombstoned files leave the
   *  index (H2/D7). Returns the number of stale rows removed. */
  prune(keepIds: string[]): Promise<number>;
  /** H2 dirty-marker epoch (optional): set at the start of a FULL rebuild, cleared only after
   *  its prune commits. An interrupted run leaves the marker; the store refuses normal opens
   *  until a full reindex completes — no partial live index is silently served. */
  beginReindex?(): Promise<void>;
  endReindex?(): Promise<void>;
  /** Persist the index_scope signature (closure sprint 3B). Called by a FULL reindex ONLY, so the
   *  hash advances exactly with the authoritative prune. */
  setScopeSignature?(sig: ScopeSignature): Promise<void>;
  /** H2: INVALIDATE the persisted index_scope signature — a full rebuild from an absent/invalid
   *  manifest (configless own-star rebuild) calls this so a cross-star read stays fail-closed
   *  until a fresh VALID scoped reindex re-stamps. Clearing (not merely declining to stamp) closes
   *  the delete→configless-rebuild→restore-identical-manifest re-admission exploit. */
  clearScopeSignature?(): Promise<void>;
  /** The persisted index_scope signature, or null when the index has never stamped one. */
  getScopeSignature?(): Promise<ScopeSignature | null>;
  /** generation-v1 (canon re-homing R5#1): persist the content-generation hash stamped by a FULL
   *  index build — sha256 over the canonical "v1" encoding of (path, content-hash, trust) records
   *  ‖ index scope ‖ parser version ‖ embedding spec ‖ index schema version (see funes-engine/src/
   *  generation.ts, the ONE encoding module). Deterministic across loci: two builds of identical
   *  content in different dirs stamp the SAME value, so canon/follower divergence is observable. */
  setGeneration?(generation: string): Promise<void>;
  /** The persisted generation, or null when the index predates generation stamping. */
  getGeneration?(): Promise<string | null>;
}

/** Lifecycle + provenance frontmatter for agent-written memory (`out_memory/<id>.md`).
 *  Per D7 (PLAN Amend 2026-06-08d): markdown is canonical; these fields drive supersession
 *  chains and tombstones, and MUST survive `reindex` deterministically. */
export interface MemoryMeta {
  created?: string;
  updated?: string;
  sources?: string[];
  trust?: Trust;
  tags?: string[];
  /** supersession chain: this item was replaced by <id>. Excluded from recall. */
  superseded_by?: string;
  valid_until?: string;
  /** P5.19 — the STATE/EVENT bit. `true` marks a claim that can go stale and is expected to be
   *  REPLACED by a later assertion of the same fact ("the retainer is X"); `false`/absent marks an
   *  EVENT, a record of something that happened, which is append-only and never goes stale.
   *  The distinction is the caller's (funes never names an LLM); funes's job is to carry it, index
   *  it, and let ranking see it. Read at index time by markdown.ts alongside `as_of`. */
  volatile?: boolean;
  /** Validity time for a volatile claim — when this was true, as distinct from when the file was
   *  edited. `as_of` beats `updated` for freshness. */
  as_of?: string;
  /** soft tombstone: suppressed from recall, file retained. Excluded from recall. */
  forgotten?: boolean;
}

/** A memory item is "tombstoned" (excluded from the derived index) iff superseded or forgotten. */
export function isTombstoned(meta: MemoryMeta | undefined): boolean {
  return !!meta && (meta.forgotten === true || meta.superseded_by != null);
}

/** Input to `MemoryStore.remember`: like a MemoryItem but `id` is optional (the store assigns
 *  one under `out_memory/`) and provenance/lifecycle ride in `meta`. */
export interface RememberInput {
  id?: string;
  title: string;
  body: string;
  type?: string;
  edges?: MemoryEdge[];
  meta?: MemoryMeta;
}

export interface RememberManyResult extends RememberResult {
  ids: string[];
}

/** The Library/domain surface (D7 write-through). The A/B implementation writes canonical
 *  markdown (`out_memory/<id>.md`) FIRST, then reflects into the derived `Store`. This is the
 *  surface a harness (Flue `SessionStore`, an MCP server, a CLI) consumes. */
export interface MemoryStore {
  remember(inputs: RememberInput[]): Promise<RememberManyResult>;
  recall(q: RecallQuery): Promise<RecallResult[]>;
  /** Write `next` as a new item; mark `oldId` superseded_by it (old file kept, off-index). */
  supersede(oldId: string, next: RememberInput): Promise<{ id: string }>;
  /** Add a typed edge from `fromId` to `toId` (default `related_to`). */
  link(fromId: string, toId: string, type?: string): Promise<void>;
  /** Soft tombstone by default (frontmatter `forgotten: true`, off-index, file kept).
   *  `{ hard: true }` deletes the markdown file outright. */
  forget(id: string, opts?: { hard?: boolean }): Promise<void>;
}
