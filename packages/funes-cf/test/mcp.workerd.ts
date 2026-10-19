// PLAN-0.5.0 item 43 (ADR-0014, record 32): the edge face's /mcp entry, driven through the Worker's
// own fetch under local workerd. First the edge tracer — an outbox bearer's put_page through /mcp, the
// DO apply, the local R2 bucket, then a recall_v2 that returns the page — then record 35's A-rows.
import { createExecutionContext, env, runInDurableObject } from "cloudflare:test";
import { createHash } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it, vi } from "vitest";
import { scopeHash } from "funes-shared";
import { EdgeStore } from "../src/edge-store.ts";
import { PROVISION_OUTBOX_SQL } from "../src/mint.ts";
import { WorkersAiEmbedder } from "../src/workers-ai-embedder.ts";
import worker from "../src/index.ts";

const HOST = env.FUNES_HOST;
const MCP = `https://${HOST}/mcp`;
const TASTE = "rainblow.ing/taste";
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const token = (c: string) => `funes_${c.repeat(43)}`;

type WorkerEnv = Parameters<typeof worker.fetch>[1];
const fetchWorker = (input: string | URL | Request, init?: RequestInit, e: WorkerEnv = env) =>
  worker.fetch(new Request(input, init) as Parameters<typeof worker.fetch>[0], e, createExecutionContext());

/** A ULID minted now (Crockford base32 time, then a 16-character tail). */
function ulid(tail = "0000000000000000", ms = Date.now()): string {
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let t = "";
  for (let i = 0, n = ms; i < 10; i++, n = Math.floor(n / 32)) t = A[n % 32] + t;
  return t + tail;
}

const OUTBOX = token("o");
const BOT = token("b");

/** The taste DO's own SQL, for setup only. */
const inTaste = <T>(fn: (state: DurableObjectState) => T | Promise<T>) =>
  runInDurableObject(env.TASTE.getByName(TASTE), (_o, state) => fn(state));

/** A grant row as the mint writes it, revoking the actor's live row first (one live row per actor). */
const grant = (t: string, actor: string, role: string, label: string, o: { stars?: string; created?: string; expires?: string | null } = {}) =>
  inTaste((state) => {
    const sql = state.storage.sql;
    if (sql.exec("select 1 from grants where token_sha256 = ? and revoked_at is null", sha(t)).toArray().length) return; // the file's DO storage persists across its tests
    sql.exec("update grants set revoked_at = ? where actor = ? and revoked_at is null", new Date().toISOString(), actor);
    sql.exec("insert into grants(token_sha256, actor, role, stars, created_at, expires_at, revoked_at, label) values (?, ?, ?, ?, ?, ?, null, ?)",
      sha(t), actor, role, o.stars ?? `["${TASTE}"]`, o.created ?? new Date().toISOString(), o.expires ?? null, label);
  });

/** The outbox row by the named provisioning statement, the bot row as the mint writes it, and one
 *  live slot, as the post-seed full build leaves the edge store. */
async function provision(): Promise<void> {
  await inTaste((state) => {
    if (state.storage.sql.exec("select 1 from grants where token_sha256 = ? and revoked_at is null", sha(OUTBOX)).toArray().length) return;
    state.storage.transactionSync(() => { for (const s of PROVISION_OUTBOX_SQL) state.storage.sql.exec(s, sha(OUTBOX), "replica", new Date().toISOString()); });
  });
  await grant(BOT, "taste-bot", "bot", "bot");
  await inTaste((state) => {
    const store = new EdgeStore(state.storage, new WorkersAiEmbedder(env.AI, state.storage));
    if (store.built) return;
    store.beginBuild();
    store.writeBuild([], []);
    store.swap({ scope: { hash: scopeHash([]), ignoreScope: false }, ownerStarId: TASTE });
  });
}

/** An MCP client over the Worker's fetch, as the outbox and the bot connect: Bearer on every request. */
async function client(bearer: string): Promise<Client> {
  const c = new Client({ name: "edge-test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(MCP), {
    fetch: (input, init) => fetchWorker(input as string | URL, init),
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  }));
  return c;
}
const json = (r: { content?: unknown }) => JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;

const HEAT = "---\ntitle: Heat\ntype: Film\ndomain: movies\n---\nA crime film about a heist crew.\n";

