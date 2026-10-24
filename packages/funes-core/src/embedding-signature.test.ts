import { test, expect } from "bun:test";
import { embeddingSignature, type Embedder, type EmbedderId } from "./types.ts";

const fake = (extra: Partial<EmbedderId> & { dim?: number } = {}): Embedder => ({
  dim: extra.dim ?? 16,
  async embedQuery() { return new Float32Array(0); },
  async embedPassage() { return new Float32Array(0); },
  async embedPassages() { return []; },
  ...extra,
} as Embedder);

test("embeddingSignature: BACKWARD-COMPAT — {id,dim} (or bare {dim}) keeps the historical <id>:<dim>", () => {
  // the golden-fixture fakes rely on this: extending the fn must not perturb their signature
  expect(embeddingSignature(fake({ dim: 16 }))).toBe("e:16");
  expect(embeddingSignature(fake({ id: "gold", dim: 16 }))).toBe("gold:16");
});

test("embeddingSignature: extended identity appends rev/dt/pool/trunc in fixed order (Codex R3#4)", () => {
  const sig = embeddingSignature(fake({ id: "m", dim: 384, revision: "abc", dtype: "q8", pooling: "mean", truncation: 2000 }));
  expect(sig).toBe("m:384:rev=abc:dt=q8:pool=mean:trunc=2000");
  // each field is discriminating: a different weight/quantization/pooling/truncation ⇒ different sig
  const base = fake({ id: "m", dim: 384, revision: "abc", dtype: "q8", pooling: "mean", truncation: 2000 });
  expect(embeddingSignature(base)).not.toBe(embeddingSignature(fake({ id: "m", dim: 384, revision: "def", dtype: "q8", pooling: "mean", truncation: 2000 })));
  expect(embeddingSignature(base)).not.toBe(embeddingSignature(fake({ id: "m", dim: 384, revision: "abc", dtype: "fp32", pooling: "mean", truncation: 2000 })));
  // partial identity: only the set fields appear (fixed order preserved)
  expect(embeddingSignature(fake({ id: "m", dim: 384, dtype: "q8" }))).toBe("m:384:dt=q8");
});

test("embeddingSignature: the forward width, platform, arch and onnxruntime version are signed after trunc (PLAN-0.4.0 items 8, 3, 13)", () => {
  const id = { id: "m", dim: 384, revision: "abc", dtype: "q8", pooling: "mean", truncation: 2000 };
  const full = { ...id, forwardBatch: 1, platform: "darwin", arch: "arm64", ort: "1.24.3" };
  expect(embeddingSignature(fake(full))).toBe("m:384:rev=abc:dt=q8:pool=mean:trunc=2000:fwd=1:plat=darwin:arch=arm64:ort=1.24.3");
  // each is discriminating: RAI-138 (a forward of 32 shapes the vector) and RAI-152 (one signature,
  // two vectors across darwin/arm64 and linux/x64) are exactly the moves the old signature missed
  for (const moved of [{ forwardBatch: 32 }, { platform: "linux" }, { arch: "x64" }, { ort: "1.25.0" }]) {
    expect(embeddingSignature(fake({ ...full, ...moved }))).not.toBe(embeddingSignature(fake(full)));
  }
  // an impl that does not declare them keeps its pre-wave tail
  expect(embeddingSignature(fake(id))).toBe("m:384:rev=abc:dt=q8:pool=mean:trunc=2000");
});

test("embeddingSignature: the instruction-set class is signed right after arch, and only when the impl declares it (RAI-289)", () => {
  const full = { id: "m", dim: 384, revision: "abc", dtype: "q8", pooling: "mean", truncation: 2000, forwardBatch: 1, platform: "linux", arch: "x64", ort: "1.30.0" };
  expect(embeddingSignature(fake({ ...full, isa: "avx2" }))).toBe("m:384:rev=abc:dt=q8:pool=mean:trunc=2000:fwd=1:plat=linux:arch=x64:isa=avx2:ort=1.30.0");
  // RAI-289: an EPYC 7763 (avx2) and an EPYC 9V45 (avx512f) took different MLAS fp32 kernels under one signature
  expect(embeddingSignature(fake({ ...full, isa: "avx512f" }))).not.toBe(embeddingSignature(fake({ ...full, isa: "avx2" })));
  // absent (darwin-arm64 and every other non-linux-x64 locus): the pre-RAI-289 string, byte for byte
  const darwin = { ...full, platform: "darwin", arch: "arm64" };
  const before = "m:384:rev=abc:dt=q8:pool=mean:trunc=2000:fwd=1:plat=darwin:arch=arm64:ort=1.30.0";
  expect(embeddingSignature(fake({ ...darwin, isa: null }))).toBe(before);
  expect(embeddingSignature(fake(darwin))).toBe(before);
});

test("embeddingSignature: the canary fingerprint is signed last as cfp=, and only when the impl declares it (ADR-0015)", () => {
  // the edge embedder's signature as ADR-0015 spells it (the store appends the chunk signature after it)
  const edge = { id: "@cf/baai/bge-m3", dim: 1024, pooling: "none", forwardBatch: 1, platform: "workers-ai", canary: "0123456789abcdef" };
  expect(embeddingSignature(fake(edge))).toBe("@cf/baai/bge-m3:1024:pool=none:fwd=1:plat=workers-ai:cfp=0123456789abcdef");
  // a re-recorded canary moves the signature, so a re-embed never claims the old rows
  expect(embeddingSignature(fake({ ...edge, canary: "fedcba9876543210" }))).not.toBe(embeddingSignature(fake(edge)));
  // after ort, when both are declared
  const full = { id: "m", dim: 384, platform: "darwin", arch: "arm64", ort: "1.30.0" };
  expect(embeddingSignature(fake({ ...full, canary: "00ff00ff00ff00ff" }))).toBe("m:384:plat=darwin:arch=arm64:ort=1.30.0:cfp=00ff00ff00ff00ff");
  // absent or null (E5, every Mac locus): the pre-canary string, byte for byte
  expect(embeddingSignature(fake({ ...full, canary: null }))).toBe("m:384:plat=darwin:arch=arm64:ort=1.30.0");
  expect(embeddingSignature(fake(full))).toBe("m:384:plat=darwin:arch=arm64:ort=1.30.0");
});
