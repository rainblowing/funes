// index_scope — funes reads the star manifest's memory.index_scope NATIVELY now (closure sprint
// 3B). Before this, funes only WARNED that a direct reindex ignored index_scope, so one accidental
// `funes reindex` re-admitted every excluded (secret-bearing) path. These pure helpers make the
// index the capability boundary: reindex applies the excludes, stamps a canonical scope signature,
// and cross-star (--ops) reads refuse when the index no longer matches current policy.
import { readFileSync, statSync } from "node:fs";
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

export { scopeRefusalReason, guardRefusal, expectationRefusal } from "funes-core";
export type { ScopeExpectation } from "funes-core";
import type { ScopeExpectation } from "funes-core";
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

/** The parse memo, keyed on star.yaml's `(mtimeMs, size, ino)` — NEVER on elapsed time.
 *
 *  This read is on the hot path twice per guarded op: item 16's expectation is a thunk the guard
 *  evaluates before AND after retrieval, and each evaluation was a synchronous read plus a YAML
 *  parse — measured at 2.09 ms/call against a Dropbox-hosted star.yaml, so ~4.2 ms added to every
 *  recall. The stat still happens on every call; only the parse is skipped.
 *
 *  The key is what makes the memo safe, and a TTL would not be. Item 16 exists to catch a star.yaml
 *  narrowed DURING a read: a memo that expired on a clock would serve the pre-edit scope to the
 *  post-retrieval check for the length of its window, which is precisely the window item 16 closes.
 *  A stat key cannot — an edit moves mtime (and usually size), the key misses, the second check
 *  re-reads and still sees it. Keyed per path because the hub holds many stars open at once.
 *
 *  Bounded by the number of vaults one process ever touches, which is the fleet it serves. */
const scopeMemo = new Map<string, { key: string; result: ScopeExcludesResult }>();

/** Read + VALIDATE memory.index_scope.exclude from <vault>/star.yaml, fail-closed (H2). A missing
 *  file is `absent`; a present-but-broken shape is `invalid` (with a reason), NOT a silent empty
 *  list; a well-formed manifest is `valid` with the canonicalized excludes ([] when none declared). */
export function readIndexScopeExcludes(vault: string): ScopeExcludesResult {
  const p = join(vault, "star.yaml");
  // statSync rather than the existsSync it replaces: the memo needs the stat anyway, and a throw
  // here means the same thing existsSync's `false` meant — no readable manifest at this path.
  let st: ReturnType<typeof statSync>;
  try { st = statSync(p); } catch { return { kind: "absent" }; }
  const key = `${st.mtimeMs}:${st.size}:${st.ino}`;
  const hit = scopeMemo.get(p);
  if (hit?.key === key) return hit.result;
  const result = parseIndexScopeExcludes(p);
  scopeMemo.set(p, { key, result });
  return result;
}

function parseIndexScopeExcludes(p: string): ScopeExcludesResult {
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


/** PLAN-0.3.0 item 16, cross-star: the DESIRED scope for a governed cross-star read, as a thunk the
 *  guard re-evaluates on both checks. Same refusal semantics as `crossStarExpectedHash` — an absent
 *  or invalid manifest is a refusal on this boundary — plus `refuseWhileDirty`, because a foreign
 *  caller must not be served out of a rebuild whose built scope is not re-stamped yet.
 *
 *  A THUNK rather than a value: the desired scope is local policy on a file that can change during
 *  the read, and the whole point of item 16 is that it is compared after retrieval as well as
 *  before. Never snapshotted, and never memoized on TIME — either would reintroduce exactly the
 *  window it closes. `readIndexScopeExcludes` re-stats star.yaml on every single call and reuses a
 *  parse only while `(mtimeMs, size, ino)` is unchanged, so an edit landing mid-read still misses
 *  the memo and is still seen by the post-retrieval check. */
export function crossStarExpectation(vault: string): () => ScopeExpectation {
  return () => {
    const e = crossStarExpectedHash(vault);
    return "refusal" in e ? e : { hash: e.hash, refuseWhileDirty: true };
  };
}

/** PLAN-0.3.0 item 16, OWN-STAR: the desired scope for every other serving surface — the half that
 *  did no checking at all before this release, so a `star.yaml` narrowed after a build kept serving
 *  the rows it had just withdrawn to every local MCP client and HTTP face.
 *
 *  It differs from the cross-star expectation in exactly two ways, and both are deliberate:
 *  - an ABSENT manifest is `null`, not a refusal. A configless vault has declared no policy, and
 *    enforcing the empty-list hash would refuse every configless index ever built — while
 *    `crossStarExpectedHash` refuses it because a GOVERNED boundary needs a declared one.
 *  - `refuseWhileDirty` is false. At the moment a local reindex starts, the built scope still
 *    equals the policy that produced it: if the operator narrowed `star.yaml` the hash comparison
 *    already refuses, and if they did not there is nothing to withhold. Refusing anyway would take
 *    the operator's own daemon down for the length of every rebuild, to buy nothing.
 *  An INVALID manifest still refuses: a star.yaml we cannot read must never widen a serving
 *  surface, which is the same fail-closed rule reindex and export already apply.
 *
 *  This is the hot one — every guarded local op evaluates it TWICE — and the reason
 *  `readIndexScopeExcludes` memoizes on a stat key rather than re-parsing. See that memo. */
export function ownStarExpectation(vault: string): () => ScopeExpectation {
  return () => {
    const scope = readIndexScopeExcludes(vault);
    if (scope.kind === "absent") return null;
    if (scope.kind === "invalid") {
      return { refusal: `serve refused — star.yaml index_scope is invalid (${scope.reason}); a scope funes cannot read must not be served as if it were empty. Fix the manifest, then run a full \`funes reindex\`.` };
    }
    return { hash: scopeHash(scope.excludes), refuseWhileDirty: false };
  };
}

/** P3.15: directory names a CONFIGLESS reindex skips. Without a star.yaml, `walkMd` descends every
 *  non-dot tree, so the quickstart's `funes reindex --vault .` in a code repo happily ingests
 *  dependency documentation and build output. Deliberately NOT inside `walkMd`, which publication
 *  and twinkling also call with their own declared scope, and deliberately NOT folded into
 *  `excludes` — that would change the scope hash and the generation hash for configless vaults.
 *  A DECLARED index_scope is authoritative and is never silently extended with these. */
export const CONFIGLESS_EXCLUDES = ["node_modules", "dist", "build", "vendor", "target", "out_okf"] as const;

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


