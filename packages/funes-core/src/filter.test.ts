import { test, expect } from "bun:test";
import { matchesFilter, type RecallFilter } from "./filter.ts";

// ADR-0013: the one membership decision. A filter is an AND of terms; each term is an OR of
// clauses (a declared key is a one-clause term; a predicate keeps its OR of ANDs), optionally negated.
const taste: RecallFilter = {
  all: [{ any: [{ suggested: { ne: true }, domain: { exists: true } }, { my_score: { exists: true } }] }],
};

test("matchesFilter: taste(page) — an item that is not suggested, or is scored", () => {
  expect(matchesFilter({ domain: "movies" }, taste)).toBe(true);
  expect(matchesFilter({ domain: "movies", suggested: true }, taste)).toBe(false);
  expect(matchesFilter({ domain: "movies", suggested: true, my_score: 8 }, taste)).toBe(true);
  expect(matchesFilter({ title: "a remembered note" }, taste)).toBe(false); // no domain
});

test("matchesFilter: a negated term, strict equality without coercion, ANDed terms", () => {
  const notTaste: RecallFilter = { all: [{ ...taste.all[0]!, not: true }] };
  expect(matchesFilter({ domain: "movies", suggested: true }, notTaste)).toBe(true);
  expect(matchesFilter({ domain: "movies" }, notTaste)).toBe(false);
  const both: RecallFilter = { all: [{ any: [{ domain: "movies" }] }, { any: [{ year: 1999 }] }] };
  expect(matchesFilter({ domain: "movies", year: 1999 }, both)).toBe(true);
  expect(matchesFilter({ domain: "movies", year: "1999" }, both)).toBe(false);
  expect(matchesFilter({ domain: "books", year: 1999 }, both)).toBe(false);
});

test("matchesFilter: a null row matches nothing, not even a negation (fail-closed)", () => {
  expect(matchesFilter(null, { all: [{ any: [{ domain: { exists: false } }], not: false }] })).toBe(false);
  expect(matchesFilter(undefined, { all: [{ any: [{ domain: "x" }], not: true }] })).toBe(false);
});

test("matchesFilter: own properties only — a prototype name is never present", () => {
  expect(matchesFilter({}, { all: [{ any: [{ constructor: { exists: true } }] }] })).toBe(false);
  expect(matchesFilter({}, { all: [{ any: [{ toString: { ne: 1 } }] }] })).toBe(true);
});
