// PLAN-0.5.0 item 37 (ADR-0015, record 31): the edge store — a DO SQLite twin of the libSQL index in
// two slots — run inside a real SQLite-backed DO under local workerd, so every DO SQLite clause the
// store issues (json_each, bm25, row_number, fts5 unicode61, BLOB vectors, transactionSync) executes
// here, not only in the docs.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Embedder, MemoryItem } from "funes-core";
import { EdgeStore } from "../src/edge-store.ts";

const DIM = 1024;
/** A deterministic bag-of-words embedder: each word lights one dimension, so two texts sharing words
 *  are near and the vector arm ranks for real. Never Workers AI. */
class WordEmbedder implements Embedder {
  readonly dim = DIM;
  readonly id = "test/words";
  calls = 0;
  private vec(text: string): Float32Array {
    this.calls++;
    const v = new Float32Array(DIM);
    for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      let h = 0;
      for (const c of w) h = (h * 31 + c.codePointAt(0)!) >>> 0;
      v[h % DIM]! += 1;
    }
    return v;
  }
  async embedQuery(t: string) { return this.vec(t); }
  async embedPassage(t: string) { return this.vec(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.vec(t)); }
}

const SCOPE = { hash: "scope-hash-of-nothing", ignoreScope: false };
const page = (id: string, title: string, body: string, extra: Partial<MemoryItem> = {}): MemoryItem =>
  ({ id, path: `${id}.md`, title, body, trust: "trusted", ...extra });

/** A fresh SQLite DO per call: the store under test over its storage. */
function inDo<T>(fn: (store: EdgeStore, storage: DurableObjectStorage, e: WordEmbedder) => Promise<T> | T): Promise<T> {
  const stub = env.TASTE.getByName(crypto.randomUUID());
  return runInDurableObject(stub, async (_o, state) => {
    const e = new WordEmbedder();
    return fn(new EdgeStore(state.storage, e), state.storage, e);
  });
}

/** A full build of `items` into the shadow slot, then the swap. */
async function build(store: EdgeStore, items: MemoryItem[]): Promise<void> {
  store.beginBuild();
  store.writeBuild(await store.embed(items), items.map((it) => ({ id: it.id, version: `etag-${it.id}` })));
  store.swap({ scope: SCOPE, ownerStarId: "rainblow.ing/taste", okf: null });
}

describe("recall over the live slot", () => {
  it("fuses FTS (Cyrillic, case-folded), the vector scan and the graph arm, ranked 1..n", () =>
    inDo(async (store) => {
      await build(store, [
        page("items/stalker", "Сталкер", "фильм Тарковского о Зоне [[items/zona]]", { edges: [{ type: "related-to", target: "items/zona" }] }),
        page("items/zona", "The Zone", "a room that grants wishes"),
        page("items/solaris", "Solaris", "a planet ocean"),
      ]);
      // FTS: stalker only. Vector: stalker, then the two zero-score pages by page_id (solaris, zona),
      // as libSQL's exact arm returns its nearest chunks whatever their score. At k=2 the seeds are
      // stalker and solaris, so the graph arm walks stalker → zona, and zona (vector 3rd + graph 1st)
      // fuses above solaris (vector 2nd) at RRF k=5.
      const hits = await store.recall({ query: "СТАЛКЕР", k: 2 });
      expect(hits.map((h) => h.id)).toEqual(["items/stalker", "items/zona"]);
      expect(hits.map((h) => h.rank)).toEqual([1, 2]);
      // At k=3 zona is a vector seed itself, and a seed is never a graph candidate (libSQL's rule).
      expect((await store.recall({ query: "СТАЛКЕР", k: 3 })).map((h) => h.id)).toEqual(["items/stalker", "items/solaris", "items/zona"]);
    }));

  it("prefilters FTS, the scan and the fused list with matchesFilter, so a selective where never starves k", () =>
    inDo(async (store) => {
      // 30 films outrank the one book on every arm; k=1 under {domain: book} must still find it.
      const films = Array.from({ length: 30 }, (_, i) => page(`items/f${i}`, `ocean film ${i}`, "ocean ocean ocean", { frontmatter: { domain: "film" } }));
      await build(store, [...films, page("items/b", "a book", "ocean once", { frontmatter: { domain: "book" } }), page("items/none", "ocean", "ocean")]);
      const where = { all: [{ any: [{ domain: "book" }] }] };
      expect((await store.recall({ query: "ocean", k: 1, filter: where })).map((h) => h.id)).toEqual(["items/b"]);
      // A page with no frontmatter matches no filter, a negated one included (fail-closed).
      const notFilm = await store.recall({ query: "ocean", k: 5, filter: { all: [{ any: [{ domain: "film" }], not: true }] } });
      expect(notFilm.map((h) => h.id)).toEqual(["items/b"]);
      expect(await store.recall({ query: "ocean", k: 5, filter: { all: [{ any: [{ domain: "song" }] }] } })).toEqual([]);
      // The stored frontmatter rides each hit, for the op layer's `fields` and the collapse keys.
      expect((await store.recall({ query: "ocean", k: 1, filter: where }))[0]!.frontmatter).toEqual({ domain: "book" });
    }));

  it("keeps the first chunk per page from the top n×3 chunks (one hit per page, however many chunks match)", () =>
    inDo(async (store) => {
      const long = Array.from({ length: 400 }, () => "ocean wave").join(" "); // several 1,800-char chunks
      await build(store, [page("items/long", "long", long), page("items/short", "short", "ocean wave")]);
      const hits = await store.recall({ query: "ocean wave", k: 5 });
      expect(hits.map((h) => h.id).sort()).toEqual(["items/long", "items/short"]);
      expect((await store.stats()).chunks).toBeGreaterThan(3);
    }));
});

