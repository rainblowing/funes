import type { Embedder } from "funes-core";
import { homedir } from "node:os";
import { join } from "node:path";

/** Local multilingual embedder (intfloat/multilingual-e5-small, 384-dim) via Transformers.js.
 *  Matches twinkling A1: e5 "query:"/"passage:" prefixes + mean pooling + L2 normalize, so
 *  re-embedding on any machine is free, offline, and deterministic (PLAN.md §4a). RU+EN safe.
 */
// Xenova mirror ships quantized onnx; q8 is ~2-4x faster on wasm than fp32. e5-small caps
// at 512 tokens, so pre-truncating the input string avoids tokenizing huge chat exports.
export const E5_MODEL = "Xenova/multilingual-e5-small";
export const E5_DIM = 384;
/** Immutable HF commit the model download is PINNED to (Codex R3#4) — so Mac and NAS embed with
 *  byte-identical weights and can never publish "the same" generation from a silently-reuploaded
 *  model. Fetched 2025-07-22 snapshot of Xenova/multilingual-e5-small; part of the embedding
 *  signature, so bumping it is an index-breaking change (the drift guard forces one rebuild). */
export const E5_REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
export const E5_POOLING = "mean";
const MAX_CHARS = 2000;

// ── H1: chunking — MOVED to funes-core (P3.14) ─────────────────────────────────────────────
// chunkText + the CHUNK_* constants are pure and shared by BOTH backends, so they live in the
// edge-portable core now; funes-libsql imports them from there instead of reaching into this
// package (that import was half the package cycle). Re-exported here for existing importers.
export { CHUNK_SIZE, CHUNK_OVERLAP, MAX_CHUNKS_PER_PAGE, CHUNK_SIG, chunkText } from "funes-core";
import { chunkText } from "funes-core";

/** Max texts per onnxruntime forward — bounds peak memory regardless of caller batch size.
 *  Stays HERE: it is an embedder-runtime knob, not a chunking parameter. */
export const EMBED_FORWARD_BATCH = 32;

/** Where model weights live. Transformers.js defaults `env.cacheDir` INSIDE its own package
 *  directory — measured at 152MB in node_modules/.bun/@huggingface+transformers@4.2.0/…/.cache —
 *  so every `npm i -g @funes-tech/cli` throws the weights away and the next run re-downloads them
 *  over ~70s. A cache keyed to the install is not a cache.
 *
 *  `.twinkling` (not `.funes`) is deliberate: it is the estate home factory.ts already uses for
 *  `libsql/`, and the `.twinkling` → `.funes` rename is a separate, deliberate breaking change.
 *  When that happens, this and factory.ts:43 move together. */
export function modelCacheDir(): string {
  return process.env.FUNES_MODEL_DIR ?? join(homedir(), ".twinkling", "models");
}

export class E5Embedder implements Embedder {
  readonly dim = E5_DIM;
  /** Embedding-signature identity (H1 drift guard) — MUST reflect the actual model in use
   *  (S0 fix: id was hardcoded to E5_MODEL, so a custom model silently signed as E5). The
   *  revision/dtype/pooling/truncation fields (Codex R3#4) pin the full weight+config identity
   *  into the signature so two loci can't diverge silently. */
  readonly id: string;
  readonly revision: string;
  readonly dtype: string;
  readonly pooling = E5_POOLING;
  readonly truncation = MAX_CHARS;
  private extractor: any | null = null;

  constructor(model: string = E5_MODEL, dtype: string = "q8", revision: string = E5_REVISION) {
    this.id = model;
    this.dtype = dtype;
    this.revision = revision;
  }

  private get model(): string { return this.id; }

  private async pipe() {
    if (!this.extractor) {
      const { pipeline, env } = await import("@huggingface/transformers");
      const cache = modelCacheDir();
      env.cacheDir = cache;
      env.localModelPath = cache; // the tokenizer resolves against THIS, not cacheDir
      const opts = { dtype: this.dtype as any, revision: this.revision };

      // transformers.js resolves the tokenizer separately from the model and, when that resolution
      // fails, hands back a pipeline whose `tokenizer` is NULL instead of throwing. The failure then
      // surfaces on the first forward pass as `this.tokenizer is not a function`, which names
      // neither the model nor the cache. Reject it HERE, where a retry is still possible.
      const load = async (localOnly: boolean) => {
        const p = await pipeline("feature-extraction", this.model, localOnly ? { ...opts, local_files_only: true } : opts);
        if (!p?.tokenizer || !p?.model) throw new Error("pipeline loaded without a tokenizer");
        return p;
      };

      try {
        // Local first, so a warm cache does not depend on the network being reachable.
        // CEILING (measured, transformers.js 4.2.0): this only succeeds for an UNPINNED model. The
        // tokenizer's cache key drops `revision`, so a revision-pinned load offline finds the model
        // and not the tokenizer. We keep the pin — it is what makes two loci embed byte-identically
        // — and accept that a cold network is a hard failure, with an error that says so.
        this.extractor = await load(true);
      } catch {
        try {
          this.extractor = await load(false);
        } catch (e) {
          throw new Error(
            `funes: could not load the embedding model ${this.model}@${this.revision.slice(0, 8)}.\n` +
            `  cache: ${cache}   (override with FUNES_MODEL_DIR)\n` +
            `  Not usable from that cache, and the download failed — check access to huggingface.co.\n` +
            `  A first run fetches ~145MB and takes ~70s; the cache is reused across upgrades.\n` +
            `  cause: ${(e as Error).message}`,
          );
        }
      }
    }
    return this.extractor;
  }

  /** Batched feature-extraction, BOUNDED: callers may pass thousands of texts (a 32-page
   *  reindex batch of chunked chat exports = up to ~8k chunks); one unbounded [N, dim]
   *  forward OOM-killed the 2026-06-11 vault re-embed silently. Slice into fixed forwards. */
  private async embedMany(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extractor = await this.pipe();
    const result: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += EMBED_FORWARD_BATCH) {
      const clipped = texts.slice(i, i + EMBED_FORWARD_BATCH)
        .map((t) => (t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) : t));
      const out = await extractor(clipped, { pooling: "mean", normalize: true });
      const rows = out.tolist() as number[][];
      for (const v of rows) result.push(Float32Array.from(v));
    }
    return result;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return (await this.embedMany([`query: ${text}`]))[0]!;
  }
  async embedPassage(text: string): Promise<Float32Array> {
    return (await this.embedMany([`passage: ${text}`]))[0]!;
  }
  embedPassages(texts: string[]): Promise<Float32Array[]> {
    return this.embedMany(texts.map((t) => `passage: ${t}`));
  }
}
