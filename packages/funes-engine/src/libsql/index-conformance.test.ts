// RAI-314 seam (3): the index-module conformance suite. One SqlIndex over each exec adapter — libsql,
// and DO SQLite EMULATED on libsql with the DO's refusals (more than 100 binds, temp tables, ATTACH,
// SQL BEGIN; RAI-301 measured the real ones; funes-cf's workerd suite runs the real DO) — must give
// the pinned recall golden byte for byte, the same filtered recall, a BLOB round trip, and the one
// build walk's guarantees (bytewise order, the refs staleness check, a write during an in-place build).
// B8b (RAI-344): the turso adapter runs the same suite, on the Turso engine's own `fts` lexical arm.
import { describe, expect, test } from "bun:test";
import Database from "libsql";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Embedder } from "funes-core";
import type { BuildInput, Dialect, MemoryItem, SqlExec, SqlValue, Vault, VaultEntry } from "funes-core/internal";
import { DO_SQLITE_DIALECT, encodeGeneration, FunesStore, LIBSQL_DIALECT, ORG_DIALECT, ORG_SLOTS, PARSER_VERSION, pathOrder, RowVault, SCHEMA_VERSIONS, sha256Hex, SqlIndex, starConfigFromText, statParity, TURSO_DIALECT } from "funes-core/internal";
import type { RecallFilter } from "funes-core/internal";
import { GoldenEmbedder, goldenCorpus, goldenOf, type Golden } from "../../../funes-core/src/__fixtures__/index-golden.ts";
import { libsqlExec, openTurso } from "./store.ts";

const GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL("../../../funes-core/src/__fixtures__/recall-golden.json", import.meta.url)), "utf8")) as Golden;

const REFUSED = /\b(temp|temporary)\s+table\b|\battach\b|^\s*(begin|savepoint)\b/i;
/** DO SQLite's refusals over a libsql handle: a statement that breaks one throws, as on the DO. */
function doEmulated(): SqlExec {
  const inner = libsqlExec(new Database(":memory:"));
  const guard = (s: string, a: readonly SqlValue[] = []) => {
    if (a.length > 100) throw new Error(`DO: too many SQL variables (${a.length})`);
    if (REFUSED.test(s)) throw new Error(`DO: SQLITE_AUTH (${s.slice(0, 40)})`);
  };
  return {
    all: (s, a) => (guard(s, a), inner.all(s, a)),
    iterate: (s, a) => (guard(s, a), inner.iterate(s, a)),
    run: (s, a) => (guard(s, a), inner.run(s, a)),
    tx: inner.tx,
  };
}

const ADAPTERS: Array<{ name: string; dialect: Dialect; exec: () => SqlExec; slots?: string[] }> = [
  { name: "libsql", dialect: LIBSQL_DIALECT, exec: () => libsqlExec(new Database(":memory:")) },
  { name: "do-sqlite", dialect: DO_SQLITE_DIALECT, exec: doEmulated, slots: ["_a", "_b"] },
  { name: "turso", dialect: TURSO_DIALECT, exec: () => libsqlExec(openTurso(":memory:")) },
];

function open(a: (typeof ADAPTERS)[number], embedder = new GoldenEmbedder()): SqlIndex {
  const index = new SqlIndex({ exec: a.exec(), dialect: a.dialect, embedder, slots: a.slots });
  index.createTables();
  index.addColumns();
  return index;
}

/** A vault in memory: the port's bytewise order and `after`, versions that move on every write. */
function memVault(files: Record<string, string>): Vault & { put(path: string, text: string): void } {
  const m = new Map<string, { bytes: Uint8Array; version: string }>();
  let v = 0;
  // an lstat-shaped version, which the libsql dialect's stat columns parse
  const put = (path: string, text: string) => { const bytes = new TextEncoder().encode(text); m.set(path, { bytes, version: `${++v}:${v}:${bytes.length}` }); };
  for (const [p, t] of Object.entries(files)) put(p, t);
  return {
    put,
    read: async (p) => m.get(p) ?? null,
    async *list(o = {}) {
      const paths = [...m.keys()].sort(pathOrder).filter((p) => (o.after == null || pathOrder(p, o.after) > 0) && !o.exclude?.(p));
      for (const path of paths) yield { path, version: m.get(path)!.version } satisfies VaultEntry;
    },
    atomically: () => { throw new Error("read-only"); },
  };
}
const page = (title: string, extra = "") => `---\ntitle: ${title}\n${extra}---\n${title} body text\n`;

