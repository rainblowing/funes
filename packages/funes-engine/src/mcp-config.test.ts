import { test, expect } from "bun:test";
import { operations } from "./ops.ts";
import { resolveExposedOps, refusalMessage } from "./mcp-config.ts";

// The fail-closed op-exposure rules for mcp.ts, unit-tested without spawning a server. The spawned
// end-to-end wiring (tools/list equals the allowlist; a startup with a bad allowlist exits non-zero)
// lives in mcp-boundary.test.ts.

const names = (ops: ReturnType<typeof resolveExposedOps>) => ops.map((o) => o.name);

test("resolveExposedOps: --ops allowlist exposes EXACTLY the named ops, in allowlist order", () => {
  const picked = resolveExposedOps(operations, { readonly: false, ops: ["health", "recall"] });
  expect(names(picked)).toEqual(["health", "recall"]); // order = allowlist order, not registry order
});

test("resolveExposedOps: empty allowlist fails closed", () => {
  expect(() => resolveExposedOps(operations, { readonly: false, ops: [] })).toThrow(/empty allowlist/);
});

test("resolveExposedOps: an unknown op name fails closed", () => {
  expect(() => resolveExposedOps(operations, { readonly: false, ops: ["recall", "teleport"] })).toThrow(/unknown operation "teleport"/);
});

test("resolveExposedOps: a mutation in the allowlist fails closed (allowlist is read-only by construction)", () => {
  expect(() => resolveExposedOps(operations, { readonly: false, ops: ["recall", "remember"] })).toThrow(/not read-only/);
});

test("resolveExposedOps: duplicate names dedupe, first occurrence wins", () => {
  const picked = resolveExposedOps(operations, { readonly: false, ops: ["recall", "recall", "health"] });
  expect(names(picked)).toEqual(["recall", "health"]);
});

test("resolveExposedOps: --readonly (no allowlist) = the read-only subset; unrestricted = the full registry", () => {
  expect(names(resolveExposedOps(operations, { readonly: true, ops: null })).sort())
    .toEqual(["graph", "health", "hotlist", "indexed_page", "neighbors", "page", "recall", "tree"]);
  expect(resolveExposedOps(operations, { readonly: false, ops: null }).length).toBe(operations.length);
});

test("resolveExposedOps H8: --cross-star refuses an fs-served op (page); the index-served allowlist is admitted", () => {
  // page reads the vault filesystem (served: fs) -> banned on a cross-star boundary.
  expect(() => resolveExposedOps(operations, { readonly: false, ops: ["recall", "page"], crossStar: true }))
    .toThrow(/reads the vault filesystem.*index-served ops only/);
  // the pure index-served cross-star surface passes
  expect(names(resolveExposedOps(operations, { readonly: false, ops: ["recall", "indexed_page", "health"], crossStar: true })))
    .toEqual(["recall", "indexed_page", "health"]);
  // WITHOUT --cross-star the same page allowlist is fine (own-star runtime keeps fs ops)
  expect(names(resolveExposedOps(operations, { readonly: false, ops: ["recall", "page", "health"] })))
    .toEqual(["recall", "page", "health"]);
});

test("refusalMessage: mode-specific — allowlist vs --readonly", () => {
  expect(refusalMessage("page", { readonly: false, ops: ["recall"] })).toContain("--ops allowlist");
  expect(refusalMessage("remember", { readonly: true, ops: null })).toContain("refused on a --readonly funes server");
});
