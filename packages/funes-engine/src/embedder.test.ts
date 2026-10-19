import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { funesHome } from "funes-shared";
import { embeddingSignature } from "funes-core";
import { E5Embedder, E5_DIM, E5_MODEL, E5_REVISION, cpuFlags, mlasIsa, modelCacheDir, seedTokenizerProbe } from "./embedder.ts";

const cos = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

// First run downloads the ~120MB onnx model; long timeout. Cached afterwards.
test("E5 embedder: 384-dim, L2-normalized, EN + RU semantic order", async () => {
  const e = new E5Embedder();
  const q = await e.embedQuery("fitness goals protein");
  expect(q.length).toBe(E5_DIM);

  let norm = 0;
  for (const x of q) norm += x * x;
  expect(Math.sqrt(norm)).toBeCloseTo(1, 2);

  const fit = await e.embedPassage("lose body fat, gain muscle, eat protein daily");
  const piano = await e.embedPassage("play piano scales and arpeggios twice a week");
  expect(cos(q, fit)).toBeGreaterThan(cos(q, piano));

  // multilingual: a Russian fitness query is still closer to the fitness passage
  const ru = await e.embedQuery("цели по фитнесу и белок");
  expect(cos(ru, fit)).toBeGreaterThan(cos(ru, piano));
}, 300_000);

// The model cache used to live inside the transformers.js package directory — measured at 152MB in
// node_modules/.bun/@huggingface+transformers@4.2.0/…/.cache. Every `npm i -g @funes-tech/cli`
// threw it away and the next run re-downloaded 135MB over ~70s. A cache keyed to the install is
// not a cache. These run without touching the network, unlike the rest of this file.
test("the model cache lives outside node_modules, so an upgrade does not discard it", () => {
  const prev = process.env.FUNES_MODEL_DIR;
  delete process.env.FUNES_MODEL_DIR;
  try {
    const dir = modelCacheDir();
    expect(dir).not.toContain("node_modules");
    expect(dir.startsWith("/") || /^[A-Za-z]:/.test(dir)).toBe(true); // absolute, not install-relative
    expect(dir).toBe(join(funesHome(), "models")); // the funes home (ADR-0016) — moves with the index
  } finally {
    if (prev === undefined) delete process.env.FUNES_MODEL_DIR; else process.env.FUNES_MODEL_DIR = prev;
  }
});

test("FUNES_MODEL_DIR overrides it, so a locus can point at shared storage", () => {
  const prev = process.env.FUNES_MODEL_DIR;
  process.env.FUNES_MODEL_DIR = "/mnt/models";
  try { expect(modelCacheDir()).toBe("/mnt/models"); }
  finally { if (prev === undefined) delete process.env.FUNES_MODEL_DIR; else process.env.FUNES_MODEL_DIR = prev; }
});

// The offline hard failure P1.1 exists to remove. transformers.js probes for tokenizer_config.json
// at the UNPINNED key before it loads anything, and a pinned download only ever writes the pinned
// one — so a fully warm 135MB cache still died with "pipeline loaded without a tokenizer" the moment
// the network went away. The probe's path IS the contract, so these assert it literally.
const cacheDir = () => mkdtempSync(join(tmpdir(), "funes-model-"));

test("a pinned cache gets the unpinned tokenizer_config.json the pre-flight probe looks for", () => {
  const cache = cacheDir();
  mkdirSync(join(cache, E5_MODEL, E5_REVISION), { recursive: true });
  writeFileSync(join(cache, E5_MODEL, E5_REVISION, "tokenizer_config.json"), '{"pinned":true}');

  seedTokenizerProbe(cache, E5_MODEL, E5_REVISION);

  // exactly where get_file_metadata(model, "tokenizer_config.json", {}) looks: no revision segment
  expect(readFileSync(join(cache, E5_MODEL, "tokenizer_config.json"), "utf8")).toBe('{"pinned":true}');
  rmSync(cache, { recursive: true, force: true });
});

