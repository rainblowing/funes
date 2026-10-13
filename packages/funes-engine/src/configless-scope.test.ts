import { test, expect } from "bun:test";
import { anyExclude, buildScopeExclude, configlessExclude, CONFIGLESS_EXCLUDES } from "./scope.ts";

// P3.15 step 10. `walkMd` descends every non-dot tree, so the quickstart's `funes reindex --vault .`
// in a code repo ingests dependency documentation and build output as if they were memories. These
// defaults apply ONLY when there is no star.yaml; a declared index_scope is authoritative.

test("configless defaults skip dependency and build trees at ANY depth", () => {
  const ex = configlessExclude();
  for (const seg of CONFIGLESS_EXCLUDES) {
    expect(ex(`${seg}/readme.md`)).toBe(true);
    expect(ex(`packages/app/${seg}/pkg/readme.md`)).toBe(true); // nested, not just top level
    expect(ex(`${seg}/`)).toBe(true);
  }
  expect(ex("wiki/notes.md")).toBe(false);
  // segment-aware: a name that merely CONTAINS a skipped word is kept
  expect(ex("my-dist-notes/plan.md")).toBe(false);
  expect(ex("distillery/plan.md")).toBe(false);
  expect(ex("notes/build-log.md")).toBe(false);
});

test("a DECLARED scope is authoritative — defaults are never silently added to it", () => {
  // this is the whole point of composing at the call site instead of inside walkMd: a star that
  // deliberately indexes its vendor/ notes must keep doing so.
  const declared = buildScopeExclude(["raw/**"])!;
  expect(declared("vendor/notes.md")).toBe(false);
  expect(declared("raw/x.md")).toBe(true);
});

test("anyExclude ORs, and collapses to undefined when nothing applies", () => {
  expect(anyExclude(undefined, undefined)).toBeUndefined();
  const only = anyExclude(configlessExclude(), undefined)!;
  expect(only("dist/a.md")).toBe(true);
  const both = anyExclude(buildScopeExclude(["raw/**"]), configlessExclude())!;
  expect(both("raw/a.md")).toBe(true);   // declared arm
  expect(both("dist/a.md")).toBe(true);  // configless arm
  expect(both("wiki/a.md")).toBe(false); // neither
});
