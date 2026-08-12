import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import {
  GENERATION_VERSION, encodeGeneration, generationRecord, hashItem, normalizeGenerationPath,
  type GenerationRecord,
} from "funes-shared";
import { indexDir } from "./reindex.ts";
import { operations, dispatchToolCall, type OperationContext } from "./ops.ts";
import { FunesStore } from "./funes-store.ts";
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

const REC: GenerationRecord[] = [
  { path: "wiki/a.md", contentHash: "aaaa", trust: "trusted" },
  { path: "in_web/b.md", contentHash: "bbbb", trust: "untrusted" },
  { path: "out_memory/c.md", contentHash: "cccc", trust: "untrusted" },
];
const BASE = { records: REC, scope: null, embeddingSpec: "e:16:chunk1800o200" };

// ── the pure encoding ─────────────────────────────────────────────────────────────────────────────

test("generation-v1: versioned value, record-order independent, canonical", () => {
  const g = encodeGeneration(BASE);
  expect(g.startsWith(`${GENERATION_VERSION}:`)).toBe(true);
  expect(g).toMatch(/^v1:[0-9a-f]{64}$/);
  // sorted records: any input order encodes identically
  expect(encodeGeneration({ ...BASE, records: [...REC].reverse() })).toBe(g);
  // path normalization: backslashes + NFC fold into the same value (mac NFD vs linux NFC canon)
  const nfd = "wiki/cafe\u0301.md"; // café decomposed (e + combining acute)
  const nfc = "wiki/caf\u00e9.md";  // café precomposed
  const withNfd = encodeGeneration({ ...BASE, records: [...REC, { path: nfd, contentHash: "dddd", trust: "trusted" }] });
  const withNfc = encodeGeneration({ ...BASE, records: [...REC, { path: nfc, contentHash: "dddd", trust: "trusted" }] });
  expect(withNfd).toBe(withNfc);
  expect(normalizeGenerationPath("wiki\\a.md")).toBe("wiki/a.md");
});

test("generation-v1: diverges on EVERY input — record content, trust label, scope, parser, embedding, schema", () => {
  const g = encodeGeneration(BASE);
  // one changed page (content hash)
  expect(encodeGeneration({ ...BASE, records: [{ ...REC[0]!, contentHash: "eeee" }, REC[1]!, REC[2]!] })).not.toBe(g);
  // one changed TRUST label on otherwise identical content
  expect(encodeGeneration({ ...BASE, records: [{ ...REC[0]!, trust: "untrusted" }, REC[1]!, REC[2]!] })).not.toBe(g);
  // an added / removed record
  expect(encodeGeneration({ ...BASE, records: REC.slice(1) })).not.toBe(g);
  // index scope (present vs null, hash flip, ignore flip)
  const scoped = encodeGeneration({ ...BASE, scope: { hash: "s1", ignoreScope: false } });
  expect(scoped).not.toBe(g);
  expect(encodeGeneration({ ...BASE, scope: { hash: "s2", ignoreScope: false } })).not.toBe(scoped);
  expect(encodeGeneration({ ...BASE, scope: { hash: "s1", ignoreScope: true } })).not.toBe(scoped);
  // parser / embedding spec / index schema versions
  expect(encodeGeneration({ ...BASE, parserVersion: "fm-wikilinks/2" })).not.toBe(g);
  expect(encodeGeneration({ ...BASE, embeddingSpec: "e5:384:chunk1800o200" })).not.toBe(g);
  expect(encodeGeneration({ ...BASE, indexSchemaVersion: "4" })).not.toBe(g); // default is "3" (provenance-v1)
});