test("seeding invents nothing: a cold cache stays cold and an existing copy is left alone", () => {
  const cache = cacheDir();
  mkdirSync(join(cache, E5_MODEL), { recursive: true });

  // cold: nothing to copy from, so nothing is fabricated — the download still has to happen
  seedTokenizerProbe(cache, E5_MODEL, E5_REVISION);
  expect(existsSync(join(cache, E5_MODEL, "tokenizer_config.json"))).toBe(false);

  // an unpinned load writes that key itself; it is that load's file, not ours to overwrite
  writeFileSync(join(cache, E5_MODEL, "tokenizer_config.json"), "MAIN");
  mkdirSync(join(cache, E5_MODEL, E5_REVISION), { recursive: true });
  writeFileSync(join(cache, E5_MODEL, E5_REVISION, "tokenizer_config.json"), "PINNED");
  seedTokenizerProbe(cache, E5_MODEL, "main"); // no-op: the probe's key is already the download's key
  seedTokenizerProbe(cache, E5_MODEL, E5_REVISION);
  expect(readFileSync(join(cache, E5_MODEL, "tokenizer_config.json"), "utf8")).toBe("MAIN");
  rmSync(cache, { recursive: true, force: true });
});

// PLAN-0.4.0 item 8 (RAI-138): a vector is a function of its text alone. The real model's half of
// this lives in embedding-conformance.test.ts ("E5 embedder: … alone and inside a 32-text batch"),
// which needs the weights and so runs only in the conformance job. This is the half the default
// suite can hold without them: a stub extractor that — like q8 dynamic quantization, whose scale is
// set per forward — makes every vector depend on its forward's batch-mates. `pipe()` reuses a set
// extractor, so nothing loads. A caller batch that shares a forward then embeds a text differently
// than the text alone; at a forward batch of 1 it cannot.
test("a vector is a function of its text alone: a 32-text batch embeds each text as it embeds alone (stub extractor)", async () => {
  const e = new E5Embedder();
  const stub = async (texts: string[]) => {
    const scale = Math.max(...texts.map((t) => t.length)); // per-FORWARD, like a q8 dynamic scale
    return { tolist: () => texts.map((t) => Array.from({ length: 4 }, (_, i) => (t.charCodeAt(i) || 0) / scale)) };
  };
  (e as unknown as { extractor: unknown }).extractor = stub;

  const texts = Array.from({ length: 32 }, (_, i) => `text ${i} ${"x".repeat(i * 3)}`);
  const batched = await e.embedPassages(texts);
  for (let i = 0; i < texts.length; i++) {
    expect(Array.from(batched[i]!)).toEqual(Array.from(await e.embedPassage(texts[i]!)));
  }
});

// RAI-289: the instruction-set class MLAS dispatches on, read from /proc/cpuinfo's first `flags`
// line. The reader is injected, so these run on any host; the real file is read only on linux-x64.
const cpuinfo = (...flagLines: string[]) => () =>
  flagLines.map((f, i) => `processor\t: ${i}\nvendor_id\t: AuthenticAMD\nflags\t\t: ${f}\nbugs\t\t: sysret_ss_attrs\n`).join("\n");
const ZEN3 = "fpu vme sse sse2 ssse3 fma cx16 sse4_1 sse4_2 movbe popcnt aes xsave avx f16c rdrand bmi1 avx2 bmi2";
const ZEN5 = `${ZEN3} avx512f avx512dq avx512cd avx512bw avx512vl avx512_vnni avx512_bf16`;

