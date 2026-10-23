// E1 Rev 2 unit tests — the OUT cap, max-aggregation, and run-twice determinism.
import { test, expect } from "bun:test";
import { buildGraphArm, GRAPH_ARM_CAP_OUT, type GraphNeighborRow } from "./graph-arm.ts";

const rank = (pairs: [string, number][]) => new Map(pairs);

test("the cap is defensive per seed: SQL that over-delivers still yields CAP_OUT candidates", () => {
  const rows: GraphNeighborRow[] = [];
  for (let i = 0; i < GRAPH_ARM_CAP_OUT + 5; i++) rows.push({ seed: "s", candidate: `out-${String(i).padStart(2, "0")}` });
  expect(buildGraphArm({ seeds: ["s"], seedBestRank: rank([["s", 0]]), rows, graphListMax: 100 }).length).toBe(GRAPH_ARM_CAP_OUT);
});

test("scoring: a better-ranked seed's candidate ranks first; max-aggregation, never a sum", () => {
  const rows: GraphNeighborRow[] = [
    { seed: "worse", candidate: "twice" }, // seedW(rank 2) = 1/3
    { seed: "worse", candidate: "twice" }, // a duplicate contribution — max, not sum
    { seed: "top", candidate: "once" },    // seedW(rank 0) = 1
  ];
  expect(buildGraphArm({ seeds: ["top", "worse"], seedBestRank: rank([["top", 0], ["worse", 2]]), rows, graphListMax: 10 })).toEqual(["once", "twice"]);
});

test("determinism: identical input (any row order) -> identical output; ties break id asc", () => {
  const rows: GraphNeighborRow[] = [
    { seed: "s", candidate: "b" },
    { seed: "s", candidate: "a" }, // same seed -> identical score: tie
  ];
  const input = { seeds: ["s"], seedBestRank: rank([["s", 0]]), graphListMax: 10 };
  const r1 = buildGraphArm({ ...input, rows });
  const r2 = buildGraphArm({ ...input, rows: [...rows].reverse() });
  expect(r1).toEqual(["a", "b"]); // id asc on the tie
  expect(r2).toEqual(r1);         // row order is never a signal
});

test("seeds never appear as their own candidates", () => {
  const rows: GraphNeighborRow[] = [{ seed: "s1", candidate: "s2" }, { seed: "s1", candidate: "x" }];
  expect(buildGraphArm({ seeds: ["s1", "s2"], seedBestRank: rank([["s1", 0], ["s2", 1]]), rows, graphListMax: 10 })).toEqual(["x"]);
});
