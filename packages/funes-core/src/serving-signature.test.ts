// RAI-307: the serving signature is one readable string — the backend and the ranking version.
import { test, expect } from "bun:test";
import { servingSignature } from "./serving-signature.ts";

test("serving signature: `<backend>:<RANKING_VERSION>`, and the environment never moves it", () => {
  const before = servingSignature("libsql");
  expect(before).toBe("libsql:rank/2");
  expect(servingSignature("do-sqlite")).toBe("do-sqlite:rank/2");
  const saved = { k: process.env.FUNES_RRF_K, arm: process.env.FUNES_GRAPH_ARM, ef: process.env.FUNES_EF_SEARCH };
  Object.assign(process.env, { FUNES_RRF_K: "60", FUNES_GRAPH_ARM: "legacy", FUNES_EF_SEARCH: "40" });
  try {
    expect(servingSignature("libsql")).toBe(before);
  } finally {
    for (const [k, v] of [["FUNES_RRF_K", saved.k], ["FUNES_GRAPH_ARM", saved.arm], ["FUNES_EF_SEARCH", saved.ef]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
