// Move 5: trust-aware ranking + near-duplicate collapse — a VERSIONED ranking change gated by
// the H5 golden fixture. Composition order (store.ts recall): RRF -> trust-weight -> dup-collapse
// -> recency-tiebreak -> optional rerank. Trust is a thumb on the scale (DEMOTES untrusted, never
// excludes), not a gate; dup-collapse keeps the best of a near-identical cluster and backfills.
import { test, expect } from "bun:test";
import type { Embedder, MemoryItem } from "funes-core";
import { TRUST_WEIGHT, trustAdjust } from "./store.ts";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";

// Deterministic marker embedder (dim 4): "magnet" texts sit ON the query vector (vec rank 1),
// "zanzibar" texts at a fixed angle, everything else orthogonal — full control of the vec arm,
// no model download. Mirrors recency-tiebreak.test.ts.
class MarkerEmbedder implements Embedder {
  readonly dim = 4;
  readonly id = "trust-fake";
  private vec(t: string): Float32Array {
    if (t.includes("magnet")) return Float32Array.from([1, 0, 0, 0]);
    if (t.includes("zanzibar")) return Float32Array.from([0.8, 0.6, 0, 0]);
    return Float32Array.from([0, 1, 0, 0]);
  }
  async embedQuery(_t: string) { return Float32Array.from([1, 0, 0, 0]); }
  async embedPassage(t: string) { return this.vec(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.vec(t)); }
}

const QUERY = "zanzibar protocol";

// ── unit: trustAdjust composition primitive ─────────────────────────────────────────────────

test("trust-weight: untrusted is demoted, trusted/derived bands are ordered, weights bounded", () => {
  // a thumb on the scale, not a gate: every multiplier is in (0,1] and trusted is the ceiling.
  expect(TRUST_WEIGHT.trusted).toBe(1);
  expect(TRUST_WEIGHT.derived).toBeLessThan(TRUST_WEIGHT.trusted);
  expect(TRUST_WEIGHT.untrusted).toBeLessThan(TRUST_WEIGHT.derived);
  expect(TRUST_WEIGHT.untrusted).toBeGreaterThan(0); // never zero -> never a filter
  // adjusted score = rrf * weight(trust)
  expect(trustAdjust(0.02, "trusted")).toBe(0.02 * TRUST_WEIGHT.trusted);
  expect(trustAdjust(0.02, "untrusted")).toBe(0.02 * TRUST_WEIGHT.untrusted);
  expect(trustAdjust(0.02, undefined)).toBe(0.02 * TRUST_WEIGHT.untrusted); // missing -> untrusted
});

// ── e2e: trusted outranks an untrusted page at comparable RRF relevance ──────────────────────

test("trust-ranking: a trusted page outranks an untrusted page at an EQUAL RRF tie", async () => {
  const s = await LibsqlStore.create(new MarkerEmbedder());
  // Engineered EXACT RRF tie (same scheme as recency-tiebreak.test.ts tiePair): `lo` is FTS
  // rank 1 (each term twice) / vec rank 2 (zanzibar); `hi` is FTS rank 2 / vec rank 1 (magnet).
  // Both fuse to 1/61 + 1/62. Baseline (pre-trust) order puts the FTS-first page `lo` ahead.
  // Make the FTS-first one UNTRUSTED and the other TRUSTED: trust-weight must flip them.
  await s.remember([
    { id: "lo", path: "in_telegram/lo.md", title: "Lo", trust: "untrusted",
      body: "zanzibar protocol zanzibar protocol" },
    { id: "hi", path: "notes/hi.md", title: "Hi", trust: "trusted",
      body: "magnet zanzibar protocol" },
  ]);
  const res = await s.recall({ query: QUERY, k: 2 });
  expect(res.map((r) => r.id)).toEqual(["hi", "lo"]); // trusted promoted past the RRF tie
  // scores stay RRF (parity contract) — only the ORDER changed
  expect(res[0]!.score).toBeCloseTo(res[1]!.score, 9);
  await s.close();
});

