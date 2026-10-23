// B5 (RAI-337; RAI-310 D6; ADR-0014 as amended): the edge grants — the presets a `grants` row names,
// the row checks, and the one row builder. Portable: funes-cf validates its live rows with them, the
// Telegram `/mint` and `funes token mint --edge` build their rows with `grantRow`.
//
// - A row names a ROLE, never ops: a role is a preset below, resolved to its ops on every request,
//   so a preset change is a deploy, not a re-mint of every token.
// - The live rows validate as ONE policy, with the access file's own validator: one malformed row
//   refuses everyone. A role's actor is derived from the row's label, never free.
import { assertActorName, validateAccessPolicy, type AccessPolicy } from "./actor.ts";
import { sha256Hex } from "./funes-store.ts";
import { publicOpNames } from "./ops.ts";

export type Role = "outbox" | "bot" | "agent";

/** The presets a grant row's `role` names. `actor(label)` is the one actor the role admits;
 *  `ttlDays` non-null means a row must carry `expires_at`.
 *
 *  The outbox actor is `outbox@<label>`, the label being the replica's locus, so the provisioning row
 *  names its host and this public source does not (lint-public-tree). At most ONE live outbox row is
 *  valid, and the Telegram mint refuses the role, so there is still exactly one actor whose creates
 *  are trusted (ADR-0014). */
export const PRESETS: Readonly<Record<Role, { ops: readonly string[]; actor: (label: string) => string; ttlDays: number | null }>> = {
  outbox: { ops: ["put_page", "health"], actor: (label) => `outbox@${label}`, ttlDays: null },
  bot: { ops: ["recall", "health", "page", "put_page", "forget"], actor: (label) => `bot:${label}`, ttlDays: null },
  agent: { ops: ["recall", "indexed_page", "health"], actor: (label) => `agent:${label}`, ttlDays: 90 },
};

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
 *  hash). A mint runs it over the live rows plus its candidate (or its candidate alone, at the CLI). */
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

/** RAI-313: the kernel has no Buffer; `btoa` is a global on Bun, Node and workerd. */
const base64url = (b: Uint8Array): string => btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

const lit = (v: string | null) => (v === null ? "NULL" : `'${v.replaceAll("'", "''")}'`);

/** A new grant row, its token (`funes_` + 32 random bytes base64url, stored only as its sha256), and
 *  the statements that apply it in one transaction: revoke the derived actor's live row (for the
 *  outbox, every live outbox row), then insert. The row passes the row checks alone, or this throws. */
export function grantRow(
  o: { role: string; label: string; stars: readonly string[]; days?: number },
  now = new Date(),
): { row: GrantRow; token: string; sql: string[] } {
  if (!Object.hasOwn(PRESETS, o.role)) throw new Error(`unknown role "${o.role}" — expected ${Object.keys(PRESETS).join(", ")}`);
  const role = o.role as Role;
  const preset = PRESETS[role];
  if (o.days !== undefined && !(Number.isInteger(o.days) && o.days > 0)) throw new Error(`days must be a positive whole number (got ${o.days})`);
  const days = o.days ?? preset.ttlDays;
  const token = `funes_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
  const at = now.toISOString();
  const row: GrantRow = {
    token_sha256: sha256Hex(token),
    actor: preset.actor(assertActorName(o.label, "label")),
    role,
    stars: JSON.stringify(o.stars),
    created_at: at,
    expires_at: days === null ? null : new Date(now.getTime() + days * 86_400_000).toISOString(),
    revoked_at: null,
    label: o.label.trim(),
  };
  validateGrants([row]);
  const revoke = role === "outbox"
    ? `UPDATE grants SET revoked_at = ${lit(at)} WHERE role = 'outbox' AND revoked_at IS NULL`
    : `UPDATE grants SET revoked_at = ${lit(at)} WHERE actor = ${lit(row.actor)} AND revoked_at IS NULL`;
  const insert = "INSERT INTO grants(token_sha256, actor, role, stars, created_at, expires_at, revoked_at, label) VALUES (" +
    [row.token_sha256, row.actor, row.role, row.stars, row.created_at, row.expires_at, null, row.label].map(lit).join(", ") + ")";
  return { row, token, sql: [revoke, insert] };
}
