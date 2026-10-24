// RAI-307: the bump rule is mechanical. Every ranking constant of every backend is pinned here beside
// RANKING_VERSION. A constant change fails the first test until SNAPSHOT moves; a moved SNAPSHOT fails
// the second until RANKING_VERSION moves and SIGNED gains a line for the new version. Lines in SIGNED
// are append-only: an edited line is a version that changed meaning under one name.
import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { DEFAULT_RRF_K, GRAPH_ARM_CAP_OUT } from "funes-core/internal";
import { BM25_COLUMN_WEIGHTS, DISTILL_WEIGHT, ENTITY_BOOST, RRF_TIE_EPS, TRUST_WEIGHT, ZONE_WEIGHT } from "./ranking.ts";
import { RANKING_VERSION } from "./serving-signature.ts";

const SNAPSHOT = {
  bm25ColumnWeights: [0, 10, 3, 1], // libsql and do-sqlite: one FTS shape
  rrfK: 5,
  graphArmCapOut: 16,
  rrfTieEps: 1e-9,
  trustWeight: { trusted: 1.0, derived: 0.95, untrusted: 0.85 },
  zoneWeight: { wiki: 1.0, output: 0.7, incoming: 0.8 },
  distillWeight: 0.87,
  entityBoost: 1.5,
};

/** sha256 of the snapshot each RANKING_VERSION signs. Append on a bump; never edit a line. */
const SIGNED: Record<string, string> = {
  "rank/2": "6a1de996a3137ea94eed8791bd4546e177c43f8e4b35d99857f1f72fb7aee28e",
};

const sha = (x: unknown): string => createHash("sha256").update(JSON.stringify(x)).digest("hex");

test("the live ranking constants equal the snapshot", () => {
  const live: unknown = {
    bm25ColumnWeights: [...BM25_COLUMN_WEIGHTS], rrfK: DEFAULT_RRF_K, graphArmCapOut: GRAPH_ARM_CAP_OUT, rrfTieEps: RRF_TIE_EPS,
    trustWeight: TRUST_WEIGHT, zoneWeight: ZONE_WEIGHT, distillWeight: DISTILL_WEIGHT, entityBoost: ENTITY_BOOST,
  };
  expect(live).toEqual(SNAPSHOT);
});

test("the snapshot is the one RANKING_VERSION signs", () => {
  expect(sha(SNAPSHOT)).toBe(SIGNED[RANKING_VERSION]!);
});