describe("indexedPage", () => {
  it("serves one page's indexed snapshot by id or path (with or without .md), from the live slot only", () =>
    inDo(async (store) => {
      await build(store, [page("items/a", "Alpha", "the body", { type: "film", authored: "2026-01-02", frontmatter: { year: 1979 } })]);
      const want = { id: "items/a", path: "items/a.md", title: "Alpha", type: "film", trust: "trusted", description: null, resource: null,
        source: null, authored: "2026-01-02T00:00:00.000Z", writeActor: "unknown", body: "the body", frontmatter: { year: 1979 } };
      expect(await store.indexedPage({ id: "items/a" })).toEqual(want);
      expect(await store.indexedPage({ path: "items/a.md" })).toEqual(want);
      expect(await store.indexedPage({ path: "items/a" })).toEqual(want);
      expect(await store.indexedPage({ id: "items/zz" })).toBeNull();
    }));
});

describe("two slots and the swap", () => {
  it("serves the live slot throughout a build; only the swap moves it and stamps the content generation", () =>
    inDo(async (store) => {
      await build(store, [page("items/a", "Alpha", "first edition")]);
      const before = await store.stats();
      expect(before.contentGeneration).toMatch(/^v3:[0-9a-f]{64}$/);
      expect(before.schemaVersion).toBe("do-sqlite/1");
      expect(before.reindexDirty).toBe(false);

      store.beginBuild();
      store.writeBuild(await store.embed([page("items/b", "Beta", "second edition")]), [{ id: "items/b", version: "etag-b" }]);
      // Mid-build: the old slot answers, unchanged, and nothing reads as dirty or partial.
      expect((await store.recall({ query: "edition", k: 5 })).map((h) => h.id)).toEqual(["items/a"]);
      expect(await store.stats()).toEqual(before);
      expect((await store.pageStats())!.rows).toEqual([{ id: "items/a", version: "etag-items/a" }]);

      store.swap({ scope: SCOPE, ownerStarId: "rainblow.ing/taste", okf: { nonconformant: 2, malformed: 1 } });
      expect((await store.recall({ query: "edition", k: 5 })).map((h) => h.id)).toEqual(["items/b"]);
      const after = await store.stats();
      expect(after.contentGeneration).toMatch(/^v3:/);
      expect(after.contentGeneration).not.toBe(before.contentGeneration);
      expect(after.okf).toEqual({ nonconformant: 2, malformed: 1 });
      expect(after.scopeHash).toBe(SCOPE.hash);
      const ps = (await store.pageStats())!;
      expect(ps.rows).toEqual([{ id: "items/b", version: "etag-b" }]);
      expect(ps.at).toBe(after.lastReindexAt);
    }));

  it("names one content generation for one content and one embedder, whatever DO builds it", async () => {
    const item = page("items/a", "Alpha", "body", { frontmatter: { domain: "film" } });
    const gen = (it: MemoryItem) => inDo(async (store) => {
      await build(store, [it]);
      return (await store.stats()).contentGeneration;
    });
    const g = await gen(item);
    expect(await gen(item)).toBe(g);
    // v3: a frontmatter-only edit moves it.
    expect(await gen({ ...item, frontmatter: { domain: "book" } })).not.toBe(g);
  });
});

