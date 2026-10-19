// PLAN-0.5.0 item 44 (ADR-0014, record 32 Settle 4-5): /mint, the Telegram LoginUrl mint for the
// edge face's grants, driven through the Worker's own fetch under local workerd. Record 35's login
// rows (A3, A16) and the mint rows (A8, A9, A12) are here.
import { createExecutionContext, env, runInDurableObject } from "cloudflare:test";
import { createHash, createHmac } from "node:crypto";
import { expect, it, vi } from "vitest";
import { grantForRequest } from "../src/grants.ts";
import worker from "../src/index.ts";
import { PROVISION_OUTBOX_SQL, REVOKE_ALL_SQL } from "../src/mint.ts";

const HOST = env.FUNES_HOST;
const ORIGIN = `https://${HOST}`;
const fetchWorker = (input: string, init?: RequestInit) => worker.fetch(new Request(input, init) as Parameters<typeof worker.fetch>[0], env, createExecutionContext());

const nowS = () => Math.floor(Date.now() / 1000);
let nextId = 0;
/** Telegram's LoginUrl data for `id`, signed as Telegram signs it: hex HMAC-SHA256 over the sorted
 *  `key=value` lines, keyed by sha256(bot token) (record 13 §1). A fresh first_name per call keeps
 *  every hash unique unless a test replays one on purpose. */
function login(fields: Record<string, string | number> = {}): Record<string, string> {
  const f = Object.fromEntries(Object.entries({ id: 4242, first_name: `Vlad${nextId++}`, auth_date: nowS(), ...fields }).map(([k, v]) => [k, String(v)]));
  const dcs = Object.keys(f).sort().map((k) => `${k}=${f[k]}`).join("\n");
  return { ...f, hash: createHmac("sha256", Buffer.from(env.TELEGRAM_LOGIN_KEY, "hex")).update(dcs).digest("hex") };
}
const qs = (q: Record<string, string> | Array<[string, string]>) => new URLSearchParams(q).toString();
const getLogin = (q: Record<string, string> | Array<[string, string]>) => fetchWorker(`${ORIGIN}/mint?${qs(q)}`, { redirect: "manual" });

/** A valid login's handle, read from the 303. */
async function handle(): Promise<string> {
  const r = await getLogin(login());
  expect(r.status).toBe(303);
  return new URL(r.headers.get("location")!).searchParams.get("h")!;
}

it("a valid login answers 303, and after the GET the address bar holds only ?h=<a 128-bit handle>", async () => {
  const r = await getLogin(login());
  expect(r.status).toBe(303);
  const to = new URL(r.headers.get("location")!);
  expect(to.origin + to.pathname).toBe(`${ORIGIN}/mint`);
  expect([...to.searchParams.keys()]).toEqual(["h"]);
  expect(Buffer.from(to.searchParams.get("h")!, "base64url")).toHaveLength(16);
});

it("a replayed hash is refused, and so is the same hash uppercased", async () => {
  const q = login();
  expect((await getLogin(q)).status).toBe(303);
  expect((await getLogin(q)).status).toBe(403);
  expect((await getLogin({ ...login(), hash: login().hash!.toUpperCase() })).status).toBe(400);
  const fresh = login();
  expect((await getLogin({ ...fresh, hash: fresh.hash!.toUpperCase() })).status).toBe(400); // never reaches the replay key
  expect((await getLogin(fresh)).status).toBe(303);
});

it("a repeated query key is refused, even when one of the pair is the signed value", async () => {
  const q = login();
  expect((await getLogin([...Object.entries(q), ["id", "77"]])).status).toBe(400);
  expect((await getLogin([...Object.entries(q), ["hash", q.hash!]])).status).toBe(400);
  expect((await getLogin(q)).status).toBe(303); // the refused requests did not burn the hash
});

it("an auth_date over 300 s old or over 60 s ahead is refused; inside the window it is served", async () => {
  expect((await getLogin(login({ auth_date: nowS() - 301 }))).status).toBe(403);
  expect((await getLogin(login({ auth_date: nowS() + 61 }))).status).toBe(403);
  expect((await getLogin(login({ auth_date: "soon" }))).status).toBe(403);
  expect((await getLogin(login({ auth_date: nowS() - 290 }))).status).toBe(303);
  expect((await getLogin(login({ auth_date: nowS() + 50 }))).status).toBe(303);
});

it("a forged hash is refused: a changed field, or a MAC under another key", async () => {
  expect((await getLogin({ ...login(), id: "77" })).status).toBe(403);
  const f = { id: "4242", first_name: "Mallory", auth_date: String(nowS()) };
  const dcs = Object.keys(f).sort().map((k) => `${k}=${f[k as keyof typeof f]}`).join("\n");
  const wrongKey = createHash("sha256").update("another-bot-token").digest();
  expect((await getLogin({ ...f, hash: createHmac("sha256", wrongKey).update(dcs).digest("hex") })).status).toBe(403);
  expect((await getLogin({ id: "4242", auth_date: String(nowS()) })).status).toBe(400); // no hash at all
});

