// PLAN-0.5.0 item 33: funes-taste under local workerd, bound by wrangler.test.jsonc. The proof and
// the key gate are test/star-do.workerd.ts's.
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.ts";

it("StarDO is SQLite-backed (the v1 migration took)", async () => {
  const stub = env.STAR.getByName(crypto.randomUUID());
  const one = await runInDurableObject(stub, (_o, state) => state.storage.sql.exec("SELECT 1 AS one").one().one);
  expect(one).toBe(1);
});

it("the entry exports a plain fetch handler and nothing else", async () => {
  expect(Object.keys(worker)).toEqual(["fetch"]);
});

it("env.AI is the fake: one 1024-dim vector per text", async () => {
  const out = await env.AI.run("@cf/baai/bge-m3", { text: ["a", "bb"] });
  expect(out).toMatchObject({ shape: [2, 1024] });
});

it("OpenRouter answers from the stub, and no other host is reached", async () => {
  expect(await (await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST" })).json()).toMatchObject({ stub: "openrouter" });
  expect((await fetch("https://example.com/")).status).toBe(599);
});
