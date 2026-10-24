// RAI-306 §3a-7: `db.transaction()` issues a ROLLBACK after SQLite has already rolled a SQLITE_FULL or
// IOERR transaction back itself, and its "cannot rollback - no transaction is active" replaced the real
// cause — a disk-full publish reported only the rollback. The store's txn() keeps the first error.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { LibsqlStore } from "./store.ts";

const fake: Embedder = {
  dim: 8,
  async embedQuery() { return new Float32Array(8).fill(1); },
  async embedPassage() { return new Float32Array(8).fill(1); },
  async embedPassages(t) { return t.map(() => new Float32Array(8).fill(1)); },
};

test("a full database surfaces SQLITE_FULL from remember, not \"no transaction is active\"", async () => {
  const s = await LibsqlStore.create(fake, join(mkdtempSync(join(tmpdir(), "funes-txn-")), "index.db"));
  try {
    await s.remember([{ id: "a", title: "A", body: "first" }]);
    // The disk fills: no page beyond the ones the file already has.
    const db = (s as unknown as { db: { prepare(q: string): { get(): unknown } ; exec(q: string): void } }).db;
    const { page_count } = db.prepare("pragma page_count").get() as { page_count: number };
    db.exec(`pragma max_page_count=${page_count}`);
    const big = Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, title: `P${i}`, body: "x".repeat(4000) }));
    const err = await s.remember(big).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/full/i);
    expect(err?.message).not.toMatch(/no transaction is active/);
  } finally {
    await s.close();
  }
});
