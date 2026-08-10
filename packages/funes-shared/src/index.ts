// funes-shared — the node-side seams BOTH the engine and its storage backends need: content-defined
// index generation, zone classification, and the cross-process write lock. It depends only on
// funes-core + node builtins and NEVER on a backend, which is what keeps the package DAG acyclic
// (funes-libsql used to reach into funes-engine for these, while funes-engine imports funes-libsql —
// the cycle that blocked publishing; P3.14).
//
// Why not funes-core: core is the EDGE-PORTABLE tier and its H7 lint forbids node:/bun:/bare imports
// (scripts/lint-core-imports.ts). These three need node:crypto / node:fs, so they live one tier up.
export { GENERATION_VERSION, PARSER_VERSION, INDEX_SCHEMA_VERSION, hashItem, normalizeGenerationPath, generationRecord, encodeGeneration } from "./generation.ts";
export type { GenerationRecord, GenerationInputs } from "./generation.ts";
export { zoneOfDir, zoneOfFile, memoryZoneOf } from "./zones.ts";
export type { Zone } from "./zones.ts";
export { acquireWriteLock, withWriteLock, withScopedWriteLock, lockPathFor } from "./write-lock.ts";
export type { WriteLock, WriteLockOpts } from "./write-lock.ts";
export { canonicalizeScopeExcludes, scopeHash } from "./scope-hash.ts";
