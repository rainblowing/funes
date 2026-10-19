// The edge embedder and its canary (PLAN-0.5.0 item 38, ADR-0015, record 31).
//
// Workers AI `@cf/baai/bge-m3`, one text per call (no batch-mates), no options (no gateway) and no
// `truncate_inputs` (the chunker keeps texts ≤ 1,800 characters, so an over-long text errors rather
// than being silently cut). Its signature, with the store's chunk tail:
//   @cf/baai/bge-m3:1024:pool=<reported, or none>:fwd=1:plat=workers-ai:cfp=<16 hex>:chunk1800o200
// Workers AI pins no revision, so the canary stands in for `rev=`: six public texts whose vectors
// and reported pooling are recorded in the DO's `canary` table, and `cfp` is the first 16 hex of
// sha256 over those vectors. The canary runs in each instance's first serializer hold (item 35).
// Drift — a changed length, a changed pooling, or a cosine under CANARY_TOLERANCE — re-records the
// canary (so `cfp` moves, and the edge store reuses no vector built under the old one) and writes
// the build_state row the build driver (item 39) runs.
import { createHash } from "node:crypto";
import type { Embedder, EmbedderId } from "funes-core";

const MODEL = "@cf/baai/bge-m3";
const DIM = 1024;
/** Cosine to the recorded vector below which a canary text has drifted. A placeholder (UNVERIFIED,
 *  record 31) until runbook R11b sets it from the determinism probe's report (gate E7). */
export const CANARY_TOLERANCE = 0.9999;
/** At most this many calls start in any second (record 31; 2,400 a minute against 3,000). */
const PER_SECOND = 40;

/** The canary's six texts, verbatim from record 31's hand-on "the embedder canary": four short
 *  sentences and two item-shaped passages (about 470 and 700 bytes). Public and neutral, never
 *  taste content. The probe (item 36) embeds them too. */
export const CANARY = [
  "Солнце встаёт на востоке.",
  "The sun rises in the east.",
  "Кошка спит на подоконнике.",
  "A cat sleeps on the windowsill.",
  "Water moves through a continuous cycle. Sunlight warms oceans, lakes and rivers, and water evaporates into the air as vapour. As the vapour rises it cools and condenses into tiny droplets that form clouds. When the droplets grow heavy they fall as rain or snow. Some of this water runs off into streams and rivers, some soaks into the ground and refills underground stores, and some is taken up by plants. Eventually it returns to the sea, and the cycle begins again.",
  "Вода движется по непрерывному кругу. Солнце нагревает океаны, озёра и реки, и вода испаряется в воздух. Поднимаясь, пар остывает и превращается в мелкие капли, из которых состоят облака. Когда капли тяжелеют, они выпадают дождём или снегом. Часть воды стекает в ручьи и реки, часть впитывается в землю, а часть забирают растения. В конце концов вода возвращается в море, и круг начинается снова.",
] as const;

type Answer = { vector: Float32Array; pooling: string };
const blob = (v: Float32Array) => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return dot / Math.sqrt(na * nb);
}

export class WorkersAiEmbedder implements Embedder, EmbedderId {
  readonly id = MODEL;
  readonly dim = DIM;
  readonly forwardBatch = 1;
  readonly platform = "workers-ai";
  /** The recorded canary's pooling and fingerprint; undefined until a canary is recorded. */
  pooling: string | undefined;
  canary: string | undefined;
  /** When this instance's calls of the last second started. */
  private readonly starts: number[] = [];

  constructor(private readonly ai: Ai, private readonly storage: DurableObjectStorage) {
    storage.sql.exec("create table if not exists canary(ord integer primary key, text text not null, vector blob not null, pooling text not null)");
    this.adopt(this.recorded());
  }

  /** One text, one call. The vector as Workers AI answered it (the edge store normalizes). Every
   *  call waits for a place in the last second's PER_SECOND starts (record 31: ≤ 40/s, against
   *  Workers AI's 3,000 a minute). */
  private async call(text: string): Promise<Answer> {
    for (;;) {
      const now = Date.now();
      while (this.starts.length && this.starts[0]! <= now - 1000) this.starts.shift();
      if (this.starts.length < PER_SECOND) break;
      await new Promise((r) => setTimeout(r, this.starts[0]! + 1000 - now));
    }
    this.starts.push(Date.now());
    const out = (await this.ai.run(MODEL, { text: [text] })) as { data?: number[][]; pooling?: string };
    if (out.data?.length !== 1) throw new Error(`workers-ai: expected one vector, got ${out.data?.length ?? "none"}`);
    return { vector: Float32Array.from(out.data[0]!), pooling: out.pooling ?? "none" };
  }

  async embedPassage(text: string): Promise<Float32Array> {
    const { vector } = await this.call(text);
    if (vector.length !== DIM) throw new Error(`workers-ai: ${MODEL} answered ${vector.length} dimensions, not ${DIM}`);
    return vector;
  }
  embedQuery(text: string): Promise<Float32Array> {
    return this.embedPassage(text); // bge-m3 is symmetric: no prefixes
  }
  async embedPassages(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const t of texts) out.push(await this.embedPassage(t));
    return out;
  }

  private recorded(): Answer[] {
    return this.storage.sql.exec<{ vector: ArrayBuffer; pooling: string }>("select vector, pooling from canary order by ord").toArray()
      .map((r) => ({ vector: new Float32Array(r.vector), pooling: r.pooling }));
  }
  private adopt(rec: Answer[]): void {
    if (!rec.length) { this.pooling = this.canary = undefined; return; }
    const h = createHash("sha256");
    for (const r of rec) h.update(new Uint8Array(blob(r.vector)));
    this.pooling = rec[0]!.pooling;
    this.canary = h.digest("hex").slice(0, 16);
  }

  /** Embed the six canary texts and compare them with the record. "recorded" when there was none,
   *  "steady" when nothing drifted, "drift" when it re-recorded and wrote build_state (reason
   *  'canary'; any build in progress restarts, since its earlier batches may hold the old vectors).
   *  A Workers AI failure throws before any write, so the canary stays pending. */
  async runCanary(): Promise<"recorded" | "steady" | "drift"> {
    const fresh: Answer[] = [];
    for (const t of CANARY) fresh.push(await this.call(t));
    const was = this.recorded();
    const drift = was.length > 0 && fresh.some((f, i) => {
      const r = was[i];
      return !r || f.vector.length !== r.vector.length || f.pooling !== r.pooling || !(cosine(f.vector, r.vector) >= CANARY_TOLERANCE);
    });
    if (was.length && !drift) return "steady";
    this.storage.transactionSync(() => {
      this.storage.sql.exec("delete from canary");
      fresh.forEach((f, i) => this.storage.sql.exec("insert into canary(ord, text, vector, pooling) values (?,?,?,?)", i, CANARY[i]!, blob(f.vector), f.pooling));
      if (drift) {
        this.storage.sql.exec("insert or replace into build_state(id, reason, started_at, last_key) values (1, 'canary', ?, null)", new Date().toISOString());
      }
    });
    this.adopt(fresh);
    return drift ? "drift" : "recorded";
  }
}
