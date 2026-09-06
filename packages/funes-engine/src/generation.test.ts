import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder, MemoryItem } from "funes-core";
import {
  GENERATION_VERSION, PARSER_VERSION, INDEX_SCHEMA_VERSION, encodeGeneration, generationRecord, hashItem, normalizeGenerationPath,
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
  expect(g).toMatch(new RegExp(`^${GENERATION_VERSION}:[0-9a-f]{64}$`));
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
  // DERIVED from the live constant, never a literal: a hardcoded "other" value silently becomes
  // the DEFAULT on the next parser bump, and the assertion then proves nothing (it did — the
  // step-6 bump to fm-wikilinks/2 failed this line).
  expect(encodeGeneration({ ...BASE, parserVersion: `${PARSER_VERSION}-other` })).not.toBe(g);
  expect(encodeGeneration({ ...BASE, embeddingSpec: "e5:384:chunk1800o200" })).not.toBe(g);
  expect(encodeGeneration({ ...BASE, indexSchemaVersion: `${INDEX_SCHEMA_VERSION}-other` })).not.toBe(g); // the "4" bump made the old literal "4" the default
});

test("generation-v1: records use THE store content hash (hashItem) — edges included", () => {
  const item = { id: "wiki/a", path: "wiki/a.md", title: "A", body: "body", trust: "trusted" as const, edges: [{ type: "cites", target: "b" }] };
  const rec = generationRecord(item);
  expect(rec.contentHash).toBe(hashItem(item));
  // volatile/freshness are ALWAYS present (v2, item 6): the row's columns carry defaults, so an
  // absent frontmatter field and a declared-false one must project to the SAME record.
  expect(rec).toEqual({ path: "wiki/a.md", contentHash: hashItem(item), trust: "trusted", volatile: false, freshness: null });
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
  const ga = (await sa.contentIdentity()).contentGeneration;

  const sb = await LibsqlStore.create(new FakeEmbedder());
  await indexDir(sb, b, b, {});
  const gb = (await sb.contentIdentity()).contentGeneration;

  expect(ga).toMatch(new RegExp(`^${GENERATION_VERSION}:[0-9a-f]{64}$`));
  expect(gb).toBe(ga!); // locus-independent: canon/follower comparability

  // stats()/health expose the LIVE stamp
  expect((await sa.stats()).contentGeneration).toBe(ga!);

  // one changed page in one locus -> generations diverge
  writeFileSync(join(b, "wiki", "beta.md"), "---\ntitle: Beta\n---\nbeta body CHANGED\n");
  await indexDir(sb, b, b, {});
  const gb2 = (await sb.contentIdentity()).contentGeneration;
  expect(gb2).not.toBe(ga);

  // a TRUST-ONLY flip (content hash unchanged — remember() takes the metadata-sync path) still
  // moves the generation: trust is an effective-label input, not a content input
  writeFileSync(join(a, "wiki", "alpha.md"), "---\ntitle: Alpha\ntrust: untrusted\n---\nalpha body [[beta]]\n");
  await indexDir(sa, a, a, {});
  expect((await sa.contentIdentity()).contentGeneration).not.toBe(ga);

  await sa.close();
  await sb.close();
});

test("generation-v1: a bounded (--max) run does NOT restamp; scope input moves the generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "funes-gen-max-"));
  writeVault(root);
  const s = await LibsqlStore.create(new FakeEmbedder());
  await indexDir(s, root, root, {});
  const full = (await s.contentIdentity()).contentGeneration;
  expect(full).not.toBeNull();

  // bounded run: never reaches the stamp block — the FULL generation survives untouched
  writeFileSync(join(root, "wiki", "gamma.md"), "---\ntitle: Gamma\n---\nnew page\n");
  await indexDir(s, root, root, { maxFiles: 1 });
  expect((await s.contentIdentity()).contentGeneration).toBe(full!);

  // a scoped full rebuild (different scope signature) stamps a DIFFERENT generation even though
  // the exclude matches nothing — index scope is a first-class generation input
  await indexDir(s, root, root, { scopeSignature: { hash: "scope-x", ignoreScope: false } });
  expect((await s.contentIdentity()).contentGeneration).not.toBe(full);
  await s.close();
});