it("the edge tracer: an outbox put_page through /mcp lands in R2 and the index, and a bot recall_v2 returns the page", async () => {
  await provision();
  const outbox = await client(OUTBOX);
  const id = ulid();
  const put = await outbox.callTool({ name: "put_page", arguments: { path: "items/movies/heat.md", content: HEAT, proposalId: id } });
  expect(put.isError, JSON.stringify(put)).toBeFalsy();
  expect(json(put)).toMatchObject({ proposalId: id, status: "applied" });
  await outbox.close();

  const bot = await client(BOT);
  const recall = json(await bot.callTool({ name: "recall_v2", arguments: { query: "Heat crime film heist", k: 5 } }));
  expect((recall.results as Array<{ id: string }>).map((r) => r.id)).toContain("items/movies/heat");
  // the bytes are R2's: vault_page reads them through R2Vault, never the index
  const page = json(await bot.callTool({ name: "vault_page", arguments: { path: "items/movies/heat.md" } }));
  expect(JSON.stringify(page)).toContain("A crime film about a heist crew.");
  await bot.close();
});

// ── record 35 A-rows ──────────────────────────────────────────────────────────────────────────────

/** env with the DO namespace counted: A1/A2's "no DO call" (the DO spy count). */
function spied(): { env: WorkerEnv; calls: () => number } {
  let n = 0;
  const TASTE_NS = { getByName: (name: string) => { n++; return env.TASTE.getByName(name); } };
  return { env: { ...env, TASTE: TASTE_NS } as unknown as WorkerEnv, calls: () => n };
}

/** One raw JSON-RPC POST to /mcp, as a client that skips the handshake sends it. */
const rpc = (method: string, params: unknown, headers: Record<string, string> = {}, e: WorkerEnv = env, url = MCP) =>
  fetchWorker(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }, e);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
/** A JSON-RPC reply: the stateless legacy leg answers one SSE `data:` line, the modern leg JSON. */
const body = (text: string): unknown => JSON.parse(text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data: "))!.slice(6) : text);
const RECALL = { name: "recall_v2", arguments: { query: "Heat" } };
const HEALTH = { name: "health", arguments: {} };
const inADay = () => new Date(Date.now() + 86_400_000).toISOString();

it("A1: no token — tools/list, recall_v2, health — is 401 with WWW-Authenticate: Bearer, and no DO call", async () => {
  const s = spied();
  for (const [method, params] of [["tools/list", {}], ["tools/call", RECALL], ["tools/call", HEALTH]] as const) {
    const r = await rpc(method, params, {}, s.env);
    expect(r.status, method).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe("Bearer");
  }
  expect(s.calls()).toBe(0);
});

it("A2/A18: a bearer off the funes_ shape, a malformed Authorization, or a legacy header alone is 401 with no DO call", async () => {
  const s = spied();
  for (const headers of [
    bearer("funes_short"), bearer(`funes_${"a".repeat(44)}`), bearer(`funes_${"a".repeat(42)}.`), bearer(`other_${"a".repeat(43)}`),
    { authorization: `Basic ${BOT}` }, { authorization: BOT },
    { "x-funes-capability": BOT }, { "x-twinkling-capability": BOT }, // no legacy header at the edge (ADR-0014)
  ] as Array<Record<string, string>>) {
    const r = await rpc("tools/call", HEALTH, headers, s.env);
    expect(r.status, JSON.stringify(headers)).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe("Bearer");
  }
  // a token in the query string is never read
  expect((await rpc("tools/call", HEALTH, {}, s.env, `${MCP}?access_token=${BOT}`)).status).toBe(401);
  expect(s.calls()).toBe(0);
});

it("A3: a wrong Host on /mcp is 421, with no DO call", async () => {
  const s = spied();
  expect((await rpc("tools/call", HEALTH, bearer(BOT), s.env, "https://elsewhere.example/mcp")).status).toBe(421);
  expect(s.calls()).toBe(0);
});

it("A5: Origin or Sec-Fetch-Site on /mcp is refused, a valid bearer notwithstanding, with no DO call", async () => {
  await provision();
  const s = spied();
  for (const h of [{ origin: `https://${HOST}` }, { origin: "null" }, { "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "none" }] as Array<Record<string, string>>) {
    expect((await rpc("tools/call", HEALTH, { ...bearer(BOT), ...h }, s.env)).status, JSON.stringify(h)).toBe(403);
  }
  expect(s.calls()).toBe(0);
});

it("A4: a valid token sent on http: is refused and revoked — its next https request is 401", async () => {
  await provision();
  const t = token("h");
  await grant(t, "agent:cleartext", "agent", "cleartext", { expires: inADay() });
  expect((await rpc("tools/call", HEALTH, bearer(t))).status).toBe(200);
  const http = await rpc("tools/call", HEALTH, bearer(t), env, `http://${HOST}/mcp`);
  expect(http.status).toBe(401);
  expect(http.headers.get("www-authenticate")).toBe("Bearer");
  expect((await rpc("tools/call", HEALTH, bearer(t))).status).toBe(401);
  await inTaste((state) => expect(state.storage.sql.exec("select revoked_at from grants where actor = 'agent:cleartext'").one().revoked_at).not.toBeNull());
  expect((await rpc("tools/call", HEALTH, bearer(BOT))).status).toBe(200); // only that token
  expect((await fetchWorker(`http://${HOST}/mcp`, { method: "POST" })).status).toBe(403); // no bearer: refused
});

it("A6: an unknown token, a revoked agent token and one past its 90 days are 401 on the next request", async () => {
  await provision();
  expect((await rpc("tools/call", HEALTH, bearer(token("u")))).status).toBe(401);
  const live = token("r");
  await grant(live, "agent:to-revoke", "agent", "to-revoke", { expires: inADay() });
  expect((await rpc("tools/call", HEALTH, bearer(live))).status).toBe(200);
  // /mint's revoke statement (mint.ts), as its POST runs it; test/mint.workerd.ts drives the POST itself
  await inTaste((state) => state.storage.sql.exec("update grants set revoked_at = ? where actor = ? and revoked_at is null", new Date().toISOString(), "agent:to-revoke"));
  expect((await rpc("tools/call", HEALTH, bearer(live))).status).toBe(401);
  const stale = token("s");
  const created = new Date(Date.now() - 91 * 86_400_000);
  await grant(stale, "agent:stale", "agent", "stale", { created: created.toISOString(), expires: new Date(created.getTime() + 90 * 86_400_000).toISOString() });
  expect((await rpc("tools/call", HEALTH, bearer(stale))).status).toBe(401);
});

it("A7: a grant whose stars do not name rainblow.ing/taste is 403 before the body is read", async () => {
  await provision();
  const t = token("x");
  await grant(t, "agent:elsewhere", "agent", "elsewhere", { stars: '["rainblow.ing/other"]', expires: inADay() });
  let read = false;
  // highWaterMark 0: pull runs only when someone reads
  const body = new ReadableStream({ pull(c) { read = true; c.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }))); c.close(); } }, { highWaterMark: 0 });
  const r = await fetchWorker(MCP, { method: "POST", headers: { "content-type": "application/json", ...bearer(t) }, body, duplex: "half" } as RequestInit);
  expect(r.status).toBe(403);
  expect(read).toBe(false);
});

