import { test, expect, afterEach } from "bun:test";
import type { Embedder } from "funes-core";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scopeHash } from "./scope.ts";
import { folderContext } from "./funes-store.ts";
import { indexDir } from "./reindex.ts";
import { E5Embedder } from "./embedder.ts";
import { operations, dispatchToolCall, type OperationContext } from "./ops.ts";

// PLAN-0.5.0 item 23 (ADR-0013, ADR-0015's served/collapse keys): the recall planner at the engine
// seam — dispatchToolCall on a temp vault whose star.yaml declares `memory.recall`, as record 28
// places the acceptance case. funes names no taste key: every key below comes from this star.yaml.

class FakeEmbedder implements Embedder {
  readonly dim = 16;
  private vec(t: string): Float32Array {
    const v = new Float32Array(this.dim);
    for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) v[[...w].reduce((a, c) => a + c.charCodeAt(0), 0) % this.dim]! += 1;
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i]! /= n;
    return v;
  }
  async embedQuery(t: string) { return this.vec(t); }
  async embedPassage(t: string) { return this.vec(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.vec(t)); }
}

const RECALL = `memory:
  recall:
    keys: [domain, type, suggested, my_score]
    values:
      domain: [books, movies]
    predicates:
      taste:
        - {suggested: {ne: true}, domain: {exists: true}}
        - {my_score: {exists: true}}
      suggestion:
        - {suggested: true, my_score: {exists: false}}
    serve: [domain, suggested, my_score]
    collapse: [type]
`;

const PAGES: Record<string, string> = {
  "items/movies/heat.md": "---\ntitle: Heat\ntype: film\ndomain: movies\nmy_score: 9\n---\nHeat, a crime film about a heist.\n",
  "items/movies/dune.md": "---\ntitle: Dune\ntype: film\ndomain: movies\nsuggested: true\n---\nDune, a desert film.\n",
  "items/movies/alien.md": "---\ntitle: Alien\ntype: film\ndomain: movies\nsuggested: true\nmy_score: 7\n---\nAlien, a space horror film.\n",
};

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function star(opts: { yaml?: string; pages?: Record<string, string>; embedder?: Embedder } = {}) {
  const vault = mkdtempSync(join(tmpdir(), "funes-planner-"));
  dirs.push(vault);
  writeFileSync(join(vault, "star.yaml"), opts.yaml ?? RECALL);
  for (const [rel, text] of Object.entries(opts.pages ?? PAGES)) {
    mkdirSync(dirname(join(vault, rel)), { recursive: true });
    writeFileSync(join(vault, rel), text);
  }
  const store = await LibsqlStore.create(opts.embedder ?? new FakeEmbedder());
  await indexDir(store, vault, vault, { scopeSignature: { hash: scopeHash([]), ignoreScope: false } });
  const ctx: OperationContext = folderContext({ vault, store, trust: "untrusted", remote: true });
  return { vault, store, ctx };
}

type Envelope = { plan?: { arms: string[]; where: Record<string, unknown>; collapse: string[] }; results: Array<{ id: string; fields?: Record<string, unknown> }> };
const v2 = (ctx: OperationContext, args: Record<string, unknown>) => dispatchToolCall(operations, "recall_v2", { k: 20, ...args }, ctx) as Promise<Envelope>;
const ids = (e: Envelope) => e.results.map((r) => r.id).sort();

test("{taste:true} excludes suggested-unscored pages and remember notes; plan echoes arms, where and collapse", async () => {
  const { ctx, store } = await star();
  try {
    await dispatchToolCall(operations, "remember", { title: "film night", body: "a film night note about a heist film" }, ctx);
    const env = await v2(ctx, { query: "film heist", where: { taste: true } });
    expect(ids(env)).toEqual(["items/movies/alien", "items/movies/heat"]);
    expect(env.plan).toEqual({ arms: ["fts", "vector", "graph"], where: { taste: true }, collapse: ["type"] });
  } finally { await store.close(); }
});

test("{suggestion:true} returns only the suggested, unscored pages", async () => {
  const { ctx, store } = await star();
  try {
    await dispatchToolCall(operations, "remember", { title: "film night", body: "a film night note" }, ctx);
    expect(ids(await v2(ctx, { query: "film", where: { suggestion: true } }))).toEqual(["items/movies/dune"]);
    // a predicate passed `false` negates it; separate keys AND
    expect(ids(await v2(ctx, { query: "film", where: { taste: false, domain: "movies" } }))).toEqual(["items/movies/dune"]);
  } finally { await store.close(); }
});

test("remember → link → the remembered page still matches its filter", async () => {
  const { ctx, store } = await star();
  try {
    const a = (await dispatchToolCall(operations, "remember", { title: "film night", body: "a film night note" }, ctx)) as { id: string };
    const b = (await dispatchToolCall(operations, "remember", { title: "popcorn", body: "popcorn for film night" }, ctx)) as { id: string };
    expect(ids(await v2(ctx, { query: "film night", where: { type: "memory" } }))).toContain(a.id);
    await ctx.funes.link(a.id, b.id);
    expect(ids(await v2(ctx, { query: "film night", where: { type: "memory" } }))).toContain(a.id);
  } finally { await store.close(); }
});

