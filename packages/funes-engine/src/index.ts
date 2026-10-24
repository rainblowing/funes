// `funes-engine` "." (RAI-315; ADR-0016): the node host's entry of the Library. It exports exactly the
// symbols the contract page lists for it; every kernel symbol is on `funes-core`, never here too.
export { makeStore, funesDbDir } from "./factory.ts";
export { folderContext } from "./funes-store.ts";
// RAI-314/RAI-315 Q5: the contract walk opens its own builder store at `funesDbDir(vault)`.
export { reindex, buildReferenceMaps } from "./reindex.ts";
export type { IndexResult } from "./reindex.ts";
export { readIndexOwner } from "./index-owner.ts";
// RAI-310: the access-file reader and the capability file the funes home resolves (ADR-0016).
export { readAccessPolicy } from "./actor.ts";
export { capabilityFilePath } from "./funes-home.ts";
// ADR-0021, RAI-315 Q8: the MCP host over a folder star; mount it with `funes-core/mcp-http`'s handler.
export { folderMcpHost } from "./folder-mcp-host.ts";