it("A8: one malformed grant row makes every token 401 at /mcp", async () => {
  await provision();
  const bad = token("m");
  await inTaste((state) => state.storage.sql.exec("insert into grants(token_sha256, actor, role, stars, created_at, label) values (?, 'outbox@replica', 'bot', ?, ?, 'bot')",
    sha(bad), `["${TASTE}"]`, new Date().toISOString()));
  try {
    for (const t of [OUTBOX, BOT, bad]) expect((await rpc("tools/call", HEALTH, bearer(t))).status).toBe(401);
  } finally {
    await inTaste((state) => state.storage.sql.exec("update grants set revoked_at = ? where token_sha256 = ?", new Date().toISOString(), sha(bad)));
  }
  expect((await rpc("tools/call", HEALTH, bearer(BOT))).status).toBe(200);
});

it("tools/list names exactly the caller's preset ops", async () => {
  await provision();
  const names = async (t: string) => (body(await (await rpc("tools/list", {}, bearer(t))).text()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((x) => x.name).sort();
  expect(await names(OUTBOX)).toEqual(["health", "put_page"]);
  expect(await names(BOT)).toEqual(["forget", "health", "put_page", "recall_v2", "vault_page"]);
});

it("A10/A11/A19: ops outside the grant are refused with no write; forget hard:true is invalid; an agent reads but gets no bytes", async () => {
  await provision();
  const AGENT = token("a");
  await grant(AGENT, "agent:claude-code", "agent", "claude-code", { expires: inADay() });
  const [outbox, bot, agent] = [await client(OUTBOX), await client(BOT), await client(AGENT)];
  const path = "items/movies/ronin.md";
  const answer = async (c: Client, name: string, args: Record<string, unknown>) => json(await c.callTool({ name, arguments: args }));

  // A10: not-granted, naming the proposal id
  for (const [c, name, args] of [
    [outbox, "link", { from: "items/movies/heat", to: "items/movies/ronin" }],
    [outbox, "forget", { id: "items/movies/heat" }],
    [agent, "put_page", { path, content: "---\ntitle: Ronin\n---\nA car chase.\n" }],
  ] as const) {
    const id = ulid();
    expect(await answer(c, name, { ...args, proposalId: id }), name).toEqual({ proposalId: id, status: "refused", reason: "not-granted" });
  }
  // bot supersede: outside the host ceiling, refused at dispatch (A13 answers it before the grant)
  const sup = await bot.callTool({ name: "supersede", arguments: { id: "items/movies/heat", body: "x", proposalId: ulid() } });
  expect(sup.isError).toBe(true);
  expect(json(sup)).toMatchObject({ status: 400, error: "unknown operation: supersede" });
  // no write: the page the agent proposed is not in R2
  expect(JSON.stringify(await bot.callTool({ name: "vault_page", arguments: { path } }))).not.toContain("A car chase.");

  // A11
  const id = ulid();
  expect(await answer(bot, "forget", { id: "items/movies/heat", hard: true, proposalId: id })).toMatchObject({ proposalId: id, status: "refused", reason: "invalid" });

  // A19: the agent's reads are served; the byte read is not granted
  for (const [name, args] of [["recall_v2", { query: "Heat" }], ["indexed_page", { id: "items/movies/heat" }], ["health", {}]] as const) {
    const r = await agent.callTool({ name, arguments: args });
    expect(r.isError, `${name} ${JSON.stringify(r)}`).toBeFalsy();
  }
  const bytes = await agent.callTool({ name: "vault_page", arguments: { path: "items/movies/heat.md" } });
  expect(bytes.isError).toBe(true);
  expect(json(bytes)).toMatchObject({ status: 403, code: "FUNES_NOT_GRANTED" });
  for (const c of [outbox, bot, agent]) await c.close();
});

const POST_JSON = { "content-type": "application/json", accept: "application/json, text/event-stream" };

it("the 1 MiB cap: a body over it is 413, declared or streamed", async () => {
  await provision();
  const over = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(1024 * 1024) } });
  expect((await fetchWorker(MCP, { method: "POST", headers: { ...POST_JSON, ...bearer(BOT) }, body: over })).status).toBe(413);
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(over)); c.close(); } });
  expect((await fetchWorker(MCP, { method: "POST", headers: { ...POST_JSON, ...bearer(BOT) }, body: stream, duplex: "half" } as RequestInit)).status).toBe(413);
});

