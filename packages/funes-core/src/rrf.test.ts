import { test, expect } from "bun:test";
import { rrf, rrfScores } from "./rrf.ts";

test("rrf: an id in multiple lists outranks single-list ids", () => {
  const out = rrf([["x", "y", "z"], ["y", "w"]]);
  expect(out[0]).toBe("y");          // in both lists
  expect(out).toContain("x");
  expect(out).toContain("w");
});

test("rrf: higher rank beats lower rank", () => {
  const out = rrf([["a", "b"]]);
  expect(out).toEqual(["a", "b"]);
});

test("rrf: empty -> empty", () => {
  expect(rrf([])).toEqual([]);
  expect(rrf([[], []])).toEqual([]);
});

test("rrfScores: score is a positive number, monotonic with rank", () => {
  const s = rrfScores([["a", "b", "c"]]);
  expect(s.get("a")!).toBeGreaterThan(s.get("b")!);
  expect(s.get("c")!).toBeGreaterThan(0);
});
