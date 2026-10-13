import { test, expect } from "bun:test";
import { rrf } from "funes-core";
import { ftsQuery } from "./store.ts";
import golden from "./__fixtures__/a1-parity.json" with { type: "json" };

// Golden fixtures generated from the Python A1 backend's `_fts_query` and `_rrf` (k=60)
// in twinkling/lib/twinkling/backends/sqlite.py. These assert the substrate-INDEPENDENT
// core (FTS query construction + RRF fusion) is byte-for-byte identical across the port,
// so Python can be retired (M0c) without silent recall regressions. The vector tier is
// intentionally NOT compared — embedders differ per substrate by design (PLAN D2).

test("ftsQuery matches A1 _fts_query on every golden input", () => {
  for (const { input, output } of golden.fts_query) {
    expect(ftsQuery(input)).toBe(output);
  }
});

test("rrf fusion matches A1 _rrf ordering (incl. ties) on every golden input", () => {
  // A1 parity is defined at the HISTORICAL k=60 (what Python's _rrf hardcoded). The production
  // default moved to DEFAULT_RRF_K=5 (P2.10b, 2026-07-21) — that's a deliberate post-port ranking
  // change, not a port infidelity, so this test pins k explicitly instead of riding the default.
  for (const { input, output } of golden.rrf) {
    expect(rrf(input, 60)).toEqual(output);
  }
});
