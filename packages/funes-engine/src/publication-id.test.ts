// The publication id (PLAN-0.3.0 item 8) — the manifest's half of the identity split.
//
// A manifest names the PUBLICATION ID and never the content generation: the id is immutable, so
// local state (a principal's ack, a retention decision) can bind to it, while the content
// generation moves with the rows and is answered by the database alone. The id is generated BEFORE
// finalization and stamped into BOTH, so every open can check that the manifest and the bytes it
// points at are a pair.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import {
  PublishedIndex, publicationIdOf, publishGenerationManifest, publishReindex, readGenerationManifest,
} from "./publication.ts";
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

const embedder = new FakeEmbedder();
const open = (p: string) => LibsqlStore.create(embedder, p);

function makeVault(): string {
  const vault = mkdtempSync(join(tmpdir(), "funes-pubid-vault-"));
  mkdirSync(join(vault, "wiki"), { recursive: true });
  writeFileSync(join(vault, "wiki", "alpha.md"), "---\ntitle: Alpha\n---\nalpha sourdough loaf body\n");
  return vault;
}

test("item 8: a publish stamps ONE publication id into the manifest AND the database it points at", async () => {
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-pubid-home-"));
  const r = await publishReindex({ vault, home, embedder, open });
  const m = readGenerationManifest(home)!;
  expect(m.publicationId).toMatch(/^pub:[0-9a-f]{32}$/);
  expect(publicationIdOf(m)).toBe(m.publicationId!);

  const ro = await LibsqlStore.create(embedder, join(home, m.db), { readonly: true });
  const id = await ro.contentIdentity();
  expect(id.publicationId).toBe(m.publicationId!);      // stamped inside the bytes, before finalization
  expect(id.contentGeneration).toBe(r.generation);      // …and the content generation only in there
  expect(id.invalidatedAt).toBeNull();
  await ro.close();
});

test("item 8: a FORCED republish of identical content is a NEW publication of the SAME content generation", async () => {
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-pubid-force-"));
  const first = await publishReindex({ vault, home, embedder, open });
  const id1 = readGenerationManifest(home)!.publicationId;
  const second = await publishReindex({ vault, home, embedder, open, force: true });
  const m2 = readGenerationManifest(home)!;
  // The reason the id cannot be DERIVED from the content: these two artefacts are byte-distinct
  // files with one content generation, and anything bound to an id must tell them apart.
  expect(second.generation).toBe(first.generation);
  expect(m2.publicationId).not.toBe(id1);
});

test("item 8: a manifest paired with a FOREIGN database is refused on open, not served", async () => {
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-pubid-swap-"));
  await publishReindex({ vault, home, embedder, open });
  const m = readGenerationManifest(home)!;
  // Publish a second home and move ITS db under this manifest's name — the swap the hub refuses.
  // Both are valid funes indexes with the same content generation; only the stamped publication id
  // tells them apart, which is exactly why the pairing is checked on every open.
  const other = mkdtempSync(join(tmpdir(), "funes-pubid-other-"));
  await publishReindex({ vault, home: other, embedder, open });
  const om = readGenerationManifest(other)!;
  renameSync(join(other, om.db), join(home, m.db));

  const consumer = new PublishedIndex(home, open);
  await expect(consumer.with(async (s) => s.recall({ query: "sourdough", k: 1 })))
    .rejects.toThrow(/is not publication/);
  await consumer.close();
});

test("item 8: a LEGACY manifest names no publication id — one is derived from (generation, db), and the pairing check stands down", async () => {
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-pubid-legacy-"));
  await publishReindex({ vault, home, embedder, open });
  const m = readGenerationManifest(home)!;
  // A 0.2.1 manifest: no publicationId at all. Its db carries no stamp either, so there is nothing
  // to validate against — but local state still needs a stable name, and the generation ALONE is
  // not one (a forced republish keeps it and moves the db).
  const legacy = { version: 1 as const, generation: m.generation, db: m.db, publishedAt: m.publishedAt };
  publishGenerationManifest(home, legacy);
  expect(readGenerationManifest(home)!.publicationId).toBeUndefined();
  expect(publicationIdOf(legacy)).toMatch(/^legacy:[0-9a-f]{32}$/);
  expect(publicationIdOf({ ...legacy, db: "gen-other.db" })).not.toBe(publicationIdOf(legacy));

  // …and a legacy home still serves: the check is skipped, never failed closed on absence.
  const consumer = new PublishedIndex(home, open);
  expect((await consumer.with(async (s) => s.recall({ query: "sourdough loaf", k: 1 }))).length).toBe(1);
  await consumer.close();
  expect(JSON.parse(readFileSync(join(home, "generation.json"), "utf8")).publicationId).toBeUndefined();
});
