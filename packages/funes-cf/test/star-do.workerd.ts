// RAI-316 (ADR-0024): the edge is addressed by star key. The entry's key gate, StarDO's lazy R2 config
// and its proof, the unproven-object rule, and two stars in one bucket, driven through the Worker's
// own fetch and the namespace under local workerd.
import { createExecutionContext, env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { grantRow } from "funes-core/internal";
import worker from "../src/index.ts";
import { proveStar, type StarDO } from "../src/star-do.ts";
import type { Reply } from "../src/writer.ts";
import { FIXTURE_KEY, FIXTURE_YAML, seedStar, starYaml } from "./fixture-star.ts";

type WorkerEnv = Parameters<typeof worker.fetch>[1];
const HOST = env.FUNES_HOST;
const fetchWorker = (url: string, init?: RequestInit, e: WorkerEnv = env) =>
  worker.fetch(new Request(url, init) as Parameters<typeof worker.fetch>[0], e, createExecutionContext());
const SHAPED = `funes_${"k".repeat(43)}`;
/** A key no other test uses (a whole UUID would pass the 47-byte cap). */
const fresh = () => `example.org/${crypto.randomUUID().slice(0, 13)}`;
const health = (url: string, e?: WorkerEnv) => fetchWorker(url, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${SHAPED}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "health", arguments: {} } }),
}, e);

/** env with the STAR namespace counted: a refusal at the entry makes no DO call. */
function spied(): { env: WorkerEnv; calls: () => number } {
  let n = 0;
  const STAR = { getByName: (name: string) => { n++; return env.STAR.getByName(name); } };
  return { env: { ...env, STAR } as unknown as WorkerEnv, calls: () => n };
}

/** The object's own tables (workerd's `_cf_` ones aside) and its alarm. */
const footprint = (key: string) => runInDurableObject(env.STAR.getByName(key), async (_o, state) => ({
  tables: state.storage.sql.exec<{ name: string }>("select name from sqlite_master where type = 'table' and name not like '\\_cf\\_%' escape '\\'").toArray().map((r) => r.name),
  alarm: await state.storage.getAlarm(),
}));

