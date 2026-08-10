#!/usr/bin/env bun
// Build the publishable @funes-tech/cli artifact into a STAGING ROOT (P3.15 steps 13/14/18).
//
// Staging, not in-place: `npm pack` reads package.json from the directory it packs, and swapping the
// source manifest out and back would leave the repo dirty if the job died mid-pack. Nothing here
// mutates packages/funes-engine.
//
// The generated manifest is deliberately NOT the source one with fields deleted:
//   • `workspace:*` deps must not survive — npm rejects those URLs from an installed tarball;
//   • `libsql` is declared by funes-libsql, NOT by funes-engine, so externalizing it while dropping
//     the workspace deps would ship a tarball that dies on the stranger's first `reindex`;
//   • both native deps are EXACT-pinned: hashing one tarball does not freeze what it resolves later,
//     and a caret would let a future install pull native packages CI never tested.
import { mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { FUNES_VERSION } from "../packages/funes-engine/src/version.ts";
import { LIBSQL_ONLY_DEFINE } from "../packages/funes-engine/src/artifact.ts";

const REPO = join(import.meta.dir, "..");
const OUT = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]!
  : join(REPO, "dist-pkg");

/** Externals stay real runtime dependencies: native addons cannot be bundled. */
const EXTERNAL: Record<string, string> = {
  libsql: "0.5.29",
  "@huggingface/transformers": "4.2.0",
};
/** `pg` is external AND undeclared: the artifact refuses FUNES_BACKEND=postgres outright. */
const EXTERNAL_ONLY = ["pg"];

// Asserted from the Bun METAFILE — the actual module graph — not by grepping the output. A string
// search passes happily when a forbidden module's code is bundled without the string you looked for
// (Codex R3#12). These are path fragments matched against the bundle's input list.
const FORBIDDEN_MODULES: Array<[label: string, fragment: string]> = [
  ["daemon server", "/daemon.ts"],
  ["daemon console.html", "console.html"],
  ["HTTP face", "/face.ts"],
  ["funes-api app", "/app.ts"],
];
/** Must be PRESENT: the CLI and MCP legitimately use the daemon proxy/probe. A blanket "no daemon"
 *  rule would either fail falsely here or pressure someone into deleting a working path. */
const REQUIRED_MODULES: Array<[label: string, fragment: string]> = [
  ["daemon client (proxy/probe)", "daemon-client.ts"],
];
/** Reachable-but-dead, by the documented `typeof`-guard trade in artifact.ts. Recorded rather than
 *  asserted away, so the cost stays visible instead of becoming folklore. */
const KNOWN_DEAD: string[] = ["postgres-driver.ts"];
/** pg's own code must be gone — that one IS a string check, because it is a third-party package
 *  rather than one of our modules. */
const FORBIDDEN_STRINGS: Array<[label: string, marker: string]> = [
  ["pg driver", "pg-connection-string"],
  ["Bun.serve", "Bun.serve"],
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const entry = join(REPO, "packages/funes-engine/src/cli.ts");
const outfile = join(OUT, "dist/cli.js");
mkdirSync(dirname(outfile), { recursive: true });

const args = [
  "build", entry, "--target=node", "--outfile", outfile,
  "--define", `${LIBSQL_ONLY_DEFINE}=true`,
  `--metafile=${join(OUT, "meta.json")}`,
  ...[...Object.keys(EXTERNAL), ...EXTERNAL_ONLY].flatMap((e) => ["--external", e]),
];
const build = Bun.spawnSync(["bun", ...args], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
if (build.exitCode !== 0) {
  process.stderr.write(new TextDecoder().decode(build.stderr));
  throw new Error("build-cli: bun build failed");
}

// Bun 1.3.14 PRESERVES the source shebang (`#!/usr/bin/env bun`) — it does not rewrite it for
// --target=node. Left alone, `node dist/cli.js` passes every smoke while the INSTALLED `funes`
// command dies on a machine without bun. Rewrite it, and assert it below.
const built = readFileSync(outfile, "utf8");
const body = built.startsWith("#!") ? built.slice(built.indexOf("\n") + 1) : built;
writeFileSync(outfile, `#!/usr/bin/env node\n${body}`);

const emitted = readFileSync(outfile, "utf8");
if (!emitted.startsWith("#!/usr/bin/env node\n")) throw new Error("build-cli: node shebang not emitted");
const meta = JSON.parse(readFileSync(join(OUT, "meta.json"), "utf8")) as {
  outputs: Record<string, { inputs?: Record<string, unknown> }>;
};
const modules = [...new Set(Object.values(meta.outputs).flatMap((o) => Object.keys(o.inputs ?? {})))];

const leaked = FORBIDDEN_MODULES.filter(([, f]) => modules.some((m) => m.includes(f)));
if (leaked.length) throw new Error(`build-cli: forbidden modules in the bundle: ${leaked.map(([l]) => l).join(", ")}`);
const missing = REQUIRED_MODULES.filter(([, f]) => !modules.some((m) => m.includes(f)));
if (missing.length) throw new Error(`build-cli: expected modules absent from the bundle: ${missing.map(([l]) => l).join(", ")}`);
const strLeaks = FORBIDDEN_STRINGS.filter(([, marker]) => emitted.includes(marker));
if (strLeaks.length) throw new Error(`build-cli: forbidden code in the artifact: ${strLeaks.map(([l]) => l).join(", ")}`);
const dead = KNOWN_DEAD.filter((f) => modules.some((m) => m.includes(f)));
rmSync(join(OUT, "meta.json"));

const src = JSON.parse(readFileSync(join(REPO, "packages/funes-engine/package.json"), "utf8")) as Record<string, unknown>;
if (src.version !== FUNES_VERSION) throw new Error(`build-cli: version.ts (${FUNES_VERSION}) != package.json (${String(src.version)})`);

writeFileSync(join(OUT, "package.json"), JSON.stringify({
  name: "@funes-tech/cli",
  version: FUNES_VERSION,
  description: "funes — a markdown-canonical hybrid memory layer (FTS + vector + graph, RRF-fused).",
  license: "MIT",
  repository: { type: "git", url: "git+https://github.com/rainblowing/funes.git" },
  type: "module",
  bin: { funes: "dist/cli.js" },
  files: ["dist", "README.md", "LICENSE"],
  engines: { node: ">=22" },
  // In the MANIFEST, not a --access flag. A scoped package defaults to `restricted`, which needs a
  // paid plan; when the flag got split across a line during the placeholder publish npm saw
  // `--access` with no value and answered 402 Payment Required. Nothing to mistype here.
  publishConfig: { access: "public" },
  dependencies: EXTERNAL,
}, null, 2) + "\n");

for (const f of ["README.md", "LICENSE"]) {
  const from = join(REPO, f);
  if (existsSync(from)) copyFileSync(from, join(OUT, f)); // npm needs these INSIDE the package root
  else process.stderr.write(`build-cli: WARNING — ${f} missing from the staging root\n`);
}

const kb = Math.round(emitted.length / 1024);
process.stdout.write(
  `build-cli: ${OUT} — dist/cli.js ${kb}KB, node shebang, v${FUNES_VERSION}\n` +
  `  ${modules.length} modules; no daemon/face/app/console.html/pg; daemon-client present\n` +
  (dead.length ? `  known dead (documented typeof-guard trade, artifact.ts): ${dead.join(", ")}\n` : ""),
);
