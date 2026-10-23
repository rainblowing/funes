import type { Embedder } from "funes-core";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { modelsDir } from "./funes-home.ts";

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
// kernel. Re-exported here for existing importers.
export { CHUNK_SIZE, CHUNK_OVERLAP, MAX_CHUNKS_PER_PAGE, CHUNK_SIG, chunkText } from "funes-core/internal";
import { chunkText } from "funes-core/internal";

/** Texts per onnxruntime forward. ONE, because a vector must be a function of its text alone
 *  (PLAN-0.4.0 item 8, RAI-138, ADR-0008). At 32 a text's vector depended on its batch-mates — q8
 *  dynamic quantization sets its scale per forward, and one text alone versus inside a 32-text
 *  forward differed in 128 of 128 tries — and an incremental build embeds only the CHANGED pages,
 *  so forward composition was build history: RAI-123's two loci shared a content generation and
 *  scored differently. The slicing loop in `embedMany` stays, so a caller's batch still never
 *  reaches the runtime as one [N, dim] forward (the 2026-06-11 OOM); measured cost on darwin/arm64
 *  is none (0.92x the batched wall time), Linux is unmeasured.
 *
 *  NOT a memory knob. The width shapes the vectors, so from PLAN-0.4.0 item 13 on it is SIGNED —
 *  `embeddingSignature()` carries `fwd=` — and changing it is a signed index-breaking change the
 *  drift guard forces a rebuild for. Before item 13 the width was never signed, so 32 → 1 moves
 *  nothing the estate keys on: incremental updates mix 32- and 1-forward rows under the old
 *  signature until the wave's `--fresh` clears them. Stays HERE: an embedder-runtime property, not
 *  a chunking parameter. */
export const EMBED_FORWARD_BATCH = 1;

/** Where model weights live. Transformers.js defaults `env.cacheDir` INSIDE its own package
 *  directory — measured at 152MB in node_modules/.bun/@huggingface+transformers@4.2.0/…/.cache —
 *  so every `npm i -g @funes-tech/cli` throws the weights away and the next run re-downloads them
 *  over ~70s. A cache keyed to the install is not a cache.
 *
 *  It is `<funes home>/models` (ADR-0016), so it moves with the index when the home does. */
export function modelCacheDir(): string {
  return modelsDir();
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

/** The onnxruntime version this process's forwards run on, for the signature (PLAN-0.4.0 item 3,
 *  extend branch: RAI-152 measured one signature and two vectors across darwin/arm64 and linux/x64).
 *  Resolved from `@huggingface/transformers`' OWN location because that package picks the runtime —
 *  onnxruntime-node under Node and Bun — and read from its package.json because a signature is
 *  computed at open, before the model (and the native runtime) loads.
 *  CEILING: the PACKAGE's version. The conformance test checks it against
 *  `env.backends.onnx.versions.node`, which proves transformers imported this same package (not
 *  onnxruntime-web, not another copy) — but that value is the package's own JS constant, so the
 *  native lib inside it is unverified: a rebuilt libonnxruntime under an unchanged package.json signs
 *  the same. Throws rather than sign an unknown runtime. */
export function onnxRuntimeVersion(): string {
  try {
    const transformers = createRequire(import.meta.url).resolve("@huggingface/transformers");
    const pkg = createRequire(transformers).resolve("onnxruntime-node/package.json");
    return (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
  } catch (e) {
    throw new Error(`funes: cannot name the onnxruntime version for the embedding signature — ${(e as Error).message}`);
  }
}

const readCpuinfo = (): string => readFileSync("/proc/cpuinfo", "utf8");

/** The first `flags` line of /proc/cpuinfo, raw — the evidence behind `mlasIsa`, recorded verbatim
 *  in a conformance record. Throws when the file or the line is missing. */
export function cpuFlags(read: () => string = readCpuinfo): string {
  try {
    const line = read().split("\n").find((l) => /^flags\s*:/.test(l))?.replace(/^flags\s*:\s*/, "").trim();
    if (!line) throw new Error("no `flags` line in /proc/cpuinfo");
    return line;
  } catch (e) {
    throw new Error(`funes: cannot name the instruction-set class for the embedding signature — ${(e as Error).message}`);
  }
}

/** The instruction-set class onnxruntime's MLAS dispatches its fp32 kernels on, for the signature
 *  (RAI-289). An EPYC 7763 (Zen 3) and an EPYC 9V45 (Zen 5) gave two vectors under one signature:
 *  with AVX-512F present MLAS swaps SGEMM, Exp/SumExp/ReduceMax, Erf and QuantizeLinearU8 to AVX-512F
 *  kernels (98/384 elements, 1–31 ulp). Signed on linux-x64 ONLY: null everywhere else, so no other
 *  locus's signature moves (win32-x64 has no /proc/cpuinfo; onnxruntime-node ships no darwin-x64).
 *  The kernel clears `avx`/`avx512f` from `flags` when it does not enable their XSAVE state, so the
 *  line is a faithful proxy for the CPUID + XCR0 checks MLAS makes. Throws on linux-x64 rather than
 *  sign an unknown class, like onnxRuntimeVersion().
 *
 *  CEILING: the class list is ORT 1.30.0's dispatch table (mlas/lib/platform.cpp :537 avx2+fma,
 *  :609 avx512f, nested inside it) and must be re-derived at every `ort=` bump. Known unsigned axes, out of scope:
 *  arm64 KleidiAI on SME (`mlas.disable_kleidiai`, an M4 locus) and linux-arm64 SVE kernels
 *  (Graviton, Neoverse). A kernel booted with `clearcpuid=` can disagree with CPUID; the raw flags
 *  in the conformance record make that diagnosable. */
export function mlasIsa(platform: string = process.platform, arch: string = process.arch, read: () => string = readCpuinfo): "avx512f" | "avx2" | "avx" | "sse" | null {
  if (platform !== "linux" || arch !== "x64") return null;
  const f = new Set(cpuFlags(read).split(/\s+/));
  // nested as in MLAS: the AVX-512F override sits inside the AVX2+FMA3 block (avx512f needs only avx in Linux's cpuid-deps)
  if (f.has("avx2") && f.has("fma")) return f.has("avx512f") ? "avx512f" : "avx2";
  if (f.has("avx")) return "avx";
  return "sse";
}

export class E5Embedder implements Embedder {
  readonly dim = E5_DIM;
  /** Embedding-signature identity (H1 drift guard) — MUST reflect the actual model in use
   *  (S0 fix: id was hardcoded to E5_MODEL, so a custom model silently signed as E5). The
   *  revision/dtype/pooling/truncation fields (Codex R3#4) pin the full weight+config identity
   *  into the signature so two loci can't diverge silently; the forward width (item 8) and the
   *  platform, arch and onnxruntime version (item 3) pin what the vectors are computed WITH,
   *  since PLAN-0.4.0 item 13. */
  readonly id: string;
  readonly revision: string;
  readonly dtype: string;
  readonly pooling = E5_POOLING;
  readonly truncation = MAX_CHARS;
  readonly forwardBatch = EMBED_FORWARD_BATCH;
  readonly platform = process.platform;
  readonly arch = process.arch;
  /** RAI-289: the MLAS instruction-set class, linux-x64 only (null elsewhere). */
  readonly isa = mlasIsa();
  readonly ort = onnxRuntimeVersion();
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
            `  cache: ${cache}   (under the funes home; FUNES_HOME relocates it)\n` +
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
