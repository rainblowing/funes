// The funes INDEX-STORE contract — the type surface both backends (funes-libsql, funes-engine's
// PostgresStore) implement, and that the daemon / ops / surface consume. Types only: no runtime code,
// so it lives in the edge-portable core (P3.14 — funes-libsql importing these from funes-engine was
// the other half of the package cycle that blocked publishing). The IMPLEMENTATIONS stay in their
// backends; the graph-bake helpers that produce GraphArtifact stay in funes-engine.
import type { FinalizeReindex, MemoryItem, ScopeSignature, Store } from "./types.ts";
import type { ScopeExpectation } from "./scope-guard.ts";

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

/** What a database answers about ITS OWN identity (PLAN-0.3.0 item 8). Two fields, because the one
 *  "generation" string was answering two questions and could answer neither honestly:
 *
 *  - **publicationId** — IMMUTABLE once written, so local state (a principal's ack, a retention
 *    decision) can bind to it. Generated before a publication is finalized and stamped in BOTH the
 *    database and the manifest; a manifest names THIS, never the content generation.
 *  - **contentGeneration** — the canonical identity of the rows the index holds RIGHT NOW, and
 *    therefore NULLABLE: an incremental mutation clears it, because the rows no longer match any
 *    completed build. ONLY the database answers it. Null has four causes, all of them honest: never
 *    stamped, a legacy v1 stamp (computed over a narrower field set, and never invalidated by the
 *    incremental writes this release exists to fix — so it is reported invalid, not reinterpreted),
 *    invalidated by a mutation, or a build in flight. */
export interface ContentIdentity {
  publicationId: string | null;
  contentGeneration: string | null;
  /** When the content generation was invalidated, ISO — persisted ATOMICALLY with the invalidation
   *  (item 13), so an operator can see WHEN the index stopped matching a completed build. Null
   *  whenever `contentGeneration` is non-null. Recovery is MANUAL in 0.3.0 (`publish --force`):
   *  automatic republish rebuilds every embedding per home per write burst (review-log R3#9). */
  invalidatedAt: string | null;
  /** Which mutation invalidated it, e.g. `remember: 3 rows re-indexed`. Diagnostic, never parsed. */
  invalidatedReason: string | null;
}

/** The read-only health snapshot (`stats()`) both backends return — one declaration instead of the
 *  identical inline type repeated at three call sites. Carries the index_scope signature so the
 *  cross-star (`--ops`) serve-time guard can read it over the daemon-proxy path, and the content
 *  identity so `health` can say WHY it has no content generation. */
export interface IndexStats extends ContentIdentity {
  nodes: number;
  edges: number;
  embeddingSignature: string | null;
  reindexDirty: boolean;
  lastReindexAt: string | null;
  scopeHash: string | null;
  ignoreScope: boolean;
  /** PLAN-0.3.0 item 20: the index schema version this database is stamped with, so an operator
   *  reads WHICH schema is being served rather than inferring it from a build that opened cleanly.
   *  `null` where the backend does not persist one (postgres stamps no `schema_version` row) —
   *  reported as unknown rather than as the serving process's own constant, which would be a
   *  claim about the database that the database never made. */
  schemaVersion: string | null;
}

/** The FULL funes index-store surface both backends (funes-engine, funes-libsql) implement — the
 *  base funes-core Store plus the read/telemetry/bake methods the daemon, ops, and surface consume.
 *  makeStore() returns this, so FUNES_BACKEND swaps backends with no cast. */
