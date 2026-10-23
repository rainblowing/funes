// RAI-313 (ADR-0022): the kernel's import allowlist, per file and per named import, plus the exact pins.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LINT = join(import.meta.dir, "lint-core-imports.ts");

function core(files: Record<string, string>, deps: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "funes-core-lint-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: deps }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, "src", name), text);
  return root;
}
const lint = (root: string) => Bun.spawnSync(["bun", LINT, root], { stdout: "pipe", stderr: "pipe" });

test("the allowlist passes: node:crypto names, node:util in funes-store.ts, zod in ops.ts, exact pins", () => {
  const r = lint(core({
    "a.ts": 'import { createHash } from "node:crypto";\nexport const h = createHash;\n',
    "funes-store.ts": 'import { isDeepStrictEqual } from "node:util";\nexport const e = isDeepStrictEqual;\n',
    "ops.ts": 'import { z } from "zod";\nexport const s = z;\n',
  }, { zod: "4.6.5" }));
  expect(r.stderr.toString()).toBe("");
  expect(r.exitCode).toBe(0);
});

test.each([
  ["node:fs", 'import { readFileSync } from "node:fs";\nexport const r = readFileSync;\n', "not on the kernel's allowlist"],
  ["a name off the list", 'import { randomBytes } from "node:crypto";\nexport const r = randomBytes;\n', '"randomBytes" from "node:crypto"'],
  ["a file off the list", 'import { z } from "zod";\nexport const s = z;\n', '"zod" is allowed only in ops.ts'],
  ["a runtime global", "export const e = process.env.X;\n", 'runtime global "process."'],
])("refuses %s", (_why, text, message) => {
  const r = lint(core({ "a.ts": text }));
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain(message);
});

test("refuses a dependency that is not pinned exactly", () => {
  const r = lint(core({ "a.ts": "export const x = 1;\n" }, { yaml: "^2.9.1" }));
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain('"yaml": "^2.9.1" is not an exact pin');
});
