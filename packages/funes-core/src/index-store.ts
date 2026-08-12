// The funes INDEX-STORE contract — the type surface both backends (funes-libsql, funes-engine's
// PostgresStore) implement, and that the daemon / ops / surface consume. Types only: no runtime code,
// so it lives in the edge-portable core (P3.14 — funes-libsql importing these from funes-engine was
// the other half of the package cycle that blocked publishing). The IMPLEMENTATIONS stay in their
// backends; the graph-bake helpers that produce GraphArtifact stay in funes-engine.
import type { MemoryItem, ScopeSignature, Store } from "./types.ts";

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
  stats(): Promise<{ nodes: number; edges: number; embeddingSignature: string | null; reindexDirty: boolean; lastReindexAt: string | null; scopeHash: string | null; ignoreScope: boolean; generation: string | null }>;
  close(): Promise<void>;
  readonly recallTracking: boolean;
  /** The resource the cross-process write lock is keyed on (the on-disk index path), or null for
   *  an in-memory store. Exposed so a CALLER can hold the same lock across a multi-step mutation —
   *  canonical markdown write + index update — instead of the index locking only its own half. */
  readonly lockResource: string | null;
  beginReindex(): Promise<void>;
  endReindex(): Promise<void>;
  setScopeSignature(sig: ScopeSignature): Promise<void>;
  clearScopeSignature(): Promise<void>;
  getScopeSignature(): Promise<ScopeSignature | null>;
  /** generation-v1 (canon re-homing R5#1): the persisted content-generation stamp of the last FULL
   *  build (generation.ts is the ONE encoding module). Stamped beside the index like the scope
   *  signature; null when the index predates generation stamping. Exposed via stats()/health. */
  setGeneration(generation: string): Promise<void>;
  getGeneration(): Promise<string | null>;
  /** OPTIONAL, libsql-only: publisher-side finalization — wal_checkpoint(TRUNCATE) +
   *  journal_mode=DELETE on the store's OWN handle, so a published generation db opens read-only
   *  from an RO mount with no -wal/-shm (publication.ts calls it right before close+publish).
   *  Absent on pglite/postgres (no SQLite journal to flip). */
  finalizeForPublish?(): Promise<void>;
  /** H9: the ATOMIC cross-star serve guard — refuse-check the index_scope boundary, retrieve, and
   *  re-check in one guarded read, so a reindex that re-admits excluded rows between check and
   *  retrieval can never be served. `retrieve` runs the actual read (recall/indexedPage). */
  guardedRead<T>(expectedHash: string, retrieve: () => Promise<T>): Promise<GuardedResult<T>>;
}
