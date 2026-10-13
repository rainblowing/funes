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

// The three producers added 2026-08-22 for the one-folder arrangement (serena beside funes, OKF as
// the wire format). Each emits a REAL predicate with a resolvable target instead of another
// `related-to`, and each covers a link shape the extractor previously read as prose.
test("mem: refs, OKF object sources, and a local OKF resource become typed edges", () => {
  const dir = mkdtempSync(join(tmpdir(), "funes-md-"));
  try {
    const f = join(dir, "concept.md");
    writeFileSync(f, [
      "---",
      "title: Revenue",
      "type: metric",
      "resource: /computations/revenue.md",   // OKF §5.1 derivation edge
      "sources:",
      "  - { id: ga4-schema, resource: /tables/events.md }",  // OKF v0.2 object form
      '  - "[[chat-a]]"',                                     // funes wikilink form, still works
      "  - { id: vendor-docs, resource: https://example.com/x }", // external ⇒ no node, no edge
      "---",
      "Onboarding lives in `mem:auth/login`; see mem:core for the entry point.",
      "A stale-after note[^ga4-schema] cites its source by footnote.",
    ].join("\n"));
    const { item } = fileToItemWithMeta(f, dir);
    const set = new Set((item.edges ?? []).map((e) => `${e.type} ${e.target}`));
    expect(set.has("derived-from computations/revenue")).toBe(true); // resource: -> derived-from
    expect(set.has("cites tables/events")).toBe(true);               // OKF object source -> cites
    expect(set.has("cites chat-a")).toBe(true);                      // wikilink source still cites
    expect(set.has("references login")).toBe(true);                  // mem:auth/login -> last segment
    expect(set.has("references core")).toBe(true);                   // bare mem:core
    // An external URI is metadata, not a node: no edge may be invented for it.
    expect([...set].some((s) => s.includes("example.com"))).toBe(false);
    // The footnote is NOT a second edge — `sources` already emitted cites for that id.
    expect((item.edges ?? []).filter((e) => e.type === "cites").length).toBe(2);
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

// ── PLAN-0.4.0 item 11(a), RAI-134: the tolerant retry, and the only three reasons to report ─────
// Shaped on the funes star's failed pages (wiki/concepts/theory-of-mind, wiki/synthesis/
// three-deployment-modes, wiki/synthesis/memory-systems-comparison): `tags: [#…]`, a multi-link
// line on several keys, a lone `supersedes: [[x]]`, and a plain-scalar `status:` carrying a link.
const OBSIDIAN = [
  "---",
  "title: Three Deployment Modes",
  "type: synthesis",
  "aliases: [ToM, Theory of Mind]",
  "status: design (v1) — refinement of [[synthesis/pyramid-memory]] Mode C",
  "related: [[synthesis/pyramid-memory]], [[entities/cognee|Cognee]], [[concepts/architecture-spectrum]]",
  "compared_items: [[entities/mem0]], [[entities/letta]]",
  "related_concepts: [[entities/honcho]]",
  "tags: [#agent-memory, #project, #cf-native]",
  "supersedes: [[synthesis/two-deployment-modes]]",
  "---",
  "# Three Deployment Modes",
  "",
  "Mode C leans on [[entities/letta]] and [[concepts/working-memory#Limits|working memory]].",
].join("\n");
// The same page with its YAML fixed by the two rules — what scripts/fix-frontmatter.ts writes.
const FIXED = OBSIDIAN
  .replace("related: [[synthesis/pyramid-memory]], [[entities/cognee|Cognee]], [[concepts/architecture-spectrum]]",
    'related: ["[[synthesis/pyramid-memory]]", "[[entities/cognee|Cognee]]", "[[concepts/architecture-spectrum]]"]')
  .replace("compared_items: [[entities/mem0]], [[entities/letta]]", 'compared_items: ["[[entities/mem0]]", "[[entities/letta]]"]')
  .replace("related_concepts: [[entities/honcho]]", 'related_concepts: ["[[entities/honcho]]"]')
  .replace("tags: [#agent-memory, #project, #cf-native]", "tags: [agent-memory, project, cf-native]")
  .replace("supersedes: [[synthesis/two-deployment-modes]]", 'supersedes: ["[[synthesis/two-deployment-modes]]"]');

test("a page the tolerant retry recovers is an ordinary page: no error, and deep-equal to the page with fixed YAML", () => {
  const got = parseFrontmatter(OBSIDIAN);
  expect(got.error).toBeUndefined();
  expect(got).toEqual(parseFrontmatter(FIXED, { strict: true })); // data AND body — the equivalence gate; FIXED needs no retry
  expect(got.data.title).toBe("Three Deployment Modes");
  expect(got.data.tags).toEqual(["agent-memory", "project", "cf-native"]);
  expect(got.data.related_concepts).toEqual(["[[entities/honcho]]"]);
  expect(got.body.startsWith("# Three Deployment Modes")).toBe(true); // the frontmatter is no longer body text
});

test("error is reported ONLY when both parses fail, the fence never closes, or the YAML is not a map", () => {
  expect(parseFrontmatter("---\nfoo: bar: baz\n---\nb")).toMatchObject({ data: {}, body: "---\nfoo: bar: baz\n---\nb", error: expect.stringContaining("Nested mappings") });
  expect(parseFrontmatter("---\ntitle: x\nno closing fence")).toMatchObject({ data: {}, error: "the frontmatter fence opens and never closes" });
  expect(parseFrontmatter("---\n- a\n- b\n---\nb")).toMatchObject({ data: {}, error: "the frontmatter is not a YAML map" });
  expect(parseFrontmatter("---\njust a scalar\n---\nb").error).toBe("the frontmatter is not a YAML map");
  // no error: valid, empty, absent, recovered
  expect(parseFrontmatter("---\ntitle: X\n---\nb").error).toBeUndefined();
  expect(parseFrontmatter("---\n---\nb")).toEqual({ data: {}, body: "b" });
  expect(parseFrontmatter("# heading\ntext").error).toBeUndefined();
  expect(parseFrontmatter("---\ntags: [#a, #b]\n---\nb").error).toBeUndefined();
  // a page the STRICT parse reads is never rewritten: a lone `[[a]]` keeps the meaning YAML gives it
  expect(parseFrontmatter("---\nrelated: [[a]]\n---\nb").data.related).toEqual([["a"]]);
});

test("the edges of a recovered page are the ones today's failed parse gave it, plus the typed producers", () => {
  const dir = mkdtempSync(join(tmpdir(), "funes-md-"));
  try {
    const f = join(dir, "page.md");
    writeFileSync(f, OBSIDIAN);
    const { item, parseError } = fileToItemWithMeta(f, dir);
    expect(parseError).toBeUndefined();
    // Every link in the frontmatter, from every key — the set the body scan harvested while the
    // parse failed and the frontmatter was body text — then the body's. Frontmatter strings come
    // BEFORE the body (edge order is inside hashItem), in key order, each target once per type.
    expect((item.edges ?? []).map((e) => `${e.type} ${e.target}`)).toEqual([
      "related-to synthesis/pyramid-memory",
      "related-to entities/cognee",
      "related-to concepts/architecture-spectrum",
      "related-to entities/mem0",
      "related-to entities/letta",
      "related-to entities/honcho",
      "related-to synthesis/two-deployment-modes",
      "related-to concepts/working-memory",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the generic frontmatter source reaches nested strings and leaves sources/people/resource/edges to their producers", () => {
  const dir = mkdtempSync(join(tmpdir(), "funes-md-"));
  try {
    const f = join(dir, "page.md");
    writeFileSync(f, [
      "---",
      "title: P",
      'sources: ["[[src]]"]',
      'people: ["[[ann]]"]',
      "resource: res.md",
      "edges:",
      '  - { type: depends-on, target: "[[dep]]" }',
      'related: ["[[r]]"]',
      "meta:",
      '  notes: ["see [[deep]] and [[deeper]]"]',
      "---",
      "body [[b]] and mem:m",
    ].join("\n"));
    const set = (fileToItemWithMeta(f, dir).item.edges ?? []).map((e) => `${e.type} ${e.target}`);
    // The WHOLE order — edge order is inside hashItem: explicit edges, then sources, people, the OKF
    // resource, the generic frontmatter scan in key order, the body's links, then mem:.
    expect(set).toEqual([
      "depends-on [[dep]]", "cites src", "mentions ann", "derived-from res",
      "related-to r", "related-to deep", "related-to deeper", "related-to b", "references m",
    ]);
    // the four producer-owned keys never ALSO become related-to
    for (const t of ["src", "ann", "res", "dep"]) expect(set).not.toContain(`related-to ${t}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("code is not a link: body wikilinks skip fenced and inline code; mem: skips fenced code only", () => {
  const dir = mkdtempSync(join(tmpdir(), "funes-md-"));
  try {
    const f = join(dir, "page.md");
    writeFileSync(f, [
      "---",
      "title: Code",
      "---",
      "Real [[kept]] link and `[[inline-code]]` and ``[[double `tick]]``, and `a span that",
      "wraps [[wrapped-code]]` onto a second line.",
      "A lone ` backtick never pairs across a blank line:",
      "",
      "so [[after-blank]] is a link, and so is this ` one.",
      "```toml",
      "[[kv_namespaces]]",
      "binding = \"mem:fenced-ref\"",
      "```",
      "~~~",
      "[[tilde-fenced]]",
      "~~~",
      "",
      "````", // a fence closes only on a run of its own length or longer — the ``` inside is text
      "```",
      "[[inside-nested]]",
      "````",
      "",
      "```x``` then [[after-inline-triple]] — a backtick in the info string: inline code, not a fence",
      "",
      "    ```", // four spaces of indent: not a fence
      "[[after-indented]]",
      "",
      "Serena writes `mem:auth/login` inside backticks, and that is the link.",
      "```",
      "[[unclosed-fence]] runs to the end, as CommonMark closes it",
    ].join("\n"));
    const set = (fileToItemWithMeta(f, dir).item.edges ?? []).map((e) => `${e.type} ${e.target}`);
    expect(set).toEqual([
      "related-to kept", "related-to after-blank", "related-to after-inline-triple", "related-to after-indented", "references login",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A YAML alias may point at its own parent: `yaml` returns a truly self-referencing object. The
// generic frontmatter scan walks every value, so it must not walk one twice — one such page used to
// throw RangeError out of fileToItemWithMeta and abort every reindex and publish of its star.
test("a cyclic YAML alias in the frontmatter yields an item, and its links once", () => {
  const dir = mkdtempSync(join(tmpdir(), "funes-md-"));
  try {
    const f = join(dir, "cyclic.md");
    writeFileSync(f, '---\ntitle: C\nmeta: &m\n  link: "[[x]]"\n  self: *m\nagain: *m\n---\nbody');
    const { item, parseError } = fileToItemWithMeta(f, dir);
    expect(parseError).toBeUndefined();
    expect(item.edges).toEqual([{ type: "related-to", target: "x" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The retry's rules are YAML-line rules. A block scalar's lines are prose, so `Related: [[a]], [[b]]`
// inside a `description: |` must come back as written — before, it came back a quoted list, and
// scripts/fix-frontmatter.ts wrote that change into the page (its own check could not see it).
test("the tolerant retry never rewrites the text of a block scalar, and resumes after it", () => {
  const page = [
    "---",
    "title: B",
    "tags: [#x]",
    "description: |",
    "  Related: [[a]], [[b]]",
    "",
    "  tags: [#y]",
    "summary: >-",
    "  Parent: [[p]]",
    "related: [[c]], [[d]]",
    "---",
    "body",
  ].join("\n");
  const { data, error } = parseFrontmatter(page);
  expect(error).toBeUndefined();
  expect(data.tags).toEqual(["x"]);
  expect(data.description).toBe("Related: [[a]], [[b]]\n\ntags: [#y]\n");
  expect(data.summary).toBe("Parent: [[p]]");
  expect(data.related).toEqual(["[[c]]", "[[d]]"]); // the block ended: the next key is YAML again
});
