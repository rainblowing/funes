// PLAN-0.5.0 item 33: funes-taste under local workerd, bound by wrangler.test.jsonc.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import STAR_YAML from "../src/star.yaml?raw";
import { proveLocus } from "../src/taste-do.ts";
import worker from "../src/index.ts";

it("the taste DO is SQLite-backed (the v1 migration took)", async () => {
  const stub = env.TASTE.getByName("rainblow.ing/taste");
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

// PLAN-0.5.0 item 35 (record 24 §1): the DO serves only as the taste star's write locus.
describe("the locus proof", () => {
  const taste = (key: string) => key === "rainblow.ing/taste";

  it("proves the bundled star.yaml under FUNES_LOCUS funes-taste and the star's own object", () => {
    expect(proveLocus(STAR_YAML, "funes-taste", taste)).toEqual({ locus: "funes-taste" });
    expect(proveLocus(STAR_YAML, " Funes-Taste", taste)).toEqual({ locus: "funes-taste" }); // ADR-0005's normalization
  });

  it("refuses another locus, no locus, another object, and a star.yaml that does not validate", () => {
    for (const [why, got] of [
      ["another locus", proveLocus(STAR_YAML, "funes-other", taste)],
      ["no FUNES_LOCUS", proveLocus(STAR_YAML, undefined, taste)],
      ["a refused locus name", proveLocus(STAR_YAML, "funes taste", taste)],
      ["another object", proveLocus(STAR_YAML, "funes-taste", () => false)],
      ["no write_locus", proveLocus(STAR_YAML.replace(/^\s*write_locus:.*$/m, ""), "funes-taste", taste)],
      ["no meta.id", proveLocus(STAR_YAML.replace(/^\s*id:.*$/m, ""), "funes-taste", taste)],
      ["not YAML", proveLocus("meta: [", "funes-taste", taste)],
      ["an invalid recall declaration", proveLocus(STAR_YAML.replace("collapse: [type, creator]", "collapse: 7"), "funes-taste", taste)],
    ] as const) expect(got, why).toHaveProperty("refused");
  });

  it("an object of the class under any other name never serves", async () => {
    const refused = await runInDurableObject(env.TASTE.getByName(crypto.randomUUID()), (o) => o.call(null, "health", {}).then(() => "served", (e: Error) => e.message));
    expect(refused).toMatch(/does not serve — this object is not idFromName/);
  });

  it("the taste star's own object serves: a call without a grant is 401", async () => {
    expect(await env.TASTE.getByName("rainblow.ing/taste").call(null, "put_page", {})).toEqual({ status: 401, body: { error: "unauthorized" } });
  });
});
