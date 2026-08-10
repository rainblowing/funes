// Provenance schema-v1 (2026-07-22): declared source/authored surface; write_actor is STAMPED by the
// store, never accepted from the item payload; v2→v3 migrates additively; declared provenance folds
// into the generation. See wiki/synthesis/2026-07-22-provenance-schema-v1.md.
import { test, expect } from "bun:test";
import Database from "libsql";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { encodeGeneration } from "funes-shared";
import { LibsqlStore } from "./index.ts";

const fake: Embedder = {
  dim: 8,
  async embedQuery() { return new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]); },
  async embedPassage() { return new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]); },
  async embedPassages(t) { return t.map(() => new Float32Array([1, 0, 0, 0, 0, 0, 0, 0])); },
};

test("provenance: declared source/authored surface in recall + indexedPage", async () => {
  const s = await LibsqlStore.create(fake, ":memory:");
  await s.remember([{
    id: "notes/paper", title: "GraphRAG", body: "hybrid retrieval notes",
    source: "https://arxiv.org/abs/2404.16130", authored: "2026-05-01", trust: "trusted",
  }]);
  const hit = (await s.recall({ query: "GraphRAG", k: 5 })).find((r) => r.id === "notes/paper")!;
  expect(hit.source).toBe("https://arxiv.org/abs/2404.16130");
  expect(hit.authored).toBe("2026-05-01T00:00:00.000Z");
  const page = (await s.indexedPage({ id: "notes/paper" }))!;
  expect(page.source).toBe("https://arxiv.org/abs/2404.16130");
  expect(page.authored).toBe("2026-05-01T00:00:00.000Z");
});

test("provenance: write_actor is STAMPED from the store, NEVER from the item payload", async () => {
  // The store is constructed with a server-set actor; an item that tries to self-assert a different
  // actor via a stray field must be ignored (the write path reads writeActor from the store only).
  const s = await LibsqlStore.create(fake, ":memory:", { writeActor: "operator:ada" });
  await s.remember([{ id: "a", title: "A", body: "b",
    // hostile self-assertion — there is no MemoryItem.writeActor, so this is inert, but assert it:
    ...( { writeActor: "trusted-human", write_actor: "root" } as object ),
  }]);
  const page = (await s.indexedPage({ id: "a" }))!;
  expect(page.writeActor).toBe("operator:ada"); // server fact, not the payload's claim
});

test("provenance: legacy/local writes stamp write_actor 'unknown' (the default)", async () => {
  const s = await LibsqlStore.create(fake, ":memory:"); // no writeActor → local/legacy
  await s.remember([{ id: "a", title: "A", body: "b" }]);
  expect((await s.indexedPage({ id: "a" }))!.writeActor).toBe("unknown");
  expect((await s.indexedPage({ id: "a" }))!.source).toBeNull();
});

test("provenance: a source-only edit is hash-skipped yet persists (metadata-sync path)", async () => {
  const s = await LibsqlStore.create(fake, ":memory:");
  const base = { id: "a", title: "A", body: "stable body", trust: "trusted" as const };
  await s.remember([{ ...base, source: "first://x" }]);
  const r = await s.remember([{ ...base, source: "second://y" }]); // same title/body ⇒ hash unchanged
  expect(r.skipped).toBe(1); // proves the metadata-sync path, not a re-embed
  expect((await s.indexedPage({ id: "a" }))!.source).toBe("second://y");
});

test("provenance: declared source/authored fold into the generation (a provenance edit re-publishes)", () => {
  const rec = { path: "a.md", contentHash: "h", trust: "trusted" };
  const base = { records: [rec], scope: null, embeddingSpec: "e:8:c" };
  const g = encodeGeneration(base);
  expect(encodeGeneration({ ...base, records: [{ ...rec, source: "x://1" }] })).not.toBe(g);
  expect(encodeGeneration({ ...base, records: [{ ...rec, authored: "2026-01-01" }] })).not.toBe(g);
});

test("provenance: a pre-provenance (v2) index migrates additively on a writer open", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "funes-prov-")), "idx.db");
  const s1 = await LibsqlStore.create(fake, dbPath);
  await s1.remember([{ id: "a", title: "A", body: "b" }]);
  await s1.close();
  // simulate a v2 index: drop the provenance columns + set schema_version back to "2"
  const raw = new Database(dbPath);
  raw.exec(`
    alter table nodes drop column source;
    alter table nodes drop column authored;
    alter table nodes drop column write_actor;
    insert into meta(key,value) values ('schema_version','2') on conflict(key) do update set value='2';
  `);
  raw.close();
  // reopen (writer): additive migration re-adds the columns + stamps 3
  const s2 = await LibsqlStore.create(fake, dbPath);
  const sv = (new Database(dbPath).prepare("select value from meta where key='schema_version'").get() as { value: string }).value;
  expect(sv).toBe("3");
  expect((await s2.indexedPage({ id: "a" }))!.writeActor).toBe("unknown"); // pre-existing row backfilled
  await s2.close();
});
