// The local R2 seed (ADR-0024): a star's config put into a `wrangler dev` session's local R2 before the
// session starts, as the deploy login puts it at `<key>/_/star.yaml`. Without it the star's object
// refuses every path. The spawned tests use it: funes-cf's n9.node.ts and taste-bot's h4.node.ts.
// No account: `--local --persist-to`, CLOUDFLARE_* stripped, metrics off.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_readRawConfig } from "wrangler";

const PKG = join(import.meta.dirname, "..");
const CONFIG = join(PKG, "wrangler.test.jsonc");

/** Put `yaml` at `<key>/_/star.yaml` in the test config's bucket, under `persistTo`. */
export function seedLocalStar(o: { persistTo: string; key: string; yaml: string }): void {
  const bucket = (experimental_readRawConfig({ config: CONFIG }).rawConfig as { r2_buckets: Array<{ bucket_name: string }> }).r2_buckets[0]!.bucket_name;
  const dir = mkdtempSync(join(tmpdir(), "funes-cf-seed-"));
  try {
    const file = join(dir, "star.yaml");
    writeFileSync(file, o.yaml);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLOUDFLARE_")));
    execFileSync(join(PKG, "node_modules/.bin/wrangler"), [
      "r2", "object", "put", `${bucket}/${o.key}/_/star.yaml`, "--file", file, "--local", "--persist-to", o.persistTo, "-c", CONFIG,
    ], { cwd: PKG, stdio: "pipe", env: { ...env, WRANGLER_SEND_METRICS: "false" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// `bun test/seed-local.ts <persist-to> <star key> <star.yaml file>`: the same seed for a repo that
// may not import funes code (taste-bot's h4.node.ts spawns it).
if ((import.meta as { main?: boolean }).main) {
  const [persistTo, key, file] = process.argv.slice(2);
  if (!persistTo || !key || !file) throw new Error("usage: bun seed-local.ts <persist-to> <star key> <star.yaml file>");
  seedLocalStar({ persistTo, key, yaml: readFileSync(file, "utf8") });
}
