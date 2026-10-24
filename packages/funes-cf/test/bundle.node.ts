// RAI-313 (ADR-0022): the Worker metafile gate. The edge bundle is built the way `wrangler deploy`
// builds it (a dry run, no account), and its module graph — the esbuild metafile, never a grep of the
// output — holds no input under packages/funes-engine/, no libsql, and no external node:fs, node:os
// or node:child_process. This proves the never-cross list on the artifact itself.
// *.node.ts, not *.test.ts: the repo's `bun test` must not pick this up.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PKG = join(import.meta.dirname, "..");
interface Metafile { inputs: Record<string, { imports?: Array<{ path: string; external?: boolean }> }> }

describe("the Worker metafile gate", () => {
  let out: string;
  let meta: Metafile;
  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "funes-cf-bundle-"));
    execFileSync(join(PKG, "node_modules/.bin/wrangler"), ["deploy", "--dry-run", "--outdir", out, "--metafile", join(out, "meta.json")], {
      cwd: PKG, stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8")) as Metafile;
  }, 120_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("bundles the kernel and no input under packages/funes-engine/ or libsql", () => {
    const inputs = Object.keys(meta.inputs);
    expect(inputs.some((i) => i.includes("funes-core/src/"))).toBe(true); // the gate reads the real graph
    expect(inputs.filter((i) => i.includes("packages/funes-engine/") || i.includes("funes-engine/src/"))).toEqual([]);
    expect(inputs.filter((i) => /(^|\/)libsql(\/|$)|@libsql\//.test(i))).toEqual([]);
  });

  it("leaves no external node:fs, node:os or node:child_process", () => {
    const externals = new Set(Object.values(meta.inputs).flatMap((i) => (i.imports ?? []).filter((m) => m.external).map((m) => m.path)));
    expect([...externals].filter((p) => /^(node:)?(fs|os|child_process)(\/|$)/.test(p))).toEqual([]);
  });
});
