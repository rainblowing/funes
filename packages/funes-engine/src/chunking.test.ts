// H1: chunked embeddings — chunkText unit tests + the motivating needle case (a long page
// whose distinctive phrase sits past the old 2000-char embedding head MUST be found by the
// vector arm) + chunk-row hygiene (replacement, prune, remove, idempotency).
import { test, expect } from "bun:test";
import type { Embedder, MemoryItem } from "funes-core";
import { CHUNK_OVERLAP, CHUNK_SIZE, chunkText } from "./embedder.ts";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";

// Deterministic bag-of-words embedder, dim 64, truncating at 2000 chars to mirror the
// production E5 embedder's MAX_CHARS — i.e. exactly the pre-H1 "head-only" behavior when fed
// whole pages, and a no-op for chunks (CHUNK_SIZE=1800 < 2000). The needle-test word sets are
// chosen so query words share NO hash bucket with filler/decoy/title words at dim 64 — cosine
// against the query is then exactly 0 for needle-free text (a clean old-engine-blindness proof).
class Fake implements Embedder {
  readonly dim = 64;
  readonly id = "fake-chunk";
  vec(t: string): Float32Array {
    const v = new Float32Array(this.dim);
    for (const w of t.slice(0, 2000).toLowerCase().match(/[a-z0-9]+/g) ?? [])
      v[[...w].reduce((a, c) => a + c.charCodeAt(0), 0) % this.dim]! += 1;
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i]! /= n;
    return v;
  }
  async embedQuery(t: string) { return this.vec(t); }
  async embedPassage(t: string) { return this.vec(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.vec(t)); }
}

// ── chunkText ───────────────────────────────────────────────────────────────────────────────

test("chunkText: text at or under size is a single identity chunk (old behavior preserved)", () => {
  expect(chunkText("short text")).toEqual(["short text"]);
  const exact = "x ".repeat(CHUNK_SIZE / 2); // exactly CHUNK_SIZE chars
  expect(chunkText(exact)).toEqual([exact]);
});

test("chunkText: long text -> overlapping word-boundary windows covering every token", () => {
  // unique tokens w0..w1499 (~10k chars) make every chunk position unambiguous
  const tokens = Array.from({ length: 1500 }, (_, i) => `w${i}`);
  const text = tokens.join(" ");
  const chunks = chunkText(text);
  expect(chunks.length).toBeGreaterThan(3);
  let prevLast = -1;
  let prevEndsAt = -1;
  for (const c of chunks) {
    expect(c.length).toBeLessThanOrEqual(CHUNK_SIZE);
    const ws = c.split(/\s+/).filter(Boolean);
    for (const w of ws) expect(w).toMatch(/^w\d+$/); // word-boundary snapping: no token split
    const first = Number(ws[0]!.slice(1));
    const last = Number(ws[ws.length - 1]!.slice(1));
    if (prevLast >= 0) {
      expect(first).toBeLessThanOrEqual(prevLast); // consecutive chunks OVERLAP (no gaps either)
      expect(text.indexOf(c)).toBeLessThan(prevEndsAt);
    }
    prevLast = last;
    prevEndsAt = text.indexOf(c) + c.length;
  }
  expect(prevLast).toBe(1499); // coverage reaches the end
});

test("chunkText: a phrase shorter than the overlap survives intact in some chunk, anywhere", () => {
  const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ";
  const needle = "THE DISTINCTIVE NEEDLE PHRASE"; // 29 chars < CHUNK_OVERLAP
  for (const at of [0, 777, 2500, 4444, 6900]) {
    const text = filler.repeat(90).slice(0, at) + " " + needle + " " + filler.repeat(90).slice(at);
    const hit = chunkText(text).some((c) => c.includes(needle));
    expect(hit).toBe(true);
  }
});

