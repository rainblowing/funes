// P3.14: the index-store CONTRACT (these interfaces) is funes-core's, types only. The postgres
// implementation left in 0.6.0 (RAI-325); the libSQL store is libsql/store.ts. Re-exported so
// existing importers are unchanged.
export type { HotlistRow, FunesIndexStore, IndexStats } from "funes-core";
export type { FreshnessFields, GraphNode, GraphEdge, GraphArtifact, GraphAuditRows, IndexedPage, NeighborsResult, GuardedResult, ServingIndex, ContentIdentity } from "funes-core/internal";
