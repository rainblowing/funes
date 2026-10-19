// The edge face's grants (PLAN-0.5.0 item 42, ADR-0014, record 32 Settle 2): who may call the taste
// star's writer, read from the DO's own SQLite `grants` table (created by the edge store, item 37, as
// a protocol table no rebuild drops).
//
// - A row names a ROLE, never ops: a role is a preset below, resolved to its ops on every request,
//   so a preset change is a deploy, not a re-mint of every token.
// - Every request reads and validates every live (unrevoked) row with the access file's own validator
//   (item 41) plus the preset rules. No cache: a revocation takes effect on the next request. One
//   malformed row refuses everyone; an empty table refuses everyone; an expired row is no grant.
// - The presented sha256 is compared with every row in constant time (`grantFor`).
// - `write_actor` stays per process (ADR-0009): a grant's actor reaches the ADR-0005 audit line and
//   the trust stamp only, never the store's constructor.
import type { AccessPolicy, Grant, Operation } from "funes-engine/portable";
import { assertActorName, grantFor, operations, publicOpNames, validateAccessPolicy } from "funes-engine/portable";
import { logError } from "./log.ts";

/** The host ceiling: the only ops the edge face serves, named (never keyed on `served`, which also
 *  labels the mutations served here). `forget` is soft only — `hard: true` is refused `invalid`. */
export const HOST_CEILING: readonly string[] = ["recall_v2", "indexed_page", "health", "vault_page", "put_page", "link", "forget"];

export type Role = "outbox" | "bot" | "agent";

/** The funes-cf presets a grant row's `role` names. `actor(label)` is the one actor the role admits;
 *  `ttlDays` non-null means a row must carry `expires_at` (the mint sets it, item 44).
 *
 *  The outbox actor is `outbox@<label>`, the label being the replica's locus (record 22's convention),
 *  so the provisioning row names its host and this public source does not (lint-public-tree). At most
 *  ONE live outbox row is valid, and the mint refuses the role, so there is still exactly one actor
 *  whose creates are trusted (ADR-0014), written at provisioning. */
export const PRESETS: Readonly<Record<Role, { ops: readonly string[]; actor: (label: string) => string; ttlDays: number | null }>> = {
  outbox: { ops: ["put_page", "health"], actor: (label) => `outbox@${label}`, ttlDays: null },
  bot: { ops: ["recall_v2", "health", "vault_page", "put_page", "forget"], actor: () => "taste-bot", ttlDays: null },
  agent: { ops: ["recall_v2", "indexed_page", "health"], actor: (label) => `agent:${label}`, ttlDays: 90 },
};

/** The registry cut to the host ceiling: what the edge dispatches over. Any other op answers
 *  `unknown operation` at dispatch; `forget` refuses `hard: true` in its argument gate, so the
 *  refusal is `invalid` and comes before any write. */
export const EDGE_OPERATIONS: Operation[] = operations
  .filter((o) => HOST_CEILING.includes(o.name))
  .map((o) => (o.name !== "forget" ? o : {
    ...o,
    args: o.args.refine((a) => (a as { hard: boolean }).hard !== true, { message: "hard=true is not served at the edge: forget is soft only (ADR-0014)" }),
  }));

/** One `grants` row as SQLite holds it. */
export interface GrantRow {
  token_sha256: string;
  actor: string;
  role: string;
  /** A JSON array of star refs. */
  stars: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  label: string;
}

/** Validate the live rows as ONE policy, or throw naming the first bad row by position (never its
 *  hash). The mint (item 44) runs it over the live rows plus its candidate before it inserts. */
export function validateGrants(rows: readonly GrantRow[]): AccessPolicy {
  const bad = (i: number, why: string) => new Error(`grants row #${i + 1}: ${why} — refusing everyone (fail-closed)`);
  const actors: Record<string, unknown> = {};
  for (const [i, r] of rows.entries()) {
    const preset = Object.hasOwn(PRESETS, r.role) ? PRESETS[r.role as Role] : null;
    if (!preset) throw bad(i, `unknown role "${r.role}"`);
    assertActorName(r.label, `grants row #${i + 1}: label`);
    if (r.actor !== preset.actor(r.label)) throw bad(i, `role ${r.role} admits only actor "${preset.actor(r.label)}"`);
    if (Object.hasOwn(actors, r.actor)) throw bad(i, `a second live row for actor "${r.actor}"`);
    if (r.role === "outbox" && rows.findIndex((o) => o.role === "outbox") !== i) throw bad(i, "a second live outbox row");
    if (r.expires_at != null && Number.isNaN(Date.parse(r.expires_at))) throw bad(i, "expires_at is not a date");
    if (preset.ttlDays !== null && r.expires_at == null) throw bad(i, `role ${r.role} expires: expires_at is required`);
    let stars: unknown;
    try {
      stars = JSON.parse(r.stars);
    } catch {
      throw bad(i, "stars is not a JSON array");
    }
    actors[r.actor] = { token_sha256: r.token_sha256, role: r.role, stars };
  }
  const roles = Object.fromEntries(Object.entries(PRESETS).map(([name, p]) => [name, { ops: [...p.ops] }]));
  return validateAccessPolicy({ roles, actors }, publicOpNames(), "grants");
}

/** Every live (unrevoked) grants row, expired ones included: what validateGrants judges. */
export function liveGrantRows(sql: SqlStorage): GrantRow[] {
  return sql.exec<GrantRow & Record<string, SqlStorageValue>>(
    "select token_sha256, actor, role, stars, created_at, expires_at, revoked_at, label from grants where revoked_at is null",
  ).toArray();
}

/** The grant a request's token names, read NOW from the DO's SQLite, or null — the 401. Null for a
 *  missing, unknown, revoked or expired token, and for EVERY token while any live row is malformed. */
export function grantForRequest(sql: SqlStorage, presented: string | null | undefined, now: Date): Grant | null {
  const rows = liveGrantRows(sql);
  let policy: AccessPolicy;
  try {
    policy = validateGrants(rows);
  } catch (e) {
    logError("grants-malformed", e);
    return null;
  }
  const expired = new Set(rows.filter((r) => r.expires_at != null && Date.parse(r.expires_at) <= now.getTime()).map((r) => r.actor));
  return grantFor({ actors: policy.actors.filter((a) => !expired.has(a.actor)) }, presented);
}