// NOTE: the second "backend-neutral protocol" arm (a PGLite store stamping + exposing the generation
// identically) was removed with PGLite 2026-07-20 — the libSQL arm above is the sole backend and
// already asserts stamp + stats + health exposure.

// ── three signatures, not one (PLAN-0.3.0 items 5 + 6) ──────────────────────────────────────────

test("item 5: widening the CONTENT GENERATION does not move the EMBEDDING-CONTENT FINGERPRINT", () => {
  // The trap this pins: before the split, one hash answered both "must this be re-embedded" and
  // "what rows does this index hold". Folding metadata into it would re-embed a whole vault for a
  // frontmatter edit that cannot move a single vector — eight homes, per edit.
  const base = { id: "wiki/a", path: "wiki/a.md", title: "A", body: "body", trust: "trusted" as const };
  const fp = hashItem(base);
  const g0 = encodeGeneration({ ...BASE, records: [generationRecord(base)] });
  for (const widened of [
    { ...base, type: "note" },
    { ...base, description: "a description" },
    { ...base, resource: "https://example.com/x" },
    { ...base, volatile: true },
    { ...base, freshness: "2026-01-01" },
    { ...base, source: "x://1" },
    { ...base, authored: "2026-01-01" },
    { ...base, trust: "untrusted" as const },
  ]) {
    expect(hashItem(widened)).toBe(fp);                                                   // no re-embed
    expect(encodeGeneration({ ...BASE, records: [generationRecord(widened)] })).not.toBe(g0); // new identity
  }
  // and the fingerprint still moves on what the embedder actually reads (title/body) + edges
  expect(hashItem({ ...base, body: "other" })).not.toBe(fp);
  expect(hashItem({ ...base, title: "B" })).not.toBe(fp);
  expect(hashItem({ ...base, edges: [{ type: "cites", target: "b" }] })).not.toBe(fp);
});

test("item 6: the content generation carries type/description/resource/volatile/freshness", () => {
  const rec: GenerationRecord = { path: "a.md", contentHash: "h", trust: "trusted" };
  const g = encodeGeneration({ ...BASE, records: [rec] });
  expect(encodeGeneration({ ...BASE, records: [{ ...rec, type: "note" }] })).not.toBe(g);
  expect(encodeGeneration({ ...BASE, records: [{ ...rec, description: "d" }] })).not.toBe(g);
  expect(encodeGeneration({ ...BASE, records: [{ ...rec, resource: "r://1" }] })).not.toBe(g);
  expect(encodeGeneration({ ...BASE, records: [{ ...rec, volatile: true }] })).not.toBe(g);
  expect(encodeGeneration({ ...BASE, records: [{ ...rec, freshness: 1767225600 }] })).not.toBe(g);
  // absent volatile IS false — the row column defaults to 0, so the two must be ONE identity, else
  // a store-fed item and a markdown-fed item over identical rows would claim different generations
  expect(encodeGeneration({ ...BASE, records: [{ ...rec, volatile: false }] })).toBe(g);
  // freshness normalizes to the instant the row stores: two spellings of one date are one identity
  const at = (freshness: string) => generationRecord({ id: "a", path: "a.md", title: "A", body: "b", freshness } as MemoryItem).freshness;
  expect(at("2026-01-01")).toBe(at("2026-01-01T00:00:00.000Z"));
  // an unparsable date is null — what the store records, not a NaN that hashes as a stray value
  expect(at("not a date")).toBeNull();
});

test("item 6: ADVISORY fields are excluded — a stamped write_actor cannot move the generation", () => {
  // write_actor depends on WHO ran the write; recall_stats moves when someone merely READS. Either
  // one inside the identity breaks the same-content-same-generation invariant that makes two loci
  // comparable at all. Neither is a MemoryItem field, so a hostile payload claiming one is inert.
  const base = { id: "wiki/a", path: "wiki/a.md", title: "A", body: "body", trust: "trusted" as const };
  const hostile = { ...base, ...({ writeActor: "root", write_actor: "root", recall_stats: 99 } as object) };
  expect(generationRecord(hostile)).toEqual(generationRecord(base));
  expect(encodeGeneration({ ...BASE, records: [generationRecord(hostile)] }))
    .toBe(encodeGeneration({ ...BASE, records: [generationRecord(base)] }));
});

