import { test, expect } from "bun:test";
import { embeddingSignature, type Embedder, type EmbedderId } from "./index.ts";

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
