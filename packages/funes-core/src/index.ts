// `funes-core` (RAI-313, RAI-315; ADR-0016, ADR-0022): the kernel entry of the Library. It exports
// exactly the symbols the contract page lists for it, and no symbol has a second entry. The host-only
// kernel symbols are on `funes-core/internal`; the HTTP MCP handler is on `funes-core/mcp-http`.
// identity grammar (PRD 2026-08-27, D12): one parser for funes and twinkl.ing
export { parseStarUri, canonicalKey, refKey, formatStarUri, STAR_ACCESS } from "./star-uri.ts";
export type { StarAccess } from "./star-uri.ts";
// page rules and the codec
export { isSyncConflict } from "./vault.ts";
export { normalizeRelationType } from "./relations.ts";
export { resolveTarget } from "./reindex.ts";
export type { ReferenceMaps } from "./reindex.ts";
export { parseFrontmatter, normalizePage } from "./markdown.ts";
export { render } from "./write.ts";
export { itemPaths, slug, pagesDigest } from "./page-id.ts";
export { scopeHash } from "./scope-hash.ts";
// the registry and the one dispatcher (ADR-0020, RAI-304)
export { dispatchToolCall, ceiling, opCapabilities, publicOpNames } from "./ops.ts";
export type { OpEntry, Tier, OperationContext, RecallHit, RecallEnvelope, Health } from "./ops.ts";
// authorization (RAI-310)
export { authorize } from "./authorize.ts";
export type { Refusal } from "./authorize.ts";
export { presentedToken } from "./presented-token.ts";
export { assertActorName } from "./actor.ts";
export type { Grant, AccessPolicy } from "./actor.ts";
// star config
export { validateRecallDeclaration } from "./recall-declaration.ts";
// RAI-315 Q11: the one port-level composition — a harness export, not frozen at 1.0.0.
export { portContext } from "./port-context.ts";
// stores and answers
export type { FunesIndexStore, IndexStats, HotlistRow } from "./index-store.ts";
export type { Embedder, Trust } from "./types.ts";