test("generation-v1: records use THE store content hash (hashItem) — edges included", () => {
  const item = { id: "wiki/a", path: "wiki/a.md", title: "A", body: "body", trust: "trusted" as const, edges: [{ type: "cites", target: "b" }] };
  const rec = generationRecord(item);
  expect(rec.contentHash).toBe(hashItem(item));
  expect(rec).toEqual({ path: "wiki/a.md", contentHash: hashItem(item), trust: "trusted" });
  // an edge rewrite (what resolveEdgeTargets does) changes the record — resolved edges are hashed
  expect(generationRecord({ ...item, edges: [{ type: "cites", target: "wiki/b" }] }).contentHash).not.toBe(rec.contentHash);
});

// ── computed at index build, deterministic across DIRECTORIES, exposed via health ────────────────

function writeVault(root: string): void {
  mkdirSync(join(root, "wiki"), { recursive: true });
  mkdirSync(join(root, "in_web"), { recursive: true });
  writeFileSync(join(root, "wiki", "alpha.md"), "---\ntitle: Alpha\n---\nalpha body [[beta]]\n");
  writeFileSync(join(root, "wiki", "beta.md"), "---\ntitle: Beta\n---\nbeta body\n");
  writeFileSync(join(root, "in_web", "feed.md"), "---\ntitle: Feed\n---\ningested feed body\n");
}

test("generation-v1: two FULL builds of identical content in DIFFERENT dirs stamp the SAME generation; one changed page or trust label diverges", async () => {
  const a = mkdtempSync(join(tmpdir(), "funes-gen-a-"));
  const b = mkdtempSync(join(tmpdir(), "funes-gen-b-"));
  writeVault(a);
  writeVault(b);

  const sa = await LibsqlStore.create(new FakeEmbedder());
  await indexDir(sa, a, a, {});
  const ga = await sa.getGeneration();

  const sb = await LibsqlStore.create(new FakeEmbedder());
  await indexDir(sb, b, b, {});
  const gb = await sb.getGeneration();

  expect(ga).toMatch(/^v1:[0-9a-f]{64}$/);
  expect(gb).toBe(ga!); // locus-independent: canon/follower comparability

  // stats()/health expose the LIVE stamp
  expect((await sa.stats()).generation).toBe(ga!);

  // one changed page in one locus -> generations diverge
  writeFileSync(join(b, "wiki", "beta.md"), "---\ntitle: Beta\n---\nbeta body CHANGED\n");
  await indexDir(sb, b, b, {});
  const gb2 = await sb.getGeneration();
  expect(gb2).not.toBe(ga);

  // a TRUST-ONLY flip (content hash unchanged — remember() takes the metadata-sync path) still
  // moves the generation: trust is an effective-label input, not a content input
  writeFileSync(join(a, "wiki", "alpha.md"), "---\ntitle: Alpha\ntrust: untrusted\n---\nalpha body [[beta]]\n");
  await indexDir(sa, a, a, {});
  expect(await sa.getGeneration()).not.toBe(ga);

  await sa.close();
  await sb.close();
});

test("generation-v1: a bounded (--max) run does NOT restamp; scope input moves the generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "funes-gen-max-"));
  writeVault(root);
  const s = await LibsqlStore.create(new FakeEmbedder());
  await indexDir(s, root, root, {});
  const full = await s.getGeneration();
  expect(full).not.toBeNull();

  // bounded run: never reaches the stamp block — the FULL generation survives untouched
  writeFileSync(join(root, "wiki", "gamma.md"), "---\ntitle: Gamma\n---\nnew page\n");
  await indexDir(s, root, root, { maxFiles: 1 });
  expect(await s.getGeneration()).toBe(full!);

  // a scoped full rebuild (different scope signature) stamps a DIFFERENT generation even though
  // the exclude matches nothing — index scope is a first-class generation input
  await indexDir(s, root, root, { scopeSignature: { hash: "scope-x", ignoreScope: false } });
  expect(await s.getGeneration()).not.toBe(full);
  await s.close();
});

// NOTE: the second "backend-neutral protocol" arm (a PGLite store stamping + exposing the generation
// identically) was removed with PGLite 2026-07-20 — the libSQL arm above is the sole backend and
// already asserts stamp + stats + health exposure.
