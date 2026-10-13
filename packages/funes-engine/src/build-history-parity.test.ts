// PLAN-0.4.0 item 8 (RAI-138) — build history must not reach the rows.
//
// RAI-123 built one corpus at two loci: same content generation, same serving signature, same fused
// order, different scores (0.2857 vs 0.2679), and `reindex --fresh` on the incremental locus moved
// its score onto the fresh one's. The ticket blamed BM25 term statistics. It was the embedder: at
// EMBED_FORWARD_BATCH=32 a vector depended on its forward's batch-mates, and an incremental build
// embeds only the CHANGED pages (`remember` embeds `chunkLists.flat()` of those), so forward
// composition WAS build history. Item 8 makes the forward one text wide; the real model's half of
// the proof is embedding-conformance.test.ts, the stub half is embedder.test.ts.
//
// This file is the store's half, with no model: given an embedder whose vector is a function of its
// text, a fresh build and a variant-then-canonical build of one vault — pages edited then restored,
// a page pruned, a page added late, all through the incremental (hash-skip) path — hold byte-equal
// chunk and node embeddings, equal per-row bm25 (nodes_fts is a plain FTS5 table, so a delete is
// exact), and answer recall() with equal (id, rank, score) triples. If this fails, the divergence
// is the store's, and no forward width fixes it.
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { indexDir } from "./reindex.ts";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";

class FakeEmbedder implements Embedder {
  readonly dim = 16;
  private vec(t: string): Float32Array {
    const v = new Float32Array(this.dim);
    for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? [])
      v[[...w].reduce((a, c) => a + c.charCodeAt(0), 0) % this.dim]! += 1;
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i]! /= n;
    return v;
  }
  async embedQuery(t: string) { return this.vec(t); }
  async embedPassage(t: string) { return this.vec(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.vec(t)); }
}

const page = (title: string, body: string, edge?: string) =>
  `---\ntitle: ${title}\n${edge ? `edges:\n  - { type: relates_to, target: ${edge} }\n` : ""}---\n${body}\n`;

/** Long enough to chunk (CHUNK_SIZE 1800), so a multi-chunk page's `ord > 0` rows are compared too. */
const LONG = (w: string) => Array.from({ length: 90 }, (_, i) => `${w} paragraph ${i} on recall fusion and ranking arms.`).join("\n");

const CANONICAL: Record<string, string> = {
  "alpha.md": page("Alpha Protein", "protein muscle fat goals and daily intake", "beta"),
  "beta.md": page("Beta", "muscle recovery, sleep and protein timing", "gamma"),
  "gamma.md": page("Gamma Scales", "piano scales and arpeggios practice", "delta"),
  "delta.md": page("Delta", "fusion ranking recall arms: text, vector, graph"),
  "epsilon.md": page("Epsilon", LONG("canonical"), "alpha"),
  "zeta.md": page("Zeta", "sleep hygiene and muscle soreness"),
  "eta.md": page("Eta", "piano practice log, recall of scales"),
  "late.md": page("Late", "protein recall ranking added after the first build"),
};

/** What the incremental locus saw first: three pages edited (one of them multi-chunk), an extra page
 *  carrying every query term that is later deleted, and `late` not yet written. Epsilon's variant is
 *  twice the canonical length, so the canonical rewrite SHRINKS it: with equal chunk counts the rewrite
 *  would only overwrite ords 0..n and a store that forgot `delete from chunks` before re-inserting
 *  (funes-libsql store.ts `delChunks`) would pass — keeping stale high-ord vectors the vector arm
 *  still ranks on. */
const VARIANT: Record<string, string> = {
  ...CANONICAL,
  "alpha.md": page("Alpha Protein", "protein protein piano recall — an edit that is later reverted", "beta"),
  "gamma.md": page("Gamma Variant", "scales only", "zeta"),
  "epsilon.md": page("Epsilon", `${LONG("variant")}\n${LONG("variant")}`, "alpha"),
  "extra.md": page("Extra", "protein muscle piano scales fusion ranking recall sleep"),
};
delete VARIANT["late.md"];

