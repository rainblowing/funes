// P2.10: fts5 title weighting + the versioned schema migration (Codex R2#4).
import { test, expect } from "bun:test";
import Database from "libsql";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { LibsqlStore } from "./index.ts";

// Bag-of-words embedder (dim 32) — enough vector signal that FTS ordering is the tiebreak the title
// weighting must win, not the whole story.
class Fake implements Embedder {
  readonly dim = 32;
  private v(t: string): Float32Array {
    const a = new Float32Array(this.dim);
    for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) a[[...w].reduce((s, c) => s + c.charCodeAt(0), 0) % this.dim]! += 1;
    let n = 0; for (const x of a) n += x * x; n = Math.sqrt(n) || 1;
    for (let i = 0; i < a.length; i++) a[i]! /= n;
    return a;
  }
  async embedQuery(t: string) { return this.v(t); }
  async embedPassage(t: string) { return this.v(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.v(t)); }
}

test("P2.10 title weighting: a TITLE match outranks a body-only mention of the same term", async () => {
  const s = await LibsqlStore.create(new Fake());
  await s.remember([
    // the term "creatine" is the TITLE of one page and a passing body mention of another
    { id: "notes/creatine", title: "Creatine", body: "notes on daily supplementation and loading phases here" },
    { id: "notes/stack", title: "My supplement stack", body: "a long list where creatine appears once among magnesium zinc omega and many other words" },
  ]);
  const res = await s.recall({ query: "creatine", k: 2 });
  expect(res[0]!.id).toBe("notes/creatine"); // the titled page wins over the body-only mention
  await s.close();
});

// Until the 0.3.0 schema fence (PLAN-0.3.0 R2#2) this asserted that a pre-2 index AUTO-MIGRATED on
// a writer open (fts rebuilt from nodes, no re-embed, stamped current). The ladder is retired: the
// same downgraded fixture is now REFUSED with the rebuild named, and the single-column fts table is
// still there afterwards — the refusal mutates nothing.
test("P2.10 schema fence: a pre-2 single-column fts index is REFUSED on a WRITER open, untouched", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "funes-p210-")), "idx.db");
  // build a normal index, then DOWNGRADE it to the pre-2 shape (single-column fts, no schema_version)
  const s1 = await LibsqlStore.create(new Fake(), dbPath);
  await s1.remember([
    { id: "notes/creatine", title: "Creatine", body: "supplementation notes" },
    { id: "notes/stack", title: "My supplement stack", body: "creatine appears once here among many other words" },
  ]);
  await s1.close();
  const raw = new Database(dbPath);
  raw.exec(`
    drop table nodes_fts;
    create virtual table nodes_fts using fts5(nid unindexed, content, tokenize='unicode61');
    insert into nodes_fts(nid,content) select id, title||' '||coalesce(description,'')||' '||body from nodes;
    delete from meta where key='schema_version';
  `);
  raw.close();

  await expect(LibsqlStore.create(new Fake(), dbPath)).rejects.toThrow(/schema_version "pre-2" != "4".*reindex --fresh/s);
  const after = new Database(dbPath);
  expect(after.prepare("select value from meta where key='schema_version'").get()).toBeUndefined(); // no stamp on the way out
  const cols = after.prepare("select * from nodes_fts limit 1").get() as Record<string, unknown>;
  expect("content" in cols && !("title" in cols)).toBe(true); // still the pre-2 single column — nothing rebuilt
  after.close();
});

test("P2.10 schema migration: a READ-ONLY open REFUSES a pre-2 index (can't migrate)", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "funes-p210-ro-")), "idx.db");
  const s1 = await LibsqlStore.create(new Fake(), dbPath);
  await s1.remember([{ id: "a", title: "A", body: "b" }]);
  // finalize to a DELETE-journal single-file so RO can open it, then downgrade the schema
  await s1.finalizeForPublish?.();
  await s1.close();
  const raw = new Database(dbPath);
  raw.exec(`
    drop table nodes_fts;
    create virtual table nodes_fts using fts5(nid unindexed, content, tokenize='unicode61');
    insert into nodes_fts(nid,content) select id, title||' '||body from nodes;
    delete from meta where key='schema_version';
  `);
  raw.close();
  await expect(LibsqlStore.create(new Fake(), dbPath, { readonly: true })).rejects.toThrow(/schema_version|pre-2|rebuild/i);
});
