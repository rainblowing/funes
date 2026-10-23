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
import { ceiling } from "../packages/funes-core/src/index.ts";
import { contractEntry, operations } from "../packages/funes-core/src/internal.ts";

const names = (ops: { name: string }[]) => ops.map((o) => o.name);
const OUT = join(import.meta.dir, "../packages/funes-engine/src/__fixtures__/ops-contract.json");
const snapshot = {
  _comment:
    "FROZEN advertised-contract snapshot. Regenerating this file IS a contract change to every MCP " +
    "client and to twinkling — do it in its own commit whose diff is the release note. " +
    "Regenerate with `bun run scripts/freeze-ops-contract.ts`.",
  operations: operations.map(contractEntry),
  // ADR-0020: what each host serves, derived from `tiers` by `ceiling()`.
  ceilings: {
    home: names(ceiling("home")),
    "home off loopback": names(ceiling("home", { loopback: false })),
    "cross-star": names(ceiling("home", { crossStar: true })),
    org: names(ceiling("org")),
    edge: names(ceiling("edge")),
  },
};
writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + "\n");
process.stdout.write(`froze ${snapshot.operations.length} ops -> ${OUT}\n`);
