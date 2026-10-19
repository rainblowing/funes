// The Vault port's pure rules (PLAN-0.5.0 item 11, ADR-0011 §The decision): what a page is, where a
// history object lives, and the one guard every page swap passes.
import { test, expect } from "bun:test";
import { isPagePath, historyPath, assertWritable, zoneOfDir, zoneOfFile } from "./vault.ts";

const SHA = "9f" + "0".repeat(60) + "c2";

test("isPagePath: a .md page at any depth", () => {
  for (const p of ["note.md", "wiki/rag.md", "raw/in_telegram/2025/x.md", "items/films/dune.md", "projects/in_progress.md"]) {
    expect(isPagePath(p)).toBe(true);
  }
});

test("isPagePath: never a dot segment, star.yaml, .history/, a reserved file, a summary or a sync-conflict copy", () => {
  for (const p of [
    "star.yaml", "notes.txt", "README",                                   // not .md
    ".obsidian/x.md", "wiki/.trash/x.md", ".hidden.md",                   // dot segment
    ".history/wiki/rag.md/" + "a".repeat(64),                              // history object
    "index.md", "wiki/index.md", "log.md", "wiki/log.md",                 // OKF §3.1 reserved
    "wiki/rag.summary.md",                                                // summary
    "wiki/rag.sync-conflict-20260909-120000-ABCDEFG.md",                  // Syncthing copy
    "/abs.md", "wiki//x.md", "wiki/../x.md", "./x.md", "wiki/",           // not a vault path
  ]) {
    expect([p, isPagePath(p)]).toEqual([p, false]);
  }
  // a name that merely carries the words is a page (sync-conflicts.ts, review round 1 #20)
  expect(isPagePath("wiki/how.sync-conflict-resolution.md")).toBe(true);
});

test("historyPath: .history/<page path>/<sha256>, no .md suffix, so never a page", () => {
  expect(historyPath("films/dune.md", SHA)).toBe(`.history/films/dune.md/${SHA}`);
  expect(isPagePath(historyPath("films/dune.md", SHA))).toBe(false);
});

test("historyPath: the name certifies the content, so it refuses anything but a lowercase sha256", () => {
  for (const bad of ["", "abc", SHA.toUpperCase(), SHA + "0", `${SHA.slice(0, 63)}/`]) {
    expect(() => historyPath("films/dune.md", bad)).toThrow(/sha256/);
  }
});

test("zoneOfDir/zoneOfFile live in funes-core (moved from funes-shared, which re-exports them)", () => {
  expect(zoneOfFile("raw/stray.md")).toBe("incoming");
  expect(zoneOfFile("projects/client/in_briefs/x.md")).toBe("incoming");
  expect(zoneOfFile("projects/in_progress.md")).toBe("wiki");
  expect(zoneOfDir("out/out_memory")).toBe("output");
});

const BYTES = new TextEncoder().encode("# page\n");
const V = "v1";
/** Every shape of swap: create-once, replace, remove. */
const SWAPS: [string | null, Uint8Array | null][] = [[null, BYTES], [V, BYTES], [V, null]];

test("assertWritable: a page outside the incoming zone takes every swap", () => {
  for (const p of ["wiki/rag.md", "note.md", "out/out_memory/x.md", "items/films/dune.md", "projects/in_progress.md"]) {
    for (const [e, n] of SWAPS) expect(() => assertWritable(p, e, n)).not.toThrow();
  }
});

test("assertWritable: the incoming zone (first segment raw, any in_* segment) refuses every swap", () => {
  for (const p of ["raw/stray.md", "raw/in_telegram/x.md", "in_telegram/x.md", "projects/client/in_briefs/x.md"]) {
    for (const [e, n] of SWAPS) expect(() => assertWritable(p, e, n)).toThrow(/incoming/);
  }
});

test("assertWritable: under .history/ only create-once — a history object is never replaced or removed", () => {
  const h = historyPath("films/dune.md", SHA);
  expect(() => assertWritable(h, null, BYTES)).not.toThrow();
  expect(() => assertWritable(h, V, BYTES)).toThrow(/create-once/);
  expect(() => assertWritable(h, V, null)).toThrow(/create-once/);
  expect(() => assertWritable(h, null, null)).toThrow(/create-once/);
});

test("assertWritable: the history of an incoming page is refused too — its page can never be replaced", () => {
  expect(() => assertWritable(historyPath("raw/in_telegram/x.md", SHA), null, BYTES)).toThrow(/incoming/);
});

test("assertWritable: a path that is not a vault path is refused, so no segment trick reaches raw/", () => {
  for (const p of ["/wiki/x.md", "wiki//x.md", "./raw/x.md", "wiki/../raw/x.md", "../x.md", "wiki/x.md/", ""]) {
    expect(() => assertWritable(p, null, BYTES)).toThrow(/not a vault path/);
  }
});
