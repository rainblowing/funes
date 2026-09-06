import { test, expect } from "bun:test";
import picomatch from "picomatch";
import { buildScopeExclude, readIndexScopeExcludes, PICOMATCH_OPTS } from "./scope.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import corpus from "./__fixtures__/glob-parity.json" with { type: "json" };

// P3.15 step 5. index_scope decides which files a cross-star reader can ever see, so the matcher
// swap (Bun.Glob -> picomatch, because Bun.Glob does not exist on Node) has to be provably
// behaviour-preserving. The corpus was GENERATED from Bun.Glob and checked in: the public repo's CI
// runs on Node and has neither Bun.Glob nor twinkling's buildExcludePredicate to compare against,
// so importing either one live would simply die there.

test("picomatch reproduces Bun.Glob on every case in the generated corpus", () => {
  const mismatches: string[] = [];
  for (const [glob, path, expected] of corpus.cases as Array<[string, string, boolean]>) {
    const got = picomatch(glob, PICOMATCH_OPTS)(path);
    if (got !== expected) mismatches.push(`${glob} vs ${path}: bun=${expected} pico=${got}`);
  }
  expect(mismatches).toEqual([]);
  expect(corpus.cases.length).toBeGreaterThan(1000);
});

// Both options are load-bearing and neither is picomatch's default — this pins WHY.
test("dropping `dot` would silently WIDEN index scope (dotfiles stop being excluded)", () => {
  expect(picomatch("**/*.secret", { strictSlashes: true })(".hidden/a.secret")).toBe(false); // wrong
  expect(picomatch("**/*.secret", PICOMATCH_OPTS)(".hidden/a.secret")).toBe(true); // Bun's answer
});

test("dropping `strictSlashes` would match the bare parent directory", () => {
  expect(picomatch("raw/**", { dot: true })("raw")).toBe(true); // wrong
  expect(picomatch("raw/**", PICOMATCH_OPTS)("raw")).toBe(false); // Bun's answer
});

test("the predicate still excludes dirs via the <relDir>/ shim and files directly", () => {
  const ex = buildScopeExclude(["raw/**", "in_*/**"])!;
  expect(ex("raw/")).toBe(true);        // directory form, before descending
  expect(ex("raw/a.md")).toBe(true);
  expect(ex("raw/.hidden.md")).toBe(true); // dotfile inside an excluded tree
  expect(ex("in_chatgpt/")).toBe(true);
  expect(ex("wiki/a.md")).toBe(false);
  expect(buildScopeExclude([])).toBeUndefined();
});

// Extglobs and negated classes are the ONLY constructs the two engines read differently, so they
// are refused at manifest validation rather than quietly excluding a different set on each side.
test("a manifest using an extglob or negated class is INVALID, not silently divergent", () => {
  const dir = mkdtempSync(join(tmpdir(), "funes-scope-"));
  try {
    const write = (glob: string) =>
      writeFileSync(join(dir, "star.yaml"), `memory:\n  index_scope:\n    exclude:\n      - "${glob}"\n`);

    for (const bad of ["!(a)/**", "+(a|b)/**", "**/[!x]*.md", "?(a)/**", "@(a|b)/**", "[^x]/**"]) {
      write(bad);
      const r = readIndexScopeExcludes(dir);
      expect(r.kind).toBe("invalid");
      expect((r as { reason: string }).reason).toMatch(/not portable across matchers/);
    }
    for (const ok of ["raw/**", "in_*/**", "{x,y}/**", "[abc]/**", "docs/*.md", "p?/**"]) {
      write(ok);
      expect(readIndexScopeExcludes(dir).kind).toBe("valid");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
