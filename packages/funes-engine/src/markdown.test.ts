import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileToItemWithMeta, parseFrontmatter } from "./markdown.ts";

// Wikilinks ARE the knowledge graph: sources:/people: frontmatter + body [[links]] become edges
// alongside explicit `edges:` (so recall edge-walk, neighbors, and the graph-viz bake see them).

test("fileToItemWithMeta materializes sources:/people:/body wikilinks as edges (+ explicit)", () => {
  const dir = mkdtempSync(join(tmpdir(), "funes-md-"));
  try {
    const f = join(dir, "topic.md");
    writeFileSync(f, [
      "---",
      "title: Blum",
      "type: topic",
      "edges:",
      "  - { type: depends-on, target: hyperflex }",
      "sources:",
      '  - "[[chat-a]]"',
      '  - "[[chat-b]]"',
      "people:",
      '  - "[[nikita]]"',
      "---",
      "Body references [[anton]] and [[projects/blum|Blum]] and [[anton]] again.",
    ].join("\n"));
    const { item } = fileToItemWithMeta(f, dir);
    const set = new Set((item.edges ?? []).map((e) => `${e.type} ${e.target}`));
    expect(set.has("depends-on hyperflex")).toBe(true);     // explicit kept
    expect(set.has("cites chat-a")).toBe(true);              // sources: -> cites
    expect(set.has("cites chat-b")).toBe(true);
    expect(set.has("mentions nikita")).toBe(true);           // people: -> mentions
    expect(set.has("related-to anton")).toBe(true);          // body [[ ]] -> related-to
    expect(set.has("related-to projects/blum")).toBe(true);  // alias [[id|alias]] -> id only
    // de-duped: the repeated [[anton]] yields ONE related-to anton
    expect((item.edges ?? []).filter((e) => e.type === "related-to" && e.target === "anton").length).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a page with no links/edges still has no edges (undefined)", () => {
  const dir = mkdtempSync(join(tmpdir(), "funes-md-"));
  try {
    const f = join(dir, "plain.md");
    writeFileSync(f, "---\ntitle: Plain\n---\njust prose, no links.\n");
    expect(fileToItemWithMeta(f, dir).item.edges).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression: CRLF frontmatter was silently dropped, which is a correctness bug wearing a parsing
// bug's clothes. '---\r\n' fails a '---\n' fence test, so parseFrontmatter returned {} for EVERY
// key — including superseded_by and forgotten. A tombstoned note written or normalized on Windows
// kept answering recall forever, and no error was ever raised to say so.
const CRLF_META = "---\ntitle: Northwind retainer\ntrust: trusted\nsuperseded_by: nw-002\n---\nbody line\n";
{
  const meta = CRLF_META;
  test("parses CRLF frontmatter identically to LF", () => {
    const lf = parseFrontmatter(meta);
    const crlf = parseFrontmatter(meta.replace(/\n/g, "\r\n"));
    expect(crlf.data).toEqual(lf.data);
    expect(crlf.data.superseded_by).toBe("nw-002"); // the tombstone that used to vanish
    expect(crlf.body.replace(/\r/g, "")).toBe(lf.body);
  });

  test("parses frontmatter behind a UTF-8 BOM", () => {
    expect(parseFrontmatter("﻿" + meta).data.trust).toBe("trusted");
  });
}