function writeVault(dir: string, pages: Record<string, string>): void {
  rmSync(join(dir, "wiki"), { recursive: true, force: true });
  mkdirSync(join(dir, "wiki"), { recursive: true });
  for (const [name, text] of Object.entries(pages)) writeFileSync(join(dir, "wiki", name), text);
}

const QUERIES = ["protein muscle", "piano scales", "fusion ranking recall"];
/** The production weights (store.ts BM25_*_WEIGHT); any fixed weights would prove delete-exactness. */
const BM25 = "bm25(nodes_fts, 0.0, 10.0, 3.0, 1.0)";
const ftsMatch = (q: string) => q.split(" ").map((t) => `"${t}"`).join(" OR ");

/** Epsilon's chunk-row count — read beside the open store, to prove the shrink happened. */
function epsilonChunks(dbPath: string): number {
  const d = new Database(dbPath, { readonly: true });
  try {
    return (d.prepare("select count(*) as n from chunks where page_id = 'wiki/epsilon'").get() as { n: number }).n;
  } finally { d.close(); }
}

function rows(dbPath: string) {
  const d = new Database(dbPath);
  try {
    return {
      chunks: d.prepare("select page_id, ord, hex(embedding) as e from chunks order by page_id, ord").all(),
      nodes: d.prepare("select id, hex(embedding) as e from nodes order by id").all(),
      bm25: QUERIES.map((q) => d.prepare(`select nid, ${BM25} as s from nodes_fts where nodes_fts match ? order by nid`).all(ftsMatch(q))),
    };
  } finally { d.close(); }
}

test("RAI-138: a fresh build and a variant-then-canonical build of one vault hold equal rows and answer recall equally", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-history-vault-"));
  const homes = mkdtempSync(join(tmpdir(), "funes-history-homes-"));
  const incrementalDb = join(homes, "incremental.db");
  const freshDb = join(homes, "fresh.db");

  // The incremental locus: a full build of the variant, then the canonical vault over it — no --fresh.
  writeVault(vault, VARIANT);
  const inc = await LibsqlStore.create(new FakeEmbedder(), incrementalDb);
  await indexDir(inc, vault, vault);
  const variantEpsilon = epsilonChunks(incrementalDb);
  writeVault(vault, CANONICAL);
  const second = await indexDir(inc, vault, vault);
  // The history this test is about actually happened: re-embedded edits, hash-skips, a prune.
  expect(second).toMatchObject({ indexed: 4, skipped: 4, pruned: 1 });

  // The fresh locus: the same vault on disk, built once from nothing.
  const fresh = await LibsqlStore.create(new FakeEmbedder(), freshDb);
  await indexDir(fresh, vault, vault, { fresh: true });

  // RAI-123's premise, reproduced: one content generation over both.
  const gen = (await fresh.contentIdentity()).contentGeneration;
  expect(gen).not.toBeNull();
  expect((await inc.contentIdentity()).contentGeneration).toBe(gen!);

  const triples = async (s: LibsqlStore) =>
    Promise.all(QUERIES.map(async (query) => (await s.recall({ query, k: 8 })).map((r) => [r.id, r.rank, r.score])));
  const recallFresh = await triples(fresh);
  expect(recallFresh.every((t) => t.length > 0)).toBe(true);
  expect(await triples(inc)).toEqual(recallFresh); // exact: score is the raw RRF sum, so equal per-arm order
  await inc.close();
  await fresh.close();

  const a = rows(freshDb);
  const b = rows(incrementalDb);
  expect(a.chunks.length).toBeGreaterThan(Object.keys(CANONICAL).length); // the long page chunked
  // The canonical rewrite shrank epsilon, so equal chunk rows below also prove no stale high ords.
  expect(variantEpsilon).toBeGreaterThan(epsilonChunks(freshDb));
  expect(epsilonChunks(freshDb)).toBeGreaterThan(1);
  expect(b.chunks).toEqual(a.chunks);
  expect(b.nodes).toEqual(a.nodes);
  expect(a.bm25.every((r) => r.length > 0)).toBe(true);
  expect(b.bm25).toEqual(a.bm25);
});
