/** Canonical memory-item + the contracts funes-core depends on (storage/embedder injected). */
import type { Version } from "./vault.ts";
import type { RecallFilter } from "./filter.ts";

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
  /** ADR-0013: the page's scalar frontmatter (strings, finite numbers, booleans; any other value
   *  left out), stored as `nodes.frontmatter`. Metadata-only: not in `hashItem`, so an edit never
   *  re-embeds, but in the content generation (v3). Absent: the row stores null and matches no `where`. */
  frontmatter?: ScalarFrontmatter;
}

export interface RecallQuery {
  query: string;
  k?: number;
  /** ADR-0015: the star's declared collapse keys (`memory.recall.collapse`), read live by the op and
   *  passed here — near-duplicate collapse also keys on their frontmatter values. The store never
   *  reads star.yaml. Absent or empty: collapse keys on trust, zone and title alone. */
  collapse?: string[];
  /** ADR-0013: a `where` funes-engine compiled against the star's live declaration. The arms return
   *  only pages whose stored frontmatter passes `matchesFilter` (inside FTS, inside the vector scan,
   *  and on the fused list). A store that cannot apply it refuses; it never ignores it. */
  filter?: RecallFilter;
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
   *  ordering key — order is trust × zone × entity-adjusted, then tiebroken, so re-sorting by `score` silently produces a different ranking than the one
   *  returned. `rank` is the authoritative order and survives filtering or merging. */
  rank?: number;
  /** ADR-0013/0015: the page's scalar frontmatter as the index stores it. Never sent as is: the op
   *  layer projects it to the star's served keys (`fields`). */
  frontmatter?: ScalarFrontmatter;
}

/** ADR-0013: a page's scalar frontmatter, the `nodes.frontmatter` column parsed. */
export type ScalarFrontmatter = Record<string, string | number | boolean>;

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
 *  yield DISTINCT signatures — so two loci (Mac + NAS) can never publish "the same" CONTENT
 *  GENERATION from materially different embedders (a q8-vs-fp32 or upstream-reupload divergence the
 *  bare `<id>:<dim>` missed). A pinned immutable `revision` is the actual guarantee; the rest
 *  disambiguate config. */
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
  /** Texts per runtime forward. It shapes the vectors (q8 quantization scales per forward), so it
   *  is signed (PLAN-0.4.0 items 8 + 13, ADR-0008). */
  readonly forwardBatch?: number;
  /** The OS, CPU architecture and onnxruntime version the vectors are computed on. RAI-152 measured
   *  one signature and two vectors across darwin/arm64 and linux/x64, so these are signed (PLAN-0.4.0
   *  item 3, extend branch): two platforms never claim one content generation over different rows.
   *  The impl supplies them — funes-core reads no runtime global (H7). */
  readonly platform?: string;
  readonly arch?: string;
  /** The instruction-set class onnxruntime's MLAS dispatches its fp32 kernels on (RAI-289: an EPYC
   *  7763 and an EPYC 9V45 gave two vectors under one signature). Declared on linux-x64 only; null
   *  or absent elsewhere, so every other locus keeps its signature byte for byte. */
  readonly isa?: string | null;
  readonly ort?: string;
  /** ADR-0015: 16 hex hashing the canary vectors an embedder recorded, for an embedder whose runtime
   *  the code cannot pin (Workers AI). Append-only, signed last as `cfp=`, so a canary re-recorded
   *  after drift moves the signature. Absent for E5: every Mac locus keeps its signature byte for byte. */
  readonly canary?: string | null;
}

/** The embedding signature pinned into an index (H1, GBrain). Base `<model-id>:<dim>`; a real
 *  embedder appends its pinned identity as `key=value` segments in FIXED order —
 *  `rev=…:dt=…:pool=…:trunc=…:fwd=…:plat=…:arch=…[:isa=…]:ort=…[:cfp=…]` — each present only when set and joined by
 *  `:` (no value contains one), so it splits back unambiguously. A change is a hard stop on open — a
 *  same-dim model/weight/config/runtime swap would silently mis-recall otherwise.
 *
 *  NOT one of the three signatures (PLAN-0.3.0 P1): this names the EMBEDDER, and it enters the
 *  content generation as the `embeddingSpec` tail input. The embedding-content FINGERPRINT — the
 *  only trigger for a re-embed — is `hashItem()` in funes-core generation.ts.
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
    x.forwardBatch != null ? `fwd=${x.forwardBatch}` : null,
    x.platform != null ? `plat=${x.platform}` : null,
    x.arch != null ? `arch=${x.arch}` : null,
    x.isa != null ? `isa=${x.isa}` : null,
    x.ort != null ? `ort=${x.ort}` : null,
    x.canary != null ? `cfp=${x.canary}` : null,
  ].filter((s): s is string => s !== null);
  return extra.length ? `${base}:${extra.join(":")}` : base;
}

export interface RememberResult {
  indexed: number;   // newly embedded/written (new or content-changed)
  skipped: number;   // unchanged (content hash matched) — no re-embed
}

/** The persisted index_scope signature (closure sprint 3B): the sha256 of the exclude globs the
 *  index was BUILT with, plus whether that build bypassed scope (a pre-0.6.0 `--ignore-scope`; the
 *  flag is gone, the stored marker is still read and refused — RAI-306 Q4). Advanced ONLY by
 *  a full build's finalize, with its prune, so no partial run can bless stale excluded rows. Cross-star (`--ops`) reads refuse when the
 *  persisted hash differs from current policy, the signature is missing, or `ignoreScope` is set. */
