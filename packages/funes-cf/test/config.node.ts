// PLAN-0.5.0 items 33 and 36: the invariants of funes-taste's and funes-probe's wrangler configs (records 24 §2 and 34, RAI-190).
// They run in Node, not workerd: they read the config files the way `wrangler deploy` does
// (wrangler's own parser) and scan the package's source tree.
// *.node.ts, not *.test.ts: the repo's `bun test` must not pick these up.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { experimental_readRawConfig, unstable_getDurableObjectClassNameToUseSQLiteMap } from "wrangler";

const PKG = join(import.meta.dirname, "..");
type Raw = Record<string, any>;
const read = (file: string): Raw => experimental_readRawConfig({ config: join(PKG, file) }).rawConfig as Raw;
const deploy = read("wrangler.jsonc");
/** Every config a test run binds, with the deploy config it mirrors. A new one is added here, so
 *  the no-`ai` rule covers it. */
const TEST_CONFIGS = [
  ["wrangler.test.jsonc", "wrangler.jsonc"],
  ["probe/wrangler.test.jsonc", "probe/wrangler.jsonc"],
] as const;

const doBinding = () => {
  const bindings = deploy.durable_objects?.bindings ?? [];
  expect(bindings).toHaveLength(1);
  return bindings[0];
};
const bucket = () => {
  const buckets = deploy.r2_buckets ?? [];
  expect(buckets).toHaveLength(1);
  return buckets[0];
};

describe("wrangler.jsonc (the deploy config)", () => {
  it("names the Worker funes-taste, and FUNES_LOCUS equals the name", () => {
    expect(deploy.name).toBe("funes-taste");
    expect(deploy.vars.FUNES_LOCUS).toBe(deploy.name);
    expect(Object.keys(deploy.vars).sort()).toEqual(["FUNES_HOST", "FUNES_LOCUS", "TELEGRAM_ALLOWED_IDS"]);
  });

  it("puts the taste DO class in a new_sqlite_classes migration (else it is KV-backed for good)", () => {
    const cls = doBinding().class_name;
    expect(deploy.migrations).toEqual([{ tag: "v1", new_sqlite_classes: [cls] }]);
    expect(unstable_getDurableObjectClassNameToUseSQLiteMap(deploy.migrations).get(cls)).toBe(true);
  });

  it("gives the DO binding no script_name", () => {
    expect(doBinding()).not.toHaveProperty("script_name");
  });

  it("has one route, FUNES_HOST as a custom domain, and no workers.dev", () => {
    expect(deploy.routes).toEqual([{ pattern: deploy.vars.FUNES_HOST, custom_domain: true }]);
    expect(deploy.workers_dev).toBe(false);
  });

  it("binds one bucket, never remote, with no preview bucket equal to it and no previews block", () => {
    const b = bucket();
    expect(b).not.toHaveProperty("remote");
    if ("preview_bucket_name" in b) expect(b.preview_bucket_name).not.toBe(b.bucket_name);
    expect(deploy).not.toHaveProperty("previews");
  });

  it("binds AI for the embedder", () => {
    expect(deploy.ai).toEqual({ binding: "AI" });
  });

  it("has no remote binding anywhere, no env block and no KV", () => {
    expect(JSON.stringify(deploy)).not.toMatch(/"remote":\s*true/);
    expect(deploy).not.toHaveProperty("env");
    expect(deploy.kv_namespaces ?? []).toEqual([]);
  });

  it("turns logs and traces off", () => {
    expect(deploy.observability.logs.enabled).toBe(false);
    expect(deploy.observability.logs.invocation_logs).toBe(false);
    expect(deploy.observability.traces.enabled).toBe(false);
  });

  it("bundles *.yaml as Text modules (the taste star.yaml)", () => {
    expect(deploy.rules).toContainEqual(expect.objectContaining({ type: "Text", globs: ["**/*.yaml"] }));
  });
});

