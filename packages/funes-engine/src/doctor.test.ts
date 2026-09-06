// PLAN-0.2.1 step 24 — the three definitions the audit stands on, pinned. All pure: the analysis
// takes rows, so none of this needs a database, and a backend that returns the rows correctly
// cannot disagree with this file about what they mean.
import { test, expect } from "bun:test";
import { activeOverrides, auditGraphRows, formatAuditReport, formatOverrideFindings } from "./doctor.ts";

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

// 0.3.0 item 23 — an override nobody can see is a permanent silent exception, so doctor names every
// active one, in red.
test("doctor: an active sync-root override is a RED finding; none is stated as none", () => {
  expect(activeOverrides({})).toEqual([]);
  expect(formatOverrideFindings([])).toContain("none");
  const findings = activeOverrides({ FUNES_SYNC_ROOT_OK: "/x/index.db" });
  expect(findings).toEqual([{ name: "FUNES_SYNC_ROOT_OK", value: "/x/index.db", why: expect.stringContaining("TORN") }]);
  const plain = formatOverrideFindings(findings, { color: false });
  expect(plain).toContain("ACTIVE OVERRIDES: 1");
  expect(plain).toContain("FUNES_SYNC_ROOT_OK=/x/index.db");
  expect(plain).not.toContain("\u001b"); // a pipe gets bytes an operator can diff, never escapes
  expect(formatOverrideFindings(findings, { color: true })).toContain("\u001b[31m");
});

// item 23's rationale applies verbatim to item 25's audit: an override nobody can see is a
// permanent silent exception, and a DISABLED write audit is one. `audit` is the shipped default, so
// it is NOT a finding — a report that flagged the normal configuration would train an operator to
// scroll past this section.
test("doctor: FUNES_WRITE_DESIGNATION=off is a RED finding; audit (the default) is not", () => {
  expect(activeOverrides({ FUNES_WRITE_DESIGNATION: "audit" })).toEqual([]);
  const findings = activeOverrides({ FUNES_WRITE_DESIGNATION: " OFF " }); // normalized as the resolver does
  expect(findings).toEqual([{ name: "FUNES_WRITE_DESIGNATION", value: "off", why: expect.stringContaining("DISABLED") }]);
  expect(formatOverrideFindings(findings)).toContain("FUNES_WRITE_DESIGNATION=off");
  // two suspensions at once are BOTH named — one finding may never mask another
  expect(activeOverrides({ FUNES_SYNC_ROOT_OK: "/x/index.db", FUNES_WRITE_DESIGNATION: "off" })).toHaveLength(2);
});