test("trust-ranking: a STRONGLY-relevant untrusted hit is NOT buried below weak trusted noise", async () => {
  const s = await LibsqlStore.create(new MarkerEmbedder());
  // `strong` is untrusted but has a genuine MULTI-ARM lead: FTS rank 1 (magnet+zanzibar+protocol)
  // AND vec rank 1 (magnet sits on the query vector). The trusted distractors are single-arm weak
  // (FTS-only on "protocol", vec-orthogonal). The trust haircut (15%) is bounded, so a two-arm lead
  // this large survives it: thumb on the scale, not a gate. (A *1-rank* RRF gap the thumb IS designed
  // to override — RRF compresses relevance into rank bands, so "modest gap" means a rank or two.)
  //
  // Deliberately zone-NEUTRAL (all notes/ = wiki zone) so this isolates the TRUST thumb; the zone
  // thumb has its own test. Earlier this corpus leaned on `strong` being the edge target of a
  // query-matching seed for a THIRD stacked arm — the DEFAULT_GRAPH_ARM="v2" adoption (P2.11)
  // correctly stopped double-counting a page that is already a direct FTS/vec hit via its own
  // in-edge, so the durable, arm-independent guarantee is the two-arm one asserted here.
  await s.remember([
    { id: "strong", path: "notes/strong.md", title: "Strong", trust: "untrusted",
      body: "magnet zanzibar protocol zanzibar protocol" },
    { id: "f1", path: "notes/f1.md", title: "F1", trust: "trusted", body: "protocol reference sheet" },
    { id: "f2", path: "notes/f2.md", title: "F2", trust: "trusted", body: "protocol reference sheet" },
    { id: "weak", path: "notes/weak.md", title: "Weak", trust: "trusted", body: "protocol" },
  ]);
  const res = await s.recall({ query: QUERY, k: 5 });
  expect(res[0]!.id).toBe("strong"); // a far-more-relevant untrusted hit is never buried/gated out
  // demotion is never exclusion: untrusted stays present + trust-labeled (S3 unrestricted recall)
  expect(res.find((r) => r.id === "strong")!.trust).toBe("untrusted");
  await s.close();
});

test("trust-ranking: all-same-trust ordering is unchanged vs pure RRF (thumb, not a reshuffle)", async () => {
  // Same corpus, all trusted: the trust multiplier is uniform, so it scales every score equally
  // and the order must be byte-identical to what RRF (+ recency-tiebreak) already produced.
  // c MUST have a vector distinct from a (both "zanzibar…" would map to the SAME marker vector,
  // creating a vec-arm tie whose kNN order is nondeterministic across HNSW builds — that flaked).
  // "obscure trivia" → the orthogonal else-vector, so the vec ranks are strictly b > a > c.
  const items: MemoryItem[] = [
    { id: "a", path: "notes/a.md", title: "A", trust: "trusted", body: "zanzibar protocol zanzibar protocol" },
    { id: "b", path: "notes/b.md", title: "B", trust: "trusted", body: "magnet zanzibar protocol" },
    { id: "c", path: "notes/c.md", title: "C", trust: "trusted", body: "obscure trivia note" },
  ];
  const s = await LibsqlStore.create(new MarkerEmbedder());
  await s.remember(items);
  const withTrust = (await s.recall({ query: QUERY, k: 3 })).map((r) => r.id);
  await s.close();
  // Uniform trusted multiplier scales every adjusted score by the SAME factor → order-preserving.
  // `a` (FTS rank 1 / vec rank 2) and `b` (FTS rank 2 / vec rank 1) are a symmetric, EXACT RRF tie;
  // `c` (orthogonal vector, no query term) is strictly weakest. The property under test is that a
  // uniform trust weight does NOT reshuffle or bury equal-trust results: `c` stays last and the
  // tied pair stays the top two (their internal tie-break is not meaningful, so don't assert it).
  expect(withTrust[2]).toBe("c");
  expect([...withTrust].slice(0, 2).sort()).toEqual(["a", "b"]);
});

