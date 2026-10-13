#!/usr/bin/env bun
// P3.14: the package graph must stay ACYCLIC — a cycle makes the packages unpublishable (npm has no
// way to install a mutually-dependent pair) and was the concrete blocker before the funes-shared
// extraction: funes-libsql imported ~19 modules from funes-engine while funes-engine dynamically
// imported funes-libsql. This lint fails the build if any package reaches "upward" again.
//
// The intended layering (each tier may only import from tiers BELOW it):
//   funes-core    — edge-portable, zero runtime deps (its own purity lint is lint-core-imports.ts)
//   funes-shared  — node-side seams shared by the engine AND the backends (generation, zones, locks)
//   funes-libsql  — the libSQL backend
//   funes-engine  — the engine: CLI, MCP, daemon, faces, ops, PostgresStore; may load a backend
//   funes-api     — the HTTP spine
import { readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const PKGS = join(import.meta.dir, "..", "packages");
/** rank = tier; a package may import only from a STRICTLY lower rank (or itself). */
const RANK: Record<string, number> = {
  "funes-core": 0,
  "funes-shared": 1,
  "funes-libsql": 2,
  "funes-api": 2,
  "funes-engine": 3,
};

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".ts")) yield p;
  }
}

const transpiler = new Bun.Transpiler({ loader: "ts" });
const violations: string[] = [];

for (const pkg of Object.keys(RANK)) {
  const src = join(PKGS, pkg, "src");
  if (!existsSync(src)) continue;
  for (const file of walk(src)) {
    // strip a leading shebang (cli.ts has one) — the transpiler rejects it
    const text = (await Bun.file(file).text()).replace(/^#!.*\n/, "");
    for (const imp of transpiler.scanImports(text)) {
      // both spellings reach another package: a bare specifier, or a relative ../../<pkg>/ path
      const bare = Object.keys(RANK).find((p) => imp.path === p || imp.path.startsWith(p + "/"));
      const rel = imp.path.match(/\.\.\/\.\.\/(funes-[a-z]+)\//)?.[1];
      const target = bare ?? (rel && RANK[rel] !== undefined ? rel : undefined);
      if (!target || target === pkg) continue;
      if (RANK[target]! >= RANK[pkg]!) {
        violations.push(`${relative(process.cwd(), file)}: ${pkg} (tier ${RANK[pkg]}) imports ${target} (tier ${RANK[target]}) — "${imp.path}"`);
      }
    }
  }
}

if (violations.length) {
  console.error("lint:dag FAILED — package layering violated (a cycle makes the packages unpublishable):");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`lint:dag OK — ${Object.keys(RANK).length} packages, no upward imports (acyclic)`);
