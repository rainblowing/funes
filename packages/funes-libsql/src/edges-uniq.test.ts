// N1/N3 (graph research 2026-07-13): edges_target index exists, edges_uniq dedups a legacy
// index on open, and insert-or-ignore keeps raw remember() duplicates out.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "libsql";
import { LibsqlStore } from "./store.ts";
import type { Embedder } from "funes-core";

const fakeEmbedder: Embedder = {
  dim: 4,
  async embedQuery() { return new Float32Array([1, 0, 0, 0]); },
  async embedPassage() { return new Float32Array([1, 0, 0, 0]); },
  async embedPassages(texts) { return texts.map(() => new Float32Array([1, 0, 0, 0])); },
};

test("edges: target index + unique index exist; duplicate edges collapse (migration + insert-or-ignore)", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "funes-euniq-")), "idx.db");
  // Seed a LEGACY index: no unique index, duplicate rows already present.
  const s1 = await LibsqlStore.create(fakeEmbedder, dbPath);
  await s1.close();
  const raw = new Database(dbPath);
  raw.exec("drop index if exists edges_uniq; drop index if exists edges_target;");
  raw.exec("insert into edges(source,type,target,weight) values ('a','related_to','b',1.0)");
  raw.exec("insert into edges(source,type,target,weight) values ('a','related_to','b',1.0)"); // dup
  raw.close();
  // Reopen: migration dedups THEN builds the unique index; schema block restores edges_target.
  const s2 = await LibsqlStore.create(fakeEmbedder, dbPath);
  // Raw remember() with in-item duplicates: insert-or-ignore keeps one.
  await s2.remember([{ id: "c", title: "C", body: "x", trust: "trusted",
    edges: [{ type: "cites", target: "b" }, { type: "cites", target: "b" }] }]);
  await s2.close();
  const check = new Database(dbPath);
  const dupA = (check.prepare("select count(*) n from edges where source='a'").get() as { n: number }).n;
  const dupC = (check.prepare("select count(*) n from edges where source='c'").get() as { n: number }).n;
  const idx = (check.prepare("select name from sqlite_master where type='index' and tbl_name='edges'").all() as { name: string }[]).map((r) => r.name);
  check.close();
  expect(dupA).toBe(1);                       // legacy dup removed by the migration
  expect(dupC).toBe(1);                       // insert-or-ignore collapsed the in-item dup
  expect(idx).toContain("edges_uniq");
  expect(idx).toContain("edges_target");
});
