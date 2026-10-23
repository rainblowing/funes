// The funes INDEX-STORE contract — the type surface every backend (the libSQL adapter, the DO index)
// implements, and that the daemon / ops / surface consume. Types only: no runtime code,
// so it lives in the edge-portable core (P3.14 — the libSQL package importing these from funes-engine was
// the other half of the package cycle that blocked publishing). The IMPLEMENTATIONS stay in their
// backends; the graph-bake helpers that produce GraphArtifact stay in funes-engine.
import type { MemoryItem, OkfCounts, PageStatRecord, PageSwap, RecallQuery, RecallResult, RememberResult, ScalarFrontmatter, ScopeSignature, Store } from "./types.ts";
import type { ScopeExpectation } from "./scope-guard.ts";
import type { BuildInput, BuildResult } from "./sql-index.ts";

/** Rev 7 freshness (a): volatility/freshness frontmatter carried on MemoryItem past the
 *  funes-core type. Metadata-only like trust (H4) — excluded from the content hash, synced on
 *  every remember() pass, never a re-embed. `freshness` = `as_of:` else `updated:` else null. */
export interface FreshnessFields {
  volatile?: boolean;
  freshness?: string | null;
}

/** One row of the R8 hot-cache telemetry: a trusted page + its advisory recall counters. */
export interface HotlistRow {
  id: string;
  title: string;
  path?: string;
  trust: string;
  hit_count: number;
  last_recalled: string | null;
}

// ── graph-viz bake (P1) — the baked global-constellation artifact (store.graph()) ──────────
export interface GraphNode {
  id: string; label: string;
  x: number; y: number;        // baked forceAtlas2 layout — the browser only renders
  community: number;           // Louvain cluster, remapped to size-rank (0 = largest) for a stable palette
  degree: number;              // simple-graph degree → node size ("god nodes")
  zone: string;                // incoming | output | wiki
  type: string | null;         // entity | concept | source | synthesis
  trust: string;               // border channel
  hit_count: number;           // R8 recall telemetry (advisory; 0 when untracked)
}
export interface GraphEdge { source: string; target: string; type: string; family: string; weight: number }
export interface GraphArtifact {
  signature: string;           // = sig:nodeCount:md5(content_hashes):sim<k>@<cutoff> — cache key; rebuild when it flips
  builtAt: string;
  stats: { nodes: number; edges: number; simEdges: number; communities: number };
  nodes: GraphNode[];
  edges: GraphEdge[];          // typed frontmatter edges (family ∈ 5 funes families) + thresholded similarity edges (family "similarity")
}

// ── graph audit (PLAN-0.2.1 step 24) — the RAW rows `funes doctor` reasons over ────────────────
/** Every node id, and every typed edge exactly as STORED. Deliberately unjoined and
 *  unnormalized, which is the whole point: a dangling edge is one whose target has no node to
 *  join to, so a joining query cannot see it, and a spelling fork is invisible the moment
 *  `normalizeRelationType` is applied. `graph()` does both (it drops edges whose ends are absent
 *  and maps types to families), so it is the wrong instrument for an audit no matter how it is
 *  filtered afterwards.
 *
 *  Backend-neutral by construction: both backends return rows and NOTHING else — the definitions
 *  of "dangling", "orphan" and "fork" live in one pure function (funes-engine's doctor.ts), so
 *  the two backends cannot drift into two different answers about the same graph. */
export interface GraphAuditRows {
  nodeIds: string[];
  edges: Array<{ source: string; type: string; target: string }>;
}

/** indexedPage() return shape — one page's INDEXED snapshot (title/body/metadata as last indexed),
 *  served from the DATABASE only. The cross-star (--ops) read body: no filesystem read, so a
 *  deleted-but-indexed file still answers and an on-disk-but-unindexed (index_scope-excluded) file
 *  does not — the index is the capability boundary, with no TOCTOU. */
export interface IndexedPage {
  id: string;
  path: string | null;
  title: string;
  type: string | null;
  trust: string;
  description: string | null;
  resource: string | null;
  /** Provenance-v1: DECLARED `source`/`authored` (ISO) + STAMPED `writeActor` ("unknown" legacy). */
  source: string | null;
  authored: string | null;
  writeActor: string;
  body: string;
  /** ADR-0013/0015: the page's scalar frontmatter as indexed; the op layer projects it to the
   *  star's served keys. Absent from an index that does not store it yet. */
  frontmatter?: ScalarFrontmatter | null;
}

/** neighbors() return shape — the graph-explorer / inspector data source. */
export interface NeighborsResult {
  node: { id: string; title: string; path?: string; trust?: string; type?: string } | null;
  similar: Array<{ id: string; title: string; path?: string; trust?: string; score: number }>;
  edgesOut: Array<{ type: string; id: string; title: string | null; trust?: string }>;
  edgesIn: Array<{ type: string; id: string; title: string | null; trust?: string }>;
}

