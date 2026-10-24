// PLAN-0.5.0 item 25: `funes eval` over MCP under an agent bearer — the edge's only door (record 35
// Q2/Q3), proven here against a loopback `funes serve`, which runs the same handler and the same
// Bearer rule (ADR-0021). The generation comes from recall's envelope, never a manifest; the
// serving identity from health, read before the first case and after the last (RAI-308 Q10).
import { test, expect, afterAll } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { GENERATION_VERSION } from "funes-core/internal";
import { startServe, type RunningServe } from "./serve.ts";
import { scopeHash } from "funes-core";
import { LibsqlStore } from "./libsql/store.ts";
import { connectMcpEval } from "./recall-eval-mcp.ts";
import { runEval, type EvalFixture } from "./recall-eval.ts";

class FakeEmbedder implements Embedder {
  readonly dim = 16;
  private vec(t: string): Float32Array {
    const v = new Float32Array(this.dim);
    for (const w of t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) v[[...w].reduce((a, c) => a + c.charCodeAt(0), 0) % this.dim]! += 1;
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i]! /= n;
    return v;
  }
  async embedQuery(t: string) { return this.vec(t); }
  async embedPassage(t: string) { return this.vec(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.vec(t)); }
}

const TOK_AGENT = "funes_" + "A".repeat(43); // the edge's agent-token shape (record 32)
const TOK_STRANGER = "funes_" + "B".repeat(43);
const GEN = `${GENERATION_VERSION}:` + "c".repeat(64);
const REPO = join(import.meta.dir, "..", "..", "..");
const CLI = join(REPO, "packages", "funes-engine", "src", "cli.ts");
const tmp: string[] = [];
const faces: RunningServe[] = [];
afterAll(async () => {
  for (const f of faces) await f.close();
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});
const dir = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d; };

/** A fixture star served by a loopback `funes serve` at one locus, behind a version-2 access file
 *  whose agent role holds exactly the edge agent preset's reads. */
async function servedStar(locus: string, opts: { finalize?: boolean } = {}): Promise<{ face: RunningServe; store: LibsqlStore; vault: string }> {
  const vault = dir("funes-evalmcp-vault-");
  mkdirSync(join(vault, "wiki"), { recursive: true });
  const store = await LibsqlStore.create(new FakeEmbedder());
  await store.remember([
    { id: "wiki/bread", path: "wiki/bread.md", title: "Bread", body: "sourdough hydration and crumb", trust: "trusted" },
    { id: "wiki/starter", path: "wiki/starter.md", title: "Starter", body: "levain feeding schedule", trust: "trusted" },
    { id: "wiki/heat", path: "wiki/heat.md", title: "Heat", body: "oven temperature", trust: "trusted" },
  ]);
  if (opts.finalize !== false) await store.finalizeReindex({ contentGeneration: GEN, scope: { hash: scopeHash([]), ignoreScope: false } });
  const mapPath = join(vault, ".access.json");
  writeFileSync(mapPath, JSON.stringify({
    version: 2,
    roles: { agent: { ops: ["recall", "indexed_page", "health"] } },
    actors: { "eval@host-a": { token_sha256: createHash("sha256").update(TOK_AGENT).digest("hex"), role: "agent", stars: ["*"] } },
  }));
  chmodSync(mapPath, 0o600);
  const was = process.env.FUNES_LOCUS;
  process.env.FUNES_LOCUS = locus; // the locus is FUNES_LOCUS over the short hostname, read at startup
  let face: RunningServe;
  try {
    face = await startServe({ vault, bind: "127.0.0.1", port: 0, access: mapPath, ops: ["recall", "indexed_page", "health"], store });
  } finally {
    if (was === undefined) delete process.env.FUNES_LOCUS; else process.env.FUNES_LOCUS = was;
  }
  faces.push(face);
  return { face, store, vault };
}

const FIXTURE: EvalFixture = {
  vault: "fixture-star", k: 3,
  thresholds: { pAtK: 0.5, mrr: 0.3, negativeRate: 0.5, unseenPAtK: 0.5 },
  cases: [
    { id: "c1", query: "sourdough hydration", relevant: ["wiki/bread"], split: "seen" },
    { id: "c2", query: "levain feeding", relevant: ["wiki/starter"], split: "unseen" },
  ],
};

test("recall over MCP under an agent bearer: the generation from recall's envelope, the signatures and locus from health", async () => {
  const { face, store } = await servedStar("host-a");
  const src = await connectMcpEval(`${face.url}/mcp`, TOK_AGENT);
  try {
    const r = await runEval(FIXTURE, src.recall, { page: src.page });
    expect(r.cases[0]!.returned[0]).toBe("wiki/bread");
    expect(r.cases[0]!.scores.every((s) => typeof s === "number")).toBe(true);
    expect(r.cases[0]!.arms).toHaveLength(r.cases[0]!.returned.length);
    expect(r.cases[0]!.arms![0]).toBe("unattributed"); // shares "sourdough"; and MCP serves no edges
    expect(await src.answered()).toEqual({
      contentGeneration: GEN, servingSignature: store.servingSignature(), embeddingSignature: (await store.stats()).embeddingSignature, locus: "host-a",
    });
  } finally {
    await src.close();
  }
});

