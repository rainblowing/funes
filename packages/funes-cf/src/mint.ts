// /mint (PLAN-0.5.0 item 44, ADR-0014, record 32 Settle 4-5): the edge face's grants are minted and
// revoked here, behind a Telegram LoginUrl login. It runs inside the taste DO, after the entry's
// Host and https: checks.
//
// - GET /mint?<login>: refuse a repeated query key, a hash that is not lowercase hex, a bad HMAC
//   (keyed by TELEGRAM_LOGIN_KEY = sha256 of the bot token, timingSafeEqual), an auth_date over
//   300 s old or 60 s ahead, an id off TELEGRAM_ALLOWED_IDS, and a used hash (login_seen). Then 303 to
//   /mint?h=<handle>: single-use, 128-bit, expiring with the login, so the signed data leaves the
//   address bar and history.
// - GET /mint?h=<handle>: the confirm page (no script; Referrer-Policy same-origin, so its form POST
//   carries Origin).
// - POST /mint: mint or revoke, only with Origin exactly https://<FUNES_HOST>, Sec-Fetch-Site
//   same-origin when present, and a valid handle, which the POST consumes.
// - A token is `funes_` + 32 random bytes base64url, shown once, stored as sha256. The mint validates
//   the live rows plus the new one in its own transaction (refusing the mint, never the table),
//   refuses the outbox role, and revokes the actor's live row. Revoke sets revoked_at; no row is
//   ever deleted.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sha256Hex as sha256hex } from "funes-engine/portable";
import { createProtocolTables } from "./edge-store.ts";
import { liveGrantRows, PRESETS, validateGrants } from "./grants.ts";

/** The one star every grant names (ADR-0014). */
const TASTE_STAR = "rainblow.ing/taste";

export interface MintEnv {
  FUNES_HOST: string;
  TELEGRAM_LOGIN_KEY: string;
  TELEGRAM_ALLOWED_IDS: string;
}

/** NAMED SQL — the outbox provisioning statement (runbook 12, and the mint-root compromise order's
 *  re-provisioning, record 35 R11). Run in order, in one transaction, inside Vlad's deploy login
 *  (Data Studio); the mint never writes this role. Bindings: ?1 the token's sha256 (64 lowercase hex;
 *  the token itself is `funes_` + 32 random bytes base64url and goes only to the replica's 0600 token
 *  file), ?2 the replica's locus label (the actor is `outbox@<label>`), ?3 now (ISO 8601). The first
 *  statement revokes the live outbox row, so there is still one. */
export const PROVISION_OUTBOX_SQL: readonly string[] = [
  "UPDATE grants SET revoked_at = ?3 WHERE role = 'outbox' AND revoked_at IS NULL",
  `INSERT INTO grants(token_sha256, actor, role, stars, created_at, expires_at, revoked_at, label) VALUES (?1, 'outbox@' || ?2, 'outbox', '["${TASTE_STAR}"]', ?3, NULL, NULL, ?2)`,
];

/** NAMED SQL — the sanctioned revoke-all (ADR-0014): the mint-root compromise order runs it AFTER
 *  rotating the bot token and TELEGRAM_LOGIN_KEY, then re-mints the bot grant and re-provisions the
 *  outbox row. Every row stays. Binding: now (ISO 8601). */
export const REVOKE_ALL_SQL = "UPDATE grants SET revoked_at = ? WHERE revoked_at IS NULL";

/** How long a login, its hash in login_seen, and its handle live (ADR-0014). */
const LOGIN_TTL_S = 300;
const LOGIN_SKEW_S = 60;

const refuse = (status: number, why: string) => new Response(`refused: ${why}\n`, { status, headers: { "cache-control": "no-store" } });

export async function serveMint(request: Request, storage: DurableObjectStorage, env: MintEnv, now = new Date()): Promise<Response> {
  const sql = storage.sql;
  createProtocolTables(sql);
  const nowS = Math.floor(now.getTime() / 1000);
  const url = new URL(request.url);
  if (request.method === "POST") return mintPost(request, storage, env, now);
  if (request.method !== "GET") return refuse(405, "GET or POST only");
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length) return refuse(400, "a repeated query key");
  if (keys.length === 1 && keys[0] === "h") {
    const h = url.searchParams.get("h")!;
    return liveHandle(sql, h, nowS) ? confirmPage(sql, h) : refuse(403, "no valid handle: log in again from the bot's /token");
  }
  return loginGet(url, sql, env, nowS);
}

function loginGet(url: URL, sql: SqlStorage, env: MintEnv, nowS: number): Response {
  const q = Object.fromEntries(url.searchParams);
  const hash = q.hash ?? "";
  if (!/^[0-9a-f]{64}$/.test(hash)) return refuse(400, "hash must be 64 lowercase hex");
  if (!/^[0-9a-f]{64}$/.test(env.TELEGRAM_LOGIN_KEY ?? "")) return refuse(500, "TELEGRAM_LOGIN_KEY is not set as 64 lowercase hex");
  const dcs = Object.keys(q).filter((k) => k !== "hash").sort().map((k) => `${k}=${q[k]}`).join("\n");
  const mac = createHmac("sha256", Buffer.from(env.TELEGRAM_LOGIN_KEY, "hex")).update(dcs).digest();
  if (!timingSafeEqual(mac, Buffer.from(hash, "hex"))) return refuse(403, "the login does not verify");
  const authDate = /^\d{1,12}$/.test(q.auth_date ?? "") ? Number(q.auth_date) : NaN;
  if (!(nowS - authDate <= LOGIN_TTL_S && authDate - nowS <= LOGIN_SKEW_S)) return refuse(403, "auth_date is stale or ahead");
  const allowed = env.TELEGRAM_ALLOWED_IDS.split(/[\s,]+/).filter(Boolean);
  if (!allowed.includes(q.id ?? "")) return refuse(403, "this Telegram id is not allowed");
  sql.exec("delete from login_seen where expires_at < ?", nowS); // expired hashes are pruned (record 32)
  if (sql.exec("select 1 from login_seen where hash = ?", hash).toArray().length) return refuse(403, "this login was already used");
  sql.exec("insert into login_seen(hash, expires_at) values (?, ?)", hash, authDate + LOGIN_TTL_S);
  const h = randomBytes(16).toString("base64url");
  sql.exec("delete from mint_handles where expires_at < ?", nowS);
  sql.exec("insert into mint_handles(handle_sha256, expires_at) values (?, ?)", sha256hex(h), authDate + LOGIN_TTL_S);
  return new Response(null, { status: 303, headers: { location: `https://${env.FUNES_HOST}/mint?h=${h}`, "cache-control": "no-store" } });
}

