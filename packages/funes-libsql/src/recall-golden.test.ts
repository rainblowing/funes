// H5 golden for libSQL — a faithful MIRROR of funes-engine/src/recall-golden.test.ts (same FROZEN
// GoldenEmbedder + corpus + queries) run through LibsqlStore. Pins libSQL's full recall pipeline and,
// by diffing this fixture against the pglite one, makes the backend's ranking change reviewable.
//   REGEN_GOLDEN=1 bun test packages/funes-libsql/src/recall-golden.test.ts
import { test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Embedder, MemoryItem } from "funes-core";
import { LibsqlStore } from "./store.ts";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/recall-golden.json", import.meta.url));
const K = 5;

// FROZEN — byte-identical to the pglite golden's embedder (any drift invalidates the comparison).
class GoldenEmbedder implements Embedder {
  readonly dim = 32;
  readonly id = "golden-fake";
  private vec(t: string): Float32Array {
    const v = new Float32Array(this.dim);
    for (const w of t.slice(0, 2000).toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      const h = [...w].reduce((a, c) => (Math.imul(a, 31) + c.charCodeAt(0)) >>> 0, 7);
      v[h % this.dim]! += 1 + (h % 1009) / 4096;
    }
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i]! /= n;
    return v;
  }
  async embedQuery(t: string) { return this.vec(t); }
  async embedPassage(t: string) { return this.vec(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.vec(t)); }
}

// FROZEN corpus + queries — identical to the pglite golden.
const PARA = "morning standup notes shipping schedule revision logistics vendor invoice follow up meeting agenda item discussion thread reply ";
const NEEDLE = "harbor terminal lease renewal clause quarterly tonnage rebate appendix";
const LONG_BODY = PARA.repeat(38) + NEEDLE + " " + PARA.repeat(18);

const GOLDEN_CORPUS: MemoryItem[] = [
  { id: "fitness", path: "fitness.md", title: "Fitness goals", trust: "trusted", body: "lose body fat gain muscle protein daily steps training plan", edges: [{ type: "related_to", target: "diet" }] },
  { id: "diet", path: "diet.md", title: "Diet plan", trust: "trusted", body: "calories protein carbs fat macros meal prep creatine" },
  { id: "piano", path: "piano.md", title: "Piano practice", trust: "trusted", body: "scales arpeggios hanon twice a week metronome repertoire" },
  { id: "sailing", path: "sailing.md", title: "Sailing log", trust: "trusted", body: "wing foiling regatta wind knots crew tactics", edges: [{ type: "related_to", target: "catamaran" }] },
  { id: "catamaran", path: "catamaran.md", title: "Catamaran research", trust: "trusted", body: "hybrid electric drivetrain solar panels displacement hulls leech" },
  { id: "in_chat_export/harbor-terms", path: "in_chat_export/harbor-terms.md", title: "Long chat export", trust: "untrusted", body: LONG_BODY },
  { id: "ton", path: "ton.md", title: "TON roadmap", trust: "trusted", body: "ton roadmap milestone mainnet wallet integration telegram", edges: [{ type: "related_to", target: "ghost-page" }] },
  { id: "tetra", path: "tetra.md", title: "Tetra chain", trust: "derived", body: "app specific chain telegram ecosystem validators bridge throughput" },
  { id: "in_chatgpt/dump", path: "in_chatgpt/dump.md", title: "Chat dump", trust: "untrusted", body: "assorted answers about cooking travel visas weather seasons" },
  { id: "web3", path: "web3.md", title: "Web3 glossary", trust: "trusted", body: "blockchain crypto tokens defi staking governance" },
  { id: "cycling", path: "cycling.md", title: "Cycling routes", trust: "trusted", body: "gravel e-bike coastal promenade loop elevation watts bidon" },
  { id: "recipes", path: "recipes.md", title: "Recipes", trust: "trusted", body: "chicken rice broccoli oats whey pancakes" },
];

const QUERIES = [
  "fitness protein goals", "piano scales practice", "sailing regatta wind",
  "harbor tonnage rebate clause", "ton roadmap milestone", "zebra xylophone quasar",
] as const;

type GoldenRow = [id: string, score4dp: number, trust: string];
interface Golden { engine: string | null; k: number; queries: Record<string, GoldenRow[]> }

async function computeGolden(): Promise<Golden> {
  const s = await LibsqlStore.create(new GoldenEmbedder());
  await s.remember(GOLDEN_CORPUS);
  const queries: Record<string, GoldenRow[]> = {};
  for (const q of QUERIES) {
    const res = await s.recall({ query: q, k: K });
    queries[q] = res.map((r) => [r.id, Math.round(r.score * 1e4) / 1e4, r.trust ?? ""]);
  }
  const engine = (await s.stats()).embeddingSignature;
  await s.close();
  return { engine, k: K, queries };
}

test("H5 golden (libsql): full recall output (order, 4dp scores, trust) matches the pinned fixture", async () => {
  const got = await computeGolden();
  if (process.env.REGEN_GOLDEN === "1" || !existsSync(FIXTURE)) writeFileSync(FIXTURE, JSON.stringify(got, null, 2) + "\n");
  const want = JSON.parse(readFileSync(FIXTURE, "utf8")) as Golden;
  expect(got).toEqual(want);

  // P3.15 anti-vacuity guard. The long-document row exists to prove the CHUNKED arm finds a needle
  // buried ~4.8k chars into a body; its query tokens appear nowhere else in the corpus, and
  // deliberately NOT in its own title — a title hit would satisfy bm25 (title weight 10) without the
  // chunk arm doing anything, and the golden would still be "green" while proving nothing. If a
  // future corpus edit breaks that isolation, this fails loudly instead of silently going hollow.
  expect(got.queries["harbor tonnage rebate clause"]!.map((r) => r[0])).toContain("in_chat_export/harbor-terms");
});

test("H5 golden (libsql): edge-walk — catamaran reachable for a sailing query", async () => {
  const s = await LibsqlStore.create(new GoldenEmbedder());
  await s.remember(GOLDEN_CORPUS);
  expect((await s.recall({ query: "sailing regatta wind", k: K })).map((r) => r.id)).toContain("catamaran");
  await s.close();
});

test("H5 golden (libsql): dangling edge target never starves results below k", async () => {
  const s = await LibsqlStore.create(new GoldenEmbedder());
  await s.remember(GOLDEN_CORPUS);
  const res = await s.recall({ query: "ton roadmap milestone", k: K });
  expect(res.length).toBe(K);
  expect(res.map((r) => r.id)).not.toContain("ghost-page");
  await s.close();
});

test("H5 golden (libsql): a query matching nothing in FTS still returns k results (vector arm)", async () => {
  const s = await LibsqlStore.create(new GoldenEmbedder());
  await s.remember(GOLDEN_CORPUS);
  expect((await s.recall({ query: "zebra xylophone quasar", k: K })).length).toBe(K);
  await s.close();
});
