// Postgres LIVE smoke test — the coverage gap R1 (PGLite removal 2026-07-20 deleted every test that
// exercised the pg dialect; store.ts has since gained UNTESTED SQL, incl. provenance-v1's insert
// $15/$16/$17 + to_char projection). This runs the real pg write/read path against a cluster and is
// the gate for the sparkling profile-B staging rollout.
//
//   FUNES_PG_URL="postgres://funes_test@localhost:5433/funes_test" bun test packages/funes-engine/src/postgres-smoke.test.ts
//
// SKIPS cleanly when FUNES_PG_URL is unset (normal suite), so it never blocks libsql-only CI. Point
// it at a THROWAWAY db (it DROPs + recreates the funes tables). A docker one-liner for staging:
//   docker run --rm -e POSTGRES_HOST_AUTH_METHOD=trust -p 5433:5432 pgvector/pgvector:pg17
import { test, expect } from "bun:test";
import type { Embedder } from "funes-core";
import { makeStore } from "./factory.ts";

const PG = process.env.FUNES_PG_URL;
const live = test.skipIf(!PG);

// Deterministic fake embedder (dim 8) — this smoke test validates SQL round-trips + provenance, not
// semantic ranking, so a real E5 download is unnecessary. "alpha"/"beta" get distinct vectors.
class FakeEmbedder implements Embedder {
  readonly dim = 8;
  private v(t: string): Float32Array {
    const a = new Float32Array(8);
    for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) a[[...w].reduce((s, c) => s + c.charCodeAt(0), 0) % 8]! += 1;
    let n = 0; for (const x of a) n += x * x; n = Math.sqrt(n) || 1;
    for (let i = 0; i < a.length; i++) a[i]! /= n;
    return a;
  }
  async embedQuery(t: string) { return this.v(t); }
  async embedPassage(t: string) { return this.v(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.v(t)); }
}

async function freshStore(writeActor?: string) {
  // wipe the funes tables so the run is repeatable; the store recreates them (create-if-not-exists).
  const { postgresDriver } = await import("./postgres-driver.ts");
  const d = await postgresDriver(PG!);
  for (const t of ["nodes", "edges", "chunks", "recall_stats", "meta"]) await d.exec(`drop table if exists ${t} cascade;`);
  return makeStore({ backend: "postgres", pgUrl: PG, embedder: new FakeEmbedder(), writeActor });
}

live("pg smoke: remember + recall round-trips (create extension/table/index all execute)", async () => {
  const s = await freshStore();
  await s.remember([
    { id: "notes/alpha", title: "Alpha", body: "alpha widgets gizmos", trust: "trusted" },
    { id: "notes/beta", title: "Beta", body: "beta sprockets", trust: "trusted" },
  ]);
  const ids = (await s.recall({ query: "alpha widgets", k: 5 })).map((r) => r.id);
  expect(ids).toContain("notes/alpha");
});

live("pg smoke: provenance-v1 SQL — declared surfaces, write_actor stamped not from payload", async () => {
  const s = await freshStore("operator:ada"); // server-set actor
  await s.remember([{
    id: "notes/p", title: "Paper", body: "graphrag hybrid retrieval",
    source: "https://arxiv.org/abs/2404.16130", authored: "2026-05-01", trust: "trusted",
    ...({ writeActor: "trusted-human" } as object), // hostile self-assertion — must be ignored
  }]);
  const hit = (await s.recall({ query: "graphrag", k: 5 })).find((r) => r.id === "notes/p")!;
  expect(hit.source).toBe("https://arxiv.org/abs/2404.16130");
  expect(hit.authored).toBe("2026-05-01T00:00:00Z"); // to_char projection ($16 timestamptz round-trip)
  expect(hit.writeActor).toBe("operator:ada");       // server fact, not the payload's claim
  const page = (await s.indexedPage({ id: "notes/p" }))!;
  expect(page.source).toBe("https://arxiv.org/abs/2404.16130");
  expect(page.writeActor).toBe("operator:ada");
});

live("pg smoke: a source-only edit is hash-skipped yet the metadata-sync UPDATE persists it", async () => {
  const s = await freshStore();
  const base = { id: "notes/q", title: "Q", body: "stable body", trust: "trusted" as const };
  await s.remember([{ ...base, source: "first://x" }]);
  const r = await s.remember([{ ...base, source: "second://y" }]); // same title/body ⇒ hash-skipped
  expect(r.skipped).toBe(1);
  expect((await s.indexedPage({ id: "notes/q" }))!.source).toBe("second://y");
});

live("pg smoke: schema-v3 columns exist + fresh index has no schema_version guard (idempotent adds)", async () => {
  const s = await freshStore();
  await s.remember([{ id: "a", title: "A", body: "b" }]);
  expect((await s.indexedPage({ id: "a" }))!.writeActor).toBe("unknown"); // default stamp, legacy semantics
});
