import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "libsql";
import type { Embedder, MemoryItem } from "funes-core";
import { LibsqlStore } from "./store.ts";

// READ-ONLY open (canon host read face, 2026-07-16): mode=ro — no WAL pragma, no DDL, no meta writes.
// The RW create() path's `PRAGMA journal_mode=WAL` header write is what crash-looped the read
// face on an RO index mount ("attempt to write a readonly database", RestartCount 3439). These
// tests pin: the RO open serves recall/stats, refuses writes with a CLEAR error, validates the
// index LOUDLY at open, and — with the publisher-side finalize — needs zero write access at all.

class FakeEmbedder implements Embedder {
  readonly dim = 64;
  private vec(t: string): Float32Array {
    const v = new Float32Array(this.dim);
    for (const w of t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      let h = 0;
      for (const c of w) h = (h * 31 + c.codePointAt(0)!) % 1_000_003;
      v[h % this.dim]! += 1;
    }
    let norm = 0; for (const x of v) norm += x * x; norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < v.length; i++) v[i]! /= norm;
    return v;
  }
  async embedQuery(t: string) { return this.vec(t); }
  async embedPassage(t: string) { return this.vec(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.vec(t)); }
}

const ITEMS: MemoryItem[] = [
  { id: "sourdough", path: "sourdough.md", title: "Sourdough", body: "rye loaf starter hydration ferment overnight", trust: "trusted" },
  { id: "telescope", path: "wiki/telescope.md", title: "Telescope", body: "dobsonian collimation primary mirror", trust: "trusted" },
];

/** Build a finalized (journal_mode=DELETE, no sidecars) index — the published-generation shape. */
async function buildIndex(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "funes-ro-"));
  const p = join(dir, "index.db");
  const rw = await LibsqlStore.create(new FakeEmbedder(), p);
  await rw.remember(ITEMS);
  await rw.setGeneration("v1:" + "a".repeat(64));
  await rw.finalizeForPublish(); // same-handle by design (a 2nd connection is SQLITE_BUSY until GC)
  await rw.close();
  return p;
}

test("finalizeForPublish: WAL index flips to journal_mode=delete, -wal/-shm gone (RO-mount consumable)", async () => {
  const p = await buildIndex();
  expect(existsSync(p + "-wal")).toBe(false);
  expect(existsSync(p + "-shm")).toBe(false);
  // SQLite header bytes 18/19 (file-format read/write version): 1 = legacy/DELETE journal, 2 = WAL
  const header = readFileSync(p);
  expect(header[18]).toBe(1);
  expect(header[19]).toBe(1);
});

test("RO open: recall/stats/indexedPage serve; writes refuse with a CLEAR error; no sidecars appear", async () => {
  const p = await buildIndex();
  const s = await LibsqlStore.create(new FakeEmbedder(), p, { readonly: true });
  const res = await s.recall({ query: "rye starter hydration", k: 2 });
  expect(res[0]!.id).toBe("sourdough");
  const st = await s.stats();
  expect(st.nodes).toBe(2);
  expect(st.generation).toBe("v1:" + "a".repeat(64));
  expect((await s.indexedPage({ id: "telescope" }))?.title).toBe("Telescope");
  expect(s.recallTracking).toBe(false); // telemetry forced OFF — recordRecalls is a write

  // defense in depth UNDER the face op allowlist: every structural write refuses, clearly
  await expect(s.remember([{ id: "x", title: "X", body: "b" }])).rejects.toThrow(/READ-ONLY/);
  await expect(s.remove(["sourdough"])).rejects.toThrow(/READ-ONLY/);
  await expect(s.prune([])).rejects.toThrow(/READ-ONLY/);
  await expect(s.beginReindex()).rejects.toThrow(/READ-ONLY/);
  await s.close();

  expect(existsSync(p + "-wal")).toBe(false); // the RO open never re-entered WAL
  expect(existsSync(p + "-shm")).toBe(false);
});

test("RO open works from a READ-ONLY directory — the live crash-loop repro", async () => {
  const p = await buildIndex();
  const dir = join(p, "..");
  chmodSync(dir, 0o555); // the RO index mount
  try {
    const s = await LibsqlStore.create(new FakeEmbedder(), p, { readonly: true });
    expect((await s.recall({ query: "dobsonian collimation", k: 1 }))[0]!.id).toBe("telescope");
    await s.close();
  } finally {
    chmodSync(dir, 0o755); // temp-dir cleanup needs it back
  }
});

test("RW open F3: opening an EXISTING finalized (DELETE) db leaves it DELETE, no sidecars; busy_timeout is set on both modes", async () => {
  const p = await buildIndex(); // finalized: journal_mode=delete, no -wal/-shm
  // the broker opens the SAME published generation READ-WRITE — it must NOT flip it back to WAL
  // (that recreates -shm and races the mode=ro readers). journal mode stays untouched; busy set.
  const rw = await LibsqlStore.create(new FakeEmbedder(), p);
  const rwdb = (rw as unknown as { db: { prepare: (q: string) => { get: () => Record<string, unknown> } } }).db;
  expect(rwdb.prepare("PRAGMA journal_mode").get().journal_mode).toBe("delete");
  expect(rwdb.prepare("PRAGMA busy_timeout").get().timeout).toBe(5000);
  await rw.close();
  expect(existsSync(p + "-wal")).toBe(false); // a finalized generation opened RW stayed sidecar-free
  expect(existsSync(p + "-shm")).toBe(false);
  // and the RO open carries the same busy_timeout (a reader waits out a brief writer lock, not 500)
  const ro = await LibsqlStore.create(new FakeEmbedder(), p, { readonly: true });
  const rodb = (ro as unknown as { db: { prepare: (q: string) => { get: () => Record<string, unknown> } } }).db;
  expect(rodb.prepare("PRAGMA busy_timeout").get().timeout).toBe(5000);
  await ro.close();
});