describe("the source tree", () => {
  const src = join(PKG, "src");
  const files = readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ f, text: readFileSync(join(src, f), "utf8") }));

  it("names the bucket binding only in the DO's module", () => {
    const cls = doBinding().class_name;
    const doModule = files.filter(({ text }) => new RegExp(`export class ${cls}\\b`).test(text)).map(({ f }) => f);
    expect(doModule).toHaveLength(1);
    const name = new RegExp(`\\b${bucket().binding}\\b`);
    expect(files.filter(({ text }) => name.test(text)).map(({ f }) => f).filter((f) => f !== doModule[0])).toEqual([]);
  });

  // Record 24 S1: a DO has one alarm and setAlarm replaces it, so only armAlarm (never later than
  // the one set) may call it.
  it("sets the one alarm only through armAlarm", () => {
    const calls = files.flatMap(({ f, text }) => [...text.matchAll(/\bsetAlarm\(/g)].map(() => f));
    expect(calls).toEqual(["writer.ts"]);
    expect(files.find(({ f }) => f === "writer.ts")!.text).toMatch(/export async function armAlarm\([^)]*\)[^{]*\{[^}]*setAlarm\(/);
  });

  // The three sanctioned operator statements (record 24 §4; Vlad 2026-10-10) ship as named files.
  it("ships exactly the three sanctioned operator statements", () => {
    expect(readdirSync(join(PKG, "sql")).sort()).toEqual(["abandon-journal.sql", "clear-seed-built.sql", "delete-conflict.sql"]);
  });
});

describe("probe/wrangler.jsonc (the throwaway funes-probe, item 36)", () => {
  const probe = read("probe/wrangler.jsonc");
  const script = readFileSync(join(PKG, "../../scripts/cf-session.sh"), "utf8");

  it("is funes-probe on workers.dev, with no route, no vars and no Durable Object", () => {
    expect(probe.name).toBe("funes-probe");
    expect(probe.workers_dev).toBe(true);
    expect(probe).not.toHaveProperty("routes");
    expect(probe).not.toHaveProperty("vars");
    expect(probe).not.toHaveProperty("durable_objects");
  });

  it("binds one throwaway bucket, never the canonical one, and the session script deletes that name", () => {
    expect(probe.r2_buckets).toHaveLength(1);
    const name = probe.r2_buckets[0].bucket_name;
    expect(name).not.toBe(bucket().bucket_name);
    expect(script).toContain(`PROBE_BUCKET="${name}"`);
  });

  // No gateway: the probe's AI.run takes no options, which the workerd fake refuses (vitest.config.ts).
  it("binds AI, and has no remote binding, env block or KV", () => {
    expect(probe.ai).toEqual({ binding: "AI" });
    expect(JSON.stringify(probe)).not.toMatch(/"remote":\s*true/);
    expect(probe).not.toHaveProperty("env");
    expect(probe.kv_namespaces ?? []).toEqual([]);
  });

  it("turns logs and traces off", () => {
    expect(probe.observability).toEqual(deploy.observability);
  });

  it("keeps the deploy config's compatibility date", () => {
    expect(probe.compatibility_date).toBe(deploy.compatibility_date);
  });
});

describe("the test configs", () => {
  for (const [file, of] of TEST_CONFIGS) {
    it(`${file} has no ai and no remote binding`, () => {
      const t = read(file);
      expect(t).not.toHaveProperty("ai");
      expect(JSON.stringify(t)).not.toMatch(/"remote":\s*true/);
    });
    it(`${file} is ${of} less its ai binding`, () => {
      const { ai: _ai, ...rest } = read(of);
      expect(read(file)).toEqual(rest);
    });
  }
});

describe("package.json", () => {
  it("is private and pins the edge toolchain exactly (PLAN-0.5.0 Versions)", () => {
    const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
    expect(pkg.private).toBe(true);
    expect(pkg.devDependencies).toMatchObject({
      wrangler: "4.149.0",
      "@cloudflare/workers-types": "5.20261010.1",
      "@cloudflare/vitest-plugin": "1.4.0",
      vitest: "4.1.11",
      "@vitest/runner": "4.1.11",
      "@vitest/snapshot": "4.1.11",
    });
  });
});