describe("the entry's key gate", () => {
  it("refuses 404 unknown-star, with no DO call, a key that is not exactly canonical or is over 47 bytes", async () => {
    const at47 = `example.org/${"k".repeat(47 - "example.org/".length)}`;
    expect(new TextEncoder().encode(at47).length).toBe(47);
    const s = spied();
    for (const key of [`${at47}k`, "Example.org/fixture", "example.org/fixture/", "example.org/Fixture", "example.org", "example.org/a/b/c/d/e", "example.org/%61"]) {
      const r = await health(`https://${HOST}/mcp/${key}`, s.env);
      expect(r.status, key).toBe(404);
      expect(await r.json(), key).toMatchObject({ error: "unknown-star" });
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
    for (const path of ["/mcp", "/mcp/", "/mint", "/elsewhere/example.org/fixture"]) expect((await health(`https://${HOST}${path}`, s.env)).status, path).toBe(404);
    expect(s.calls()).toBe(0);
    expect(proveStar(starYaml(`${at47}k`), "funes-taste", `${at47}k`)).toMatchObject({ refused: expect.stringMatching(/47 bytes/) });
  });
});

describe("the proof", () => {
  it("proves the config under FUNES_LOCUS and its own key", () => {
    expect(proveStar(FIXTURE_YAML, "funes-taste", FIXTURE_KEY)).toMatchObject({ locus: "funes-taste" });
    expect(proveStar(FIXTURE_YAML, " Funes-Taste", FIXTURE_KEY)).toMatchObject({ locus: "funes-taste" }); // ADR-0005's normalization
  });

  it("refuses another locus, another key, and a config the edge cannot serve", () => {
    for (const [why, text, locus, key] of [
      ["another locus", FIXTURE_YAML, "funes-other", FIXTURE_KEY],
      ["no FUNES_LOCUS", FIXTURE_YAML, undefined, FIXTURE_KEY],
      ["a refused locus name", FIXTURE_YAML, "funes taste", FIXTURE_KEY],
      ["a config put under another key's prefix", FIXTURE_YAML, "funes-taste", "example.org/other"],
      ["no write_locus", FIXTURE_YAML.replace(/^\s*write_locus:.*$/m, ""), "funes-taste", FIXTURE_KEY],
      ["no meta.id", FIXTURE_YAML.replace(/^\s*id:.*$/m, ""), "funes-taste", FIXTURE_KEY],
      ["not YAML", "meta: [", "funes-taste", FIXTURE_KEY],
      ["an invalid recall declaration", FIXTURE_YAML.replace("collapse: [type, creator]", "collapse: 7"), "funes-taste", FIXTURE_KEY],
      ["no memory_dir", FIXTURE_YAML.replace(/^\s*memory_dir:.*$/m, ""), "funes-taste", FIXTURE_KEY],
      ["no item_pages", FIXTURE_YAML.replace(/^\s*item_pages:.*$/m, ""), "funes-taste", FIXTURE_KEY],
      ["a malformed mint allowlist", starYaml(FIXTURE_KEY, { mintIds: "[vlad]" }), "funes-taste", FIXTURE_KEY],
    ] as const) expect(proveStar(text, locus, key), why).toHaveProperty("refused");
  });
});

describe("the unproven-object rule", () => {
  it("an unknown key's object refuses /mcp and /mint, and keeps empty storage and no alarm", async () => {
    const key = fresh();
    const r = await health(`https://${HOST}/mcp/${key}`);
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: "unknown-star" });
    expect((await fetchWorker(`https://${HOST}/mint/${key}?id=1&hash=${"0".repeat(64)}`)).status).toBe(404);
    expect((await fetchWorker(`http://${HOST}/mcp/${key}`, { method: "POST", headers: { authorization: `Bearer ${SHAPED}` } })).status).toBe(401);
    const stub = env.STAR.getByName(key) as DurableObjectStub<StarDO>;
    expect(await stub.call(SHAPED, "health", {})).toMatchObject({ status: 404 });
    expect(await footprint(key)).toEqual({ tables: [], alarm: null });
  });

  it("a config put after the object woke serves at the next request: a refusal is never memoized", async () => {
    const key = fresh();
    expect((await health(`https://${HOST}/mcp/${key}`)).status).toBe(404);
    await seedStar(env.VAULT, key);
    expect((await health(`https://${HOST}/mcp/${key}`)).status).toBe(401); // proven: the unknown token is the refusal now
  });

  it("an R2 error answers 503 and is retried at the next request, never cached", async () => {
    const key = fresh();
    await seedStar(env.VAULT, key);
    const answers = await runInDurableObject(env.STAR.getByName(key), async (o: StarDO) => {
      let failed = 0;
      const flaky = { get: async (k: string) => (failed++ === 0 ? Promise.reject(new Error("R2 get: internal error (10001)")) : env.VAULT.get(k)) };
      (o as unknown as { env: object }).env = { ...env, VAULT: new Proxy(env.VAULT, { get: (t, p) => (p === "get" ? flaky.get : Reflect.get(t, p).bind(t)) }) };
      return [await o.authorize(SHAPED), await o.authorize(SHAPED)];
    });
    expect(answers[0]).toMatchObject({ status: 503, error: "unavailable" });
    expect(answers[1]).toMatchObject({ status: 401, error: "unauthorized" });
  });
});