/** One full build over a slot that has none: the edge needs a live slot before a write lands. */
async function built(index: SqlIndex, files: Record<string, string> = {}): Promise<void> {
  await index.build({ vault: memVault(files) });
}

describe.each(ADAPTERS)("index module on $name", (a) => {
  test("gate 1: the recall golden, byte for byte", async () => {
    const index = open(a);
    await built(index);
    await index.remember(goldenCorpus());
    expect(await goldenOf((q) => index.recall(q), index.sig)).toEqual(GOLDEN);
  });

  test("gate 1: filtered recall — the planner's three taste shapes", async () => {
    const index = open(a);
    await built(index);
    const fm = (o: Record<string, string | number | boolean>): MemoryItem["frontmatter"] => o;
    await index.remember([
      { id: "items/films/a", path: "items/films/a.md", title: "Arrival", body: "aliens language linguist", trust: "trusted", frontmatter: fm({ domain: "movies", title: "Arrival", title_ru: "Прибытие", my_score: 9 }) },
      { id: "items/films/b", path: "items/films/b.md", title: "Blade Runner", body: "replicants rain neon", trust: "trusted", frontmatter: fm({ domain: "movies", title: "Blade Runner", suggested: true }) },
      { id: "items/books/c", path: "items/books/c.md", title: "Contact", body: "aliens radio signal", trust: "trusted", frontmatter: fm({ domain: "books", title: "Contact" }) },
    ]);
    const taste: RecallFilter = { all: [{ any: [{ suggested: { ne: true }, domain: { exists: true } }, { my_score: { exists: true } }] }] };
    const ids = async (filter: RecallFilter) => (await index.recall({ query: "aliens", k: 5, filter })).map((r) => r.id);
    expect((await ids(taste)).sort()).toEqual(["items/books/c", "items/films/a"]);
    expect(await ids({ all: [{ any: [{ title: "Contact" }] }] })).toEqual(["items/books/c"]);
    expect(await ids({ all: [{ any: [{ title_ru: "Прибытие" }] }] })).toEqual(["items/films/a"]);
  });

  test("gate 4: a BLOB round trip — written, read, written back: still a blob, the same bytes", async () => {
    const index = open(a);
    const vault = memVault({ "a.md": page("Alpha") });
    await index.build({ vault });
    const t = index.live()!;
    const read = () => index.x.all<{ ty: string; e: ArrayBuffer | Uint8Array }>(`select typeof(embedding) ty, embedding e from ${t.chunks}`)[0]!;
    const first = read();
    expect(first.ty).toBe("blob");
    const want = await new GoldenEmbedder().embedPassage("Alpha\nAlpha body text");
    expect([...new Uint8Array(first.e as ArrayBuffer)]).toEqual([...new Uint8Array(want.buffer)]);
    // the second build reuses the vector it reads back (the edge: into the other slot)
    vault.put("a.md", page("Alpha", "tags: [x]\n"));
    await index.build({ vault });
    const t2 = index.live()!;
    const again = index.x.all<{ ty: string; e: ArrayBuffer | Uint8Array }>(`select typeof(embedding) ty, embedding e from ${t2.chunks}`)[0]!;
    expect(again.ty).toBe("blob");
    expect([...new Uint8Array(again.e as ArrayBuffer)]).toEqual([...new Uint8Array(want.buffer)]);
  });

  test("gate 6: the walk reads in bytewise UTF-8 order — an astral `😀` after `＃`", async () => {
    const index = open(a);
    const seen: string[] = [];
    const vault = memVault({ "😀.md": page("Smile"), "＃.md": page("Hash"), "a/b.md": page("AB"), "a-c.md": page("AC") });
    const read = vault.read;
    vault.read = async (p) => { seen.push(p); return read(p); };
    await index.build({ vault, batch: 1 });
    expect(seen.slice(0, 4)).toEqual(["a-c.md", "a/b.md", "＃.md", "😀.md"]); // pass 1, one page per batch
    expect(seen.slice(4)).toEqual(["a-c.md", "a/b.md", "＃.md", "😀.md"]); // pass 2
    expect(index.statsSync().nodes).toBe(4);
  });

  test("gate 6: an alias that changes between the passes sends the build back to pass 1", async () => {
    const index = open(a);
    const vault = memVault({ "a.md": page("A", "edges:\n  - { type: cites, target: bee }\n"), "b.md": page("B") });
    const input: BuildInput = { vault };
    const phase = () => (JSON.parse(index.meta("build_cursor")!) as { phase: string }).phase;
    do expect(await index.buildStep(input, 1)).toBe("more"); while (phase() === "refs"); // pass 1 read `b` with no aliases; pass 2 wrote `a`
    vault.put("b.md", page("B", "aliases: [bee]\n"));
    expect(await index.buildStep(input, 1)).toBe("more"); // pass 2 finds `b`'s aliases moved: back to pass 1
    expect(phase()).toBe("refs");
    while ((await index.buildStep(input, 1)) === "more");
    const t = index.live()!;
    expect(index.x.all<{ target: string }>(`select target from ${t.edges} where source='a'`)).toEqual([{ target: "b" }]);
  });

  test("gate 6: a refs restart counts the OKF floor and the skipped pages once, as a clean build does", async () => {
    const files = { "a.md": "no frontmatter a\n", "b.md": "---\ntitle: [broken\n---\nb\n", "c.md": page("C"), "d.md": "no frontmatter d\n" };
    const clean = open(a);
    await clean.build({ vault: memVault(files) });
    const index = open(a);
    const vault = memVault(files);
    const input: BuildInput = { vault };
    const phase = () => (JSON.parse(index.meta("build_cursor")!) as { phase: string; after: string | null });
    do expect(await index.buildStep(input, 1)).toBe("more"); while (phase().phase === "refs" || phase().after !== "b.md");
    vault.put("c.md", page("C", "aliases: [cee]\n")); // pass 2 is past a and b: c's aliases moved, back to pass 1
    while ((await index.buildStep(input, 1)) === "more");
    for (const k of ["okf_nonconformant", "okf_malformed", "build_skipped"]) expect([k, index.meta(k)]).toEqual([k, clean.meta(k)]);
  });

  test("gate 6 (Q10): a write during an in-place build survives the finalize", async () => {
    if (a.slots) return; // a shadow build refuses writes (`building`): the edge never writes mid-build
    const index = open(a);
    const vault = memVault({ "m.md": page("M"), "n.md": page("N") });
    await index.build({ vault });
    const input: BuildInput = { vault, batch: 1 };
    while (index.meta("build_cursor") == null || JSON.parse(index.meta("build_cursor")!).phase !== "pages" || JSON.parse(index.meta("build_cursor")!).after == null) {
      await index.buildStep(input, 1);
    }
    // the walk is past "m": a funes write lands "a" (before the cursor) on disk and in the index
    vault.put("a.md", page("Written"));
    await index.remember([{ id: "a", path: "a.md", title: "Written", body: "Written body text", trust: "trusted" }]);
    while ((await index.buildStep(input, 1)) === "more");
    expect(await index.indexedPage({ id: "a" })).not.toBeNull();
    expect(index.meta("build_cursor")).toBeNull();
    expect(index.contentIdentity().contentGeneration).not.toBeNull();
  });

  test("RAI-318: a write's swaps upsert the stat with its hash; a removed file drops its row; equal bytes behind a moved version are fresh", async () => {
    const index = open(a);
    const vault = memVault({ "a.md": page("A"), "gone.md": page("Gone") });
    await index.build({ vault });
    const parity = async () => statParity(vault, index.statsSync().lastReindexAt, await index.pageStats());
    expect(await parity()).toEqual({ changed: false, basis: "stat" });
    // a funes write lands "n" on disk and in the index, with the version its swap returned
    vault.put("n.md", page("N"));
    const n = (await vault.read("n.md"))!;
    await index.remember([{ id: "n", path: "n.md", title: "N", body: "N body text", trust: "trusted" }], [{ id: "n", version: n.version, hash: sha256Hex(n.bytes) }]);
    await index.remove(["gone"], [{ id: "gone", version: null, hash: null }]);
    const rows = (await index.pageStats())!.rows;
    expect(rows.find((r) => r.id === "n")).toEqual({ id: "n", version: n.version, hash: sha256Hex(n.bytes) });
    expect(rows.some((r) => r.id === "gone")).toBe(false);
    // "gone" still on disk here: the record no longer names it, so the vault reads as changed
    expect(await parity()).toEqual({ changed: true, basis: "stat" });
    await index.remove(["gone"], [{ id: "gone", version: (await vault.read("gone.md"))!.version, hash: sha256Hex((await vault.read("gone.md"))!.bytes) }]);
    // the same bytes under a new version (a sync client's xattr): the content check reads it fresh
    vault.put("a.md", page("A"));
    expect(await parity()).toEqual({ changed: false, basis: "stat" });
    vault.put("a.md", page("A2"));
    expect(await parity()).toEqual({ changed: true, basis: "stat" });
  });

  test("a build begun under another scope restarts from the top; an unchanged rebuild re-embeds nothing", async () => {
    let embeds = 0;
    const embedder = new GoldenEmbedder();
    const counting = Object.assign(Object.create(embedder) as GoldenEmbedder, {
      embedPassages: async (ts: string[]) => { embeds += ts.length; return embedder.embedPassages(ts); },
    });
    const index = open(a, counting);
    const vault = memVault({ "a.md": page("A"), "b.md": page("B"), "c.md": page("C") });
    expect(await index.buildStep({ vault, scope: { hash: "s1", ignoreScope: false } }, 1)).toBe("more");
    await index.build({ vault, scope: { hash: "s2", ignoreScope: false } });
    expect(index.scopeSignature()).toEqual({ hash: "s2", ignoreScope: false });
    expect(embeds).toBe(3);
    await index.build({ vault, scope: { hash: "s2", ignoreScope: false } });
    expect(embeds).toBe(3);
  });
});

