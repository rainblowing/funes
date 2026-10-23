// RAI-317: the op verbs, generated from the home ceiling, through the one dispatcher. In process over a
// libSQL store with a fake embedder (a spawned CLI would load the E5 model on the first embed); the
// binary itself is driven end to end in cli.test.ts.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { LibsqlStore } from "./libsql/store.ts";
import { folderContext } from "./funes-store.ts";
import { resolveWriteDesignation } from "./process-locus.ts";
import { processLocus } from "./process-locus.ts";
import { indexDir } from "./reindex.ts";
import { scopeHash } from "funes-core";
import { ceiling, dispatchToolCall } from "funes-core";
import { toolText } from "funes-core/internal";
import { parse } from "./cli-parse.ts";
import { OP_COMMANDS, cliDesignation, exitCodeOf, noteEmptyOrStale, opArgs, runOp, type OpCommand } from "./cli-ops.ts";

class FakeEmbedder implements Embedder {
  readonly dim = 16;
  private vec(t: string) {
    const v = new Float32Array(this.dim);
    for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) v[[...w].reduce((a, c) => a + c.charCodeAt(0), 0) % this.dim]! += 1;
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    return v.map((x) => x / n);
  }
  async embedQuery(t: string) { return this.vec(t); }
  async embedPassage(t: string) { return this.vec(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.vec(t)); }
}

const tmp: string[] = [];
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

/** A star in a temp dir, indexed as `funes reindex` leaves it; `locus` is this process's locus. */
async function star(opts: { writeLocus?: string; locus?: string | null } = {}) {
  const vault = mkdtempSync(join(tmpdir(), "funes-cli-ops-"));
  tmp.push(vault);
  writeFileSync(join(vault, "star.yaml"), `meta:\n  id: cli-ops-star\n${opts.writeLocus ? `  write_locus: ${opts.writeLocus}\n` : ""}`);
  writeFileSync(join(vault, "note.md"), "---\ntitle: Fitness\n---\nprotein creatine goals\n");
  const store = await LibsqlStore.create(new FakeEmbedder());
  await indexDir(store, vault, { scopeSignature: { hash: scopeHash([]), ignoreScope: false } });
  const ctx = folderContext({ vault, store });
  ctx.designation = opts.locus === null ? cliDesignation(vault) : resolveWriteDesignation(vault, { locus: opts.locus ?? "host-a" });
  return { vault, ctx, store };
}

/** argv → the op call the CLI makes, through the same three steps cli.ts takes. */
async function cli(argv: string[], ctx: Awaited<ReturnType<typeof star>>["ctx"], stdin = "") {
  const p = parse(argv, OP_COMMANDS);
  if (p.kind !== "run") throw new Error(JSON.stringify(p));
  const args = opArgs(p.cmd, p.values, p.positionals);
  if (typeof args === "string") throw new Error(args);
  if (p.cmd.stdin && args[p.cmd.stdin] === undefined) args[p.cmd.stdin] = stdin;
  return runOp(p.cmd.op, args, p.values.json === true, (name, a) => dispatchToolCall(name, a, ctx));
}

test("the 11 op verbs are the home ceiling, and every op arg has exactly one CLI spelling", () => {
  expect(OP_COMMANDS.map((c) => c.verb)).toEqual(["recall", "page", "indexed_page", "health", "tree", "neighbors", "graph", "hotlist", "remember", "supersede", "forget"]);
  for (const c of OP_COMMANDS) {
    const e = ceiling("home").find((o) => o.name === c.op)!;
    expect([...(c.positional ? [c.positional] : []), ...Object.values(c.args)].sort()).toEqual(Object.keys(e.inputSchema.properties).sort());
  }
  const supersede = OP_COMMANDS.find((c) => c.verb === "supersede")!;
  expect(supersede.positional).toBe("oldId");
  expect(supersede.args).toMatchObject({ "as-of": "as_of", tags: "tags", sources: "sources" });
});

test("remember from argv and stdin, then recall: --json is byte-equal to the MCP tool text, the default is YAML", async () => {
  const s = await star();
  const w = await cli(["remember", "--title", "Creatine", "--sources", "https://a,page/b", "--sources", "page/c", "--tags", "x,y"], s.ctx, "creatine dose 5g");
  expect(w.code).toBe(0);
  const id = /id: (\S+)/.exec(w.out)?.[1];
  expect(id).toStartWith("out_memory/");
  const r = await cli(["recall", "creatine", "--k", "3", "--json"], s.ctx);
  expect(r.out).toBe(toolText(await dispatchToolCall("recall", { query: "creatine", k: 3 }, s.ctx)));
  expect(JSON.parse(r.out).results[0].id).toBe(id);
  const page = JSON.parse((await cli(["page", `${id}.md`, "--json"], s.ctx)).out);
  expect(page.frontmatter.sources).toEqual(["https://a", "page/b", "page/c"]);
  expect(JSON.parse((await cli(["page", `${id}.md`, "--raw", "--json"], s.ctx)).out).content).toContain("creatine dose 5g");
  await s.store.close();
});

