// B5 (RAI-337; RAI-310 D4, D8a; ADR-0014 and ADR-0021 as amended): the one HTTP MCP handler, through
// its interface — a web Request in, a Response out — over a fake host. The check order: Host 421,
// browser origin 403, Bearer 401, star 403, method 405, byte cap 413, parse 400, then dispatch.
import { expect, test } from "bun:test";
import { mcpHandler, type McpHost } from "funes-core/mcp-http";
import type { Grant } from "funes-core";
import type { Refusal } from "funes-core";

const HOST = "funes.test:8787";
const URL_ = `http://${HOST}/mcp`;
const GOOD = "funes_good";
const OTHER_STAR = "funes_elsewhere";

function fakeHost(over: Partial<McpHost> = {}) {
  const seen = { grants: 0, calls: [] as Array<{ name: string; token: string | null; actor: string }> };
  const host: McpHost = {
    tier: "home",
    host: HOST,
    async grant(token): Promise<Grant | Refusal> {
      seen.grants++;
      if (token === GOOD) return { actor: "alice", ops: new Set(["recall", "health"]), stars: ["*"] };
      if (token === OTHER_STAR) return { status: 403, error: "not-granted", message: 'actor "eve" holds no grant for star "x"' };
      return { status: 401, error: "unauthorized", message: "unknown credential: send Authorization: Bearer <token>" };
    },
    async call(name, args, auth) {
      seen.calls.push({ name, token: auth.token, actor: auth.grant.actor });
      if (name === "health") throw Object.assign(new Error("operation health: not granted"), { code: "not-granted" });
      return { echo: args };
    },
    ...over,
  };
  return { serve: mcpHandler(host), seen };
}

const rpc = (method: string, params: unknown, headers: Record<string, string> = {}, init: RequestInit = {}, url = URL_) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    ...init,
  });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const peer = { loopback: true };
const reply = async (r: Response) => {
  const text = await r.text();
  return JSON.parse(text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data: "))!.slice(6) : text);
};

test("each refusal comes before the next check, in the one order", async () => {
  const { serve, seen } = fakeHost();
  const cases: Array<[Request, number, string]> = [
    [rpc("tools/list", {}, { ...bearer(GOOD), origin: "https://evil.example" }, {}, "http://elsewhere:8787/mcp"), 421, "host"],
    [rpc("tools/list", {}, { origin: "https://evil.example" }), 403, "browser-origin"],
    [rpc("tools/list", {}, { "sec-fetch-site": "none" }), 403, "browser-origin"],
    [rpc("tools/list", {}), 401, "unauthorized"],
    [rpc("tools/list", {}, { authorization: "Basic abc" }), 401, "unauthorized"],
    [rpc("tools/list", {}, { "x-twinkling-capability": GOOD }), 401, "unauthorized"], // a legacy header alone is no token
    [rpc("tools/list", {}, bearer("funes_nobody")), 401, "unauthorized"],
    [rpc("tools/list", {}, bearer(OTHER_STAR)), 403, "not-granted"],
    [new Request(URL_, { method: "GET", headers: bearer(GOOD) }), 405, "method"],
    [rpc("tools/list", {}, bearer(GOOD), { body: JSON.stringify({ pad: "x".repeat(1024 * 1024) }) }), 413, "too-large"],
    [rpc("tools/list", {}, bearer(GOOD), { body: "{not json" }), 400, "invalid"],
  ];
  for (const [req, status, error] of cases) {
    const r = await serve(req, peer);
    expect(r.status, error).toBe(status);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-type")).toBe("application/json");
    const b = (await r.json()) as { error: string; message: string };
    expect(b.error).toBe(error);
    expect(typeof b.message).toBe("string");
    if (status === 401) {
      expect(r.headers.get("www-authenticate")).toBe("Bearer");
      expect(b.message).toContain("Authorization: Bearer");
    }
    expect([...r.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
  }
  expect(seen.calls).toEqual([]);
});

test("Host, origin and a missing token answer before the host is asked for a grant", async () => {
  const { serve, seen } = fakeHost();
  await serve(rpc("tools/list", {}, bearer(GOOD), {}, "http://elsewhere/mcp"), peer);
  await serve(rpc("tools/list", {}, { ...bearer(GOOD), origin: "null" }), peer);
  await serve(rpc("tools/list", {}, { authorization: "Bearer bad token" }), peer);
  expect(seen.grants).toBe(0);
});

test("a grant refusal comes before the body is read; a streamed body over the cap is 413", async () => {
  const { serve } = fakeHost();
  let read = false;
  const body = new ReadableStream({ pull(c) { read = true; c.enqueue(new TextEncoder().encode("{}")); c.close(); } }, { highWaterMark: 0 });
  expect((await serve(new Request(URL_, { method: "POST", headers: bearer(OTHER_STAR), body, duplex: "half" } as RequestInit), peer)).status).toBe(403);
  expect(read).toBe(false);
  const over = new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", pad: "x".repeat(2048) }));
  const stream = new ReadableStream({ start(c) { c.enqueue(over); c.close(); } });
  const small = mcpHandler({ tier: "home", host: HOST, maxBodyBytes: 1024, grant: async () => ({ actor: "a", ops: new Set(["recall"]), stars: ["*"] }), call: async () => ({}) });
  expect((await small(new Request(URL_, { method: "POST", headers: bearer(GOOD), body: stream, duplex: "half" } as RequestInit), peer)).status).toBe(413);
});

test("tools/list names the grant's ops; tools/call passes the token and the grant; a tool error has the edge shape", async () => {
  const { serve, seen } = fakeHost();
  const list = await reply(await serve(rpc("tools/list", {}, bearer(GOOD)), peer));
  expect(list.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["health", "recall"]);
  const ok = await reply(await serve(rpc("tools/call", { name: "recall", arguments: { query: "q" } }, bearer(GOOD)), peer));
  expect(JSON.parse(ok.result.content[0].text)).toEqual({ echo: { query: "q" } });
  expect(seen.calls[0]).toEqual({ name: "recall", token: GOOD, actor: "alice" });
  const bad = await reply(await serve(rpc("tools/call", { name: "health", arguments: {} }, bearer(GOOD)), peer));
  expect(bad.result.isError).toBe(true);
  expect(JSON.parse(bad.result.content[0].text)).toEqual({ status: 403, code: "not-granted", error: "operation health: not granted" });
});

test("a legacy header beside a valid Bearer is ignored", async () => {
  const { serve } = fakeHost();
  const r = await serve(rpc("tools/list", {}, { ...bearer(GOOD), "x-twinkling-capability": "other" }), peer);
  expect(r.status).toBe(200);
});