it("A5: no /mcp response carries a CORS header — refusals, a preflight, served calls, the cap", async () => {
  await provision();
  const responses = [
    await rpc("tools/list", {}),
    await rpc("tools/list", {}, bearer("funes_short")),
    await rpc("tools/list", {}, { ...bearer(BOT), origin: "https://evil.example" }),
    await rpc("tools/list", {}, bearer(BOT), env, "https://elsewhere.example/mcp"),
    await rpc("tools/list", {}, bearer(token("u")), env, `http://${HOST}/mcp`),
    await fetchWorker(MCP, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } }),
    await fetchWorker(MCP, { method: "GET", headers: bearer(BOT) }),
    await rpc("tools/list", {}, bearer(BOT)),
    await rpc("tools/call", HEALTH, bearer(BOT)),
    await rpc("tools/call", { name: "page", arguments: {} }, bearer(BOT)),
    await fetchWorker(MCP, { method: "POST", headers: { ...POST_JSON, ...bearer(BOT) }, body: "x".repeat(1024 * 1024 + 1) }),
  ];
  expect(responses.map((r) => r.status)).toEqual([401, 401, 403, 421, 401, 403, 405, 200, 200, 200, 413]);
  for (const r of responses) expect([...r.headers.keys()].filter((k) => k.startsWith("access-control-")), String(r.status)).toEqual([]);
});

it("a served read writes no console line (the SDK's own warnings included)", async () => {
  await provision();
  const lines: string[] = [];
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" "))));
  try {
    expect((await rpc("tools/list", {}, bearer(BOT))).status).toBe(200);
    expect((await rpc("tools/call", HEALTH, bearer(BOT))).status).toBe(200);
  } finally {
    for (const s of spies) s.mockRestore();
  }
  expect(lines).toEqual([]);
});

it("a throw inside /mcp answers 500 and logs {event, name, code} only (record 35 L9)", async () => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
  const boom = () => { throw Object.assign(new TypeError(`SENTINEL ${BOT}`), { code: "E_TEST_CODE", cause: "SENTINEL" }); };
  const throwing = { ...env, TASTE: { getByName: () => ({ authorize: async () => boom() }) } } as unknown as WorkerEnv;
  try {
    const r = await rpc("tools/call", HEALTH, bearer(BOT), throwing, `${MCP}?q=SENTINEL`);
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain("SENTINEL");
  } finally {
    spy.mockRestore();
  }
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toEqual({ event: "entry-error", name: "TypeError", code: "E_TEST_CODE" });
  expect(lines[0]).not.toContain("SENTINEL");
  expect(lines[0]).not.toContain("funes_");
});
