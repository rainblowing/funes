// B5 (RAI-337; RAI-310 D5, D8a; ADR-0009, ADR-0014 as amended): the one authorization function.
// stdio calls it at startup (FUNES_ACTOR_MAP set), an HTTP host per request, the edge per request.
// Pure apart from the hash: the policy comes in already read and validated, so it runs in workerd.
// Async so that a WebCrypto hash later is no signature break.
import { ceiling, type Tier } from "./ops.ts";
import { grantCoversStar, grantFor, UNKNOWN_ACTOR, type AccessPolicy, type Grant } from "./actor.ts";

/** Why `authorize` said no. The HTTP handler answers it as `{error, message}` with this status. */
export type Refusal = { status: 401 | 403; error: "unauthorized" | "not-granted"; message: string };

const UNAUTHORIZED = (why: string): Refusal => ({ status: 401, error: "unauthorized", message: `${why}: send Authorization: Bearer <token>` });

/** A token plus a policy → a Grant whose ops are role ∩ ceiling(tier, {crossStar, loopback}) ∩ narrow.
 *  `policy` null is an HTTP host that loads no access file: tokenless reads only, actor `unknown`,
 *  and a presented token refuses (nothing can check it). */
export async function authorize(
  token: string | null,
  policy: AccessPolicy | null,
  at: { tier: Tier; star: string | null; loopback?: boolean; crossStar: boolean; narrow?: ReadonlySet<string> },
): Promise<Grant | Refusal> {
  const served = ceiling(at.tier, { crossStar: at.crossStar, loopback: at.loopback })
    .filter((o) => (policy !== null || o.readonly) && (!at.narrow || at.narrow.has(o.name)))
    .map((o) => o.name);
  const presented = token?.trim() || null;
  if (policy === null) {
    if (presented) return UNAUTHORIZED("this host loads no access file, so it accepts no token");
    return { actor: UNKNOWN_ACTOR, ops: new Set(served), stars: ["*"] };
  }
  if (!presented) return UNAUTHORIZED("no credential");
  const grant = grantFor(policy, presented);
  if (!grant) return UNAUTHORIZED("unknown, revoked or expired credential");
  if (!grantCoversStar(grant, at.star)) {
    return { status: 403, error: "not-granted", message: `actor "${grant.actor}" holds no grant for star "${at.star ?? "(no id)"}"` };
  }
  return { actor: grant.actor, ops: new Set(served.filter((n) => grant.ops.has(n))), stars: grant.stars };
}
