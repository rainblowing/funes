// RAI-307 (plan B3): `reindex --fresh` rebuilds index.db IN PLACE, and every locked write rechecks the
// index identity. The skeptic's probe used bun:sqlite; this one runs the libsql driver: a handle opened
// before an in-place rebuild must refuse its next write instead of writing into the rebuilt tables.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import type { MemoryItem } from "funes-core/internal";
import { SCHEMA_VERSIONS } from "funes-core/internal";
import { LibsqlStore, openRawIndex, resetIndexInPlace } from "./store.ts";

/** A model-free embedder whose signature is `<id>:<dim>`. */
const emb = (id: string, dim: number): Embedder & { id: string } => ({
  id, dim,
  async embedQuery() { return new Float32Array(dim).fill(1); },
  async embedPassage() { return new Float32Array(dim).fill(1); },
  async embedPassages(ts) { return ts.map(() => new Float32Array(dim).fill(1)); },
});
const page = (id: string): MemoryItem => ({ id, path: `${id}.md`, title: id, body: `${id} body`, trust: "trusted" });

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "funes-fresh-"));
  path = join(dir, "index.db");
  process.env.FUNES_HOME = join(dir, "home");
});
afterEach(() => {
  delete process.env.FUNES_HOME;
  rmSync(dir, { recursive: true, force: true });
});

const meta = (): Record<string, string> => {
  const d = openRawIndex(path, false);
  try { return Object.fromEntries((d.prepare("select key, value from meta").all() as Array<{ key: string; value: string }>).map((r) => [r.key, r.value])); } finally { d.close(); }
};
const inspected = () => { const m = meta(); return { embeddingSignature: m.embedding_signature ?? null, schemaVersion: m.schema_version ?? null }; };
const chunkDecl = (): string => {
  const d = openRawIndex(path, false);
  try { return (d.prepare("select sql from sqlite_master where name = 'chunks'").get() as { sql: string }).sql; } finally { d.close(); }
};

test("RAI-307 probe: a handle opened before an in-place --fresh refuses remember, remove and beginReindex, and writes nothing", async () => {
  const old = await LibsqlStore.create(emb("a", 8), path);
  await old.remember([page("wiki/one")]);
  resetIndexInPlace(path, emb("b", 16), inspected());
  for (const write of [() => old.remember([page("wiki/two")]), () => old.remove(["wiki/one"]), () => old.beginReindex()]) {
    await expect(write()).rejects.toThrow(/restart this process/);
  }
  expect(meta().embedding_signature).toBe("b:16:chunk1800o200");
  const d = openRawIndex(path, false);
  try { expect((d.prepare("select count(*) as n from nodes").get() as { n: number }).n).toBe(0); } finally { d.close(); }
  await old.close();
});

test("the reset is one transaction: dirty, empty derived tables in the new shape, the new signature and schema; the owner and recall telemetry stay", async () => {
  const old = await LibsqlStore.create(emb("a", 8), path, { trackRecalls: true });
  await old.remember([page("wiki/one")]);
  await old.recall({ query: "one" });
  await old.setOwnerStarId("git://example/star");
  await old.close();
  expect(chunkDecl()).toContain("F32_BLOB(8)");

  resetIndexInPlace(path, emb("b", 16), inspected());
  const m = meta();
  expect(m).toMatchObject({ reindex_dirty: "1", embedding_signature: "b:16:chunk1800o200", schema_version: SCHEMA_VERSIONS.libsql, owner_star_id: "git://example/star" });
  expect(m.generation).toBeUndefined();
  expect(chunkDecl()).toContain("F32_BLOB(16)");
  const d = openRawIndex(path, false);
  try {
    for (const t of ["nodes", "edges", "chunks", "nodes_fts", "page_stat"]) expect((d.prepare(`select count(*) as n from ${t}`).get() as { n: number }).n).toBe(0);
    expect((d.prepare("select count(*) as n from recall_stats").get() as { n: number }).n).toBe(1);
  } finally { d.close(); }
  // the builder's own open (allowDirty) writes into the new shape
  const next = await LibsqlStore.create(emb("b", 16), path, { allowDirty: true });
  await next.remember([page("wiki/two")]);
  expect((await next.stats()).nodes).toBe(1);
  await next.close();
});

test("the reset refuses an index whose signature or schema moved since the inspect, and changes nothing", async () => {
  const s = await LibsqlStore.create(emb("a", 8), path);
  await s.remember([page("wiki/one")]);
  await s.close();
  const before = meta();
  expect(() => resetIndexInPlace(path, emb("b", 16), { embeddingSignature: "someone-else:8", schemaVersion: SCHEMA_VERSIONS.libsql })).toThrow(/changed since .*inspect/);
  expect(meta()).toEqual(before);
});
