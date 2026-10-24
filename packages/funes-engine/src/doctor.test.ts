// PLAN-0.2.1 step 24 — the three definitions the audit stands on, pinned. All pure: the analysis
// takes rows, so none of this needs a database, and a backend that returns the rows correctly
// cannot disagree with this file about what they mean.
import { test, expect } from "bun:test";
import { auditGraphRows, formatAuditReport, formatSyncConflicts, formatUnparsed, formatUnparsedLine } from "./doctor.ts";

/** a→b resolves. Everything else misses, which is what makes c and e dangling-only and leaves d
 *  isolated. `related-to` and `related_to` are ONE relation stored two ways. */
const ROWS = {
  nodeIds: ["a", "b", "c", "d", "e"],
  edges: [
    { source: "a", type: "related-to", target: "b" },
    { source: "a", type: "related_to", target: "missing1" },
    { source: "c", type: "related-to", target: "missing1" },
    { source: "c", type: "mentions", target: "missing2" },
    { source: "e", type: "mentions", target: "missing3" },
  ],
};

test("a dangling edge is one whose TARGET is absent from nodes", () => {
  const r = auditGraphRows(ROWS);
  expect(r.nodes).toBe(5);
  expect(r.edges).toBe(5);
  expect(r.dangling).toBe(4);
  expect(r.resolved).toBe(1);
});

test("orphans split into isolated and dangling-only, and the two are not the same finding", () => {
  const r = auditGraphRows(ROWS);
  // c and e carry edges that all miss; d carries none at all. Both are "no resolved typed edge",
  // and they are reported apart because the remedy differs: fix a link vs connect a page.
  expect(r.orphans).toBe(3);
  expect(r.danglingOnly).toBe(2);
  expect(r.sampleDanglingOnly).toEqual(["c", "e"]);
  expect(r.isolated).toBe(1);
  expect(r.sampleIsolated).toEqual(["d"]);
  // a has a resolved edge out, b has one in — neither is an orphan.
  expect(r.sampleIsolated).not.toContain("a");
  expect(r.sampleDanglingOnly).not.toContain("b");
});

test("dangling edges group by the RAW stored type, count desc then type asc", () => {
  const r = auditGraphRows(ROWS);
  expect(r.danglingByType.map((t) => [t.type, t.count])).toEqual([
    ["mentions", 2], ["related-to", 1], ["related_to", 1],
  ]);
  // Folding the spellings here would hide WHICH producer emitted the broken edges.
  expect(r.danglingByType[0]!.topTargets).toEqual([
    { target: "missing2", count: 1 }, { target: "missing3", count: 1 },
  ]);
  expect(r.danglingByType[0]!.sampleSources).toEqual(["c", "e"]);
});

test("a spelling fork is reported only when one relation has SEVERAL stored spellings", () => {
  const r = auditGraphRows(ROWS);
  expect(r.spellingForks).toEqual([{
    normalized: "related-to",
    spellings: [{ spelling: "related-to", count: 2 }, { spelling: "related_to", count: 1 }],
  }]);
  // `mentions` is stored one way, so it is not a fork — the report must not list every type.
  expect(r.spellingForks.find((f) => f.normalized === "mentions")).toBeUndefined();
});

test("a clean graph reports no findings rather than empty sections", () => {
  const r = auditGraphRows({ nodeIds: ["a", "b"], edges: [{ source: "a", type: "related-to", target: "b" }] });
  expect(r.dangling).toBe(0);
  expect(r.orphans).toBe(0);
  expect(r.spellingForks).toEqual([]);
  const text = formatAuditReport(r, { vault: "/v", generation: "v1:abc", source: "/v/gen.db", verified: true });
  expect(text).toContain("dangling edges: none");
  expect(text).toContain("relation spelling forks: none");
  expect(text).toContain("Reported, not repaired");
});

test("--live output NAMES itself unverified", () => {
  const r = auditGraphRows(ROWS);
  const live = formatAuditReport(r, { vault: "/v", generation: null, source: "/v/index.db", verified: false });
  expect(live).toContain("UNVERIFIED");
  const published = formatAuditReport(r, { vault: "/v", generation: "v1:abc", source: "/v/gen.db", verified: true });
  expect(published).not.toContain("UNVERIFIED");
  expect(published).toContain("generation v1:abc");
});

