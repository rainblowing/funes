#!/usr/bin/env bun
// Thin runner for the stdio MCP server — the logic lives in mcp-server.ts so the CLI can start one
// in-process. This file stays a direct entrypoint on purpose: `bun .../mcp.ts` is spawned by
// mcp-boundary.test.ts and named in star manifests' identity.command, and it dispatches
// UNCONDITIONALLY (no import.meta.main, which evaluates undefined on older Node 22.x).
import { runMcp } from "./mcp-server.ts";

await runMcp(process.argv.slice(2));