export interface ScopeSignature {
  hash: string;
  ignoreScope: boolean;
}

/** The derived-index surface (substrate plug-in). `remember` here = *index* these items;
 *  it does NOT write canonical markdown. Used by `reindex` and by `MemoryStore`. */
export interface Store {
  /** `swaps`: the pages the caller's write swapped, whose stat rows the index records (RAI-318). */
  remember(items: MemoryItem[], swaps?: PageSwap[]): Promise<RememberResult>;
  recall(q: RecallQuery): Promise<RecallResult[]>;
  /** Remove items from the derived index (used by supersede/forget). */
  remove(ids: string[], swaps?: PageSwap[]): Promise<number>;
  /** The persisted index_scope signature, or null when the index has never stamped one. */
  getScopeSignature?(): Promise<ScopeSignature | null>;
}

/** What `finalizeReindex` commits, in one transaction (PLAN-0.3.0 item 12). */
export interface FinalizeReindex {
  /** The content generation the completed FULL build establishes — the canonical identity of the
   *  rows the index now holds (funes-core generation.ts, the ONE encoding module). Deterministic
   *  across loci: two builds of identical content in different dirs stamp the SAME value, so
   *  canon/follower divergence is observable. */
  contentGeneration: string;
  /** The built scope this run establishes: a signature STAMPS it, `null` CLEARS it (an absent/
   *  invalid-manifest configless rebuild must not re-bless re-admitted files), `undefined` leaves
   *  the prior one alone. Same tri-state the separate set/clearScopeSignature calls had — moved in
   *  here because the built scope describes the rows this transaction is naming. */
  scope?: ScopeSignature | null;
  /** PLAN-0.4.0 item 6 (RAI-124, ADR-0007): the version of EVERY file this full run walked,
   *  tombstones included — the record freshness is judged against. It REPLACES the whole stat
   *  record in the same transaction and is stamped with the same instant as `last_reindex_at`.
   *  Absent, the prior record stays but loses its stamp, so freshness answers `null` rather than
   *  comparing the vault against a record some earlier build wrote. A backend that keeps no stat
   *  record ignores it. */
  pageStats?: PageStat[];
  /** PLAN-0.5.0 item 20 (ADR-0012 §What keeps it true): the OKF drift counters this full build took,
   *  stamped as meta `okf_nonconformant` / `okf_malformed`. Absent or null clears them — the star
   *  opted out (`memory.okf: false`), or the build did not count — so no older count passes as this
   *  build's. */
  okf?: OkfCounts | null;
}

/** The OKF floor's drift counters over a star's OKF scope (the index scope minus the incoming zone)
 *  plus its reserved `index.md`/`log.md` files. `nonconformant`: files that are not a fixed point of
 *  the normalizer — an edit it would make, or a refusal; `malformed`: the refusals whose frontmatter
 *  does not parse (a subset of `nonconformant`). */
export interface OkfCounts {
  nonconformant: number;
  malformed: number;
}

/** RAI-124: one walked page's version as a full build recorded it. `id` is the page id — the
 *  vault-relative path minus `.md`, exactly as the walk derives it. `version` is opaque and compared
 *  for equality only, never ordered (ADR-0007, ADR-0015): a folder's is its lstat triple (funes-core
 *  `lstatVersion`), an edge's the R2 etag the build read the bytes with. */
export interface PageStat {
  id: string;
  version: Version;
  /** RAI-318: the sha256 of the bytes `version` names, when the writer had them (a funes write, a
   *  build since 0.6.0). On a version mismatch, freshness compares it with the file's bytes. */
  hash?: string | null;
}

/** RAI-318: one page a funes write swapped — the version the swap returned and the sha256 of the
 *  bytes it wrote, or `version: null` when the swap removed the file. The index upserts (or drops)
 *  the page's stat row in the same index update. */
export interface PageSwap {
  id: string;
  version: Version | null;
  hash: string | null;
}

/** RAI-124: the stat record an index holds, and `at` — its `page_stat_at` stamp, which must equal
 *  `last_reindex_at` for the record to describe the build the rows came from. */
export interface PageStatRecord {
  at: string | null;
  rows: PageStat[];
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
  /** Soft tombstone by default (frontmatter `forgotten: true`, off-index, file kept).
   *  `{ hard: true }` deletes the markdown file outright. */
  forget(id: string, opts?: { hard?: boolean }): Promise<void>;
}
