#!/usr/bin/env bun
// The stdio MCP entry file (RAI-317 Q11): `bun …/mcp.ts <flags>` runs `funes mcp <flags>` through the
// one CLI parser. It stays a file, not a parser: star manifests name it in identity.command, which
// twinkl.ing hashes, so a path change would be connection drift. It dispatches unconditionally (no
// import.meta.main, which evaluates undefined on older Node 22.x).
process.argv.splice(2, 0, "mcp");
await import("./cli.ts");
export {}; // a module, so the top-level await above is legal