test("item 6: a type-only edit is hash-skipped, yet reaches the row AND moves the generation", async () => {
  // The reconcile the plan calls for: `type` was missing from the hash-skipped UPDATE, so once it
  // became a generation input a type-only edit would move the recomputed target while the built
  // index still held the old value — the publisher's final target check could never pass.
  const root = mkdtempSync(join(tmpdir(), "funes-gen-type-"));
  mkdirSync(join(root, "wiki"), { recursive: true });
  const page = join(root, "wiki", "alpha.md");
  writeFileSync(page, "---\ntitle: Alpha\ntype: note\n---\nalpha body\n");
  const s = await LibsqlStore.create(new FakeEmbedder());
  await indexDir(s, root, root, {});
  const g1 = (await s.contentIdentity()).contentGeneration;
  expect((await s.indexedPage({ id: "wiki/alpha" }))!.type).toBe("note");

  writeFileSync(page, "---\ntitle: Alpha\ntype: decision\n---\nalpha body\n"); // body untouched
  const r = await indexDir(s, root, root, {});
  expect(r.indexed).toBe(0);                                                    // hash-skipped: no re-embed
  expect((await s.indexedPage({ id: "wiki/alpha" }))!.type).toBe("decision");   // …yet the row moved
  expect((await s.contentIdentity()).contentGeneration).not.toBe(g1);                                 // …and so did the identity
  await s.close();
});

// ── the second locus, at the reindex boundary (PLAN-0.3.0 items 11 + 12) ────────────────────────

test("items 11+12: a FULL reindex over an UNCHANGED vault ends stamped and un-invalidated", async () => {
  // The no-op arms of the mutation matrix all fire inside a clean-tree reindex: every remember() is
  // hash-skipped, the metadata sync moves nothing, and the authoritative prune deletes nothing.
  // Blanket invalidation would have marked this index invalid and demanded a manual republish for
  // a run that changed not one row (Codex R4#9).
  const root = mkdtempSync(join(tmpdir(), "funes-gen-noop-"));
  writeVault(root);
  const s = await LibsqlStore.create(new FakeEmbedder());
  await indexDir(s, root, root, {});
  const g1 = (await s.contentIdentity()).contentGeneration;
  expect(g1).toMatch(new RegExp(`^${GENERATION_VERSION}:`));

  await indexDir(s, root, root, {});
  const id = await s.contentIdentity();
  expect(id.contentGeneration).toBe(g1!);   // same rows, same identity
  expect(id.invalidatedAt).toBeNull();
  expect(id.invalidatedReason).toBeNull();
  await s.close();
});

test("items 11+12: an INCREMENTAL write after a full build clears the stamp — the two-loci bug, closed", async () => {
  // THE bug this release exists for: setGeneration() ran only from reindex.ts's full-run block
  // while remember()/remove()/prune() wrote rows and never touched it, so two loci could advertise
  // one generation over different row sets. A mutation now takes the stamp with it, and says when
  // and why — recovery is MANUAL in 0.3.0 (item 13), so the reason is the whole diagnosis.
  const root = mkdtempSync(join(tmpdir(), "funes-gen-incr-"));
  writeVault(root);
  const s = await LibsqlStore.create(new FakeEmbedder());
  await indexDir(s, root, root, {});
  expect((await s.contentIdentity()).contentGeneration).not.toBeNull();

  await s.remember([{ id: "wiki/delta", path: "wiki/delta.md", title: "Delta", body: "a page the build never saw", trust: "trusted" }]);
  const id = await s.contentIdentity();
  expect(id.contentGeneration).toBeNull();
  expect(id.invalidatedReason).toMatch(/^remember: 1 page re-indexed/);
  expect(Date.parse(id.invalidatedAt!)).not.toBeNaN();
  expect((await s.stats()).invalidatedReason).toBe(id.invalidatedReason!); // item 13: health sees it

  // …and the repair is a full rebuild, which re-stamps and clears the invalidation together.
  await indexDir(s, root, root, {});
  const after = await s.contentIdentity();
  expect(after.contentGeneration).not.toBeNull();
  expect(after.invalidatedAt).toBeNull();
  await s.close();
});