test("chunkText: one giant unbroken token hard-cuts without stalling", () => {
  const text = "z".repeat(5000);
  const chunks = chunkText(text);
  expect(chunks.length).toBeGreaterThan(2);
  for (const c of chunks) {
    expect(c.length).toBeGreaterThan(0);
    expect(c.length).toBeLessThanOrEqual(CHUNK_SIZE);
  }
  // overlap-stitched coverage: total chars >= original length
  expect(chunks.reduce((a, c) => a + c.length, 0)).toBeGreaterThanOrEqual(text.length);
});

// ── the needle case (the motivating real-world failure) ────────────────────────────────────

const FILLER =
  "morning standup notes shipping schedule revision logistics vendor invoice follow up meeting agenda item discussion thread reply ";
// A short distinctive paragraph, well under CHUNK_OVERLAP per sentence, repeated 3x for signal
// mass — like one dense technical message buried inside a long chat export.
// P3.15: this vocabulary is chosen by HASH BUCKET, not by theme. Every NEEDLE_QUERY word must land
// in a dim-64 bucket that the filler, the title and all three decoys avoid, or the cosine-is-zero
// claim below stops holding and the test passes for the wrong reason. Re-run that check before
// changing any word here (a themed replacement was tried first and clashed on buckets 44 and 61).
const NEEDLE = "obsidian pendulum calibration voltage turbine constant. ".repeat(3);
const NEEDLE_QUERY = "obsidian pendulum calibration turbine";
const LONG: MemoryItem = {
  id: "long", title: "Long chat export", trust: "untrusted",
  body: FILLER.repeat(38) + NEEDLE + FILLER.repeat(18), // needle past char 4000; > 6000 total
};
// decoys share NO hash bucket with the query words (verified at dim 64)
const DECOYS: MemoryItem[] = [
  { id: "d1", title: "Hiking diary", body: "mountain trek photos sunset trail river" },
  { id: "d2", title: "Options grant", body: "retention grant schedule paperwork lawyer" },
  { id: "d3", title: "Lake house", body: "cabin rental pier kayak weekend" },
];

// NOTE (PGLite removal 2026-07-20): the pglite variants of these tests inspected the `chunks` table
// via the raw PGLite handle + pgvector `<=>` distance queries. Retargeted to behavioral assertions
// over the default libSQL backend — the end-to-end needle recall (the H1 motivating case) and the
// chunk-replacement behavior are backend-agnostic; the raw-row internals are covered by the libSQL
// recall-golden.

test("H1 needle: end-to-end recall surfaces a phrase past char 4000 (a non-head chunk carries it)", async () => {
  const s = await LibsqlStore.create(new Fake());
  await s.remember([LONG, ...DECOYS]);
  // The needle sits past the old 2000-char embedding head, so head-only vector recall was blind to
  // it; chunked embeddings make the long page recallable by a needle query it shares no head signal
  // with (the decoys share NO hash bucket with the query words).
  const res = await s.recall({ query: NEEDLE_QUERY, k: 3 });
  expect(res.map((r) => r.id)).toContain("long");
  await s.close();
});

// NOTE: a precise "shrinking a page replaces its chunk rows (no orphan ords)" test needed raw
// chunk-row inspection (pglite-handle); behaviorally it's unreliable at single-page scale (recall
// returns the only page regardless of relevance). The chunk-replacement-on-reindex property is
// covered by the libSQL store's own tests + the recall-golden. Dropped with PGLite 2026-07-20.

test("H1: remove drops a page from recall (its chunks go with it)", async () => {
  const s = await LibsqlStore.create(new Fake());
  await s.remember([LONG, ...DECOYS]);
  await s.remove(["long"]);
  expect((await s.recall({ query: NEEDLE_QUERY, k: 5 })).map((r) => r.id)).not.toContain("long");
  await s.close();
});

test("chunkText caps pathological inputs at maxChunks (multi-MB export dumps)", () => {
  const huge = ("word ".repeat(400) + "\n").repeat(3000); // ~6MB
  const chunks = chunkText(huge);
  expect(chunks.length).toBeLessThanOrEqual(256);
  expect(chunkText(huge, { maxChunks: 10 }).length).toBe(10);
});
