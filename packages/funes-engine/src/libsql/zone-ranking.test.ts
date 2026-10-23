// The zone-weight values every backend ranks with (funes-core ranking.ts, the one copy since
// PLAN-0.5.0 item 15). The recall behavior is covered by the H5 golden; this locks the values.
import { test, expect } from "bun:test";
import { ZONE_WEIGHT, DISTILL_WEIGHT, zoneAdjust } from "funes-core/internal";

test("libsql zone-weight mirrors pglite (wiki 1 > distill .87 > incoming .8 > output .7 > 0)", () => {
  expect(ZONE_WEIGHT).toEqual({ wiki: 1.0, output: 0.7, incoming: 0.8 });
  expect(DISTILL_WEIGHT).toBe(0.87); // Ruling-B refinement — must stay in lockstep with funes-engine
  expect(zoneAdjust(0.02, "people/ada.md")).toBe(0.02 * ZONE_WEIGHT.wiki);
  expect(zoneAdjust(0.02, "out/out_digest/2026-W26.md")).toBe(0.02 * ZONE_WEIGHT.output);
  expect(zoneAdjust(0.02, "out/out_distill/telegram/x.md")).toBe(0.02 * DISTILL_WEIGHT);
  expect(zoneAdjust(0.02, "raw/in_telegram/x.md")).toBe(0.02 * ZONE_WEIGHT.incoming);
});