test("a refusal keeps its code: not-write-locus 3, a bad argument 2, bad --where JSON 2, a missing positional 2", async () => {
  const away = await star({ writeLocus: "host-a", locus: "host-b" });
  const w = await cli(["remember", "--title", "t", "--body", "b"], away.ctx);
  expect(w.code).toBe(3);
  expect(w.err).toContain("not-write-locus");
  const s = await star();
  const bad = await cli(["remember", "--title", "t", "--body", "b", "--as-of", "banana"], s.ctx);
  expect(bad.code).toBe(2);
  expect(bad.err).toContain("as_of must be an ISO-8601 date");
  expect(JSON.parse((await cli(["recall", "protein", "--k", "999", "--json"], s.ctx)).out).results.length).toBeGreaterThan(0); // k clamps, as over MCP
  const where = parse(["recall", "q", "--where", "{nope"], OP_COMMANDS);
  if (where.kind !== "run") throw new Error("parse");
  expect(opArgs(where.cmd, where.values, where.positionals)).toBe("recall: --where takes JSON");
  expect((await cli(["neighbors"], s.ctx)).code).toBe(2);
  await away.store.close(); await s.store.close();
});

test("the designation with FUNES_LOCUS unset: the short hostname is the locus, so a star whose write_locus is this host writes", async () => {
  const was = process.env.FUNES_LOCUS;
  delete process.env.FUNES_LOCUS;
  try {
    const here = processLocus()!;
    expect(here).toBe(hostname().split(".")[0]!.toLowerCase());
    const s = await star({ writeLocus: here, locus: null });
    expect((await cli(["remember", "--title", "t", "--body", "b"], s.ctx)).code).toBe(0);
    const other = await star({ writeLocus: `not-${here}`, locus: null });
    expect((await cli(["remember", "--title", "t", "--body", "b"], other.ctx)).code).toBe(3);
    await s.store.close(); await other.store.close();
  } finally {
    if (was !== undefined) process.env.FUNES_LOCUS = was;
  }
});

test("a refused proposal answer exits 3 (2 when its reason is invalid) and still prints the answer", async () => {
  const answer = (reason: string) => async () => ({ proposalId: "01J0000000000000000000000A", status: "refused", reason });
  const refused = await runOp("forget", { id: "x" }, true, answer("stale-base"));
  expect(refused.code).toBe(3);
  expect(JSON.parse(refused.out).reason).toBe("stale-base");
  expect((await runOp("forget", { id: "x" }, true, answer("invalid"))).code).toBe(2);
});

test("exit codes: busy is 75 on both locks, a refusal 3, an argument 2, anything else 1", () => {
  const e = (code?: string) => Object.assign(new Error("x"), code ? { code } : {});
  expect([e("busy"), e("not-write-locus"), e("not-granted"), e("out-of-scope"), e("invalid"), e("not-found"), e()].map(exitCodeOf)).toEqual([75, 3, 3, 3, 2, 1, 1]);
});

test("noteEmptyOrStale: an empty index names `funes reindex` on stderr, and nothing else", async () => {
  const lines: string[] = [];
  await noteEmptyOrStale({ pageStats: async () => null }, "/v", { nodes: 0, lastReindexAt: null }, 0, "q", (l) => lines.push(l));
  expect(lines).toEqual(["funes: the index is empty — run `funes reindex --vault /v` first\n"]);
});

test("the generated synopsis names the positional, the stdin body and the list flags", () => {
  const syn = (v: string) => (OP_COMMANDS.find((c) => c.verb === v) as OpCommand).synopsis;
  expect(syn("recall")).toBe("recall <query> [--k <n>] [--where <json>]");
  expect(syn("remember")).toContain("--title <title> --body <text>|stdin");
  expect(syn("remember")).toContain("[--sources <sources>…]");
  expect(syn("forget")).toBe("forget <id> [--proposal-id <proposal-id>]");
});

// 0.4.0 item 6 on the CLI: a local `recall`'s freshness lines. A spawned recall embeds, so the note is
// called in-process over a real full build. One vault per case: the
// freshness memo is module state, and an edit inside its window would read as the cached answer.
test("recall's freshness note: silent over a fresh index, names an edit, and says when there is no record to compare", async () => {
  const lines = async (store: { pageStats: LibsqlStore["pageStats"] }, vault: string, lastReindexAt: string | null) => {
    const out: string[] = [];
    await noteEmptyOrStale(store, vault, { nodes: 1, lastReindexAt }, 1, "q", (l) => out.push(l));
    return out;
  };
  const builtVault = async () => {
    const vault = mkdtempSync(join(tmpdir(), "funes-cli-note-"));
    writeFileSync(join(vault, "a.md"), "---\ntitle: A\n---\nbody\n");
    const store = await LibsqlStore.create(new FakeEmbedder());
    await indexDir(store, vault, {});
    return { vault, store, stamp: (await store.stats()).lastReindexAt };
  };
  const fresh = await builtVault();
  const edited = await builtVault();
  const bare = mkdtempSync(join(tmpdir(), "funes-cli-note-bare-"));
  try {
    // A Freshness is an OBJECT: `if (f)` type-checks and would print the stale line here, always.
    expect(await lines(fresh.store, fresh.vault, fresh.stamp)).toEqual([]);
    writeFileSync(join(edited.vault, "a.md"), "---\ntitle: A\n---\nbody, edited\n"); // a stat move alone over equal bytes is fresh (RAI-318)
    expect((await lines(edited.store, edited.vault, edited.stamp)).join("")).toContain("notes have changed since the last reindex");
    // Stamped, with no stat record (an index built before it existed): unknown, never silence.
    expect((await lines({ pageStats: async () => null }, bare, "2026-01-01T00:00:00.000Z")).join("")).toContain("no per-page stats");
  } finally {
    await fresh.store.close();
    await edited.store.close();
    for (const d of [fresh.vault, edited.vault, bare]) rmSync(d, { recursive: true, force: true });
  }
});
