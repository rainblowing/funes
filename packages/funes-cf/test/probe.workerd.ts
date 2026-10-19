// PLAN-0.5.0 item 36: the probe Worker funes-probe under local workerd, bound by
// probe/wrangler.test.jsonc. R2 is miniflare's local bucket; AI is vitest.config.ts's DriftingAi:
// a text of 128 bytes or more comes back rotated on every even call, cos θ = 0.999, so the worked
// example below is independent of the code under test:
//   passage: not byte-equal, min cosine 0.999, max |Δ| = sin θ = √(1 − 0.999²) ≈ 0.0447102
//   short:   byte-equal, max |Δ| 0, min cosine 1
import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import worker, { type ProbeEnv } from "../probe/index.ts";

const penv = env as unknown as ProbeEnv;
const call = (headers: Record<string, string>, e: ProbeEnv = penv) =>
  worker.fetch(new Request("https://funes-probe.example.workers.dev/", { headers }), e);

it("answers 401 with no bearer, a wrong bearer, or no bearer secret set", async () => {
  expect((await call({})).status).toBe(401);
  expect((await call({ authorization: "Bearer wrong" })).status).toBe(401);
  expect((await call({ authorization: "Bearer " }, { ...penv, PROBE_BEARER: undefined })).status).toBe(401);
});

it("reports record 35 E7: the R2 spike and the determinism probe, and leaves the bucket empty", async () => {
  const res = await call({ authorization: `Bearer ${penv.PROBE_BEARER}` });
  expect(res.status).toBe(200);
  const r = (await res.json()) as any;

  expect(r.spike).toEqual({
    abEtagsDiffer: true,
    aaEtagEqual: true,
    aaVersionDiffers: true,
    createOnceNull: true,
    staleEtagMatchesNull: true,
    pass: true,
  });
  expect((await penv.SPIKE.list()).objects).toEqual([]);

  const p = r.probe;
  expect(p.model).toBe("@cf/baai/bge-m3");
  expect(p.repeats).toBe(5);
  expect(p.texts).toBeGreaterThanOrEqual(56);
  expect(p.calls).toBe(p.texts * 5);
  expect(p.latencyMs.perCall).toHaveLength(p.calls);
  expect(p.latencyMs.max).toBeGreaterThanOrEqual(p.latencyMs.p50);
  expect(p.pooling).toEqual({ present: true, values: ["cls"] });
  expect(p.shapes).toEqual([[1, 1024]]);
  expect(p.byteEqual).toBe(false);

  expect(p.classes.short).toMatchObject({ byteEqual: true, maxAbsDelta: 0, minCosine: 1 });
  expect(p.classes.short.texts).toBe(4); // the canary's four sentences; every item text is a passage
  expect(p.classes.passage.byteEqual).toBe(false);
  expect(p.classes.passage.minCosine).toBeCloseTo(0.999, 6);
  expect(p.classes.passage.maxAbsDelta).toBeCloseTo(0.0447102, 6);
  expect(p.classes.short.texts + p.classes.passage.texts).toBe(p.texts);
});
