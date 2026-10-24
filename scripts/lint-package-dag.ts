#!/usr/bin/env bun
// P3.14: the package graph must stay ACYCLIC — a cycle makes the packages unpublishable (npm has no
// way to install a mutually-dependent pair). RAI-313 (ADR-0022): three packages, each tier importing
// only from tiers BELOW it:
//   funes-core    — the kernel (its own import allowlist is lint-core-imports.ts)
//   funes-engine  — the node host: CLI, stdio MCP, `funes serve`, the libSQL adapter, the funes home
//   funes-cf      — the edge host
// Plus one directory rule, the edge seam: funes-cf/src and the *.workerd.ts tests import only the
// kernel's entries `funes-core`, `funes-core/mcp-http` and `funes-core/internal`. funes-cf/replica (the
// Bun-side edge cluster, RAI-303) and the *.engine.ts / *.node.ts tests may import the engine.
import { readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

// argv[2]: another packages root (the lint's own test runs it over a fixture tree)
const PKGS = process.argv[2] ?? join(import.meta.dir, "..", "packages");
/** rank = tier; a package may import only from a STRICTLY lower rank (or itself). */
const RANK: Record<string, number> = { "funes-core": 0, "funes-engine": 1, "funes-cf": 2 };
const KERNEL_ENTRIES = new Set(["funes-core", "funes-core/mcp-http", "funes-core/internal"]);

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") yield* walk(p); }
    else if (e.name.endsWith(".ts")) yield p;
  }
}

const transpiler = new Bun.Transpiler({ loader: "ts" });
const violations: string[] = [];

/** The edge seam: the Worker's source and its workerd tests. */
const edgeOnly = (pkg: string, dir: string, file: string) =>
  pkg === "funes-cf" && (dir === "src" || (dir === "test" && file.endsWith(".workerd.ts")));

for (const pkg of Object.keys(RANK)) {
  for (const dir of ["src", "replica", "test"]) {
    const root = join(PKGS, pkg, dir);
    if (!existsSync(root)) continue;
    for (const file of walk(root)) {
      // strip a leading shebang (cli.ts has one) — the transpiler rejects it
      const text = (await Bun.file(file).text()).replace(/^#!.*\n/, "");
      for (const imp of transpiler.scanImports(text)) {
        // both spellings reach another package: a bare specifier, or a relative ../../<pkg>/ path
        const bare = Object.keys(RANK).find((p) => imp.path === p || imp.path.startsWith(p + "/"));
        const rel = imp.path.match(/\.\.\/\.\.\/(funes-[a-z]+)\//)?.[1];
        const target = bare ?? (rel && RANK[rel] !== undefined ? rel : undefined);
        const where = relative(process.cwd(), file);
        // the kernel's test fixtures (the recall golden) are shared by the workerd suite too
        const kernelFixture = !bare && target === "funes-core" && imp.path.includes("/funes-core/src/__fixtures__/");
        if (edgeOnly(pkg, dir, file) && target !== undefined && target !== pkg && !(bare && KERNEL_ENTRIES.has(imp.path)) && !(dir === "test" && kernelFixture)) {
          violations.push(`${where}: funes-cf/src imports only funes-core, funes-core/mcp-http and funes-core/internal — "${imp.path}"`);
          continue;
        }
        if (!target || target === pkg) continue;
        if (RANK[target]! >= RANK[pkg]!) {
          violations.push(`${where}: ${pkg} (tier ${RANK[pkg]}) imports ${target} (tier ${RANK[target]}) — "${imp.path}"`);
        }
      }
    }
  }
}

if (violations.length) {
  console.error("lint:dag FAILED — package layering or the edge seam violated:");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`lint:dag OK — ${Object.keys(RANK).length} packages, no upward imports, funes-cf/src on the kernel only`);