test("RO open F7: EVERY mutating entry point refuses — endReindex/setGeneration/set+clearScopeSignature/finalize too", async () => {
  const p = await buildIndex();
  const s = await LibsqlStore.create(new FakeEmbedder(), p, { readonly: true });
  await expect(s.endReindex()).rejects.toThrow(/READ-ONLY/);
  await expect(s.setGeneration("v1:" + "b".repeat(64))).rejects.toThrow(/READ-ONLY/);
  await expect(s.setScopeSignature({ hash: "deadbeef", ignoreScope: false })).rejects.toThrow(/READ-ONLY/);
  await expect(s.clearScopeSignature()).rejects.toThrow(/READ-ONLY/);
  await expect(s.finalizeForPublish()).rejects.toThrow(/READ-ONLY/);
  await s.close();
  expect(existsSync(p + "-wal")).toBe(false); // none of them touched the file
});

test("RO open F9: a DIRTY index (interrupted full reindex) refuses read-only at open, loudly", async () => {
  const p = await buildIndex();
  const raw = new Database(p); // an interrupted reindex left the dirty marker set
  raw.prepare("insert into meta(key,value) values ('reindex_dirty','1') on conflict(key) do update set value='1'").run();
  raw.close();
  await expect(LibsqlStore.create(new FakeEmbedder(), p, { readonly: true })).rejects.toThrow(/dirty/);
});

test("RO open F9: a malformed schema (missing core table) fails at open, not on the first recall", async () => {
  const p = await buildIndex();
  const raw = new Database(p);
  raw.exec("drop table nodes"); // meta survives, but the core operational table is gone
  raw.close();
  await expect(LibsqlStore.create(new FakeEmbedder(), p, { readonly: true })).rejects.toThrow(/missing the "nodes" table/);
});

test("RO open F9: a path with %, ?, # and a space opens (mode=ro URI escaping)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "funes-ro-uri-"));
  const p = join(dir, "a %b ?c #d loaf.db"); // every char roUri must percent-encode, plus a space
  const rw = await LibsqlStore.create(new FakeEmbedder(), p);
  await rw.remember(ITEMS);
  await rw.finalizeForPublish();
  await rw.close();
  const s = await LibsqlStore.create(new FakeEmbedder(), p, { readonly: true });
  expect((await s.recall({ query: "rye starter hydration", k: 1 }))[0]!.id).toBe("sourdough");
  await s.close();
});

test("RO open F9: repeated failed opens don't leak the native handle (no-crash loop)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "funes-ro-leak-"));
  const absent = join(dir, "nope.db");
  for (let i = 0; i < 60; i++) {
    await expect(LibsqlStore.create(new FakeEmbedder(), absent, { readonly: true })).rejects.toThrow(/cannot open index read-only/);
  }
  // a malformed (validation-failure) open also closes its handle each time — 60 opens, no fd leak
  const bad = await buildIndex();
  const raw = new Database(bad);
  raw.exec("drop table chunks");
  raw.close();
  for (let i = 0; i < 60; i++) {
    await expect(LibsqlStore.create(new FakeEmbedder(), bad, { readonly: true })).rejects.toThrow(/missing the "chunks" table/);
  }
});

test("RO open: LOUD, descriptive startup errors — absent file, non-index db, embedding drift, :memory:", async () => {
  const dir = mkdtempSync(join(tmpdir(), "funes-ro-bad-"));
  // absent index — the misconfigured-mount case must NAME the path and the fix
  await expect(LibsqlStore.create(new FakeEmbedder(), join(dir, "absent.db"), { readonly: true }))
    .rejects.toThrow(/cannot open index read-only .*absent\.db/);
  // a SQLite file that is not a funes index
  const stray = join(dir, "stray.db");
  const raw = new Database(stray);
  raw.exec("create table not_funes(x)");
  raw.close();
  await expect(LibsqlStore.create(new FakeEmbedder(), stray, { readonly: true }))
    .rejects.toThrow(/not a funes index/);
  // embedding drift: index built with dim-64 fake, opened with a different-signature embedder
  const p = await buildIndex();
  class OtherEmbedder extends FakeEmbedder { readonly id = "other-model"; }
  await expect(LibsqlStore.create(new OtherEmbedder(), p, { readonly: true }))
    .rejects.toThrow(/embedding drift/);
  // :memory: has nothing to read
  await expect(LibsqlStore.create(new FakeEmbedder(), undefined, { readonly: true }))
    .rejects.toThrow(/read-only open needs an existing index FILE/);
});
