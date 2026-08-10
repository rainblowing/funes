// index_scope — funes reads the star manifest's memory.index_scope NATIVELY now (closure sprint
// 3B). Before this, funes only WARNED that a direct reindex ignored index_scope, so one accidental
// `funes reindex` re-admitted every excluded (secret-bearing) path. These pure helpers make the
// index the capability boundary: reindex applies the excludes, stamps a canonical scope signature,
// and cross-star (--ops) reads refuse when the index no longer matches current policy.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
// P3.14: the PURE guard decisions moved to funes-core and the crypto-side signature to
// funes-shared, so funes-libsql can use them without importing this (fs/yaml-bound) module.
// Re-exported here so every existing `./scope.ts` importer keeps working unchanged.
import picomatch from "picomatch";

/** P3.15: the option pair that makes picomatch byte-identical to Bun.Glob, verified against the
 *  generated corpus in __fixtures__/glob-parity.json. Neither default is safe to omit:
 *  `dot` — Bun.Glob matches dotfiles, picomatch does NOT by default, so without it `**` and `*`
 *    stop excluding dot paths and index scope silently WIDENS at the cross-star boundary;
 *  `strictSlashes` — without it `raw/**` also matches the bare parent `raw`, which Bun does not. */
export const PICOMATCH_OPTS = { dot: true, strictSlashes: true } as const;

/** Extglobs (`!(…)`, `?(…)`, `*(…)`, `+(…)`, `@(…)`) and negated classes (`[!…]`, `[^…]`) — the
 *  only constructs where picomatch and Bun.Glob disagree. Refused at manifest validation. */
