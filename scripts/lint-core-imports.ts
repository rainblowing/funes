#!/usr/bin/env bun
// H7 (PLAN Rev 6): funes-core must stay runtime-portable — pure TS with RELATIVE imports only.
// Any `bun:*`, `node:*`, or bare-package RUNTIME import couples the portable core to a runtime
// or a dependency, and fails this lint (wired into the `test` script, so it is always-on).
//
// Exemptions, by design:
//   - type-only imports (`import type` / `export type ... from`): erased at compile time —
//     Bun's transpiler drops them from scanImports, so they never reach the check;
//   - *.test.ts files: tests run under `bun test` and legitimately import `bun:test`.
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "packages", "funes-core", "src");
const transpiler = new Bun.Transpiler({ loader: "ts" });

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) yield p;
  }
}

// Runtime GLOBALS are the gap scanImports can't see: `Bun.hash()` / `process.env` / `Deno.*` need
// no import, so they'd slip past the import check and still couple the core to a runtime. Flag them
// too (line-scan, skipping comment lines so this rule's own prose doesn't trip it).
const GLOBAL_RE = /\b(Bun|Deno)\.|\bprocess\.(env|cwd|platform|argv|exit|version|nextTick)\b/;

const violations: string[] = [];
let files = 0;
for (const file of walk(ROOT)) {
  files++;
  const src = await Bun.file(file).text();
  for (const imp of transpiler.scanImports(src)) {
    if (imp.path.startsWith("./") || imp.path.startsWith("../")) continue;
    violations.push(`${relative(process.cwd(), file)}: ${imp.kind} of "${imp.path}"`);
  }
  src.split("\n").forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // skip comment lines
    const m = line.match(GLOBAL_RE);
    if (m) violations.push(`${relative(process.cwd(), file)}:${i + 1}: runtime global "${m[0]}" — ${line.trim()}`);
  });
}

if (violations.length) {
  console.error("lint:core FAILED — funes-core allows only RELATIVE runtime imports + no runtime globals (H7):");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`lint:core OK — ${files} funes-core source file(s), no bun:/node:/bare imports or runtime globals`);
