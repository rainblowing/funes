// serving-signature-v1 (PLAN-0.3.0 item 7): every listed setting, and every ranking-code bump,
// moves the signature; an invalid configured value signs as the value actually used.
import { test, expect } from "bun:test";
import { DEFAULT_RRF_K, DEFAULT_GRAPH_ARM } from "funes-core";
import {
  SERVING_SEMANTICS_VERSION, RANKING_SEMANTICS_VERSION, TRUST_ADJUST_VERSION, ZONE_ADJUST_VERSION,
  DISTILL_ADJUST_VERSION, ENTITY_ADJUST_VERSION, DEFAULT_EF_SEARCH,
  resolveRrfK, resolveEfSearch, servingSignature,
  type ServingSignatureInputs,
} from "funes-shared";

const BASE: ServingSignatureInputs = {
  backend: "libsql",
  bm25ColumnWeights: [0.0, 10.0, 3.0, 1.0],
  reranker: null,
  env: {}, // an explicit env: never read the runner's, or the test's answer depends on the machine
};

test("serving signature: versioned value, stable for one process, deterministic", () => {
  const sig = servingSignature(BASE);
  expect(sig).toMatch(new RegExp(`^${SERVING_SEMANTICS_VERSION}:[0-9a-f]{64}$`));
  expect(servingSignature(BASE)).toBe(sig); // pure: the same settings sign the same, always
});

test("serving signature: EVERY listed setting moves it", () => {
  const sig = servingSignature(BASE);
  // backend
  expect(servingSignature({ ...BASE, backend: "postgres" })).not.toBe(sig);
  // process-local environment: fusion constant, graph arm, vector search effort
  expect(servingSignature({ ...BASE, env: { FUNES_RRF_K: "60" } })).not.toBe(sig);
  expect(servingSignature({ ...BASE, env: { FUNES_GRAPH_ARM: "legacy" } })).not.toBe(sig);
  expect(servingSignature({ ...BASE, env: { FUNES_GRAPH_ARM: "v2in" } })).not.toBe(sig);
  expect(servingSignature({ ...BASE, env: { FUNES_EF_SEARCH: "40" } })).not.toBe(sig);
  // bm25 column weights — the VALUES, so a tweak needs no version bump to be visible
  expect(servingSignature({ ...BASE, bm25ColumnWeights: [0.0, 9.0, 3.0, 1.0] })).not.toBe(sig);
  // reranker identity: present vs absent, and one model vs another
  const reranked = servingSignature({ ...BASE, reranker: "Xenova/ms-marco-MiniLM-L-6-v2:q8" });
  expect(reranked).not.toBe(sig);
  expect(servingSignature({ ...BASE, reranker: "Xenova/ms-marco-MiniLM-L-6-v2:fp32" })).not.toBe(reranked);
});

test("serving signature: EVERY ranking-code bump moves it", () => {
  // DERIVED from the live constants, never a literal: a hardcoded "other" value silently becomes
  // the DEFAULT on the next bump and the assertion then proves nothing (the lesson generation.test
  // learned the hard way at the parser-version line).
  const sig = servingSignature(BASE);
  expect(servingSignature({ ...BASE, rankingSemanticsVersion: `${RANKING_SEMANTICS_VERSION}-next` })).not.toBe(sig);
  expect(servingSignature({ ...BASE, trustAdjustVersion: `${TRUST_ADJUST_VERSION}-next` })).not.toBe(sig);
  expect(servingSignature({ ...BASE, zoneAdjustVersion: `${ZONE_ADJUST_VERSION}-next` })).not.toBe(sig);
  expect(servingSignature({ ...BASE, distillAdjustVersion: `${DISTILL_ADJUST_VERSION}-next` })).not.toBe(sig);
  expect(servingSignature({ ...BASE, entityAdjustVersion: `${ENTITY_ADJUST_VERSION}-next` })).not.toBe(sig);
  // the four adjustments are SEPARATE inputs — a zone bump must not be indistinguishable from a
  // trust bump, or a signature diff cannot say which thumb changed
  expect(servingSignature({ ...BASE, trustAdjustVersion: "x" }))
    .not.toBe(servingSignature({ ...BASE, zoneAdjustVersion: "x" }));
});

test("serving signature: NORMALIZED EFFECTIVE — an invalid value signs as the value actually used", () => {
  const sig = servingSignature(BASE);
  // a garbage k is not fused with; the process falls back, so the signature says so
  expect(resolveRrfK({ FUNES_RRF_K: "banana" })).toBe(DEFAULT_RRF_K);
  expect(servingSignature({ ...BASE, env: { FUNES_RRF_K: "banana" } })).toBe(sig);
  expect(servingSignature({ ...BASE, env: { FUNES_RRF_K: String(DEFAULT_RRF_K) } })).toBe(sig);
  // …but an EMPTY string is Number("") === 0, which is finite: k=0 is what the process really uses
  expect(resolveRrfK({ FUNES_RRF_K: "" })).toBe(0);
  expect(servingSignature({ ...BASE, env: { FUNES_RRF_K: "" } })).not.toBe(sig);
  // an unknown arm resolves to the default arm, so it signs identically
  expect(servingSignature({ ...BASE, env: { FUNES_GRAPH_ARM: "nonsense" } })).toBe(sig);
  expect(servingSignature({ ...BASE, env: { FUNES_GRAPH_ARM: DEFAULT_GRAPH_ARM } })).toBe(sig);
  // ef_search: NaN AND 0 both ride the floor — an ef_search of 0 is not a search
  expect(resolveEfSearch({ FUNES_EF_SEARCH: "nope" })).toBe(DEFAULT_EF_SEARCH);
  expect(resolveEfSearch({ FUNES_EF_SEARCH: "0" })).toBe(DEFAULT_EF_SEARCH);
  expect(resolveEfSearch({})).toBe(DEFAULT_EF_SEARCH);
  expect(servingSignature({ ...BASE, env: { FUNES_EF_SEARCH: "0" } })).toBe(sig);
});
