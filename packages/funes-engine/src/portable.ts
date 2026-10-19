// `funes-engine/portable` (PLAN-0.5.0 item 16, RAI-217; ADR-0011 "Where the portable code lives",
// ADR-0016): the workerd-portable subpath. A re-export file over the modules item 4's probe loaded
// and bundled in workerd (docs/research/0.5.0/36-workerd-bundle-probe.md): FunesStore, the page
// codec, reindex's walk and parity, the op registry and dispatchToolCall. funes-cf (ranked above
// funes-engine in lint-package-dag.ts) imports this entry, never a `src/` path.
//
// It is also the taste bot's codec entry (ADR-0017): `render()` + `parseFrontmatter`, so the bot's
// `put_page` bytes round-trip like the replica's. NOT `funes-engine/light`, twinkl.ing's entry.
// Every symbol here is contract; add one only with item 4's harness re-run proving it still bundles.
export { FunesStore } from "./funes-store.ts";
export type { FunesStoreOpts, StarConfig } from "./funes-store.ts";
export { parseFrontmatter, normalizePage, textToItemWithMeta } from "./markdown.ts";
export type { Normalized, OkfEdit, OkfRefusal } from "./markdown.ts"; // item 18: the OKF floor's normalizer (ADR-0012)
export { render } from "./write.ts";
export { sanitizeText } from "./sanitize.ts";
export { walkMd, statParity, referenceMaps, resolveEdgeTargets } from "./reindex.ts";
export type { Freshness, ReferenceMaps } from "./reindex.ts";
export { operations, dispatchToolCall, publicOpNames } from "./ops.ts";
export type { Operation, OperationContext } from "./ops.ts";
// item 42: the edge face's grants run the access file's own validator (item 41) and lookup. actor.ts
// was already in this bundle through ops.ts; item 4's harness re-run still bundles it, 11/11 OK.
export { assertActorName, grantFor, validateAccessPolicy } from "./actor.ts";
export type { AccessPolicy, Grant } from "./actor.ts";
// item 35: the edge writer reads its bundled star.yaml with the folder readers' own parsers, and
// proves its locus with the designation's own rule (write-designation.ts was already in the bundle
// through ops.ts).
export { starConfigFromText, sha256Hex } from "./funes-store.ts";
export { designationFor } from "./write-designation.ts";
// item 40: edge health names the proposal protocol the outbox's probe checks, with that very check,
// and answers freshness with the folder's own listing parity. proposal-protocol.ts imports only
// funes-core and write-designation.ts, and reindex.ts is already here (statParity).
export { PROPOSAL_PROTOCOL, probeRefusal } from "./proposal-protocol.ts";
export { vaultChangedSince } from "./reindex.ts";
// item 43: the /mcp entry answers 403 before the body for a grant that does not name the star, with
// the face's own rule (actor.ts, already bundled), and names its MCP server with the funes version
// (version.ts: one constant, already bundled through ops.ts).
export { grantCoversStar } from "./actor.ts";
export { FUNES_VERSION } from "./version.ts";
// item 55: the taste bot's `/new` names its page by the page-id rule's own path composition (record
// 25 §3, the reserved-name rule included), never a second copy of it. page-id.ts was already in this
// bundle through funes-store.ts (isItemPath).
export { itemPaths } from "./page-id.ts";