it("an id off the allowlist is refused, though its login verifies", async () => {
  expect((await getLogin(login({ id: 1001 }))).status).toBe(403);
  expect((await getLogin(login({ id: 77 }))).status).toBe(303);
});

it("login_seen holds only each used hash and its expiry, never a Telegram profile field", async () => {
  const q = login({ username: "vlad_profile" });
  expect((await getLogin(q)).status).toBe(303);
  await runInDurableObject(env.TASTE.getByName("rainblow.ing/taste"), (_o, state) => {
    const row = state.storage.sql.exec("select * from login_seen where hash = ?", q.hash!).one();
    expect(row).toEqual({ hash: q.hash, expires_at: Number(q.auth_date) + 300 });
  });
});

const TOKEN = /funes_[A-Za-z0-9_-]{43}/;
const SAME_ORIGIN = { origin: ORIGIN, "sec-fetch-site": "same-origin" };
const post = (form: Record<string, string>, headers: Record<string, string> = SAME_ORIGIN) =>
  fetchWorker(`${ORIGIN}/mint`, { method: "POST", headers, body: new URLSearchParams(form) });
/** Mint through a fresh login; the token the page shows once. */
async function mint(role: string, label: string): Promise<string> {
  const r = await post({ h: await handle(), action: "mint", role, label });
  const body = await r.text();
  expect(r.status, body).toBe(200);
  return body.match(TOKEN)![0];
}
/** Who the token is, as /mcp will resolve it: the actor, or null (the 401). */
const whoIs = (token: string) =>
  runInDurableObject(env.TASTE.getByName("rainblow.ing/taste"), (_o, state) => grantForRequest(state.storage.sql, token, new Date())?.actor ?? null);

it("the confirm page needs a valid handle and sends Referrer-Policy: same-origin, no-store and a no-script CSP", async () => {
  const h = await handle();
  const page = await fetchWorker(`${ORIGIN}/mint?h=${h}`);
  expect(page.status).toBe(200);
  expect(page.headers.get("referrer-policy")).toBe("same-origin");
  expect(page.headers.get("cache-control")).toBe("no-store");
  expect(page.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'; form-action 'self'");
  const html = await page.text();
  expect(html).toContain(`name="h" value="${h}"`);
  expect(html).not.toContain("<script");
  expect((await fetchWorker(`${ORIGIN}/mint?h=AAAAAAAAAAAAAAAAAAAAAA`)).status).toBe(403);
  expect((await fetchWorker(`${ORIGIN}/mint`)).status).toBe(400); // the bare URL: the user declined the login
});

it("a POST mints an agent token once: funes_ + 43, stored as sha256, 90 days, shown with no-store and no-referrer", async () => {
  const h = await handle();
  const r = await post({ h, action: "mint", role: "agent", label: "claude-code-a" });
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  const token = (await r.text()).match(TOKEN)![0];
  expect(token).toMatch(/^funes_[A-Za-z0-9_-]{43}$/);
  expect(await whoIs(token)).toBe("agent:claude-code-a");
  await runInDurableObject(env.TASTE.getByName("rainblow.ing/taste"), (_o, state) => {
    const row = state.storage.sql.exec<{ token_sha256: string; stars: string; expires_at: string; created_at: string }>(
      "select token_sha256, stars, expires_at, created_at from grants where actor = 'agent:claude-code-a'",
    ).one();
    expect(row.token_sha256).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.parse(row.stars)).toEqual(["rainblow.ing/taste"]);
    expect(Date.parse(row.expires_at) - Date.parse(row.created_at)).toBe(90 * 86_400_000);
  });
  expect((await post({ h, action: "mint", role: "agent", label: "claude-code-b" })).status).toBe(403); // the handle was single-use
});

