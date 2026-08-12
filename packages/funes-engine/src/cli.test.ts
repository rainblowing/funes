import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// H3 CLI arg-validation for `funes reindex` — the scope-bypass guards that must fail closed BEFORE
// any store is opened. Spawned as a subprocess (cli.ts runs its command at module load); each case
// exits non-zero in the arg-parse stage, so no E5 model / PGLite is touched (fast).

const CLI = join(import.meta.dir, "cli.ts");
const REPO = resolve(import.meta.dir, "..", "..", "..");

async function reindex(args: string[]): Promise<{ code: number; err: string }> {
  const vault = mkdtempSync(join(tmpdir(), "funes-cli-"));
  const proc = Bun.spawn(["bun", CLI, "reindex", "--vault", vault, ...args], {
    cwd: REPO,
    env: { ...process.env, FUNES_BACKEND: "libsql", FUNES_DAEMON_PORT: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  rmSync(vault, { recursive: true, force: true });
  return { code, err };
}

test("reindex: --ignore-scope + --max is rejected (a scope-bypassing run must be full)", async () => {
  const { code, err } = await reindex(["--ignore-scope", "--max", "5"]);
  expect(code).toBe(2);
  expect(err).toContain("--ignore-scope cannot be combined with --max");
}, 20_000);

test("reindex: --max must be a positive integer — abc / 0 / negative all rejected before opening a store", async () => {
  for (const bad of ["abc", "0", "-3", "2.5"]) {
    const { code, err } = await reindex(["--max", bad]);
    expect(code).toBe(2);
    expect(err).toContain("--max must be a positive integer");
  }
}, 30_000);

test("reindex: --fresh + --max is rejected (a fresh rebuild wipes first, so it must be FULL)", async () => {
  const { code, err } = await reindex(["--fresh", "--max", "5"]);
  expect(code).toBe(2);
  expect(err).toContain("--fresh cannot be combined with --max");
}, 20_000);