const liveHandle = (sql: SqlStorage, h: string, nowS: number) =>
  sql.exec("select 1 from mint_handles where handle_sha256 = ? and expires_at >= ?", sha256hex(h), nowS).toArray().length > 0;

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A no-script page. The confirm page sends Referrer-Policy same-origin (under no-referrer its form
 *  POST would carry `Origin: null`); the pages after a POST send no-referrer. */
const page = (body: string, referrer: "same-origin" | "no-referrer", status = 200) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>funes mint</title>\n${body}\n`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": referrer,
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'; form-action 'self'",
    },
  });

/** The live grants (never a hash) with a revoke button each, and the mint form. One action per
 *  login: the POST consumes the handle. */
function confirmPage(sql: SqlStorage, h: string): Response {
  const hidden = `<input type="hidden" name="h" value="${esc(h)}">`;
  const rows = liveGrantRows(sql).map((r) =>
    `<li>${esc(r.actor)} (${esc(r.role)}, since ${esc(r.created_at)}${r.expires_at ? `, until ${esc(r.expires_at)}` : ""})
<form method="post" action="/mint">${hidden}<input type="hidden" name="action" value="revoke"><input type="hidden" name="actor" value="${esc(r.actor)}"><button>Revoke</button></form></li>`);
  return page(`<h1>Grants for ${esc(TASTE_STAR)}</h1>
<ul>${rows.join("\n") || "<li>none live</li>"}</ul>
<h2>Mint</h2>
<form method="post" action="/mint">${hidden}<input type="hidden" name="action" value="mint">
<select name="role"><option value="agent">agent (90 days)</option><option value="bot">bot</option></select>
<input name="label" required maxlength="128" placeholder="label: taste-bot, or the agent's name">
<button>Mint</button></form>
<p>A mint for an actor with a live grant revokes that grant. The token is shown once.</p>`, "same-origin");
}

async function mintPost(request: Request, storage: DurableObjectStorage, env: MintEnv, now: Date): Promise<Response> {
  if (request.headers.get("origin") !== `https://${env.FUNES_HOST}`) return refuse(403, "a cross-site POST");
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return refuse(403, "Sec-Fetch-Site is not same-origin");
  const form = await request.formData();
  const field = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };
  const sql = storage.sql;
  const nowS = Math.floor(now.getTime() / 1000);
  const at = now.toISOString();
  sql.exec("delete from mint_handles where expires_at < ?", nowS);
  const consumed = sql.exec("delete from mint_handles where handle_sha256 = ?", sha256hex(field("h"))).rowsWritten;
  if (consumed !== 1) return refuse(403, "no valid handle: log in again from the bot's /token");

  if (field("action") === "revoke") {
    const actor = field("actor");
    const n = sql.exec("update grants set revoked_at = ? where actor = ? and revoked_at is null", at, actor).rowsWritten;
    return n ? page(`<p>Revoked ${esc(actor)}. Its token is refused from the next request.</p>`, "no-referrer") : refuse(404, "no live grant for that actor");
  }
  if (field("action") !== "mint") return refuse(400, "action must be mint or revoke");
  const role = field("role");
  if (role === "outbox") return refuse(403, "the mint never writes the outbox role: it is provisioned in a deploy login (ADR-0014)");
  if (role !== "bot" && role !== "agent") return refuse(400, "role must be bot or agent");
  const label = field("label");
  const preset = PRESETS[role];
  const actor = preset.actor(label);
  const token = `funes_${randomBytes(32).toString("base64url")}`;
  const expires = preset.ttlDays === null ? null : new Date(now.getTime() + preset.ttlDays * 86_400_000).toISOString();
  try {
    // Revoke the actor's live row, insert the new one, and validate the live rows as one policy: a
    // throw rolls all three back, so a bad candidate refuses the mint and never the table.
    storage.transactionSync(() => {
      sql.exec("update grants set revoked_at = ? where actor = ? and revoked_at is null", at, actor);
      sql.exec(
        "insert into grants(token_sha256, actor, role, stars, created_at, expires_at, revoked_at, label) values (?, ?, ?, ?, ?, ?, null, ?)",
        sha256hex(token), actor, role, JSON.stringify([TASTE_STAR]), at, expires, label,
      );
      validateGrants(liveGrantRows(sql));
    });
  } catch (e) {
    return refuse(400, `the mint is refused and the grants are unchanged: ${(e as Error).message}`);
  }
  return page(`<p>Minted ${esc(actor)} (${esc(role)}${expires ? `, until ${esc(expires)}` : ""}). Copy the token now: it is shown once and stored only as its sha256.</p>
<pre>${token}</pre>`, "no-referrer");
}