test("the MCP source refuses: an unknown bearer, a plain-http non-loopback URL, envelopes that disagree", async () => {
  const { face } = await servedStar("host-a");
  await expect(connectMcpEval(`${face.url}/mcp`, TOK_STRANGER).then((s) => s.recall("bread", 3))).rejects.toThrow();
  // the bearer never crosses a network in clear text
  await expect(connectMcpEval("http://203.0.113.9/mcp", TOK_AGENT)).rejects.toThrow(/https/);
  await expect(connectMcpEval(`${face.url}/mcp`, "not a token")).rejects.toThrow(/token/);
  // an unfinalized index: answered, but no generation to name
  const { face: dirty } = await servedStar("host-a", { finalize: false });
  const src = await connectMcpEval(`${dirty.url}/mcp`, TOK_AGENT);
  try {
    await src.recall("bread", 3);
    expect(await src.answered()).toMatchObject({ contentGeneration: null });
  } finally {
    await src.close();
  }
});

/** `funes eval` as a process: over MCP the spawn needs no index, no manifest and no model. */
async function evalCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", CLI, "eval", ...args], {
    // A throwaway HOME: the funes home resolves under it (ADR-0016), never the real estate's.
    cwd: REPO, env: { ...process.env, HOME: dir("funes-evalmcp-home-"), ...env }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

// The ticket's acceptance: a run against a fixture star writes, and a later run re-reads, ONE
// baseline file per locus — beside the fixture, never inside it.
test("funes eval --url: one baseline file per locus, written once and re-read", async () => {
  const a = await servedStar("host-a");
  const b = await servedStar("host-b");
  const evalDir = dir("funes-evalmcp-fixture-");
  const fixturePath = join(evalDir, "core.json");
  writeFileSync(fixturePath, JSON.stringify(FIXTURE, null, 2) + "\n");
  const fixtureBytes = readFileSync(fixturePath);
  const tokenFile = join(evalDir, ".token");
  writeFileSync(tokenFile, TOK_AGENT + "\n");
  const common = ["--vault", a.vault, "--fixture", fixturePath, "--token-file", tokenFile];

  for (const [face, locus] of [[a.face, "host-a"], [b.face, "host-b"]] as const) {
    const run = await evalCli([...common, "--url", `${face.url}/mcp`, "--baseline"]);
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    const path = join(evalDir, `core.baseline.${locus}.json`);
    expect(run.out).toContain(`baseline written to ${path}`);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written).toMatchObject({
      format: 1, locus, generation: GEN,
      fixtureSha256: createHash("sha256").update(fixtureBytes).digest("hex"),
      signature: { serving: a.store.servingSignature(), embedding: (await a.store.stats()).embeddingSignature },
    });
    expect(written.triples.c1[0]).toEqual(["wiki/bread", 1, expect.any(Number)]);
  }
  expect(readFileSync(fixturePath)).toEqual(fixtureBytes); // the fixture itself is never written

  // A second baseline at the same locus refuses; a plain run re-reads the file and claims identity.
  const again = await evalCli([...common, "--url", `${a.face.url}/mcp`, "--baseline"]);
  expect(again.code).toBe(2);
  expect(again.err).toContain("a baseline already exists");
  const reread = await evalCli([...common, "--url", `${a.face.url}/mcp`]);
  expect(reread.code).toBe(0);
  expect(reread.out).toContain(`baseline ${join(evalDir, "core.baseline.host-a.json")}`);
  expect(reread.out).toContain("IDENTICAL");

  // health answers the locus; a claimed one is no flag at all (RAI-317), so it can never disagree.
  const claimed = await evalCli([...common, "--url", `${a.face.url}/mcp`, "--locus", "host-b"]);
  expect(claimed.code).toBe(2);
  expect(claimed.err).toContain("--locus was removed in funes 0.6.0");
}, 60_000);

test("funes eval --url --baseline refuses an invalid generation (Q1) and writes nothing", async () => {
  const dirty = await servedStar("host-d", { finalize: false });
  const evalDir = dir("funes-evalmcp-fixture-");
  const fixturePath = join(evalDir, "core.json");
  writeFileSync(fixturePath, JSON.stringify(FIXTURE));
  writeFileSync(join(evalDir, ".token"), TOK_AGENT);
  const run = await evalCli(["--vault", dirty.vault, "--fixture", fixturePath, "--token-file", join(evalDir, ".token"), "--url", `${dirty.face.url}/mcp`, "--baseline"]);
  expect(run.code).toBe(2);
  expect(run.err).toContain("no content generation");
  expect(existsSync(join(evalDir, "core.baseline.host-d.json"))).toBe(false);
}, 30_000);