// RAI-314 build gate 3: the same vault gives the same rows on Turso as on libsql. The generations
// differ only by the schema tag, so the Turso rows recomputed under libsql's tag give libsql's.
test("gate 3: Turso generation equality — the Turso rows under libsql's schema tag give libsql's generation", async () => {
  const files = {
    "a.md": page("Alpha", "aliases: [first]\ntags: [x]\n"),
    "b.md": page("Bravo", "edges:\n  - { type: cites, target: first }\n"),
    "notes/c.md": page("Charlie", "trust: derived\n"),
    "😀.md": page("Smile"),
  };
  const scope = { hash: "scope-1", ignoreScope: false };
  const [lib, tur] = [ADAPTERS[0]!, ADAPTERS[2]!].map((a) => open(a));
  for (const index of [lib!, tur!]) await index.build({ vault: memVault(files), scope });
  const libGen = lib!.contentIdentity().contentGeneration;
  const turGen = tur!.contentIdentity().contentGeneration;
  expect(libGen).not.toBeNull();
  expect(turGen).not.toBe(libGen);
  const records = tur!.x.all<{ g: string }>("select gen_record g from nodes").map((r) => JSON.parse(r.g));
  expect(records).toHaveLength(4);
  expect(encodeGeneration({ records, scope, embeddingSpec: tur!.sig, parserVersion: PARSER_VERSION, indexSchemaVersion: SCHEMA_VERSIONS.libsql })).toBe(libGen!);
  expect(encodeGeneration({ records, scope, embeddingSpec: tur!.sig, parserVersion: PARSER_VERSION, indexSchemaVersion: SCHEMA_VERSIONS.turso })).toBe(turGen!);
  // the same resolved edges: `first` resolves to `a` on both engines
  for (const index of [lib!, tur!]) expect(index.x.all("select source, type, target from edges order by source, target")).toEqual([{ source: "b", type: "cites", target: "a" }]);
});

