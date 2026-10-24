// PLAN-0.5.0 item 44 (ADR-0014, record 32 Settle 4-5): /mint, the Telegram LoginUrl mint for the
// edge face's grants, driven through the Worker's own fetch under local workerd. Record 35's login
// rows (A3, A16) and the mint rows (A8, A9, A12) are here.
import { createExecutionContext, env, runInDurableObject } from "cloudflare:test";
import { createHash, createHmac } from "node:crypto";
import { beforeAll, expect, it, vi } from "vitest";
import { grantRow } from "funes-core/internal";
import { grantForRequest } from "../src/grants.ts";
import worker from "../src/index.ts";
import { REVOKE_ALL_SQL } from "../src/mint-telegram.ts";
import { FIXTURE_KEY, seedStar, starYaml } from "./fixture-star.ts";

const HOST = env.FUNES_HOST;
const ORIGIN = `https://${HOST}`;
const KEY = FIXTURE_KEY;
const MINT = `${ORIGIN}/mint/${KEY}`;
type WorkerEnv = Parameters<typeof worker.fetch>[1];
const fetchWorker = (input: string, init?: RequestInit, e: WorkerEnv = env) => worker.fetch(new Request(input, init) as Parameters<typeof worker.fetch>[0], e, createExecutionContext());
beforeAll(() => seedStar(env.VAULT));

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
const getLogin = (q: Record<string, string> | Array<[string, string]>, at = MINT) => fetchWorker(`${at}?${qs(q)}`, { redirect: "manual" });

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
  expect(to.origin + to.pathname).toBe(MINT);
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
  await runInDurableObject(env.STAR.getByName(KEY), (_o, state) => {
    const row = state.storage.sql.exec("select * from login_seen where hash = ?", q.hash!).one();
    expect(row).toEqual({ hash: q.hash, expires_at: Number(q.auth_date) + 300 });
  });
});

const TOKEN = /funes_[A-Za-z0-9_-]{43}/;
const SAME_ORIGIN = { origin: ORIGIN, "sec-fetch-site": "same-origin" };
const post = (form: Record<string, string>, headers: Record<string, string> = SAME_ORIGIN) =>
  fetchWorker(MINT, { method: "POST", headers, body: new URLSearchParams(form) });
/** Mint through a fresh login; the token the page shows once. */
async function mint(role: string, label: string): Promise<string> {
  const r = await post({ h: await handle(), action: "mint", role, label });
  const body = await r.text();
  expect(r.status, body).toBe(200);
  return body.match(TOKEN)![0];
}
/** Who the token is, as /mcp will resolve it: the actor, or null (the 401). */
const whoIs = (token: string) =>
  runInDurableObject(env.STAR.getByName(KEY), (_o, state) => grantForRequest(state.storage.sql, token, new Date())?.actor ?? null);

