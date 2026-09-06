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
