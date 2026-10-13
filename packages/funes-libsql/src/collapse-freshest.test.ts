import { test, expect } from "bun:test";
import { collapseDuplicates } from "./ranking.ts";

// Near-duplicate collapse folds twins sharing (trust, zone, normalized title) into the best-scoring
// slot. For a VOLATILE claim that is wrong: the whole point of the state/event split is that a later
// statement replaces an earlier one, so keeping the higher-scoring twin could hide the current value
// behind the outdated one — the exact staleness failure supersession exists to prevent, produced by
// the mechanism meant to tidy the results.
type Hit = { id: string; title: string; path?: string; trust?: "trusted" | "untrusted";
             duplicates?: number; volatile?: boolean; freshness?: string };
const hit = (o: Partial<Hit> & { id: string }): Hit =>
  ({ title: "Northwind retainer", path: `wiki/${o.id}.md`, trust: "trusted", ...o });

test("between two volatile twins the FRESHER one takes the slot", () => {
  // stale scores higher, so it arrives first — this is the case that used to lose.
  const out = collapseDuplicates([
    hit({ id: "stale", volatile: true, freshness: "2026-01-01" }),
    hit({ id: "current", volatile: true, freshness: "2026-08-01" }),
  ], () => 1);
  expect(out.map((h) => h.id)).toEqual(["current"]);
  expect(out[0]!.duplicates).toBe(1);
});

test("the fresher twin inherits the RANK, not a lower slot", () => {
  const out = collapseDuplicates([
    hit({ id: "other", title: "Unrelated" }),
    hit({ id: "stale", volatile: true, freshness: "2026-01-01" }),
    hit({ id: "current", volatile: true, freshness: "2026-08-01" }),
  ], () => 1);
  expect(out.map((h) => h.id)).toEqual(["other", "current"]); // position 2, where stale was
});

test("events are append-only: without volatile, score order still wins", () => {
  const out = collapseDuplicates([
    hit({ id: "first", freshness: "2026-01-01" }),
    hit({ id: "later", freshness: "2026-08-01" }),
  ], () => 1);
  expect(out.map((h) => h.id)).toEqual(["first"]); // nothing to supersede
  expect(out[0]!.duplicates).toBe(1);
});

test("a volatile twin with no freshness cannot supersede — absence is not recency", () => {
  const out = collapseDuplicates([
    hit({ id: "dated", volatile: true, freshness: "2026-01-01" }),
    hit({ id: "undated", volatile: true }),
  ], () => 1);
  expect(out.map((h) => h.id)).toEqual(["dated"]);
});

test("twins in different zones are not twins at all", () => {
  const out = collapseDuplicates([
    hit({ id: "a", path: "wiki/a.md", volatile: true, freshness: "2026-01-01" }),
    hit({ id: "b", path: "raw/b.md", volatile: true, freshness: "2026-08-01" }),
  ], () => 1);
  expect(out.map((h) => h.id)).toEqual(["a", "b"]); // both kept
});
