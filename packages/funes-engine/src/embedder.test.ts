import { test, expect } from "bun:test";
import { E5Embedder, E5_DIM } from "./embedder.ts";

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