// ── near-duplicate collapse ───────────────────────────────────────────────────────────────

test("dup-collapse: 3 near-identical pages collapse to 1 (dup count) + distinct results backfill k", async () => {
  const s = await LibsqlStore.create(new MarkerEmbedder());
  // Three near-identical dumps (same title, same zone, same trust) that dominate the vec arm
  // (magnet) + 3 distinct pages at the same trust+zone, weaker. With k=3 the cluster must cost
  // ONE slot (duplicates=2), and the next two DISTINCT results backfill to fill k. All trusted
  // so this isolates dup-collapse from the trust weight.
  await s.remember([
    { id: "in_telegram/dup1", path: "in_telegram/dup1.md", title: "Lake JV chat", trust: "untrusted",
      body: "magnet zanzibar protocol" },
    { id: "in_telegram/dup2", path: "in_telegram/dup2.md", title: "Lake JV chat", trust: "untrusted",
      body: "magnet zanzibar protocol" },
    { id: "in_telegram/dup3", path: "in_telegram/dup3.md", title: "Lake JV chat", trust: "untrusted",
      body: "magnet zanzibar protocol" },
    { id: "in_telegram/d1", path: "in_telegram/d1.md", title: "Distinct one", trust: "untrusted", body: "zanzibar protocol alpha" },
    { id: "in_telegram/d2", path: "in_telegram/d2.md", title: "Distinct two", trust: "untrusted", body: "zanzibar beta" },
    { id: "in_telegram/d3", path: "in_telegram/d3.md", title: "Distinct three", trust: "untrusted", body: "zanzibar gamma" },
  ]);
  const res = await s.recall({ query: QUERY, k: 3 });
  expect(res.length).toBe(3); // backfilled to k
  // exactly one of the dup-cluster survives, carrying the count of the two it absorbed
  const dups = res.filter((r) => r.id.startsWith("in_telegram/dup"));
  expect(dups.length).toBe(1);
  expect(dups[0]!.duplicates).toBe(2);
  // every returned slot is a DISTINCT collapse key (no two share title within trust+zone)
  const titles = res.map((r) => r.title);
  expect(new Set(titles).size).toBe(3);
  await s.close();
});

test("dup-collapse: same title but DIFFERENT trust are NOT collapsed (trust+zone is part of the key)", async () => {
  const s = await LibsqlStore.create(new MarkerEmbedder());
  await s.remember([
    { id: "in_telegram/raw", path: "in_telegram/raw.md", title: "Lake JV", trust: "untrusted", body: "magnet zanzibar protocol" },
    { id: "notes/curated", path: "notes/curated.md", title: "Lake JV", trust: "trusted", body: "magnet zanzibar protocol" },
  ]);
  const res = await s.recall({ query: QUERY, k: 5 });
  const ids = res.map((r) => r.id);
  expect(ids).toContain("in_telegram/raw");
  expect(ids).toContain("notes/curated"); // distinct trust => distinct slots, no collapse
  expect(res.every((r) => !r.duplicates)).toBe(true);
  await s.close();
});

test("dup-collapse: distinct results are never collapsed and carry no dup count", async () => {
  const s = await LibsqlStore.create(new MarkerEmbedder());
  await s.remember([
    { id: "a", path: "notes/a.md", title: "Alpha", trust: "trusted", body: "magnet zanzibar protocol" },
    { id: "b", path: "notes/b.md", title: "Beta", trust: "trusted", body: "zanzibar protocol beta" },
    { id: "c", path: "notes/c.md", title: "Gamma", trust: "trusted", body: "zanzibar gamma" },
  ]);
  const res = await s.recall({ query: QUERY, k: 3 });
  expect(res.length).toBe(3);
  expect(res.every((r) => !r.duplicates)).toBe(true);
  await s.close();
});
