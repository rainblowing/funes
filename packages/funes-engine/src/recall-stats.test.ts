// R8 recall-telemetry contract tests:
//   (1) tracking is OPT-IN, default OFF — no recall_stats table, no writes;
//   (2) tracking ON — counters increment per RETURNED recall result, last_recalled set;
//   (3) counters are NEVER an input to ranking — identical recall output on vs off,
//       even after counters are deliberately pumped;
//   (4) hotlist surfaces TRUSTED rows only (live H4 trust labels, not a path allowlist).
import { test, expect } from "bun:test";
import type { Embedder, MemoryItem } from "funes-core";
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

const ITEMS: MemoryItem[] = [
  { id: "fitness", path: "fitness.md", title: "Fitness goals", body: "protein creatine training goals", trust: "trusted" },
  { id: "diet", path: "diet.md", title: "Diet plan", body: "calories protein carbs macros goals", trust: "trusted" },
  { id: "in_chatgpt/chat", path: "in_chatgpt/chat.md", title: "Chat dump", body: "protein creatine training goals", trust: "untrusted" },
  { id: "piano", path: "piano.md", title: "Piano practice", body: "scales arpeggios twice a week", trust: "trusted" },
];

test("R8: tracking is off by default — no recall_stats table is created, recall writes nothing", async () => {
  const s = await LibsqlStore.create(new FakeEmbedder());
  await s.remember(ITEMS);
  await s.recall({ query: "protein goals", k: 3 });
  await s.recall({ query: "protein goals", k: 3 });
  // hotlist's table-existence probe doubles as the assertion: no table => never written
  expect(await s.hotlist()).toEqual([]);
  await s.close();
});

test("R8: tracking on — counters increment per returned result; last_recalled is set", async () => {
  const s = await LibsqlStore.create(new FakeEmbedder(), undefined, { trackRecalls: true });
  expect(s.recallTracking).toBe(true);
  await s.remember(ITEMS);
  const first = await s.recall({ query: "protein creatine training goals", k: 2 });
  await s.recall({ query: "protein creatine training goals", k: 2 });
  const hot = await s.hotlist(10);
  // every TRUSTED returned id is counted twice (untrusted ones are counted but not surfaced)
  for (const r of first.filter((x) => x.trust === "trusted")) {
    const row = hot.find((h) => h.id === r.id);
    expect(row).toBeDefined();
    expect(row!.hit_count).toBe(2);
    expect(row!.last_recalled).toBeTruthy();
  }
  await s.close();
});

test("R8: counters NEVER affect ranking — identical recall output with tracking on vs off, even after pumping", async () => {
  const off = await LibsqlStore.create(new FakeEmbedder());
  const on = await LibsqlStore.create(new FakeEmbedder(), undefined, { trackRecalls: true });
  await off.remember(ITEMS);
  await on.remember(ITEMS);
  // pump counters on the tracked store: recall an unrelated page many times first
  for (let i = 0; i < 5; i++) await on.recall({ query: "piano scales arpeggios", k: 1 });
  const q = { query: "protein creatine training goals", k: 4 };
  const a = (await off.recall(q)).map((r) => [r.id, r.score]);
  const b = (await on.recall(q)).map((r) => [r.id, r.score]);
  expect(b).toEqual(a); // same ids, same order, same scores — telemetry is invisible to ranking
  await off.close();
  await on.close();
});

test("R8: hotlist is trusted-only and ordered by hit_count", async () => {
  const s = await LibsqlStore.create(new FakeEmbedder(), undefined, { trackRecalls: true });
  await s.remember(ITEMS);
  for (let i = 0; i < 3; i++) await s.recall({ query: "protein creatine training goals", k: 3 });
  await s.recall({ query: "piano scales arpeggios", k: 1 });
  const hot = await s.hotlist(10);
  expect(hot.length).toBeGreaterThan(0);
  expect(hot.every((h) => h.trust === "trusted")).toBe(true);
  expect(hot.map((h) => h.id)).not.toContain("in_chatgpt/chat"); // recalled + counted, but untrusted
  for (let i = 1; i < hot.length; i++) expect(hot[i - 1]!.hit_count).toBeGreaterThanOrEqual(hot[i]!.hit_count);
  // hotlist respects n
  expect((await s.hotlist(1)).length).toBe(1);
  await s.close();
});
