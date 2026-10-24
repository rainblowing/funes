// PLAN-0.5.0 item 15: the one post-arm ranking pipeline every backend (libSQL, Postgres, funes-cf)
// runs over its fused rows. The full order is pinned by the recall goldens; this pins what is new
// in it — collapse with the star's declared keys (ADR-0015).
import { test, expect } from "bun:test";
import type { RecallResult } from "funes-core/internal";
import { rankRecall } from "./ranking.ts";

const page = (id: string, score: number, frontmatter?: RecallResult["frontmatter"]): RecallResult =>
  ({ id, path: `notes/${id}.md`, title: "Stalker", trust: "trusted", score, frontmatter });
const ids = (rs: RecallResult[]) => rs.map((r) => [r.id, r.duplicates ?? 0]);
const noMeta = () => undefined;

test("collapse keys on trust, zone and title alone when no keys are declared", () => {
  const rows = () => [page("film", 0.3, { type: "film" }), page("book", 0.2, { type: "book" })];
  expect(ids(rankRecall(rows(), { query: "stalker" }, noMeta))).toEqual([["film", 1]]);
  expect(ids(rankRecall(rows(), { query: "stalker", collapse: [] }, noMeta))).toEqual([["film", 1]]);
});

test("a declared collapse key splits same-title pages whose values differ, and folds those whose values match", () => {
  const rows = [
    page("film", 0.3, { type: "film", creator: "Tarkovsky" }),
    page("book", 0.2, { type: "book", creator: "Strugatsky" }),
    page("film-2", 0.1, { type: "film", creator: "Tarkovsky" }),
    page("bare", 0.05),
  ];
  expect(ids(rankRecall(rows, { query: "roadside", collapse: ["type", "creator"] }, noMeta)))
    .toEqual([["film", 1], ["book", 0], ["bare", 0]]);
});

test("a declared value's JSON type is part of the identity, and an absent key is not a match for a present one", () => {
  const rows = [page("a", 0.3, { year: 1979 }), page("b", 0.2, { year: "1979" }), page("c", 0.1, {})];
  expect(ids(rankRecall(rows, { query: "q", collapse: ["year"] }, noMeta))).toEqual([["a", 0], ["b", 0], ["c", 0]]);
});
