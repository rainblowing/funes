import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeScopeExcludes, readIndexScopeExcludes, crossStarExpectedHash, scopeHash, buildScopeExclude, scopeRefusalReason } from "./scope.ts";

// Pure index_scope helpers: parse star.yaml excludes, the canonical scope hash, the Bun.Glob
// predicate (twinkling-parity semantics), and the cross-star serve-time refusal decision.

function vaultWith(starYaml?: string): string {
  const v = mkdtempSync(join(tmpdir(), "funes-scope-"));
  if (starYaml != null) writeFileSync(join(v, "star.yaml"), starYaml);
  return v;
}

test("readIndexScopeExcludes (H2 discriminated): valid parses sorted+deduped; no index_scope -> valid []; missing file -> absent", () => {
  const v = vaultWith('version: 2\nmemory:\n  index_scope:\n    exclude:\n      - "raw/**"\n      - "packages/**"\n      - "raw/**"\n');
  try {
    expect(readIndexScopeExcludes(v)).toEqual({ kind: "valid", excludes: ["packages/**", "raw/**"] }); // sorted, "raw/**" deduped
  } finally { rmSync(v, { recursive: true, force: true }); }
  const none = vaultWith("version: 2\nmeta:\n  name: x\n"); // star.yaml present, no index_scope -> valid empty
  try { expect(readIndexScopeExcludes(none)).toEqual({ kind: "valid", excludes: [] }); } finally { rmSync(none, { recursive: true, force: true }); }
  const noStar = vaultWith(); // no star.yaml at all -> absent (configless; never a cross-star boundary)
  try { expect(readIndexScopeExcludes(noStar)).toEqual({ kind: "absent" }); } finally { rmSync(noStar, { recursive: true, force: true }); }
});

test("readIndexScopeExcludes (H2): present-but-broken shapes are INVALID (fail-closed), not a silent empty list", () => {
  const cases: Array<[string, RegExp]> = [
    ['memory:\n  index_scope:\n    exclude: "raw/**"\n', /must be a list/],           // scalar exclude
    ['memory:\n  index_scope:\n    exclude:\n      - "raw/**"\n      - 42\n', /non-string member/], // mixed list
    ['memory:\n  index_scope:\n    exclude:\n      - "raw/**"\n      -\n', /non-string member/],     // null member (`- `)
    ['memory:\n  index_scope:\n    exclude:\n      - "/etc/**"\n', /vault-relative/],   // leading slash
    ['memory:\n  index_scope:\n    exclude:\n      - "../other/**"\n', /escape the vault/], // .. segment
    ['memory:\n  index_scope:\n    exclude: [a, b\n', /not valid YAML/],                 // parse error
  ];
  for (const [yaml, re] of cases) {
    const v = vaultWith(yaml);
    try {
      const r = readIndexScopeExcludes(v);
      expect(r.kind).toBe("invalid");
      expect((r as { reason: string }).reason).toMatch(re);
    } finally { rmSync(v, { recursive: true, force: true }); }
  }
});

test("crossStarExpectedHash (H2): valid -> hash; absent -> refusal; invalid -> refusal", () => {
  const v = vaultWith('memory:\n  index_scope:\n    exclude:\n      - "raw/**"\n');
  try { expect(crossStarExpectedHash(v)).toEqual({ hash: scopeHash(["raw/**"]) }); } finally { rmSync(v, { recursive: true, force: true }); }
  const noStar = vaultWith();
  try { expect((crossStarExpectedHash(noStar) as { refusal: string }).refusal).toContain("no star.yaml manifest"); } finally { rmSync(noStar, { recursive: true, force: true }); }
  const bad = vaultWith('memory:\n  index_scope:\n    exclude: "raw/**"\n');
  try { expect((crossStarExpectedHash(bad) as { refusal: string }).refusal).toContain("invalid"); } finally { rmSync(bad, { recursive: true, force: true }); }
});

test("scopeHash: deterministic, order-independent, defined for the empty list", () => {
  expect(scopeHash(["a/**", "b/**"])).toBe(scopeHash(["b/**", "a/**"])); // sorted internally
  expect(scopeHash(["a/**"])).not.toBe(scopeHash(["b/**"]));
  expect(scopeHash([])).toMatch(/^[0-9a-f]{64}$/); // empty list has a well-defined sha256 too
});

test("buildScopeExclude: twinkling-parity — file match, dir-prune probe, deep globs still exclude per-file; empty -> undefined", () => {
  const ex = buildScopeExclude(["raw/in_x/**", "secret/**/key/**"])!;
  expect(ex("raw/in_x/note.md")).toBe(true);       // file under an excluded tree
  expect(ex("raw/in_x/")).toBe(true);              // dir prune (probed with `<dir>/x`)
  expect(ex("wiki/keep.md")).toBe(false);          // unrelated file kept
  expect(ex("secret/a/key/k.md")).toBe(true);      // deep multi-segment glob still excludes the file
  expect(buildScopeExclude([])).toBeUndefined();
});

test("canonicalizeScopeExcludes: trims each, drops empty/whitespace-only, dedupes, sorts", () => {
  expect(canonicalizeScopeExcludes([" raw/** ", "packages/**", "raw/**", "", "   "]))
    .toEqual(["packages/**", "raw/**"]); // trimmed, empties dropped, "raw/**" deduped, sorted
  expect(canonicalizeScopeExcludes([])).toEqual([]);
  // idempotent: canonicalizing an already-canonical list is a no-op
  const once = canonicalizeScopeExcludes([" a/** ", "b/**", "a/**"]);
  expect(canonicalizeScopeExcludes(once)).toEqual(once);
});

test("H5 parity: one canonicalizer feeds BOTH scopeHash AND buildScopeExclude — a whitespaced/duped glob can't produce a clean hash with a dirty predicate", () => {
  // The trap Codex #2 caught: if only the HASH canonicalized, " raw/** " would hash as the clean
  // `raw/**` yet the exclusion predicate would keep the untrimmed, non-matching glob. Both sides
  // must canonicalize identically.
  const dirty = [" raw/** ", "raw/**", "  packages/**  "];
  const clean = ["packages/**", "raw/**"];
  // hash parity: the dirty and the hand-canonical list hash the same
  expect(scopeHash(dirty)).toBe(scopeHash(clean));
  // predicate parity: the dirty list still EXCLUDES the excluded paths (trimmed glob matches)
  const ex = buildScopeExclude(dirty)!;
  expect(ex("raw/secret.md")).toBe(true);       // trimmed `raw/**` matches (not the untrimmed no-match)
  expect(ex("packages/x.md")).toBe(true);
  expect(ex("wiki/keep.md")).toBe(false);
  // an all-whitespace/empty list yields no predicate (nothing to exclude), same as []
  expect(buildScopeExclude(["  ", ""])).toBeUndefined();
  expect(scopeHash(["  ", ""])).toBe(scopeHash([]));
});

test("scopeRefusalReason: holds when hash matches + not ignored; refuses on missing / ignore / mismatch", () => {
  const h = scopeHash(["raw/**"]);
  expect(scopeRefusalReason({ hash: h, ignoreScope: false }, h)).toBeNull(); // boundary holds
  expect(scopeRefusalReason(null, h)).toContain("no index_scope signature"); // missing -> fail closed
  expect(scopeRefusalReason({ hash: h, ignoreScope: true }, h)).toContain("--ignore-scope");
  expect(scopeRefusalReason({ hash: h, ignoreScope: false }, scopeHash(["other/**"]))).toContain("scope-hash mismatch");
});
