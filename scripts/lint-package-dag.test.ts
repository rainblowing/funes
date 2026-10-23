// RAI-313 (ADR-0022): three packages ranked funes-core 0, funes-engine 1, funes-cf 2, and one directory
// rule: funes-cf/src and its *.workerd.ts tests import only the kernel's three entries; funes-cf/replica
// and the *.engine.ts / *.node.ts tests may import the engine. Runs the lint over a fixture packages tree.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LINT = join(import.meta.dir, "lint-package-dag.ts");

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "funes-dag-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const lint = (root: string) => Bun.spawnSync(["bun", LINT, root], { stdout: "pipe", stderr: "pipe" });
const ok = (files: Record<string, string>) => {
  const r = lint(tree(files));
  expect(r.stderr.toString()).toBe("");
  expect(r.exitCode).toBe(0);
};
const refused = (files: Record<string, string>, why: string) => {
  const r = lint(tree(files));
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain(why);
};

test("funes-cf/src may import the kernel's three entries", () => {
  ok({
    "funes-cf/src/index.ts": 'import { render } from "funes-core";\nimport { mcpHandler } from "funes-core/mcp-http";\nimport { FunesStore } from "funes-core/internal";\n',
    "funes-cf/test/x.workerd.ts": 'import { render } from "funes-core";\n',
  });
});

test("funes-cf/src may not import funes-engine", () => {
  refused({ "funes-cf/src/index.ts": 'import { render } from "funes-engine/portable";\n' }, "funes-cf/src imports only funes-core");
});

test("a funes-cf workerd test may not import funes-engine", () => {
  refused({ "funes-cf/test/x.workerd.ts": 'import { makeStore } from "funes-engine";\n' }, "funes-cf/src imports only funes-core");
});

test("funes-cf/replica and the engine tests of funes-cf may import funes-engine", () => {
  ok({
    "funes-cf/replica/seed.ts": 'import { readOwnerOnly } from "../../funes-engine/src/actor.ts";\n',
    "funes-cf/test/n9.engine.ts": 'import { makeStore } from "../../funes-engine/src/factory.ts";\n',
  });
});

test("funes-core may not import funes-engine", () => {
  refused({ "funes-core/src/x.ts": 'import { makeStore } from "funes-engine";\n' }, "funes-core (tier 0) imports funes-engine (tier 1)");
});

test("funes-engine importing funes-cf is an upward import", () => {
  refused({ "funes-engine/src/x.ts": 'import { y } from "funes-cf";\n' }, "funes-engine (tier 1) imports funes-cf (tier 2)");
});
