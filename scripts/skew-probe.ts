#!/usr/bin/env bun
// The skew probe (RAI-319; PLAN-0.6.0 §Cutover, the joint gate at step 4). Between the first and the
// second machine's upgrade the estate runs skewed: one machine publishes with 0.6.0 and another still
// serves with 0.5.0. That is tolerated only when a 0.5.0 handle opens a 0.6.0-built published.db READ-ONLY and
// serves recall from it. This script proves that, end to end, on a scratch HOME:
//
//   1. this checkout (0.6.0) runs `funes reindex` and `funes publish --json` on a two-page vault;
//   2. the 0.5.0 checkout opens the published.db the way its read faces do — makeStore({readonly}),
//      then the layer-4 stamp check against the vault's star id — and runs one recall;
//   3. the recall must rank the page that holds the query terms first.
//
//   bun scripts/skew-probe.ts --v050 <a v0.5.0 checkout with deps installed> [--models <model cache>]
//
// --models links an existing E5 model cache into the scratch home; without it the model downloads
// cold. HOME is the scratch directory for both legs (0.5.0 has no FUNES_HOME), so no real home is
// read or written. Exit 0: the skew is safe. Exit 1: it is not, and the output says which leg failed.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const arg = (f: string) => (process.argv.includes(f) ? process.argv[process.argv.indexOf(f) + 1] : undefined);
const v050 = arg("--v050") && resolve(arg("--v050")!);
const models = arg("--models") && resolve(arg("--models")!);
if (!v050 || !existsSync(join(v050, "packages/funes-libsql/src/store.ts"))) {
  console.error("usage: bun scripts/skew-probe.ts --v050 <v0.5.0 funes checkout> [--models <dir>]");
  process.exit(2);
}

const REPO = join(import.meta.dir, "..");
const root = mkdtempSync(join(tmpdir(), "funes-skew-"));
const home = join(root, "home"), vault = join(root, "vault");
const STAR = "git://example.test/skew-probe";
mkdirSync(join(home, ".funes"), { recursive: true });
mkdirSync(vault);
if (models) symlinkSync(models, join(home, ".funes/models"));
writeFileSync(join(vault, "star.yaml"), `version: 3\nmeta:\n  name: skew-probe\n  id: ${STAR}\n`);
writeFileSync(join(vault, "fitness.md"), "---\ntitle: Fitness\n---\nprotein creatine goals\n");
writeFileSync(join(vault, "sailing.md"), "---\ntitle: Sailing\n---\nhybrid catamaran research\n");
// A clean environment: a retired FUNES_* name in the caller's shell would make 0.6.0 refuse.
const env = { PATH: process.env.PATH!, HOME: home, TMPDIR: process.env.TMPDIR ?? "/tmp" };

const run = (leg: string, cwd: string, args: string[]): string => {
  const r = spawnSync("bun", args, { cwd, env, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`skew-probe: ${leg} failed (exit ${r.status})\n${r.stdout}${r.stderr}`);
    process.exit(1);
  }
  return r.stdout;
};

try {
  const cli = join(REPO, "packages/funes-engine/src/cli.ts");
  run("0.6.0 reindex", REPO, [cli, "reindex", "--vault", vault]);
  const pub = JSON.parse(run("0.6.0 publish", REPO, [cli, "publish", "--vault", vault, "--json"]).trim().split("\n").at(-1)!);
  if (pub.ok !== true || typeof pub.dbPath !== "string" || !pub.dbPath.endsWith("published.db")) {
    console.error("skew-probe: 0.6.0 publish did not report a published.db", pub);
    process.exit(1);
  }

  // The 0.5.0 leg, from its own checkout so its own modules and its own libsql resolve.
  const handle = `
    const { makeStore, readStarIdentity } = await import("./packages/funes-engine/src/index.ts");
    const { assertStampedStarIdentity } = await import("./packages/funes-engine/src/star-identity.ts");
    const [dbPath, vault] = process.argv.slice(1);
    const store = await makeStore({ dbDir: dbPath, readonly: true });
    await assertStampedStarIdentity(store, { expectedId: readStarIdentity(vault).id, dbPath, who: "skew-probe" });
    const hits = await store.recall({ query: "protein creatine", k: 5 });
    console.log(JSON.stringify(hits.map((h) => h.path ?? h.id)));
    await store.close();`;
  const hits = JSON.parse(run("0.5.0 read-only open + recall", v050, ["-e", handle, pub.dbPath, vault]).trim().split("\n").at(-1)!) as string[];
  if (!String(hits[0]).includes("fitness")) {
    console.error(`skew-probe: the 0.5.0 handle served recall, but ranked ${JSON.stringify(hits)} — fitness.md is not first`);
    process.exit(1);
  }
  console.log(`skew-probe: OK — a 0.5.0 handle opened the 0.6.0 published.db read-only and recalled ${hits[0]} first`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
