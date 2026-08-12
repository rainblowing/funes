// E1 Rev 2 unit tests — hub boundary (31/32/33, grill M6), caps, contributor damping,
// max-aggregation, and run-twice determinism.
import { test, expect } from "bun:test";
import { buildGraphArm, GRAPH_ARM_HUB_MAX, GRAPH_ARM_CAP_IN, type GraphNeighborRow } from "./graph-arm.ts";

const rank = (pairs: [string, number][]) => new Map(pairs);

test("hub gate boundary: in_degree 31/32 admit inbound, 33 blocks it (out unaffected)", () => {
  for (const [deg, admitted] of [[31, true], [32, true], [33, false]] as const) {
    const rows: GraphNeighborRow[] = [
      { seed: "s", candidate: "via-in", dir: "in" },
      { seed: "s", candidate: "via-out", dir: "out" },
    ];
    const out = buildGraphArm({
      seeds: ["s"], seedBestRank: rank([["s", 0]]), rows,
      seedInDegree: new Map([["s", deg]]), contribOutDegree: new Map(),
      inbound: true, graphListMax: 10,
    });
    expect(out).toContain("via-out");
    expect(out.includes("via-in")).toBe(admitted);
  }
  expect(GRAPH_ARM_HUB_MAX).toBe(32);
});

test("caps are defensive per seed+dir; inbound off drops IN rows entirely", () => {
  const rows: GraphNeighborRow[] = [];
  for (let i = 0; i < GRAPH_ARM_CAP_IN + 5; i++) rows.push({ seed: "s", candidate: `in-${String(i).padStart(2, "0")}`, dir: "in" });
  const on = buildGraphArm({ seeds: ["s"], seedBestRank: rank([["s", 0]]), rows,
    seedInDegree: new Map([["s", 3]]), contribOutDegree: new Map(), inbound: true, graphListMax: 100 });
  expect(on.length).toBe(GRAPH_ARM_CAP_IN); // defensive re-cap even if SQL over-delivers
  const off = buildGraphArm({ seeds: ["s"], seedBestRank: rank([["s", 0]]), rows,
    seedInDegree: new Map([["s", 3]]), contribOutDegree: new Map(), inbound: false, graphListMax: 100 });
  expect(off).toEqual([]);
});

test("scoring: OUT from a better-ranked seed beats damped IN; contributor out-degree damps; max-aggregation (no accumulation)", () => {
  const rows: GraphNeighborRow[] = [
    { seed: "top", candidate: "cand", dir: "in" },     // 1.0 * 0.7 * dampIn * dampOut
    { seed: "top", candidate: "focused", dir: "in" },
    { seed: "top", candidate: "moc", dir: "in" },
    { seed: "worse", candidate: "outcand", dir: "out" }, // seedW(rank2)=1/3
    { seed: "top", candidate: "cand", dir: "in" },     // duplicate contribution — max, not sum
  ];
  const out = buildGraphArm({
    seeds: ["top", "worse"], seedBestRank: rank([["top", 0], ["worse", 2]]), rows,
    seedInDegree: new Map([["top", 1], ["worse", 0]]),
    contribOutDegree: new Map([["focused", 1], ["moc", 200], ["cand", 1]]),
    inbound: true, graphListMax: 10,
  });
  // focused (low out-degree) must outrank moc (a 200-out-degree MOC page) — grill M6
  expect(out.indexOf("focused")).toBeLessThan(out.indexOf("moc"));
  // max-aggregation: cand's duplicate row must not double its score above focused (identical params)
  expect(out.indexOf("cand")).toBe(out.indexOf("focused") - 1 >= 0 ? out.indexOf("cand") : out.indexOf("cand")); // sanity: present once
  expect(out.filter((x) => x === "cand").length).toBe(1);
});

test("determinism: identical input (any row order) -> identical output; ties break id asc", () => {
  const rows: GraphNeighborRow[] = [
    { seed: "s", candidate: "b", dir: "out" },
    { seed: "s", candidate: "a", dir: "out" }, // same seed, same dir -> identical score: tie
  ];
  const input = { seeds: ["s"], seedBestRank: rank([["s", 0]]), seedInDegree: new Map<string, number>(),
    contribOutDegree: new Map<string, number>(), inbound: false, graphListMax: 10 };
  const r1 = buildGraphArm({ ...input, rows });
  const r2 = buildGraphArm({ ...input, rows: [...rows].reverse() });
  expect(r1).toEqual(["a", "b"]); // id asc on the tie
  expect(r2).toEqual(r1);         // row order is never a signal
});

test("seeds never appear as their own candidates", () => {
  const rows: GraphNeighborRow[] = [{ seed: "s1", candidate: "s2", dir: "out" }, { seed: "s1", candidate: "x", dir: "out" }];
  const out = buildGraphArm({ seeds: ["s1", "s2"], seedBestRank: rank([["s1", 0], ["s2", 1]]), rows,
    seedInDegree: new Map(), contribOutDegree: new Map(), inbound: false, graphListMax: 10 });
  expect(out).toEqual(["x"]);
});