test("served keys travel as `fields` on recall, recall_v2 and indexed_page; the raw frontmatter never does", async () => {
  const { ctx, store } = await star();
  try {
    const dune = { domain: "movies", suggested: true };
    const viaV2 = (await v2(ctx, { query: "desert" })).results.find((r) => r.id === "items/movies/dune")!;
    expect(viaV2.fields).toEqual(dune);
    const viaRecall = ((await dispatchToolCall(operations, "recall", { query: "desert" }, ctx)) as Envelope["results"]).find((r) => r.id === "items/movies/dune")!;
    expect(viaRecall.fields).toEqual(dune);
    const page = (await dispatchToolCall(operations, "indexed_page", { id: "items/movies/dune" }, ctx)) as Record<string, unknown>;
    expect(page.fields).toEqual(dune);
    expect(page).not.toHaveProperty("frontmatter");
  } finally { await store.close(); }
});

test("a star that declares nothing serves no `fields`, and a recall_v2 without `where` echoes no plan", async () => {
  const { ctx, store } = await star({ yaml: "memory: {}\n" });
  try {
    const env = await v2(ctx, { query: "desert" });
    expect(env.plan).toBeUndefined();
    expect(env.results[0]).not.toHaveProperty("fields");
  } finally { await store.close(); }
});

test("refusals name what is wrong: blank query, undeclared key, value outside values, non-boolean predicate, no declaration", async () => {
  const { ctx, store } = await star();
  try {
    await expect(v2(ctx, { query: "  ", where: { taste: true } })).rejects.toThrow(/blank query/);
    await expect(v2(ctx, { query: "film", where: { creator: "x" } })).rejects.toThrow(/"creator"/);
    await expect(v2(ctx, { query: "film", where: { domain: "games" } })).rejects.toThrow(/"domain"/);
    await expect(v2(ctx, { query: "film", where: { taste: "yes" } })).rejects.toThrow(/"taste"/);
    // zod drops a `__proto__` key without a word, which would widen the filter: refused instead
    await expect(v2(ctx, { query: "film", where: JSON.parse('{"__proto__": true, "domain": "movies"}') })).rejects.toThrow(/__proto__/);
  } finally { await store.close(); }
  const bare = await star({ yaml: "memory: {}\n" });
  try {
    await expect(v2(bare.ctx, { query: "film", where: { domain: "movies" } })).rejects.toThrow(/memory\.recall/);
  } finally { await bare.store.close(); }
});

test("an invalid declaration refuses as a whole rather than serve without it", async () => {
  const { ctx, store } = await star({ yaml: "memory:\n  recall:\n    keys: [trust]\n" });
  try {
    await expect(v2(ctx, { query: "film", where: {} })).rejects.toThrow(/writer-owned/);
  } finally { await store.close(); }
});

test("the filter runs inside the vector scan, so a selective `where` cannot starve k", async () => {
  // 80 decoys sit closer to the query than the one matching page; a filter applied only after the
  // arms would find nothing in the vector arm's window.
  const pages: Record<string, string> = {
    "items/books/only.md": "---\ntitle: Only\ndomain: books\n---\nquiet orchard\n",
  };
  for (let i = 0; i < 80; i++) pages[`items/movies/m${i}.md`] = `---\ntitle: m${i}\ndomain: movies\n---\nzebra zebra\n`;
  const { ctx, store } = await star({ pages });
  try {
    expect(ids(await v2(ctx, { query: "zebra", k: 1, where: { domain: "books" } }))).toEqual(["items/books/only"]);
  } finally { await store.close(); }
});

// The RU/EN cases (record 28, record 35): funes adds no query expansion, so a Russian query to an
// English-only item, and the reverse, is the multilingual vector arm's job. These measure it on the
// real E5 model, filtered — FTS cannot cross scripts here. Named `E5 embedder` so `bun run test`
// skips them (the model is a 135 MB download); run this file by hand where the model is cached.
test("E5 embedder: RU/EN — the vector arm carries a cross-script query through a `where`", async () => {
  const pages: Record<string, string> = {
    ...PAGES,
    "items/books/master.md": "---\ntitle: Мастер и Маргарита\ntype: book\ndomain: books\nmy_score: 10\n---\nМастер и Маргарита — роман о дьяволе в Москве.\n",
    "items/books/cookbook.md": "---\ntitle: Pasta at Home\ntype: book\ndomain: books\nmy_score: 6\n---\nA cookbook of Italian pasta recipes.\n",
  };
  const { ctx, store } = await star({ pages, embedder: new E5Embedder() });
  try {
    const ru = await v2(ctx, { query: "фильм про ограбление банка", k: 1, where: { taste: true, domain: "movies" } });
    expect(ids(ru)).toEqual(["items/movies/heat"]);
    const en = await v2(ctx, { query: "a novel about the devil visiting Moscow", k: 1, where: { domain: "books" } });
    expect(ids(en)).toEqual(["items/books/master"]);
  } finally { await store.close(); }
}, 300_000);
