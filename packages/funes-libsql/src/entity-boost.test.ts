// Entity boost (stack review B-1 follow-up): an exact-name query surfaces the page NAMED that
// over artifacts that merely mention the name. Unit-pins the high-precision trigger + one
// integration proving the named page wins its own name.
import { test, expect } from "bun:test";
import { LibsqlStore } from "./store.ts";
import { entityAdjust, ENTITY_BOOST } from "./ranking.ts";
import type { Embedder } from "funes-core";

const fakeEmbedder: Embedder = {
  dim: 8,
  async embedQuery() { return new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]); },
  async embedPassage() { return new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]); },
  async embedPassages(texts) { return texts.map(() => new Float32Array([1, 0, 0, 0, 0, 0, 0, 0])); },
};

test("entityAdjust: fires ONLY on whole-query title/stem equality", () => {
  // title match (case-insensitive)
  expect(entityAdjust(1, "ada", "Ada", "people/ada")).toBe(ENTITY_BOOST);
  // stem match when the title is fuller than the query
  expect(entityAdjust(1, "ada", "Ada Lorenz", "people/ada")).toBe(ENTITY_BOOST);
  // multi-word exact title
  expect(entityAdjust(1, "orbital garden", "Orbital Garden", "projects/orbital-garden")).toBe(ENTITY_BOOST);
  // cyrillic
  expect(entityAdjust(1, "ада", "Ада", "people/ada-ru")).toBe(ENTITY_BOOST);
  // NOT a name query — untouched
  expect(entityAdjust(1, "what ada said about orbital garden", "Ada", "people/ada")).toBe(1);
  // mention-only artifact — its stem is not the query
  expect(entityAdjust(1, "ada", "chat with ada", "out/out_distill/telegram/ada-100000001")).toBe(1);
  // empty query — untouched
  expect(entityAdjust(1, "  ", "Ada", "people/ada")).toBe(1);
});

test("integration: the entity page wins its own name over a mention-heavy distill artifact", async () => {
  const s = await LibsqlStore.create(fakeEmbedder, ":memory:");
  await s.remember([
    { id: "people/ada", title: "Ada", type: "entity", body: "Ada — distributed systems engineer.", trust: "untrusted" },
    // FTS-dominant mention farm: bm25 loves it; the boost must still put the entity page first
    { id: "out/out_distill/telegram/chat-77", title: "chat about ada", type: "source-summary", body: "ada said ada did ada will ada again ada ada", trust: "untrusted" },
  ]);
  const res = await s.recall({ query: "ada", k: 3 });
  expect(res[0]!.id).toBe("people/ada");
  await s.close();
});