it("the confirm page needs a valid handle and sends Referrer-Policy: same-origin, no-store and a no-script CSP", async () => {
  const h = await handle();
  const page = await fetchWorker(`${MINT}?h=${h}`);
  expect(page.status).toBe(200);
  expect(page.headers.get("referrer-policy")).toBe("same-origin");
  expect(page.headers.get("cache-control")).toBe("no-store");
  expect(page.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'; form-action 'self'");
  const html = await page.text();
  expect(html).toContain(`name="h" value="${h}"`);
  expect(html).not.toContain("<script");
  expect(html).toContain(`<h1>Grants for ${KEY}</h1>`);
  expect(html).toContain(`action="/mint/${KEY}"`);
  expect((await fetchWorker(`${MINT}?h=AAAAAAAAAAAAAAAAAAAAAA`)).status).toBe(403);
  expect((await fetchWorker(MINT)).status).toBe(400); // the bare URL: the user declined the login
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
  await runInDurableObject(env.STAR.getByName(KEY), (_o, state) => {
    const row = state.storage.sql.exec<{ token_sha256: string; stars: string; expires_at: string; created_at: string }>(
      "select token_sha256, stars, expires_at, created_at from grants where actor = 'agent:claude-code-a'",
    ).one();
    expect(row.token_sha256).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.parse(row.stars)).toEqual([KEY]);
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
  await runInDurableObject(env.STAR.getByName(KEY), (_o, state) => {
    expect(state.storage.sql.exec("select count(*) as n from grants where role = 'outbox'").one().n).toBe(0);
  });
});

it("a re-mint revokes the actor's live row: the old token is dead on the next request", async () => {
  const first = await mint("bot", "helper");
  expect(await whoIs(first)).toBe("bot:helper");
  const second = await mint("bot", "helper");
  expect(await whoIs(first)).toBeNull();
  expect(await whoIs(second)).toBe("bot:helper");
});

it("a mint with a bad label is refused, and the grants keep working", async () => {
  const bot = await mint("bot", "helper");
  for (const label of ["has space", "x".repeat(129)]) {
    const r = await post({ h: await handle(), action: "mint", role: "agent", label });
    expect(r.status, label).toBe(400);
    expect(await r.text()).not.toMatch(TOKEN);
  }
  expect(await whoIs(bot)).toBe("bot:helper");
});

it("revoke sets revoked_at and keeps the row; while a row is malformed the mint is refused but revoke still works", async () => {
  const agent = await mint("agent", "to-revoke");
  expect((await post({ h: await handle(), action: "revoke", actor: "agent:to-revoke" })).status).toBe(200);
  expect(await whoIs(agent)).toBeNull();
  await runInDurableObject(env.STAR.getByName(KEY), (_o, state) => {
    expect(state.storage.sql.exec("select revoked_at from grants where actor = 'agent:to-revoke'").one().revoked_at).not.toBeNull();
    // A8/A9: a row naming an outbox actor under role bot makes the table malformed: everyone 401.
    state.storage.sql.exec("insert into grants values (?, 'outbox@replica', 'bot', ?, '2026-10-01T00:00:00Z', null, null, 'replica')", "ab".repeat(32), JSON.stringify([KEY]));
  });
  const bad = await post({ h: await handle(), action: "mint", role: "agent", label: "while-malformed" });
  expect(bad.status).toBe(400);
  expect(await bad.text()).not.toMatch(TOKEN);
  expect((await post({ h: await handle(), action: "revoke", actor: "outbox@replica" })).status).toBe(200);
  expect(await whoIs(await mint("agent", "after-repair"))).toBe("agent:after-repair");
  expect((await post({ h: await handle(), action: "revoke", actor: "agent:nobody" })).status).toBe(404);
});

it("the outbox row by `funes token mint --edge`'s statements (re-provisioning revokes the old), and revoke-all keeps every row", async () => {
  const bot = await mint("bot", "helper");
  await runInDurableObject(env.STAR.getByName(KEY), (_o, state) => {
    const sql = state.storage.sql;
    const provision = () => {
      const m = grantRow({ role: "outbox", label: "replica", stars: [KEY] });
      state.storage.transactionSync(() => { for (const s of m.sql) sql.exec(s); });
      return m.token;
    };
    const o1 = provision();
    expect(grantForRequest(sql, o1, new Date())?.actor).toBe("outbox@replica");
    const o2 = provision(); // R11: re-provisioning is the outbox's revocation
    expect(grantForRequest(sql, o1, new Date())).toBeNull();
    expect(grantForRequest(sql, o2, new Date())?.actor).toBe("outbox@replica");
    expect(grantForRequest(sql, bot, new Date())?.actor).toBe("bot:helper");
    const before = sql.exec("select count(*) as n from grants").one().n;
    sql.exec(REVOKE_ALL_SQL, new Date().toISOString());
    for (const t of [o2, bot]) expect(grantForRequest(sql, t, new Date())).toBeNull();
    expect(sql.exec("select count(*) as n from grants").one().n).toBe(before);
    expect(sql.exec("select count(*) as n from grants where revoked_at is null").one().n).toBe(0);
  });
  expect(await whoIs(await mint("bot", "helper"))).toBe("bot:helper"); // the compromise order's re-mint
});

it("a throw inside /mint answers 500 and logs {event, name, code} only (record 35 L9)", async () => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
  try {
    const r = await fetchWorker(MINT, {
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
  expect((await fetchWorker(`https://elsewhere.example/mint/${KEY}`)).status).toBe(421);
  const http = await fetchWorker(`http://${HOST}/mint/${KEY}`);
  expect(http.status).toBe(403);
});

// ADR-0024: the allowlist is the star's own `edge.mint.telegram_ids`, and a deployment with no login
// key has no mint.
it("a star's empty allowlist refuses every login; another star's list admits only its own ids", async () => {
  for (const [key, ids] of [["example.org/mint-none", "[]"], ["example.org/mint-other", "[77]"]] as const) await seedStar(env.VAULT, key, starYaml(key, { mintIds: ids }));
  expect((await getLogin(login(), `${ORIGIN}/mint/example.org/mint-none`)).status).toBe(403);
  expect((await getLogin(login({ id: 77 }), `${ORIGIN}/mint/example.org/mint-none`)).status).toBe(403);
  expect((await getLogin(login(), `${ORIGIN}/mint/example.org/mint-other`)).status).toBe(403); // 4242 is allowed at the fixture only
  const r = await getLogin(login({ id: 77 }), `${ORIGIN}/mint/example.org/mint-other`);
  expect(r.status).toBe(303);
  expect(new URL(r.headers.get("location")!).pathname).toBe("/mint/example.org/mint-other");
});

it("with no TELEGRAM_LOGIN_KEY the deployment has no mint: 404, with no DO call", async () => {
  const { TELEGRAM_LOGIN_KEY: _k, ...rest } = env;
  const noDo = { ...rest, STAR: { getByName: () => { throw new Error("no DO call"); } } } as unknown as WorkerEnv;
  expect((await fetchWorker(`${MINT}?${qs(login())}`, { redirect: "manual" }, noDo)).status).toBe(404);
});