/** H9: the result of a guarded cross-star read — a refusal reason OR the retrieved value. Never
 *  throws for a boundary refusal (the op layer maps `refusal` to a thrown MCP error). */
export type GuardedResult<T> = { refusal: string } | { ok: T };

/** What a database answers about ITS OWN identity (PLAN-0.3.0 item 8). The publication id it once
 *  carried beside the content generation is no longer reported (RAI-306 Q9): the per-build identity
 *  is `lastReindexAt` (IndexStats), and the publisher reads its own stamp from the meta table.
 *
 *  - **contentGeneration** — the canonical identity of the rows the index holds RIGHT NOW, and
 *    therefore NULLABLE: an incremental mutation clears it, because the rows no longer match any
 *    completed build. ONLY the database answers it. Null has four causes, all of them honest: never
 *    stamped, a legacy v1 stamp (computed over a narrower field set, and never invalidated by the
 *    incremental writes this release exists to fix — so it is reported invalid, not reinterpreted),
 *    invalidated by a mutation, or a build in flight. */
export interface ContentIdentity {
  contentGeneration: string | null;
  /** Always null since 0.6.0 (RAI-307 Q2): an index keeps no invalidation record. The health
   *  envelope (RAI-308) drops the field. */
  invalidatedAt: string | null;
  /** Why there is no content generation, when the index can say: a legacy stamp. Diagnostic, never
   *  parsed. */
  invalidatedReason: string | null;
}

/** The read-only health snapshot (`stats()`) both backends return — one declaration instead of the
 *  identical inline type repeated at three call sites. Carries the index_scope signature so the
 *  cross-star (`--ops`) serve-time guard can read it over the daemon-proxy path, and the content
 *  identity so `health` can say WHY it has no content generation. */
export interface IndexStats extends ContentIdentity {
  nodes: number;
  edges: number;
  /** RAI-206 (record 33): COUNTS only, so `health` stays a counts-and-identity op — the vector rows,
   *  nodes per trust value, and nodes per vault zone (by the node id's directories). */
  chunks: number;
  trust: Record<string, number>;
  zones: { incoming: number; output: number; wiki: number };
  embeddingSignature: string | null;
  reindexDirty: boolean;
  lastReindexAt: string | null;
  scopeHash: string | null;
  ignoreScope: boolean;
  /** PLAN-0.3.0 item 20: the index schema version this database is stamped with, so an operator
   *  reads WHICH schema is being served rather than inferring it from a build that opened cleanly.
   *  `null` where the backend does not persist one (no `schema_version` row) —
   *  reported as unknown rather than as the serving process's own constant, which would be a
   *  claim about the database that the database never made. */
  schemaVersion: string | null;
  /** PLAN-0.5.0 item 20: the OKF drift counters the last FULL build stamped, or null — never built,
   *  `memory.okf: false`, or a backend that keeps none. Served by `health` and `doctor`. */
  okf: OkfCounts | null;
}

/** The narrow serving surface (ADR-0015): what FunesStore and the dispatcher's context hold, and all
 *  an edge index (a Durable Object's SQLite) implements. Folder-only ops — health's operator state,
 *  neighbors, graph, hotlist, freshness — take the full `FunesIndexStore` from the context's folder
 *  part instead. The edge store's commit, build batch and swap stay funes-cf-internal.
 *
 *  The staging invariant: inside an apply frame, `remember`/`remove` STAGE rows, with no
 *  read-your-writes — a `recall` in the same frame does not see them — and they become durable only
 *  at S4, the frame's commit (record 24). A caller indexes the bytes it staged, never a read-back. */