it("a cross-site POST is refused; so is Sec-Fetch-Site: cross-site with the right Origin, and neither burns the handle", async () => {
  const h = await handle();
  const form = { h, action: "mint", role: "agent", label: "cross-site" };
  expect((await post(form, { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await post(form, { origin: ORIGIN, "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await post(form, { origin: `http://${HOST}` })).status).toBe(403);
  expect((await post(form, { origin: "null" })).status).toBe(403);
  expect((await post(form, {})).status).toBe(403);
  expect((await post(form, { origin: ORIGIN })).status).toBe(200); // Sec-Fetch-Site absent: Origin alone suffices
});

it("a POST with a missing or unknown handle is refused", async () => {
  expect((await post({ action: "mint", role: "agent", label: "no-handle" })).status).toBe(403);
  expect((await post({ h: "AAAAAAAAAAAAAAAAAAAAAA", action: "mint", role: "agent", label: "no-handle" })).status).toBe(403);
});

it("the mint refuses the outbox role, and writes no row", async () => {
  const r = await post({ h: await handle(), action: "mint", role: "outbox", label: "replica" });
  expect(r.status).toBe(403);
  expect(await r.text()).not.toMatch(TOKEN);
  await runInDurableObject(env.TASTE.getByName("rainblow.ing/taste"), (_o, state) => {
    expect(state.storage.sql.exec("select count(*) as n from grants where role = 'outbox'").one().n).toBe(0);
  });
});

it("a re-mint revokes the actor's live row: the old token is dead on the next request", async () => {
  const first = await mint("bot", "taste-bot");
  expect(await whoIs(first)).toBe("taste-bot");
  const second = await mint("bot", "taste-bot");
  expect(await whoIs(first)).toBeNull();
  expect(await whoIs(second)).toBe("taste-bot");
});

it("a mint with a bad label is refused, and the grants keep working", async () => {
  const bot = await mint("bot", "taste-bot");
  for (const label of ["has space", "x".repeat(129)]) {
    const r = await post({ h: await handle(), action: "mint", role: "agent", label });
    expect(r.status, label).toBe(400);
    expect(await r.text()).not.toMatch(TOKEN);
  }
  expect(await whoIs(bot)).toBe("taste-bot");
});

it("revoke sets revoked_at and keeps the row; while a row is malformed the mint is refused but revoke still works", async () => {
  const agent = await mint("agent", "to-revoke");
  expect((await post({ h: await handle(), action: "revoke", actor: "agent:to-revoke" })).status).toBe(200);
  expect(await whoIs(agent)).toBeNull();
  await runInDurableObject(env.TASTE.getByName("rainblow.ing/taste"), (_o, state) => {
    expect(state.storage.sql.exec("select revoked_at from grants where actor = 'agent:to-revoke'").one().revoked_at).not.toBeNull();
    // A8/A9: a row naming an outbox actor under role bot makes the table malformed: everyone 401.
    state.storage.sql.exec("insert into grants values (?, 'outbox@replica', 'bot', '[\"rainblow.ing/taste\"]', '2026-10-01T00:00:00Z', null, null, 'replica')", "ab".repeat(32));
  });
  const bad = await post({ h: await handle(), action: "mint", role: "agent", label: "while-malformed" });
  expect(bad.status).toBe(400);
  expect(await bad.text()).not.toMatch(TOKEN);
  expect((await post({ h: await handle(), action: "revoke", actor: "outbox@replica" })).status).toBe(200);
  expect(await whoIs(await mint("agent", "after-repair"))).toBe("agent:after-repair");
  expect((await post({ h: await handle(), action: "revoke", actor: "agent:nobody" })).status).toBe(404);
});

it("the named statements: provisioning writes the one outbox row (re-provisioning revokes the old), and revoke-all keeps every row", async () => {
  const bot = await mint("bot", "taste-bot");
  const [o1, o2] = [`funes_${"1".repeat(43)}`, `funes_${"2".repeat(43)}`];
  const sha = (t: string) => createHash("sha256").update(t).digest("hex");
  await runInDurableObject(env.TASTE.getByName("rainblow.ing/taste"), (_o, state) => {
    const sql = state.storage.sql;
    const provision = (t: string) => state.storage.transactionSync(() => {
      for (const s of PROVISION_OUTBOX_SQL) sql.exec(s, sha(t), "replica", new Date().toISOString());
    });
    provision(o1);
    expect(grantForRequest(sql, o1, new Date())?.actor).toBe("outbox@replica");
    provision(o2); // R11: re-provisioning is the outbox's revocation
    expect(grantForRequest(sql, o1, new Date())).toBeNull();
    expect(grantForRequest(sql, o2, new Date())?.actor).toBe("outbox@replica");
    expect(grantForRequest(sql, bot, new Date())?.actor).toBe("taste-bot");
    const before = sql.exec("select count(*) as n from grants").one().n;
    sql.exec(REVOKE_ALL_SQL, new Date().toISOString());
    for (const t of [o2, bot]) expect(grantForRequest(sql, t, new Date())).toBeNull();
    expect(sql.exec("select count(*) as n from grants").one().n).toBe(before);
    expect(sql.exec("select count(*) as n from grants where revoked_at is null").one().n).toBe(0);
  });
  expect(await whoIs(await mint("bot", "taste-bot"))).toBe("taste-bot"); // the compromise order's re-mint
});

it("a throw inside /mint answers 500 and logs {event, name, code} only (record 35 L9)", async () => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
  try {
    const r = await fetchWorker(`${ORIGIN}/mint`, {
      method: "POST",
      headers: { ...SAME_ORIGIN, "content-type": "multipart/form-data; boundary=x" },
      body: "SENTINEL-not-multipart",
    });
    expect(r.status).toBe(500);
  } finally {
    spy.mockRestore();
  }
  expect(lines).toHaveLength(1);
  expect(Object.keys(JSON.parse(lines[0]!))).toEqual(["event", "name", "code"]);
  expect(lines[0]).not.toContain("SENTINEL");
});

it("a wrong Host answers 421, and an http: URL is refused, before anything else", async () => {
  expect((await fetchWorker("https://elsewhere.example/mint")).status).toBe(421);
  const http = await fetchWorker(`http://${HOST}/mint`);
  expect(http.status).toBe(403);
});
