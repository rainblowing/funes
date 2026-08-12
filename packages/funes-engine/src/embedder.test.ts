import { test, expect } from "bun:test";
import { E5Embedder, E5_DIM, modelCacheDir } from "./embedder.ts";

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
// threw it away and the next run re-downloaded ~145MB over ~70s. A cache keyed to the install is
// not a cache. These run without touching the network, unlike the rest of this file.
test("the model cache lives outside node_modules, so an upgrade does not discard it", () => {
  const prev = process.env.FUNES_MODEL_DIR;
  delete process.env.FUNES_MODEL_DIR;
  try {
    const dir = modelCacheDir();
    expect(dir).not.toContain("node_modules");
    expect(dir.startsWith("/") || /^[A-Za-z]:/.test(dir)).toBe(true); // absolute, not install-relative
    expect(dir).toContain(".twinkling"); // the estate home factory.ts already uses — moves with it
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