export interface ServingIndex {
  /** `swaps` (RAI-318): the pages the caller's write swapped. Each upserts its stat row, or drops it
   *  when the swap removed the file, in the same index update as the rows. */
  remember(items: MemoryItem[], swaps?: PageSwap[]): Promise<RememberResult>;
  /** Drops the rows; a stat row stays unless `swaps` names its page as removed (RAI-318). */
  remove(ids: string[], swaps?: PageSwap[]): Promise<number>;
  recall(q: RecallQuery): Promise<RecallResult[]>;
  /** Cross-star (--ops) read: one page's INDEXED snapshot by node id or vault-relative path, from
   *  the DATABASE only (never the vault filesystem). null when it is not in the index. */
  indexedPage(ref: { id?: string; path?: string }): Promise<IndexedPage | null>;
  stats(): Promise<IndexStats>;
  /** PLAN-0.4.0 item 6 (RAI-124, ADR-0007): the per-page version record the last FULL build wrote —
   *  every page it read, tombstones included — and each funes write since upserted (RAI-318), with
   *  its `page_stat_at` stamp. It is
   *  `vaultChangedSince`'s record (0.3.0 item 18): the record names every page the
   *  build covered, so it answers the deletion half as well as the edit half.
   *
   *  `null` when there is no record to compare against — a backend that keeps none, or
   *  a read-only handle over an index built before the table existed. Never an empty record: that
   *  would read as "the build walked no files", and every page on disk would report changed. */
  pageStats(): Promise<PageStatRecord | null>;
  /** H9 + PLAN-0.3.0 item 16: the ATOMIC serve guard — refuse-check the index_scope boundary,
   *  retrieve, and re-check in one guarded read, so a reindex that re-admits excluded rows between
   *  check and retrieval can never be served. `retrieve` runs the actual read (recall/indexedPage).
   *
   *  `expected` is a THUNK, not a hash, and that is item 16's whole point: the DESIRED scope is
   *  local policy read from live `star.yaml`, so it must be recomputed AFTER retrieval as well as
   *  before it. Passing a precomputed hash closed the built-scope window and left the desired-scope
   *  one wide open — a `star.yaml` that narrowed mid-read still had its rows served. */
  guardedRead<T>(expected: () => ScopeExpectation, retrieve: () => Promise<T>): Promise<GuardedResult<T>>;
  /** PLAN-0.3.0 item 7/20: THIS process's serving signature — what outside the rows changes what a
   *  query returns: the backend and `RANKING_VERSION` (RAI-307 fixed the rest as constants).
   *  Process-local by definition, so it is reported and NEVER published as authority. */
  servingSignature(): string;
  close(): Promise<void>;
}

/** The FULL funes index-store surface the libSQL backend (funes-engine) implements — the
 *  base funes-core Store and the serving surface, plus the read/telemetry/bake methods the daemon,
 *  folder-only ops and surface consume. makeStore() returns this for every backend
 *  (libsql, turso), with no cast. */
export interface FunesIndexStore extends Store, ServingIndex {
  neighbors(id: string, k?: number): Promise<NeighborsResult>;
  hotlist(n?: number): Promise<HotlistRow[]>;
  graph(opts?: { iterations?: number; simTopK?: number; simCutoff?: number }): Promise<GraphArtifact>;
  /** The graph audit's read-only source (step 24). Reads two columns' worth of rows and writes
   *  nothing — no prune, no rewrite, no `graph.json`. Required, not optional: an audit that
   *  silently answers "no findings" on the backend that did not implement it is worse than one
   *  that does not build. */
  auditGraph(): Promise<GraphAuditRows>;
  /** `stats().lastReindexAt` alone — one meta read. A recall's freshness check reads this, never
   *  `stats()`, whose counts (chunks, trust, zones) are health's. */
  lastReindexAt(): Promise<string | null>;
  readonly recallTracking: boolean;
  /** The resource the star's write lock is keyed on: a live read-write index reports its path,
   *  `funesDbDir(vault)` (RAI-309); a private build or an in-memory store, null. Exposed so a CALLER
   *  holds the same lock across a multi-step mutation — canonical markdown write + index update. */
  readonly lockResource: string | null;
  /** RAI-314: the one build walk (sql-index.ts) over this index, resumable at its cursor. A live
   *  index runs it under the star's write lock. */
  build(input: BuildInput): Promise<BuildResult>;
  getScopeSignature(): Promise<ScopeSignature | null>;
  /** This database's own answer about what it IS (item 8). The ONLY authority on the content
   *  generation. */
  contentIdentity(): Promise<ContentIdentity>;
  /** OPTIONAL (twinkling PLAN-0.2.1 step 2 / funes step 12): the identity of the star this index
   *  was built FROM, carried inside the database bytes rather than beside them — meta key
   *  `owner_star_id`.
   *
   *  The `owner-vault` marker does NOT cover this. That marker authenticates the DIRECTORY, so
   *  substituting a client star's `index.db` under the personal path leaves it intact and lying;
   *  only a stamp inside the file travels with the file. Two consumers depend on it: twinkling's
   *  publication gate refuses to ship a database whose stamp is not the star it claims, and the
   *  hub refuses to answer from one. Stamped by every FULL build (reindex.ts), so the LIVE index
   *  carries it too — a publish-only stamp would leave the gate's actual target unstamped.
   *
   *  Optional on the interface: libsql is the only backend either consumer opens.
   *
   *  A compare-and-set since RAI-157: it refuses (`ownerClaimRefused`) when the index already names a
   *  star `mayClaimIndex` does not accept — `was` is the claimant's declared previous id. */
  setOwnerStarId?(starId: string, opts?: { was?: string | null }): Promise<void>;
  getOwnerStarId?(): Promise<string | null>;
  /** OPTIONAL, libsql-only: publisher-side finalization — wal_checkpoint(TRUNCATE) +
   *  journal_mode=DELETE on the store's OWN handle, so a published generation db opens read-only
   *  from an RO mount with no -wal/-shm (publication.ts calls it right before close+publish).
   *  Absent on a backend with no SQLite journal to flip. */
  finalizeForPublish?(): Promise<void>;
}