describe("the alarm", () => {
  it("knows its key from ctx.id.name in a fresh instance, and runs the bootstrap build", async () => {
    const key = fresh();
    await seedStar(env.VAULT, key);
    await env.VAULT.put(`${key}/_/items/movies/heat.md`, "---\ntitle: Heat\ntype: Film\ndomain: movies\n---\nA crime film.\n");
    const stub = env.STAR.getByName(key) as DurableObjectStub<StarDO>;
    // an alarm left by an evicted instance: no request has loaded this object's config
    await runInDurableObject(stub, (_o, state) => state.storage.setAlarm(Date.now() + 3_600_000));
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    while (await runDurableObjectAlarm(stub)); // the batches the build re-arms
    const meta = await runInDurableObject(stub, (_o, state) =>
      Object.fromEntries(state.storage.sql.exec<{ key: string; value: string }>("select key, value from meta where key in ('owner_star_id', 'generation')").toArray().map((r) => [r.key, r.value])));
    expect(meta).toMatchObject({ owner_star_id: key, generation: expect.stringMatching(/^v3:/) });
  });

  it("a proven wake with work due arms the alarm; one with none arms nothing", async () => {
    const key = fresh();
    await seedStar(env.VAULT, key);
    const stub = env.STAR.getByName(key) as DurableObjectStub<StarDO>;
    let armed: number | null = null;
    await runInDurableObject(stub, async (o: StarDO, state) => {
      await o.authorize(SHAPED); // no live slot: the bootstrap build is due
      armed = await state.storage.getAlarm();
    });
    expect(armed).not.toBeNull();
    while (await runDurableObjectAlarm(stub));
    await evictDurableObject(stub);
    expect(await stub.authorize(SHAPED)).toMatchObject({ status: 401 });
    expect((await footprint(key)).alarm).toBeNull();
  });
});

describe("two stars in one bucket", () => {
  it("a.b/x and a.b/x/y stay disjoint: each object serves only its own pages", async () => {
    const run = crypto.randomUUID().slice(0, 8);
    const [x, y] = [`a.b/x${run}`, `a.b/x${run}/y`];
    const page = (t: string) => `---\ntitle: ${t}\ntype: Film\ndomain: movies\n---\nAbout ${t}.\n`;
    for (const [key, name] of [[x, "one"], [y, "two"]] as const) {
      await seedStar(env.VAULT, key);
      await env.VAULT.put(`${key}/_/items/movies/${name}.md`, page(name));
    }
    const ids: Record<string, string[]> = {};
    for (const key of [x, y]) {
      const stub = env.STAR.getByName(key) as DurableObjectStub<StarDO>;
      const agent = grantRow({ role: "agent", label: "reader", stars: [key] });
      await stub.authorize(SHAPED); // the wake arms the bootstrap build
      await runInDurableObject(stub, (_o, state) => state.storage.transactionSync(() => { for (const s of agent.sql) state.storage.sql.exec(s); }));
      while (await runDurableObjectAlarm(stub));
      const r = (await stub.call(agent.token, "recall", { query: "About", k: 10 })) as unknown as Reply; // the RPC type wraps body: unknown
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      ids[key] = (r.body as { results: Array<{ id: string }> }).results.map((h) => h.id);
      // the grant names this star only: the other object refuses it
      const other = env.STAR.getByName(key === x ? y : x) as DurableObjectStub<StarDO>;
      expect(await other.authorize(agent.token)).toMatchObject({ status: 401 });
    }
    expect(ids).toEqual({ [x]: ["items/movies/one"], [y]: ["items/movies/two"] });
  });
});

it("a minted bot row and the edge row checks agree inside a star's own object (funes token mint --edge's statements)", async () => {
  await seedStar(env.VAULT);
  const m = grantRow({ role: "bot", label: "helper", stars: [FIXTURE_KEY] });
  expect(m.row.actor).toBe("bot:helper");
  const stub = env.STAR.getByName(FIXTURE_KEY) as DurableObjectStub<StarDO>;
  await stub.authorize(SHAPED);
  await runInDurableObject(stub, (_o, state) => state.storage.transactionSync(() => { for (const s of m.sql) state.storage.sql.exec(s); }));
  expect(await stub.authorize(m.token)).toMatchObject({ actor: "bot:helper", stars: [FIXTURE_KEY] });
});
