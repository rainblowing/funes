export { PostgresStore, ftsQuery, vecLiteral } from "./store.ts";
export type { HotlistRow, GraphArtifact, GraphNode, GraphEdge, NeighborsResult, FunesIndexStore } from "./store.ts";
export { makeStore, funesBackend, funesDbDir } from "./factory.ts";
export type { FunesBackend, MakeStoreOpts } from "./factory.ts";
export { FunesStore } from "./funes-store.ts";
export type { FunesStoreOpts } from "./funes-store.ts";
export { E5Embedder, E5_MODEL, E5_DIM } from "./embedder.ts";
export { CrossEncoderReranker, RERANK_MODEL } from "./rerank.ts";
export type { Reranker } from "./rerank.ts";
export { parseFrontmatter, fileToItem, fileToItemWithMeta, metaFromData } from "./markdown.ts";
export {
  slugify, memoryId, absFor, frontmatterFor, writeMemoryItem,
  readMemoryFile, patchFrontmatter, deleteMemoryFile,
} from "./write.ts";
export { walkMd, indexDir, buildBasenameMap, resolveEdgeTargets } from "./reindex.ts";
export type { WalkOpts } from "./reindex.ts";
export { zoneOfDir, zoneOfFile, memoryZoneOf } from "funes-shared";
export type { Zone } from "funes-shared";
export { operations, createRegistry, buildToolDefs, dispatchToolCall, opCapabilities } from "./ops.ts";
export type { Operation, OperationContext, McpToolDef, OpCapability } from "./ops.ts";
export { buildApp } from "./app.ts";
export type { BuildAppOpts } from "./app.ts";
export { startDaemon } from "./daemon.ts";
export type { DaemonOpts } from "./daemon.ts";
export { daemonProbe, DEFAULT_DAEMON_PORT } from "./daemon-client.ts";
export type { DaemonClient } from "./daemon-client.ts";
// index_scope boundary helpers (closure-sprint 3B): the harness reindex path stamps the same
// scope signature the funes CLI does — cross-star reads refuse without a current one. H5: the
// twinkling binding consumes canonicalizeScopeExcludes so its hash + predicate match funes byte
// for byte (one canonicalizer, no clean-hash/dirty-predicate divergence).
export { canonicalizeScopeExcludes, readIndexScopeExcludes, scopeHash, buildScopeExclude, crossStarExpectedHash } from "./scope.ts";
export type { ScopeExcludesResult } from "./scope.ts";
export type { ScopeSignature } from "funes-core";
// generation-v1 + the cross-process publication protocol (canon re-homing Rev 6, R5#1/#2) — THE
// one encoding module, the manifest writer/consumer, and the coordination-lock seam (plan item 12).
export {
  GENERATION_VERSION, PARSER_VERSION, INDEX_SCHEMA_VERSION,
  hashItem, normalizeGenerationPath, generationRecord, encodeGeneration,
} from "funes-shared";
export type { GenerationRecord, GenerationInputs } from "funes-shared";
export {
  GENERATION_MANIFEST, manifestPath, readGenerationManifest, publishGenerationManifest,
  collectGenerationRecords, computeTargetGeneration, publishReindex, PublishedIndex, hasPublishedGeneration,
} from "./publication.ts";
export type { GenerationManifest, PublishReindexOpts, PublishReindexResult, PublishedIndexOpts } from "./publication.ts";
export { coordinationDir, withCoordination } from "./coordination.ts";
// the memory service's HTTP faces (broker/read; re-homing Phase R1/R2) — startFace is the
// composition's entrypoint (face.ts also runs directly via `bun src/face.ts --face …`).
export { startFace, makeFaceDeps, resolveFaceOps, resolveBrokerOps, assertBindPolicy, DEFAULT_BROKER_OPS, DEFAULT_READ_OPS } from "./face.ts";
export type { FaceKind, FaceOpts, FaceStoreOpts, FaceDeps, ServeContext, RunningFace } from "./face.ts";