test("isa class on linux-x64: avx512f, avx2 with fma, avx, else sse — ORT 1.30.0's MLAS dispatch table", () => {
  expect(mlasIsa("linux", "x64", cpuinfo(ZEN5))).toBe("avx512f");
  expect(mlasIsa("linux", "x64", cpuinfo(ZEN3))).toBe("avx2");
  // avx2 without fma takes MLAS's AVX path, not the FMA3/AVX2 one
  expect(mlasIsa("linux", "x64", cpuinfo(ZEN3.replace(" fma ", " ")))).toBe("avx");
  expect(mlasIsa("linux", "x64", cpuinfo("fpu sse sse2 avx"))).toBe("avx");
  // MLAS nests the AVX-512F override inside the AVX2+FMA3 block: a guest masking fma or avx2 but
  // keeping avx512f (`-cpu host,-fma`) runs the AVX kernels, so it must not sign as avx512f
  expect(mlasIsa("linux", "x64", cpuinfo("sse sse2 avx avx2 avx512f"))).toBe("avx");
  expect(mlasIsa("linux", "x64", cpuinfo("sse sse2 avx avx512f"))).toBe("avx");
  expect(mlasIsa("linux", "x64", cpuinfo("sse sse2 fma avx avx512f"))).toBe("avx");
  // a Celeron J1900: no AVX at all
  expect(mlasIsa("linux", "x64", cpuinfo("fpu sse sse2 ssse3 sse4_1 sse4_2 popcnt"))).toBe("sse");
  // whole tokens, not substrings: avx512_vnni alone is not avx512f, avx_vnni is not avx
  expect(mlasIsa("linux", "x64", cpuinfo("sse sse2 avx_vnni avx512_vnni"))).toBe("sse");
  // the FIRST flags line names the class (MLAS dispatches once per process)
  expect(mlasIsa("linux", "x64", cpuinfo(ZEN3, ZEN5))).toBe("avx2");
});

test("isa class: absent off linux-x64, and /proc/cpuinfo is never read there", () => {
  const never = () => { throw new Error("read /proc/cpuinfo off linux-x64"); };
  for (const [plat, arch] of [["darwin", "arm64"], ["linux", "arm64"], ["win32", "x64"], ["darwin", "x64"]] as const) {
    expect(mlasIsa(plat, arch, never)).toBeNull();
  }
});

test("isa class on linux-x64 fails closed when the flags cannot be read", () => {
  expect(() => mlasIsa("linux", "x64", () => { throw new Error("ENOENT"); })).toThrow(/instruction-set class.*ENOENT/);
  // QEMU without Rosetta shows an arm64 cpuinfo: no flags line at all
  expect(() => mlasIsa("linux", "x64", () => "processor\t: 0\nBogoMIPS\t: 48.00\nFeatures\t: fp asimd\n")).toThrow(/instruction-set class/);
  expect(() => mlasIsa("linux", "x64", cpuinfo(""))).toThrow(/instruction-set class/);
});

test("cpuFlags returns the raw first flags line, for the conformance record", () => {
  expect(cpuFlags(cpuinfo(ZEN3, ZEN5))).toBe(ZEN3);
});

// PLAN-0.5.0 item 13 (ADR-0015): `EmbedderId.canary` is signed as `cfp=`, and E5 declares none — so
// the signature a Mac locus computes is the v0.4.0 tag's, byte for byte, and no Mac locus re-embeds.
// The literal is `git show v0.4.0:packages/funes-engine/src/__fixtures__/embedding-conformance.darwin-arm64.json`'s;
// plat/arch are set to darwin-arm64 so the pin runs on every CI platform. An ort bump moves it on purpose.
test("E5's embedding signature at a Mac locus is the v0.4.0 tag's, byte for byte", () => {
  const atMac = { ...new E5Embedder(), platform: "darwin", arch: "arm64", isa: null } as E5Embedder;
  expect("canary" in atMac).toBe(false);
  expect(embeddingSignature(atMac)).toBe(
    "Xenova/multilingual-e5-small:384:rev=761b726dd34fb83930e26aab4e9ac3899aa1fa78:dt=q8:pool=mean:trunc=2000:fwd=1:plat=darwin:arch=arm64:ort=1.30.0",
  );
});
