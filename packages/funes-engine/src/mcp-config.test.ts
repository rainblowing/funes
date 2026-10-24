import { test, expect } from "bun:test";
import { operations } from "funes-core/internal";
import { resolveExposedOps, refusalMessage } from "./mcp-config.ts";

// The fail-closed op-exposure rules for mcp.ts, unit-tested without spawning a server. The spawned
// end-to-end wiring (tools/list equals the allowlist; a startup with a bad allowlist exits non-zero)
// lives in mcp-boundary.test.ts.

const names = (ops: ReturnType<typeof resolveExposedOps>) => ops.map((o) => o.name);

test("resolveExposedOps: --ops allowlist exposes EXACTLY the named ops, in allowlist order", () => {
  const picked = resolveExposedOps(operations, { ops: ["health", "recall"] });
  expect(names(picked)).toEqual(["health", "recall"]); // order = allowlist order, not registry order
});

test("resolveExposedOps: empty allowlist fails closed", () => {
  expect(() => resolveExposedOps(operations, { ops: [] })).toThrow(/empty allowlist/);
});

test("resolveExposedOps: an unknown op name fails closed", () => {
  expect(() => resolveExposedOps(operations, { ops: ["recall", "teleport"] })).toThrow(/unknown operation "teleport"/);
});

test("resolveExposedOps: a mutation in the allowlist fails closed (allowlist is read-only by construction)", () => {
  expect(() => resolveExposedOps(operations, { ops: ["recall", "remember"] })).toThrow(/not read-only/);
});

test("resolveExposedOps: duplicate names dedupe, first occurrence wins", () => {
  const picked = resolveExposedOps(operations, { ops: ["recall", "recall", "health"] });
  expect(names(picked)).toEqual(["recall", "health"]);
});

test("resolveExposedOps: no allowlist is the full list it was given", () => {
  expect(resolveExposedOps(operations, { ops: null }).length).toBe(operations.length);
});

test("resolveExposedOps H8: --cross-star refuses an op that is not a cross-star read (page); the cross-star allowlist is admitted", () => {
  // page reads the vault filesystem (not a cross-star read) -> banned on a cross-star boundary.
  expect(() => resolveExposedOps(operations, { ops: ["recall", "page"], crossStar: true }))
    .toThrow(/not a cross-star read.*admits the cross-star reads only/);
  // the pure cross-star surface passes
  expect(names(resolveExposedOps(operations, { ops: ["recall", "indexed_page", "health"], crossStar: true })))
    .toEqual(["recall", "indexed_page", "health"]);
  // WITHOUT --cross-star the same page allowlist is fine (own-star runtime keeps fs ops)
  expect(names(resolveExposedOps(operations, { ops: ["recall", "page", "health"] })))
    .toEqual(["recall", "page", "health"]);
});

test("refusalMessage: mode-specific — allowlist vs the published index", () => {
  expect(refusalMessage("page", { ops: ["recall"] })).toContain("--ops allowlist");
  expect(refusalMessage("remember", { ops: null, published: true })).toContain("--published funes server");
});
