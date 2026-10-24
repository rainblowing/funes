// Where a write's actor comes from — and the one place it may never come from (0.3.0 item 24).
//
// `Actor` is who performed a mutation (GLOSSARY.md). It is not the locus. The store stamps
// `write_actor` from its CONSTRUCTOR and never from an item's frontmatter or an op's arguments: no
// operation in ops.ts declares an actor argument, and the test that proves it is generated from the
// registry. Since 0.6.0 (RAI-310 D3, D9) one credential format is left on a server: the version-2
// access file below. The v1 `{token: actor}` map, `--actor-map`, `--capability` and `--actor` are
// removed. `write_actor` is the grant's actor in a one-grant process (a stdio session under
// FUNES_ACTOR_MAP), else `unknown`: a multi-actor server stamps `unknown` (ADR-0009).
// RAI-313: the kernel half — the name rule, the policy validator and the grant match. The access
// file's owner-only read and the stdio session grant stay in the engine (funes-engine actor.ts).
import { createHash, timingSafeEqual } from "node:crypto";
import { refKey, sameStar } from "./star-uri.ts";

/** An actor name as it will be stored in `write_actor`. Deliberately narrow: it lands in a text
 *  column that `indexed_page` serves back out, so a name carrying whitespace, control characters or
 *  a newline would be a formatting weapon in a diagnostic surface. */
const ACTOR_NAME = /^[A-Za-z0-9._:@/+-]{1,128}$/;

/** The recorded actor when nothing trusted names one. A guess would be worse than a blank. */
export const UNKNOWN_ACTOR = "unknown";

export function assertActorName(name: string, source: string): string {
  const a = name.trim();
  if (!ACTOR_NAME.test(a)) {
    throw new Error(`${source}: "${name}" is not a usable actor name — expected 1-128 chars of [A-Za-z0-9._:@/+-] (fail-closed)`);
  }
  return a;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

// ── RAI-158 (PLAN-0.4.0 item 21): the access file, version 2 ─────────────────────────────────────
// One broker, many callers. A v2 file names ACTORS, each with a ROLE (a named set of operations)
// and the STARS it may touch; a presented token picks the actor. It stores sha256(token), never a
// token, so reading it leaks no credential. It is read on EVERY request that presents a token — no
// cache, so no stale key can hide a revocation (an (mtime, size) key misses a same-size rewrite
// under a restored mtime). Anything malformed refuses everyone: a half-loaded policy is a policy
// that silently admits the entries it did not drop.

/** What a presented credential grants: who is calling, which operations, on which stars. */
export interface Grant {
  actor: string;
  ops: ReadonlySet<string>;
  /** Star refs, compared by canonical key; "*" is every star. */
  stars: readonly string[];
}

export interface AccessPolicy {
  actors: ReadonlyArray<Grant & { hash: Uint8Array }>;
}

/** RAI-239 (PLAN-0.5.0 item 41): the ONE validation rule for a parsed `{roles, actors}` policy,
 *  shared by the file reader above and the edge face's grants (ADR-0014), so the access file and the
 *  edge grants cannot drift. Pure — no fs — so it runs in workerd (record 36: `node:crypto` loads
 *  there; the file reader does not). `publicOps` is the registry's non-internal operation names: a
 *  role naming anything else refuses — `elevate` is a CLI verb outside the registry. `source`
 *  prefixes every refusal. */
export function validateAccessPolicy(parsed: Record<string, unknown>, publicOps: ReadonlySet<string>, source: string): AccessPolicy {
  const bad = (why: string) => new Error(`${source}: ${why} — refusing everyone (fail-closed)`);
  if (!isObject(parsed.roles)) throw bad("`roles` must be an object of {name: {ops: [...]}}");
  const roles = new Map<string, Set<string>>();
  for (const [name, r] of Object.entries(parsed.roles)) {
    const ops = isObject(r) && Array.isArray(r.ops) ? r.ops : null;
    if (!ops) throw bad(`role "${name}": \`ops\` must be a list`);
    if (ops.length === 0) throw bad(`role "${name}": no operations`);
    for (const op of ops) {
      if (typeof op !== "string" || !publicOps.has(op)) throw bad(`role "${name}": unknown or internal operation "${String(op)}"`);
    }
    roles.set(name, new Set(ops as string[]));
  }
  if (!isObject(parsed.actors)) throw bad("`actors` must be an object of {name: {token_sha256, role, stars}}");
  const actors: Array<Grant & { hash: Uint8Array }> = [];
  const hashes = new Set<string>();
  // Entries are named by POSITION in every refusal, never by key: an operator who wraps an old v1 map
  // under `actors` puts raw tokens in the key slot, and a 64-hex token is a valid actor name.
  for (const [i, [name, a]] of Object.entries(parsed.actors).entries()) {
    const where = `actors entry #${i + 1}`;
    if (!ACTOR_NAME.test(name.trim())) throw bad(`${where}: not a usable actor name — expected 1-128 chars of [A-Za-z0-9._:@/+-]`);
    if (!isObject(a)) throw bad(`${where}: must be an object of {token_sha256, role, stars}`);
    const h = a.token_sha256;
    if (typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) throw bad(`${where}: token_sha256 must be 64 lowercase hex`);
    if (hashes.has(h)) throw bad(`${where}: two actors share one token hash`);
    hashes.add(h);
    const ops = roles.get(String(a.role));
    if (!ops) throw bad(`${where}: unknown role "${String(a.role)}"`);
    const stars = a.stars;
    if (!Array.isArray(stars) || stars.length === 0 || !stars.every((s) => s === "*" || (typeof s === "string" && refKey(s) !== null))) {
      throw bad(`${where}: stars must be a non-empty list of star refs or "*"`);
    }
    actors.push({ actor: name.trim(), ops, stars: stars as string[], hash: Uint8Array.from(h.match(/../g)!, (b) => parseInt(b, 16)) });
  }
  if (actors.length === 0) throw bad("no actors");
  return { actors };
}

/** The grant a presented token names, or null. The token is trimmed (every token reader in the
 *  estate trims) and hashed, then compared against EVERY entry in constant time, with no early exit. */
export function grantFor(policy: AccessPolicy, presented: string | null | undefined): Grant | null {
  const token = (presented ?? "").trim();
  if (!token) return null;
  const h = createHash("sha256").update(token).digest();
  let hit: Grant | null = null;
  for (const a of policy.actors) {
    if (timingSafeEqual(h, a.hash) && hit === null) hit = { actor: a.actor, ops: a.ops, stars: a.stars };
  }
  return hit;
}

/** Does this grant reach the star `starId` names? By canonical key, so one star under two access
 *  methods is one star; a star with no id is reached by "*" only. */
export function grantCoversStar(g: Grant, starId: string | null): boolean {
  return g.stars.includes("*") || (starId !== null && g.stars.some((s) => s !== "*" && sameStar(s, starId)));
}
