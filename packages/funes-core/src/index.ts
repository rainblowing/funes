export type {
  MemoryItem, MemoryEdge, Trust, RecallQuery, RecallResult, RememberResult, Embedder, Store,
  MemoryMeta, RememberInput, RememberManyResult, MemoryStore, ScopeSignature, FinalizeReindex,
  PageStat, PageStatRecord, ScalarFrontmatter, OkfCounts,
} from "./types.ts";
export { isTombstoned, embeddingSignature } from "./types.ts";
export { rrf, rrfScores, DEFAULT_RRF_K } from "./rrf.ts";
// ADR-0013: the recall filter and its one membership function, shared by every store.
export { matchesFilter } from "./filter.ts";
export type { RecallFilter, FilterClause, FilterCondition, FilterScalar } from "./filter.ts";
export { normalizeRelationType } from "./relations.ts";
// The star identity grammar (PRD 2026-08-27, RAI-41). funes owns it; twinkling re-exports it
// through ts/src/funes-binding.ts, so ONE parser serves both repos (D12).
export { parseStarUri, parseCanonicalKey, isCanonicalKey, canonicalKey, refKey, sameStar, mayClaimIndex, ownerClaimRefused, formatStarUri, STAR_ACCESS, MAX_WORKNAME_DEPTH } from "./star-uri.ts";
export type { StarUri, StarAccess, StarUriRejection, ParseStarUriResult, ParseCanonicalKeyResult } from "./star-uri.ts";
export { buildGraphArm, resolveGraphArm, DEFAULT_GRAPH_ARM, GRAPH_ARM_DIR_W_IN, GRAPH_ARM_HUB_MAX, GRAPH_ARM_CAP_OUT, GRAPH_ARM_CAP_IN } from "./graph-arm.ts";
export type { GraphArm } from "./graph-arm.ts";
export type { GraphArmInput, GraphNeighborRow } from "./graph-arm.ts";
// P3.14 — seams promoted out of funes-engine so the backends never import the engine (acyclic DAG).
export { CHUNK_SIZE, CHUNK_OVERLAP, MAX_CHUNKS_PER_PAGE, CHUNK_SIG, chunkText } from "./chunking.ts";
export { scopeRefusalReason, guardRefusal, expectationRefusal } from "./scope-guard.ts";
export type { ScopeExpectation } from "./scope-guard.ts";
export type { Reranker } from "./rerank.ts";
export type { EmbedderId } from "./types.ts";
export type {
  FreshnessFields, HotlistRow, GraphNode, GraphEdge, GraphArtifact, GraphAuditRows,
  IndexedPage, NeighborsResult, GuardedResult, FunesIndexStore, ServingIndex, ContentIdentity, IndexStats,
} from "./index-store.ts";
// ADR-0016: the one credential parser for every funes HTTP surface (record 33).
export { isB64Token, presentedToken } from "./presented-token.ts";
export type { PresentedToken } from "./presented-token.ts";
// ADR-0011 (PLAN-0.5.0 item 11): the Vault port and its pure rules; the zone grammar moved here.
export { isPagePath, isSyncConflict, historyPath, assertWritable, zoneOfDir, zoneOfFile } from "./vault.ts";
export type { Vault, VaultTx, VaultPath, Version, VaultFile, VaultEntry, SwapResult, Zone } from "./vault.ts";