// 0.4.0 item 7 — a sync-conflict copy is RED in the override style: none is stated as none, a pipe
// gets diffable bytes, and the text caps each list at 20 while --json (the finding itself) keeps all.
// RAI-327: the on-disk half only — the indexed half (pre-0.4.0 residue rows) is gone.
test("doctor: sync-conflict copies are a RED finding, capped at 20 in text; none is stated as none", () => {
  expect(formatSyncConflicts({ onDisk: [] })).toBe("  sync conflicts: none");
  const onDisk = Array.from({ length: 23 }, (_, i) => `wiki/p${String(i).padStart(2, "0")}.sync-conflict-20260909-120000-ABCDEFG.md`);
  const plain = formatSyncConflicts({ onDisk });
  expect(plain).toContain("SYNC CONFLICTS: 23 on disk — ");
  expect(plain).toContain(onDisk[19]!);
  expect(plain).not.toContain(onDisk[20]!);
  expect(plain).toContain("… 3 more (--json lists every one)");
  expect(plain).not.toContain("indexed (");
  expect(plain).not.toContain("\u001b");
  expect(formatSyncConflicts({ onDisk }, { color: true })).toContain("\u001b[31m");
});

// 0.4.0 item 11 (RAI-134): `vault.unparsed` — none is stated as none, the text names the first five
// and counts the rest, and a walk that stopped early says the count is partial. The reindex summary
// line takes the same cap on one line.
test("doctor: unparsed pages are a RED finding, the first five named and the rest counted; a stopped walk is said", () => {
  expect(formatUnparsed({ count: 0, first: [] })).toBe("  vault unparsed: none");
  const first = ["w/a", "w/b", "w/c", "w/d", "w/e"];
  const plain = formatUnparsed({ count: 7, first });
  expect(plain).toContain("VAULT UNPARSED: 7 page(s)");
  expect(plain).toContain("      w/e\n      … 2 more");
  expect(plain).not.toContain("\u001b");
  expect(formatUnparsed({ count: 5, first })).not.toContain("more");
  expect(formatUnparsed({ count: 1, first: ["w/a"] }, { color: true })).toContain("\u001b[31m");
  const partial = formatUnparsed({ count: 0, first: [], walkError: "EACCES: permission denied, scandir 'v/locked'" });
  expect(partial).toBe("  vault unparsed: none\n      the vault walk stopped early (EACCES: permission denied, scandir 'v/locked') — this counts only the pages read before it");

  expect(formatUnparsedLine([...first, "w/f", "w/g"])).toBe("  unparsed frontmatter (skipped, not indexed): w/a, w/b, w/c, w/d, w/e … 2 more");
  expect(formatUnparsedLine(["w/a", "w/b"])).toBe("  unparsed frontmatter (skipped, not indexed): w/a, w/b");
});

// PLAN-0.4.0 item 17 (RAI-128): the release gate deep-equals two loci's audit reports, and neither
// backend's auditGraph() selects with an ORDER BY — so the SAME rows in another order must produce
// the same report, samples included. ROWS above is pre-sorted, which is why nothing caught this.
test("the report is a function of the row SET, not the row order the backend returned", () => {
  const shuffled = { nodeIds: [...ROWS.nodeIds].reverse(), edges: [...ROWS.edges].reverse() };
  expect(auditGraphRows(shuffled)).toEqual(auditGraphRows(ROWS));
  expect(auditGraphRows(shuffled).sampleDanglingOnly).toEqual(["c", "e"]);
  expect(auditGraphRows(shuffled).danglingByType[0]!.sampleSources).toEqual(["c", "e"]);
  // ROWS has no two dangling edges on one (type, target), so a sort that ignored `source` passed the
  // asserts above; these two tie on everything else, and only `source` orders them.
  const tie = { nodeIds: ["x", "y"], edges: [{ source: "y", type: "t", target: "gone" }, { source: "x", type: "t", target: "gone" }] };
  expect(auditGraphRows(tie)).toEqual(auditGraphRows({ ...tie, edges: [...tie.edges].reverse() }));
  expect(auditGraphRows(tie).danglingByType[0]!.sampleSources).toEqual(["x", "y"]);
});
