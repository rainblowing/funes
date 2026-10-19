// PLAN-0.5.0 item 16 (RAI-217): funes-cf ranks ABOVE funes-engine, so it may import the engine's
// portable subpath and the engine may never import it back. Runs the lint over a fixture packages tree.
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

test("funes-cf may import funes-engine/portable", () => {
  const r = lint(tree({ "funes-cf/src/index.ts": 'import { render } from "funes-engine/portable";\n' }));
  expect(r.stderr.toString()).toBe("");
  expect(r.exitCode).toBe(0);
});

test("funes-engine importing funes-cf is an upward import", () => {
  const r = lint(tree({ "funes-engine/src/x.ts": 'import { y } from "funes-cf";\n' }));
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("funes-engine (tier 3) imports funes-cf (tier 4)");
});