describe("an apply: remember/remove stage, commit (S4) makes them durable in the live slot", () => {
  it("has no read-your-writes before commit, then serves the rows and clears the content generation", () =>
    inDo(async (store, storage) => {
      await build(store, [page("items/a", "Alpha", "old text"), page("items/gone", "Gone", "old text")]);
      const stamped = (await store.stats()).contentGeneration;
      expect(await store.remember([page("items/n", "New", "fresh words")])).toEqual({ indexed: 1, skipped: 0 });
      expect(await store.remove(["items/gone", "items/never"])).toBe(1);
      expect((await store.recall({ query: "fresh", k: 5 })).map((h) => h.id)).not.toContain("items/n");
      expect((await store.stats()).contentGeneration).toBe(stamped);

      storage.transactionSync(() => store.commit());
      expect((await store.recall({ query: "fresh", k: 1 })).map((h) => h.id)).toEqual(["items/n"]);
      expect(await store.indexedPage({ id: "items/gone" })).toBeNull();
      const s = await store.stats();
      expect(s.contentGeneration).toBeNull();
      expect(s.invalidatedReason).toBe("apply: 2 rows moved");
      // Only a full build records a page stat.
      expect((await store.pageStats())!.rows.map((r) => r.id).sort()).toEqual(["items/a", "items/gone"]);
    }));

  it("re-embeds nothing for an unchanged fingerprint, and a commit that moves no row keeps the stamp", () =>
    inDo(async (store, storage, e) => {
      const a = page("items/a", "Alpha", "old text");
      await build(store, [a]);
      const calls = e.calls;
      expect(await store.remember([a])).toEqual({ indexed: 0, skipped: 1 });
      expect(e.calls).toBe(calls);
      storage.transactionSync(() => store.commit());
      expect((await store.stats()).contentGeneration).toMatch(/^v3:/);
    }));

  it("discards what a failed frame staged", () =>
    inDo(async (store, storage) => {
      await build(store, [page("items/a", "Alpha", "x")]);
      await store.remember([page("items/n", "New", "fresh")]);
      store.discard();
      storage.transactionSync(() => store.commit());
      expect(await store.indexedPage({ id: "items/n" })).toBeNull();
    }));
});

describe("the protocol tables sit outside every slot", () => {
  const PROTOCOL = ["receipts", "apply_journal", "build_state", "grants", "login_seen", "mint_handles"];
  const fill = (sql: SqlStorage) => {
    sql.exec("insert into receipts values ('01J0', 'p', 'w', '2026-10-13T00:00:00Z')");
    sql.exec("insert into apply_journal(state, writes, created_at) values ('conflict', '[]', '2026-10-13T00:00:00Z')");
    sql.exec("insert into grants values ('h', 'outbox@locus-1', 'outbox', '[\"rainblow.ing/taste\"]', '2026-10-13', null, null, 'locus-1')");
    sql.exec("insert into login_seen values ('tg', 1)");
    sql.exec("insert into mint_handles values ('h', 1)");
  };
  const counts = (sql: SqlStorage) => PROTOCOL.map((t) => sql.exec<{ n: number }>(`select count(*) as n from ${t}`).one().n);

  it("survive a full build and its swap, which clears only build_state", () =>
    inDo(async (store, storage) => {
      fill(storage.sql);
      storage.sql.exec("insert into build_state values (1, 'bootstrap', '2026-10-13T00:00:00Z', null)");
      await build(store, [page("items/a", "Alpha", "x")]);
      expect(counts(storage.sql)).toEqual([1, 1, 0, 1, 1, 1]);
    }));

  it("survive a schema rebuild, which drops both slots and the index meta", () =>
    inDo(async (store, storage, e) => {
      await build(store, [page("items/a", "Alpha", "x")]);
      fill(storage.sql);
      storage.sql.exec("update meta set value = 'do-sqlite/0' where key = 'schema_version'"); // an older build's stamp
      const reopened = new EdgeStore(storage, e);
      expect(counts(storage.sql)).toEqual([1, 1, 0, 1, 1, 1]);
      const s = await reopened.stats();
      expect([s.nodes, s.contentGeneration, s.schemaVersion]).toEqual([0, null, "do-sqlite/1"]);
      expect(await reopened.recall({ query: "Alpha" })).toEqual([]);
    }));
});
