// OKF-aligned enrichment (2026-07): description/resource stored + surfaced + FTS-folded on libSQL.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "libsql";
import { LibsqlStore } from "./store.ts";
import type { Embedder } from "funes-core";

// A trivial deterministic embedder — the FTS arm does the discriminating in these tests.
const fakeEmbedder: Embedder = {
  dim: 8,
  async embedQuery() { return new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]); },
  async embedPassage() { return new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]); },
  async embedPassages(texts) { return texts.map(() => new Float32Array([1, 0, 0, 0, 0, 0, 0, 0])); },
};

test("libsql enrich: description folds into FTS + description/resource surface in recall", async () => {
  const s = await LibsqlStore.create(fakeEmbedder, ":memory:");
  await s.remember([{
    id: "notes/alpha", title: "Alpha", type: "note", body: "hello there",
    description: "a note about widgets and gizmos", resource: "https://example.com/widgets", trust: "trusted",
  }]);
  // "widgets" appears ONLY in the description → recall must still hit (FTS fold) and surface the fields.
  const res = await s.recall({ query: "widgets", k: 5 });
  const hit = res.find((r) => r.id === "notes/alpha");
  expect(hit).toBeDefined();
  expect(hit!.description).toBe("a note about widgets and gizmos");
  expect(hit!.resource).toBe("https://example.com/widgets");
});

test("libsql enrich: a description-only edit syncs the column without a re-embed (hash-skipped path)", async () => {
  const s = await LibsqlStore.create(fakeEmbedder, ":memory:");
  const base = { id: "notes/beta", title: "Beta", type: "note", body: "stable body text", trust: "trusted" as const };
  await s.remember([{ ...base, description: "first" }]);
  const r1 = await s.remember([{ ...base, description: "second" }]); // same title/body ⇒ hash unchanged
  expect(r1.skipped).toBe(1);                                        // proves the metadata-sync path, not a re-embed
  const res = await s.recall({ query: "stable", k: 5 });             // match on the (unchanged) body
  expect(res.find((r) => r.id === "notes/beta")?.description).toBe("second");
});

test("libsql enrich: legacy-schema migration ALTERs description/resource onto a pre-enrich index (Gate A-6)", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "funes-libsql-legacy-")), "idx.db");
  // Build a current store, then strip the enrich columns to simulate a pre-2026-07 index.
  const s1 = await LibsqlStore.create(fakeEmbedder, dbPath);
  await s1.remember([{ id: "notes/old", title: "Old", type: "note", body: "vintage body", trust: "trusted" }]);
  await s1.close();
  const raw = new Database(dbPath);
  raw.exec("alter table nodes drop column description; alter table nodes drop column resource;");
  raw.close();
  // Reopen: the pragma-guarded migration must re-add the columns (after the signature+dirty gates).
  const s2 = await LibsqlStore.create(fakeEmbedder, dbPath);
  await s2.remember([{ id: "notes/new", title: "New", type: "note", body: "fresh body",
    description: "post-migration description", resource: "file:///x", trust: "trusted" }]);
  const res = await s2.recall({ query: "fresh", k: 5 });
  const hit = res.find((r) => r.id === "notes/new");
  expect(hit?.description).toBe("post-migration description");
  expect(hit?.resource).toBe("file:///x");
  await s2.close();
});

test("libsql enrich: the FTS row is refreshed when description changes on a hash-skipped item (Codex #1)", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "funes-libsql-")), "idx.db");
  const s = await LibsqlStore.create(fakeEmbedder, dbPath);
  const base = { id: "notes/beta", title: "Beta", type: "note", body: "stable body text", trust: "trusted" as const };
  await s.remember([{ ...base, description: "aardvark" }]);
  await s.remember([{ ...base, description: "borzoi" }]); // same title/body ⇒ hash-skipped path
  // Inspect the FTS table directly (recall's vector arm always returns a lone item, so it can't isolate FTS).
  // P2.10: description is its own fts5 column now (weighted), not a concatenated blob.
  const row = new Database(dbPath).prepare("select description from nodes_fts where nid=?").get("notes/beta") as { description: string };
  expect(row.description).toContain("borzoi");        // FTS refreshed to the new description
  expect(row.description).not.toContain("aardvark");  // the stale description is gone
});
