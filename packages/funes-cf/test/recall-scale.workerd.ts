// PLAN-0.5.0 item 37 (record 31 "CPU — the V8 stand-in is not workerd"): recall's CPU and memory over
// the taste star's scale — 3,200 pages × 1024 dims, one chunk each — measured under local workerd.
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Embedder, MemoryItem } from "funes-core";
import { EdgeStore, type IndexRow } from "../src/edge-store.ts";

const DIM = 1024, PAGES = 3_200;
/** A seeded xorshift: the fixture is the same bytes on every run. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296 - 0.5; };
}
const unit = (r: () => number) => {
  const v = new Float32Array(DIM);
  let n = 0;
  for (let i = 0; i < DIM; i++) { v[i] = r(); n += v[i]! * v[i]!; }
  for (let i = 0; i < DIM; i++) v[i]! /= Math.sqrt(n);
  return v;
};
class Random implements Embedder {
  readonly dim = DIM;
  readonly id = "test/random";
  private r = rng(7);
  async embedQuery() { return unit(this.r); }
  async embedPassage() { return unit(this.r); }
  async embedPassages(ts: string[]) { return ts.map(() => unit(this.r)); }
}

it("recall over 3,200 × 1024 stays inside the DO's CPU and memory budget", { timeout: 120_000 }, async () => {
  const stub = env.TASTE.getByName(crypto.randomUUID());
  const r = rng(42);
  const words = ["film", "book", "album", "ocean", "zone", "mirror", "night", "river", "сталкер", "солярис", "город", "лето"];
  await runInDurableObject(stub, async (_o, state) => {
    const store = new EdgeStore(state.storage, new Random());
    store.beginBuild();
    for (let b = 0; b < PAGES; b += 500) {
      const rows: IndexRow[] = [];
      for (let i = b; i < Math.min(b + 500, PAGES); i++) {
        const body = Array.from({ length: 60 }, () => words[Math.floor((r() + 0.5) * words.length)]).join(" "); // ~420 B, as taste pages average
        const item: MemoryItem = { id: `items/p${i}`, path: `items/p${i}.md`, title: `Item ${i}`, body, trust: "trusted", frontmatter: { domain: i % 2 ? "film" : "book" } };
        rows.push({ item, vectors: [unit(r)] });
      }
      state.storage.transactionSync(() => store.writeBuild(rows, rows.map((x) => ({ id: x.item.id, version: "e" }))));
    }
    store.swap({ scope: { hash: "h", ignoreScope: false }, ownerStarId: "rainblow.ing/taste", okf: null });
    expect((await store.stats()).chunks).toBe(PAGES);
  });

  // CPU: each recall is its own DO call, timed from outside it. workerd's clocks do not advance
  // inside a synchronous block, so the wall time across the call (an upper bound on its CPU) is what
  // a run can see. Memory: local workerd reports no heap (process.memoryUsage, node:v8
  // getHeapStatistics are all zero, performance.memory is absent), so the run counts what recall
  // MATERIALIZES from SQLite — every row value it reads, BLOBs at their byte length — and the largest
  // single row, since the scan iterates its cursor and holds one chunk BLOB at a time.
  const ms: number[] = [];
  let read = { bytes: 0, maxRow: 0 };
  for (let i = 0; i < 6; i++) {
    const t0 = Date.now();
    const out = await runInDurableObject(stub, async (_o, state) => {
      const { storage, count } = counting(state.storage);
      const store = new EdgeStore(storage, new Random());
      const filtered = i % 2 === 1;
      const hits = await store.recall({ query: "сталкер ocean film", k: 10, ...(filtered ? { filter: { all: [{ any: [{ domain: "film" }] }] } } : {}) });
      return { hits: hits.length, count: { ...count } };
    });
    ms.push(Date.now() - t0);
    expect(out.hits).toBe(10);
    if (i === 0) read = out.count; // unfiltered: the whole scan
  }
  console.log(`recall over ${PAGES} × ${DIM} (local workerd): wall ms per call ${ms.join(", ")}; ` +
    `materialized ${(read.bytes / 2 ** 20).toFixed(1)} MiB per unfiltered recall, largest row ${read.maxRow} B`);
  // Budgets: 30 s CPU and 128 MB per isolate (DO limits). The bounds are far inside them, so a
  // regression (a buffered scan, an N+1 query) trips them before the platform would.
  expect(Math.max(...ms)).toBeLessThan(2_000);
  expect(read.bytes).toBeGreaterThanOrEqual(PAGES * DIM * 4); // every vector, once
  expect(read.bytes).toBeLessThan(PAGES * DIM * 4 * 1.25);
  expect(read.maxRow).toBeLessThan(DIM * 4 + 1_024); // no row larger than one chunk
});

/** storage whose sql.exec counts every value it hands back (a BLOB by byteLength, a string by its
 *  UTF-16 size, anything else 8 B) and the largest row. */
function counting(storage: DurableObjectStorage) {
  const count = { bytes: 0, maxRow: 0 };
  const tally = (row: Record<string, unknown>) => {
    let n = 0;
    for (const v of Object.values(row)) n += v instanceof ArrayBuffer ? v.byteLength : typeof v === "string" ? v.length * 2 : 8;
    count.bytes += n;
    count.maxRow = Math.max(count.maxRow, n);
    return row;
  };
  const wrap = (c: SqlStorageCursor<Record<string, SqlStorageValue>>) => ({
    next: () => { const r = c.next(); if (!r.done) tally(r.value); return r; },
    [Symbol.iterator]() { return this; },
    toArray: () => c.toArray().map(tally),
    one: () => tally(c.one()),
    get rowsWritten() { return c.rowsWritten; },
  });
  const sql = { exec: (q: string, ...b: SqlStorageValue[]) => wrap(storage.sql.exec(q, ...b)) };
  return { storage: { sql, transactionSync: <T>(f: () => T) => storage.transactionSync(f) } as unknown as DurableObjectStorage, count };
}
