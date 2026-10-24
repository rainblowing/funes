// The H5 recall golden's inputs (FROZEN): the embedder, the corpus and the queries. The libsql store,
// the index-module conformance suite (libsql, DO SQLite emulated) and the workerd suite (real DO
// SQLite) all run them against the one pinned fixture, recall-golden.json — any drift invalidates
// the comparison. REGEN_GOLDEN=1 bun test packages/funes-engine/src/libsql/recall-golden.test.ts
import type { Embedder, MemoryItem, RecallResult } from "../types.ts";

export const K = 5;

export class GoldenEmbedder implements Embedder {
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

const PARA = "morning standup notes shipping schedule revision logistics vendor invoice follow up meeting agenda item discussion thread reply ";
const NEEDLE = "harbor terminal lease renewal clause quarterly tonnage rebate appendix";
const LONG_BODY = PARA.repeat(38) + NEEDLE + " " + PARA.repeat(18);

/** A fresh copy per call: a store may resolve edge targets in place. */
export const goldenCorpus = (): MemoryItem[] => [
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

export const QUERIES = [
  "fitness protein goals", "piano scales practice", "sailing regatta wind",
  "harbor tonnage rebate clause", "ton roadmap milestone", "zebra xylophone quasar",
] as const;

export type GoldenRow = [id: string, score4dp: number, trust: string];
export interface Golden { engine: string | null; k: number; queries: Record<string, GoldenRow[]> }

/** The golden of one index: every query's ids, 4dp scores and trust, in order. */
export async function goldenOf(recall: (q: { query: string; k: number }) => Promise<RecallResult[]>, engine: string | null): Promise<Golden> {
  const queries: Record<string, GoldenRow[]> = {};
  for (const q of QUERIES) queries[q] = (await recall({ query: q, k: K })).map((r) => [r.id, Math.round(r.score * 1e4) / 1e4, r.trust ?? ""]);
  return { engine, k: K, queries };
}
