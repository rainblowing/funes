// H5 golden for libSQL — a faithful MIRROR of funes-engine/src/recall-golden.test.ts (same FROZEN
// GoldenEmbedder + corpus + queries) run through LibsqlStore. Pins libSQL's full recall pipeline and,
// by diffing this fixture against the pglite one, makes the backend's ranking change reviewable.
//   REGEN_GOLDEN=1 bun test packages/funes-engine/src/libsql/recall-golden.test.ts
import { test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GoldenEmbedder, goldenCorpus, goldenOf, K, type Golden } from "../../../funes-core/src/__fixtures__/index-golden.ts";
import { LibsqlStore } from "./store.ts";

const GOLDEN_CORPUS = goldenCorpus();

const FIXTURE = fileURLToPath(new URL("../../../funes-core/src/__fixtures__/recall-golden.json", import.meta.url));

async function computeGolden(): Promise<Golden> {
  const s = await LibsqlStore.create(new GoldenEmbedder());
  await s.remember(GOLDEN_CORPUS);
  const got = await goldenOf((q) => s.recall(q), (await s.stats()).embeddingSignature);
  await s.close();
  return got;
}

test("H5 golden (libsql): full recall output (order, 4dp scores, trust) matches the pinned fixture", async () => {
  const got = await computeGolden();
  if (process.env.REGEN_GOLDEN === "1" || !existsSync(FIXTURE)) writeFileSync(FIXTURE, JSON.stringify(got, null, 2) + "\n");
  const want = JSON.parse(readFileSync(FIXTURE, "utf8")) as Golden;
  expect(got).toEqual(want);

  // P3.15 anti-vacuity guard. The long-document row exists to prove the CHUNKED arm finds a needle
  // buried ~4.8k chars into a body; its query tokens appear nowhere else in the corpus, and
  // deliberately NOT in its own title — a title hit would satisfy bm25 (title weight 10) without the
  // chunk arm doing anything, and the golden would still be "green" while proving nothing. If a
  // future corpus edit breaks that isolation, this fails loudly instead of silently going hollow.
  expect(got.queries["harbor tonnage rebate clause"]!.map((r) => r[0])).toContain("in_chat_export/harbor-terms");
});

test("H5 golden (libsql): edge-walk — catamaran reachable for a sailing query", async () => {
  const s = await LibsqlStore.create(new GoldenEmbedder());
  await s.remember(GOLDEN_CORPUS);
  expect((await s.recall({ query: "sailing regatta wind", k: K })).map((r) => r.id)).toContain("catamaran");
  await s.close();
});

test("H5 golden (libsql): dangling edge target never starves results below k", async () => {
  const s = await LibsqlStore.create(new GoldenEmbedder());
  await s.remember(GOLDEN_CORPUS);
  const res = await s.recall({ query: "ton roadmap milestone", k: K });
  expect(res.length).toBe(K);
  expect(res.map((r) => r.id)).not.toContain("ghost-page");
  await s.close();
});

test("H5 golden (libsql): a query matching nothing in FTS still returns k results (vector arm)", async () => {
  const s = await LibsqlStore.create(new GoldenEmbedder());
  await s.remember(GOLDEN_CORPUS);
  expect((await s.recall({ query: "zebra xylophone quasar", k: K })).length).toBe(K);
  await s.close();
});
