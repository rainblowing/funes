// The edge face's grants (PLAN-0.5.0 item 42, ADR-0014, record 32 Settle 2): who may call a star's
// writer, read from the star key's own DO SQLite `grants` table (created by the edge store, item 37,
// as a protocol table no rebuild drops; ADR-0024).
//
// - A row names a ROLE, never ops: a role is a preset (the kernel's PRESETS), resolved to its ops on every request,
//   so a preset change is a deploy, not a re-mint of every token.
// - Every request reads and validates every live (unrevoked) row with the access file's own validator
//   (item 41) plus the preset rules. No cache: a revocation takes effect on the next request. One
//   malformed row refuses everyone; an empty table refuses everyone; an expired row is no grant.
// - The presented sha256 is compared with every row in constant time (`grantFor`).
// - `write_actor` stays per process (ADR-0009): a grant's actor reaches the trust stamp only, never
//   the store's constructor.
import { ceiling, type AccessPolicy, type Grant, type OpEntry } from "funes-core";
import { grantFor, validateGrants, type GrantRow } from "funes-core/internal";
import { logError } from "./log.ts";

/** The registry cut to the edge tier (ADR-0020): what the edge dispatches over. Any other op answers
 *  `unknown operation` at dispatch. No op hard-deletes, so `forget` is soft here as everywhere. */
export const EDGE_OPERATIONS: OpEntry[] = ceiling("edge");

/** The host ceiling's op names: `ceiling("edge")`, never a second list. */
export const HOST_CEILING: readonly string[] = EDGE_OPERATIONS.map((o) => o.name);

/** Every live (unrevoked) grants row, expired ones included: what validateGrants judges. */
export function liveGrantRows(sql: SqlStorage): GrantRow[] {
  return sql.exec<GrantRow & Record<string, SqlStorageValue>>(
    "select token_sha256, actor, role, stars, created_at, expires_at, revoked_at, label from grants where revoked_at is null",
  ).toArray();
}

/** The live, unexpired rows as one policy, read NOW from the DO's SQLite — or null, the 401 for
 *  everyone, while any live row is malformed. The presets and the row checks are the kernel's
 *  (grant-row.ts, RAI-310), shared with `funes token mint --edge`. */
export function livePolicy(sql: SqlStorage, now: Date): AccessPolicy | null {
  const rows = liveGrantRows(sql);
  let policy: AccessPolicy;
  try {
    policy = validateGrants(rows);
  } catch (e) {
    logError("grants-malformed", e);
    return null;
  }
  const expired = new Set(rows.filter((r) => r.expires_at != null && Date.parse(r.expires_at) <= now.getTime()).map((r) => r.actor));
  return { actors: policy.actors.filter((a) => !expired.has(a.actor)) };
}

/** The grant a request's token names, or null: a missing, unknown, revoked or expired token, and
 *  EVERY token while any live row is malformed. */
export function grantForRequest(sql: SqlStorage, presented: string | null | undefined, now: Date): Grant | null {
  const policy = livePolicy(sql, now);
  return policy && grantFor(policy, presented);
}
