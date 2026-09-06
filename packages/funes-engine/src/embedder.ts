import type { Embedder } from "funes-core";
import { copyFileSync, existsSync } from "node:fs";
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

/** The file a revision-pinned download never writes and the offline load cannot start without.
 *
 *  transformers.js 4.2.0 does not ask the model whether it has a tokenizer — it PROBES for one
 *  before loading anything: `pipeline()` → `get_pipeline_files(task, model, {device, dtype})` →
 *  `get_tokenizer_files(model)` → `get_file_metadata(model, "tokenizer_config.json", {})`. That
 *  chain drops every option that matters: no `revision`, no `cache_dir`, and — the part that makes
 *  a local-first branch a lie — no `local_files_only`. So the probe looks for the UNPINNED key
 *  `<cache>/<model>/tokenizer_config.json`, which a pinned download never writes; it misses, and
 *  goes to the network even under `local_files_only: true`. Offline it returns `exists: false`,
 *  `pipeline()` concludes the model is tokenizer-less and hands back an extractor with
 *  `tokenizer: null`, and the forward pass dies. The pinned tokenizer.json is sitting in the cache
 *  the whole time — nothing ever asks for it.
 *
 *  So give the probe the file it looks for, copied from the PINNED revision. This does NOT loosen
 *  the pin: the probe reads only `.exists` and never the contents, and if the tokenizer load itself
 *  resolves this path first it gets the pinned revision's own bytes. tokenizer.json — the vocab,
 *  the file that decides the input ids and therefore the embedding — is never copied and stays
 *  pinned-only, so two loci still embed byte-identically.
 *
 *  CEILING: this is shaped to one library's internal cache layout, measured at @huggingface/
 *  transformers 4.2.0. The upstream fix is for `get_pipeline_files` to forward the pretrained
 *  options it is already given; when it does, this becomes a no-op and can be deleted. */
export function seedTokenizerProbe(cache: string, model: string, revision: string): void {
  if (revision === "main") return; // unpinned: the probe's key IS the key the download writes
  try {
    const unpinned = join(cache, model, "tokenizer_config.json");
    const pinned = join(cache, model, revision, "tokenizer_config.json");
    // Never clobber: a cache shared with an UNPINNED load of the same model already holds main's
    // own copy at that key, and that file is the unpinned load's, not ours to replace.
    if (!existsSync(unpinned) && existsSync(pinned)) copyFileSync(pinned, unpinned);
  } catch { /* read-only cache dir: the network path still works — seeding must never be the failure */ }
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

      // Before the local attempt, because on a warm cache the pinned copy is already there and the
      // probe that decides whether this model has a tokenizer at all runs FIRST, unpinned and
      // network-bound (see seedTokenizerProbe). Without this the local-first branch below cannot
      // succeed for a pinned model no matter how complete the cache is.
      seedTokenizerProbe(cache, this.model, this.revision);
      try {
        // Local first, so a warm cache does not depend on the network being reachable.
        this.extractor = await load(true);
      } catch {
        try {
          this.extractor = await load(false);
          seedTokenizerProbe(cache, this.model, this.revision); // the download just wrote the pinned copy
        } catch (e) {
          throw new Error(
            `funes: could not load the embedding model ${this.model}@${this.revision.slice(0, 8)}.\n` +
            `  cache: ${cache}   (override with FUNES_MODEL_DIR)\n` +
            `  Not usable from that cache, and the download failed — check access to huggingface.co.\n` +
            `  A first run fetches 135MB and takes ~70s; the cache is reused across upgrades.\n` +
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
