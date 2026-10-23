#!/usr/bin/env bun
// RAI-313 (ADR-0022): funes-core is the kernel — the code every host runs identically, on Bun, Node
// and workerd with `nodejs_compat`. It imports only the allowlist below, checked per file and per
// named import. Everything else — every other `node:*`, `bun:*`, any other package, funes-engine,
// funes-cf — refuses, and so do the runtime globals that need no import (`Bun.`, `process.`, …).
// The never-cross list (the funes home, the locks, publication, launchd) holds by this structure:
// each of them needs node:fs, node:os, node:child_process or an engine import.
//
// Exemptions, by design:
//   - type-only imports (`import type` / `export type ... from`): erased at compile time —
//     Bun's transpiler drops them from scanImports, so they never reach the check;
//   - *.test.ts files: tests run under `bun test` and legitimately import `bun:test`.
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

// argv[2]: another funes-core package root (the lint's own test runs it over a fixture)
const PKG = process.argv[2] ?? join(import.meta.dir, "..", "packages", "funes-core");
const ROOT = join(PKG, "src");
const transpiler = new Bun.Transpiler({ loader: "ts" });

/** spec → the files that may import it (absent: every file) and the names they may take (absent: any). */
const ALLOW: Record<string, { files?: string[]; names?: string[] }> = {
  "node:crypto": { names: ["createHash", "timingSafeEqual"] },
  "node:async_hooks": { files: ["mutex.ts"], names: ["AsyncLocalStorage"] },
  "node:util": { files: ["funes-store.ts", "markdown.ts"], names: ["isDeepStrictEqual"] },
  // the codec and the star config
  yaml: { files: ["markdown.ts", "write.ts", "star-identity.ts", "scope.ts", "recall-planner.ts"] },
  // the registry
  zod: { files: ["ops.ts"] },
  picomatch: { files: ["scope.ts"] },
  "@modelcontextprotocol/server": { files: ["mcp-http.ts"] },
};

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) yield p;
  }
}

// Runtime GLOBALS are the gap scanImports can't see: `Bun.hash()` / `process.env` / `Buffer.from` need
// no import, so they'd slip past the import check and still couple the kernel to a runtime. Flag them
// too (line-scan, skipping comment lines so this rule's own prose doesn't trip it).
const GLOBAL_RE = /\b(Bun|Deno|Buffer)\.|\bprocess\.|\b(require|__dirname|__filename)\b|import\.meta\.dir/;
/** The named runtime imports of one specifier: `import { a, b as c } from "spec"` (not `import type`). */
const namedImports = (src: string, spec: string): string[] =>
  [...src.matchAll(new RegExp(`import\\s+(?!type\\s)([^;]*?)\\s+from\\s+"${spec.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"`, "g"))]
    .flatMap((m) => {
      const braces = m[1]!.match(/\{([^}]*)\}/);
      const names = braces ? braces[1]!.split(",").map((n) => n.trim()).filter((n) => n && !n.startsWith("type ")).map((n) => n.split(/\s+as\s+/)[0]!) : [];
      const def = m[1]!.replace(/\{[^}]*\}/, "").replace(/,/g, "").trim();
      return def ? [...names, def.startsWith("*") ? "*" : "default"] : names;
    });

const violations: string[] = [];
let files = 0;
for (const file of walk(ROOT)) {
  files++;
  const name = relative(ROOT, file);
  const where = relative(process.cwd(), file);
  const src = await Bun.file(file).text();
  for (const imp of transpiler.scanImports(src)) {
    if (imp.path.startsWith("./") || imp.path.startsWith("../")) continue;
    const rule = ALLOW[imp.path];
    if (!rule) { violations.push(`${where}: ${imp.kind} of "${imp.path}" — not on the kernel's allowlist`); continue; }
    if (rule.files && !rule.files.includes(name)) { violations.push(`${where}: "${imp.path}" is allowed only in ${rule.files.join(", ")}`); continue; }
    if (rule.names) {
      for (const n of namedImports(src, imp.path)) {
        if (!rule.names.includes(n)) violations.push(`${where}: "${n}" from "${imp.path}" — only ${rule.names.join(", ")}`);
      }
    }
  }
  if (/\.enterWith\(/.test(src)) violations.push(`${where}: AsyncLocalStorage.enterWith — workerd has no enterWith; use run`);
  src.split("\n").forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // skip comment lines
    const m = line.match(GLOBAL_RE);
    if (m) violations.push(`${where}:${i + 1}: runtime global "${m[0]}" — ${line.trim()}`);
  });
}

// The manifest: every dependency is an allowlisted package, pinned exactly.
const manifest = (await Bun.file(join(PKG, "package.json")).json()) as { dependencies?: Record<string, string> };
for (const [dep, version] of Object.entries(manifest.dependencies ?? {})) {
  if (!ALLOW[dep]) violations.push(`funes-core/package.json: dependency "${dep}" is not on the kernel's allowlist`);
  if (!/^\d+\.\d+\.\d+$/.test(version)) violations.push(`funes-core/package.json: "${dep}": "${version}" is not an exact pin`);
}

if (violations.length) {
  console.error("lint:core FAILED — funes-core imports only the kernel allowlist (RAI-313, ADR-0022):");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`lint:core OK — ${files} funes-core source file(s) on the kernel allowlist, no runtime globals`);