const EXTGLOB = /[!?*+@]\(|\[[!^]/;

export { scopeRefusalReason, guardRefusal } from "funes-core";
export { canonicalizeScopeExcludes, scopeHash } from "funes-shared";
import { canonicalizeScopeExcludes, scopeHash } from "funes-shared";


/** H2: the index_scope manifest read result, discriminated so a malformed manifest can NEVER
 *  silently degrade to "no scope". `absent` = no star.yaml (configless — legitimate for own-star
 *  reindex, never a cross-star boundary). `valid` = a well-formed manifest (possibly with no
 *  excludes). `invalid` = present-but-broken (YAML parse error, scalar `exclude`, non-string member,
 *  or a non-vault-relative glob) — the reindex REFUSES rather than re-admitting excluded files. */
export type ScopeExcludesResult =
  | { kind: "absent" }
  | { kind: "valid"; excludes: string[] }
  | { kind: "invalid"; reason: string };

/** Read + VALIDATE memory.index_scope.exclude from <vault>/star.yaml, fail-closed (H2). A missing
 *  file is `absent`; a present-but-broken shape is `invalid` (with a reason), NOT a silent empty
 *  list; a well-formed manifest is `valid` with the canonicalized excludes ([] when none declared). */
export function readIndexScopeExcludes(vault: string): ScopeExcludesResult {
  const p = join(vault, "star.yaml");
  if (!existsSync(p)) return { kind: "absent" };
  let data: { memory?: { index_scope?: { exclude?: unknown } } } | null;
  try {
    data = parseYaml(readFileSync(p, "utf8")) as { memory?: { index_scope?: { exclude?: unknown } } } | null;
  } catch (e) {
    return { kind: "invalid", reason: `star.yaml is not valid YAML: ${(e as Error).message}` };
  }
  const ex = data?.memory?.index_scope?.exclude;
  // Manifest present but no index_scope.exclude declared -> a VALID empty scope (index everything).
  if (ex === undefined || ex === null) return { kind: "valid", excludes: [] };
  if (!Array.isArray(ex)) {
    return { kind: "invalid", reason: "memory.index_scope.exclude must be a list of glob strings (got a scalar)" };
  }
  for (const g of ex) {
    if (typeof g !== "string") {
      return { kind: "invalid", reason: `memory.index_scope.exclude has a non-string member (${g === null ? "null" : typeof g})` };
    }
    const t = g.trim();
    if (t.startsWith("/")) {
      return { kind: "invalid", reason: `index_scope glob must be vault-relative (no leading "/"): ${JSON.stringify(g)}` };
    }
    if (t.split("/").some((seg) => seg === "..")) {
      return { kind: "invalid", reason: `index_scope glob must not escape the vault (no ".." segment): ${JSON.stringify(g)}` };
    }
    // P3.15: extglobs and negated classes are the ONLY forms where the matcher we ship (picomatch)
    // and the one twinkling uses (Bun.Glob) disagree — verified across a generated corpus, where
    // every other construct is byte-identical. index_scope is a fail-closed security boundary (H2),
    // so a pattern the two engines read differently is refused rather than silently excluding a
    // different set of files on each side.
    if (EXTGLOB.test(t)) {
      return { kind: "invalid", reason: `index_scope glob uses an extglob or negated class, which is not portable across matchers: ${JSON.stringify(g)} — rewrite it with plain globs (*, **, ?, [abc], {a,b})` };
    }
  }
  return { kind: "valid", excludes: canonicalizeScopeExcludes(ex as string[]) };
}

/** H2: the cross-star expected scope hash for a vault, or a REFUSAL when the manifest is
 *  absent/invalid. A governed cross-star boundary requires a VALID, manifest-built signature — an
 *  absent (configless) or invalid manifest is legitimate for own-star use but never for a cross-star
 *  read, so we refuse rather than compute a hash the serve-time recompute could match. */
export function crossStarExpectedHash(vault: string): { refusal: string } | { hash: string } {
  const scope = readIndexScopeExcludes(vault);
  if (scope.kind === "absent") {
    return { refusal: `cross-star read refused — ${vault} has no star.yaml manifest; a governed cross-star boundary requires a declared, valid index_scope (own-star reindex is fine, cross-star is not).` };
  }
  if (scope.kind === "invalid") {
    return { refusal: `cross-star read refused — star.yaml index_scope is invalid (${scope.reason}); fix the manifest and run a full \`funes reindex\`.` };
  }
  return { hash: scopeHash(scope.excludes) };
}


/** P3.15: directory names a CONFIGLESS reindex skips. Without a star.yaml, `walkMd` descends every
 *  non-dot tree, so the quickstart's `funes reindex --vault .` in a code repo happily ingests
 *  dependency documentation and build output. Deliberately NOT inside `walkMd`, which publication
 *  and twinkling also call with their own declared scope, and deliberately NOT folded into
 *  `excludes` — that would change the scope hash and the generation hash for configless vaults.
 *  A DECLARED index_scope is authoritative and is never silently extended with these. */
export const CONFIGLESS_EXCLUDES = ["node_modules", "dist", "build", "vendor", "target"] as const;

/** Segment-aware, so a nested `sub/node_modules/pkg/README.md` is skipped at any depth. */
export function configlessExclude(): (rel: string) => boolean {
  const skip = new Set<string>(CONFIGLESS_EXCLUDES);
  return (rel: string) => rel.split("/").some((seg) => skip.has(seg));
}

/** OR two optional predicates (either may be absent). */
export function anyExclude(
  ...preds: Array<((rel: string) => boolean) | undefined>
): ((rel: string) => boolean) | undefined {
  const live = preds.filter((p): p is (rel: string) => boolean => !!p);
  if (!live.length) return undefined;
  return live.length === 1 ? live[0]! : (rel: string) => live.some((p) => p(rel));
}

/** The index-scope exclusion predicate — SAME semantics as twinkling's buildExcludePredicate
 *  (Bun.Glob, called with `<relDir>/` before descending and `<relFile>` per file), so funes's native
 *  reindex and a twinkling reindex exclude identically. Canonicalizes FIRST (H5) so the globs it
 *  matches on are byte-identical to those scopeHash hashed. Empty list -> undefined (no predicate). */
export function buildScopeExclude(rawGlobs: string[]): ((rel: string) => boolean) | undefined {
  const globs = canonicalizeScopeExcludes(rawGlobs);
  if (!globs.length) return undefined;
  const gs = globs.map((g) => {
    const m = picomatch(g, PICOMATCH_OPTS);
    return { match: (p: string) => m(p) };
  });
  return (rel: string) => {
    const isDir = rel.endsWith("/");
    const clean = isDir ? rel.slice(0, -1) : rel;
    return gs.some((g) => g.match(clean) || (isDir && g.match(`${clean}/x`)));
  };
}