// B10a (RAI-347; RAI-314 Q7, ADR-0019): the org write transaction on `turso`. The org RowVault keeps
// the pages as rows in the same database as the index, so one transaction commits a write's page
// row, its index rows and its page_stat row — or none of them.
describe("the org write transaction on turso", () => {
  const org = (exec = libsqlExec(openTurso(":memory:")), embedder: Embedder = new GoldenEmbedder()) => {
    const index = new SqlIndex({ exec, dialect: ORG_DIALECT, embedder, slots: ORG_SLOTS, inPlaceOnSameSpec: true });
    index.createTables();
    const rows = new RowVault(index);
    return { index, rows, funes: new FunesStore(rows.serving, { vault: rows, star: () => starConfigFromText("meta:\n  id: rainblow.ing/org\n"), memoryDir: "out_memory", serialize: (fn) => fn() }) };
  };
  const nodes = (index: SqlIndex) => index.x.all<{ id: string }>(`select id from ${index.live()!.nodes} order by id`).map((r) => r.id);

  test("one transaction commits the page row, the index rows and the page_stat row", async () => {
    const { index, rows, funes } = org();
    await index.build({ vault: rows });
    const [id] = (await funes.remember([{ title: "Alpha", body: "alpha sourdough body" }])).ids;
    const page = (await rows.read(`${id}.md`))!;
    expect(new TextDecoder().decode(page.bytes)).toContain("alpha sourdough body");
    expect(nodes(index)).toEqual([id!]);
    expect((await index.pageStats())!.rows).toEqual([{ id: id!, version: page.version, hash: sha256Hex(page.bytes) }]);
    expect(await statParity(rows, index.statsSync().lastReindexAt, await index.pageStats())).toEqual({ changed: false, basis: "stat" });
    // a supersede: the successor, the patched page and both stats, in one commit
    const { id: next } = await funes.supersede(id!, { title: "Alpha 2", body: "alpha rye body" });
    expect(nodes(index)).toEqual([next]);
    expect((await index.pageStats())!.rows.map((r) => r.id).sort()).toEqual([id!, next].sort());
    expect((await rows.read(`${id}.md`))!.version).not.toBe(page.version);
  });

  test("a frame that throws, or a commit whose page moved, writes no page row and no index row", async () => {
    const { index, rows } = org();
    await index.build({ vault: rows });
    const bytes = new TextEncoder().encode("---\ntitle: A\n---\nA body\n");
    const item = { id: "out_memory/a", path: "out_memory/a.md", title: "A", body: "A body", trust: "untrusted" as const };
    const write = (between: () => void) => rows.atomically(async (tx) => {
      const r = await tx.swap("out_memory/a.md", null, bytes);
      await rows.serving.remember([item], [{ id: item.id, version: r.ok ? r.version : null, hash: sha256Hex(bytes) }]);
      between();
    });
    await expect(write(() => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await rows.read("out_memory/a.md")).toBeNull();
    expect(nodes(index)).toEqual([]);
    // a row that appears behind the frame fails the commit's compare-and-swap: the index rows roll back with it
    await expect(write(() => { index.x.run("insert into pages(path, revision, bytes) values (?, ?, ?)", ["out_memory/a.md", 99, bytes]); })).rejects.toThrow(/conflict/);
    expect((await rows.read("out_memory/a.md"))!.version).toBe("99");
    expect(nodes(index)).toEqual([]);
    expect((await index.pageStats())!.rows).toEqual([]);
  });

  test("the RowVault lists its rows in bytewise UTF-8 order, after a cursor, through the exclude", async () => {
    const { index, rows } = org();
    await rows.atomically(async (tx) => {
      for (const p of ["😀.md", "＃.md", "a/b.md", "a-c.md", "skip/x.md", ".history/a-c.md/x", "index.md"]) await tx.swap(p, null, new TextEncoder().encode(page(p)));
    });
    const list = async (o?: Parameters<Vault["list"]>[0]) => { const out: string[] = []; for await (const e of rows.list(o)) out.push(e.path); return out; };
    expect(await list({ exclude: (rel) => rel === "skip/" })).toEqual(["a-c.md", "a/b.md", "＃.md", "😀.md"]);
    expect(await list({ after: "a/b.md" })).toEqual(["skip/x.md", "＃.md", "😀.md"]);
    expect(index.live()).toBeNull(); // no build yet: the rows are the vault, not the index
  });

  const cursor = (index: SqlIndex) => JSON.parse(index.meta("build_cursor") ?? "null") as { phase: string; after: string | null } | null;

  test("C10: a write during an org in-place build proceeds and survives the finalize", async () => {
    const { index, rows, funes } = org();
    await index.build({ vault: rows });
    await funes.remember([{ title: "M", body: "m body" }, { title: "N", body: "n body" }]);
    const input: BuildInput = { vault: rows, scope: { hash: "s2", ignoreScope: false } }; // the same spec, a new scope: in place
    const live = index.live()!.nodes;
    while (cursor(index)?.phase !== "pages") await index.buildStep(input, 1);
    expect(index.shadowBuilding).toBe(false);
    const [a] = (await funes.remember([{ title: "Written", body: "written mid build" }])).ids;
    while ((await index.buildStep(input, 1)) === "more");
    expect(index.live()!.nodes).toBe(live); // no flip: in place
    expect(cursor(index)).toBeNull();
    expect(await index.indexedPage({ id: a })).not.toBeNull();
    expect(index.contentIdentity().contentGeneration).not.toBeNull();
    expect(await statParity(rows, index.statsSync().lastReindexAt, await index.pageStats())).toEqual({ changed: false, basis: "stat" });
  });

  test("C10: steady writes of new pages during an org in-place build do not send it back to pass 1", async () => {
    const { index, rows, funes } = org();
    await index.build({ vault: rows });
    await funes.remember([{ title: "M", body: "m body" }, { title: "N", body: "n body" }]);
    const input: BuildInput = { vault: rows, scope: { hash: "s2", ignoreScope: false } };
    while (cursor(index)?.phase !== "pages") await index.buildStep(input, 1);
    const written: string[] = [];
    for (let i = 0; ; i++) {
      expect(i).toBeLessThan(20);
      written.push(...(await funes.remember([{ title: `W${i}`, body: `written mid build ${i}` }])).ids);
      const step = await index.buildStep(input, 1);
      if (step === "done") break;
      expect(cursor(index)!.phase).toBe("pages");
    }
    expect(cursor(index)).toBeNull();
    for (const id of written) expect(await index.indexedPage({ id })).not.toBeNull();
    expect(await statParity(rows, index.statsSync().lastReindexAt, await index.pageStats())).toEqual({ changed: false, basis: "stat" });
  });

  test("C10: a write that lands between the build's read of a page and its commit stands", async () => {
    const { index, rows, funes } = org();
    await index.build({ vault: rows });
    const ids = (await funes.remember([{ title: "M", body: "m body" }, { title: "N", body: "n body" }])).ids;
    let hook: (() => Promise<void>) | null = null;
    const vault: Vault = { list: (o) => rows.list(o), atomically: (fn) => rows.atomically(fn), read: async (p) => { const f = await rows.read(p); const h = hook; hook = null; await h?.(); return f; } };
    const input: BuildInput = { vault, scope: { hash: "s2", ignoreScope: false } };
    while (cursor(index)?.phase !== "pages") await index.buildStep(input, 1);
    expect(cursor(index)!.after).toBe(`${ids[0]}.md`); // pass 2 is past M: N is the next read
    hook = async () => { await funes.forget(ids[1]!); }; // a soft forget: no new page, so no refs restart
    while ((await index.buildStep(input, 1)) === "more");
    expect(await index.indexedPage({ id: ids[1] })).toBeNull(); // the build did not bring the old row back
    expect((await index.pageStats())!.rows.find((r) => r.id === ids[1])!.version).toBe((await rows.read(`${ids[1]}.md`))!.version);
  });

  test("a migration into the shadow slot refuses writes with `building` until the flip", async () => {
    const exec = libsqlExec(openTurso(":memory:"));
    const first = org(exec);
    await first.index.build({ vault: first.rows });
    await first.funes.remember([{ title: "Old", body: "old body" }, { title: "Older", body: "older body" }]);
    // a new embedder: the same database, another embedding spec — a migration
    const { index, rows, funes } = org(exec, Object.defineProperty(new GoldenEmbedder(), "id", { value: "golden-fake-2" }));
    const live = index.live()!.nodes;
    expect(await index.buildStep({ vault: rows }, 1)).toBe("more");
    expect(index.shadowBuilding).toBe(true);
    const refused = await funes.remember([{ title: "New", body: "new body" }]).then(() => null, (e: { status?: number; code?: string }) => e);
    expect(refused).toMatchObject({ status: 503, code: "building" });
    expect(await Array.fromAsync(rows.list())).toHaveLength(2); // the refused write left no row
    while ((await index.buildStep({ vault: rows }, 1)) === "more");
    expect(index.live()!.nodes).not.toBe(live); // flipped
    expect(index.shadowBuilding).toBe(false);
    expect((await funes.remember([{ title: "New", body: "new body" }])).ids).toHaveLength(1);
    expect(index.statsSync().nodes).toBe(3);
    expect(index.statsSync().embeddingSignature).toStartWith("golden-fake-2:");
  });
});
