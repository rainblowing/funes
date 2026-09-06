#!/usr/bin/env bun
// Regenerate the frozen advertised-contract golden (packages/funes-engine/src/__fixtures__/ops-contract.json).
//
// Exists because hand-regenerating it by hand once silently dropped the _comment that tells the next
// person this file is a contract, not a snapshot. A generator that cannot lose the instruction is
// the only kind worth having.
//
// Running this IS a contract change to every MCP client and to twinkling. Commit it alone.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { operations, opCapabilities } from "../packages/funes-engine/src/ops.ts";

const OUT = join(import.meta.dir, "../packages/funes-engine/src/__fixtures__/ops-contract.json");
const snapshot = {
  _comment:
    "FROZEN advertised-contract snapshot. Regenerating this file IS a contract change to every MCP " +
    "client and to twinkling — do it in its own commit whose diff is the release note. " +
    "Regenerate with `bun run scripts/freeze-ops-contract.ts`.",
  operations: operations.map((o) => ({ name: o.name, internal: o.internal ?? false, inputSchema: o.inputSchema })),
  capabilities: opCapabilities(),
};
writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + "\n");
process.stdout.write(`froze ${snapshot.operations.length} ops -> ${OUT}\n`);