export interface FunesIndexStore extends Store {
  neighbors(id: string, k?: number): Promise<NeighborsResult>;
  /** Cross-star (--ops) read: one page's INDEXED snapshot by node id or vault-relative path, from
   *  the DATABASE only (never the vault filesystem). null when it is not in the index. */
  indexedPage(ref: { id?: string; path?: string }): Promise<IndexedPage | null>;
  hotlist(n?: number): Promise<HotlistRow[]>;
  graph(opts?: { iterations?: number; simTopK?: number; simCutoff?: number }): Promise<GraphArtifact>;
  /** The graph audit's read-only source (step 24). Reads two columns' worth of rows and writes
   *  nothing — no prune, no rewrite, no `graph.json`. Required, not optional: an audit that
   *  silently answers "no findings" on the backend that did not implement it is worse than one
   *  that does not build. */
  auditGraph(): Promise<GraphAuditRows>;
  stats(): Promise<IndexStats>;
  close(): Promise<void>;
  readonly recallTracking: boolean;
  /** The resource the cross-process write lock is keyed on (the on-disk index path), or null for
   *  an in-memory store. Exposed so a CALLER can hold the same lock across a multi-step mutation —
   *  canonical markdown write + index update — instead of the index locking only its own half. */
  readonly lockResource: string | null;
  beginReindex(): Promise<void>;
  /** PLAN-0.3.0 item 12: the ONE atomic end of a full reindex — stamp the content generation, clear
   *  the invalidation, advance the built scope, clear the dirty marker, release the reindex lock. */
  finalizeReindex(f: FinalizeReindex): Promise<void>;
  setScopeSignature(sig: ScopeSignature): Promise<void>;
  clearScopeSignature(): Promise<void>;
  getScopeSignature(): Promise<ScopeSignature | null>;
  /** This database's own answer about what it IS (item 8). The ONLY authority on the content
   *  generation: a manifest names the publication id and nothing else. */
  contentIdentity(): Promise<ContentIdentity>;
  /** Stamp the publication id — IMMUTABLE. A second call with a DIFFERENT id THROWS: the id is the
   *  thing local state binds to, so a database that quietly renamed itself would strand every ack
   *  and retention decision keyed on the old one. Re-stamping the SAME id is a no-op (idempotent
   *  retry). Called by the publisher on the freshly built off-path database, before finalization. */
  setPublicationId(publicationId: string): Promise<void>;
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
   *  Optional on the interface: libsql is the only backend either consumer opens. */
  setOwnerStarId?(starId: string): Promise<void>;
  getOwnerStarId?(): Promise<string | null>;
  /** OPTIONAL, libsql-only: publisher-side finalization — wal_checkpoint(TRUNCATE) +
   *  journal_mode=DELETE on the store's OWN handle, so a published generation db opens read-only
   *  from an RO mount with no -wal/-shm (publication.ts calls it right before close+publish).
   *  Absent on pglite/postgres (no SQLite journal to flip). */
  finalizeForPublish?(): Promise<void>;
  /** H9 + PLAN-0.3.0 item 16: the ATOMIC serve guard — refuse-check the index_scope boundary,
   *  retrieve, and re-check in one guarded read, so a reindex that re-admits excluded rows between
   *  check and retrieval can never be served. `retrieve` runs the actual read (recall/indexedPage).
   *
   *  `expected` is a THUNK, not a hash, and that is item 16's whole point: the DESIRED scope is
   *  local policy read from live `star.yaml`, so it must be recomputed AFTER retrieval as well as
   *  before it. Passing a precomputed hash closed the built-scope window and left the desired-scope
   *  one wide open — a `star.yaml` that narrowed mid-read still had its rows served. */
  guardedRead<T>(expected: () => ScopeExpectation, retrieve: () => Promise<T>): Promise<GuardedResult<T>>;
  /** PLAN-0.3.0 item 18: every id the index currently holds. ID-ONLY by contract — `auditGraph()`
   *  was the only enumeration available and it scans every edge as well, which is why the deletion
   *  signal shipped with no affordable source and every caller left the argument undefined.
   *
   *  It exists for `vaultChangedSince`: an mtime walk cannot see a DELETION (a note that is gone
   *  leaves nothing behind to be newer), so the index's own id set is the record of the corpus the
   *  last full reindex covered. Called lazily behind that function's 30s memo, and skipped entirely
   *  whenever the walk already found a newer file. */
  indexedIds(): Promise<string[]>;
  /** PLAN-0.3.0 item 15/17: a RANDOM id generated once, inside the database, and never changed.
   *  Machine-local state binds to `publicationId ?? instanceId` — never to a path hash, which is
   *  unchanged when a DIFFERENT database replaces the file at that path, so a path-keyed binding
   *  would silently declare a stranger's index "authored here". `null` only for a database old
   *  enough to predate the stamp AND opened read-only (a writable open stamps one on init). */
  instanceId(): Promise<string | null>;
  /** PLAN-0.3.0 item 7/20: THIS process's serving signature — everything outside the rows that
   *  changes what a query returns (backend, ranking semantics, effective fusion/graph/ef_search
   *  settings, bm25 weights, the adjustment versions, the reranker's identity). Computed here
   *  because the store is the only thing that holds all of those; process-local by definition, so
   *  it is reported and NEVER published as authority. */
  servingSignature(): string;
}
