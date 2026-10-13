// PLAN-0.4.0 item 12 — the gate the fix rests on: parse(fixed) deep-equals parse(tolerant(original)),
// on the shapes the funes star's failed pages carry, and the fixed YAML is read by a STRICT parse.
// Then the script end to end on a temp vault: a dry run writes nothing, `--write` rewrites exactly
// the recoverable page, and every page the plan says to leave alone is left alone.
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "../packages/funes-engine/src/markdown.ts";
import { fixFrontmatter, planFixes } from "./fix-frontmatter.ts";

const SHAPES: Record<string, string> = {
  // the body carries lines BOTH rules would rewrite, were they frontmatter — the rules stop at the fence
  "tags with #": "---\ntitle: Working Memory\ntype: concept\ntags: [#agent-memory, #cognitive-science]\n---\n# body [[x]]\nSee: [[a]], [[b]]\nlabels: [#x]\n",
  "multi-link related": "---\ntitle: Pyramid\nrelated: [[synthesis/a]], [[entities/b|B]], [[concepts/c#h]]\ntags: [design]\n---\nbody\n",
  "both, plus a lone link and a scalar link": [
    "---",
    "title: Three Modes",
    "status: design (v1) — refinement of [[synthesis/three-deployment-modes]] Mode C",
    "compared_items: [[entities/mem0]], [[entities/letta]], [[entities/zep]]",
    "related_concepts: [[entities/honcho]]",
    "tags: [#agent-memory, #project]",
    "supersedes: [[synthesis/two-deployment-modes]]",
    "dimensions:",
    "  - Architecture",
    "---",
    "",
    "Body with [[entities/letta]].",
  ].join("\n"),
};

for (const [name, original] of Object.entries(SHAPES)) {
  test(`fixFrontmatter: parse(fixed) deep-equals parse(tolerant(original)) — ${name}`, () => {
    const tolerant = parseFrontmatter(original);
    expect(tolerant.error).toBeUndefined();
    const fixed = fixFrontmatter(original);
    expect(fixed).not.toBeNull();
    expect(parseFrontmatter(fixed!)).toEqual(tolerant);
    // the fixed YAML needs no retry: a strict parse reads it
    expect(parseFrontmatter(fixed!, { strict: true })).toEqual(tolerant);
    // only frontmatter lines change, and the body is byte-identical
    expect(fixed!.split("---\n").slice(2).join("---\n")).toBe(original.split("---\n").slice(2).join("---\n"));
    expect(fixFrontmatter(fixed!)).toBeNull(); // idempotent: a fixed page has nothing left to fix
  });
}

test("fixFrontmatter leaves alone a page the strict parse reads, one no rule recovers, and one with no frontmatter", () => {
  expect(fixFrontmatter("---\nrelated: [[a]]\n---\nvalid YAML, a nested list — rewriting it would change its meaning")).toBeNull();
  expect(fixFrontmatter("---\ntitle: a: b\ntags: [#x]\n---\nunrecoverable")).toBeNull();
  expect(fixFrontmatter("# no frontmatter\n")).toBeNull();
});

test("fixFrontmatter leaves a block scalar's text as written — it is prose, not YAML", () => {
  const fixed = fixFrontmatter("---\ntags: [#x]\ndescription: |\n  Related: [[a]], [[b]]\n---\nbody\n");
  expect(fixed).toBe("---\ntags: [x]\ndescription: |\n  Related: [[a]], [[b]]\n---\nbody\n");
});

test("the script refuses a star.yaml whose index_scope it cannot read — a broken scope must not widen what it edits", () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-fixfm-"));
  try {
    writeFileSync(join(vault, "star.yaml"), "memory:\n  index_scope:\n    exclude: 42\n");
    writeFileSync(join(vault, "p.md"), SHAPES["tags with #"]!);
    expect(() => planFixes(vault)).toThrow(/index_scope is invalid/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("the script: a dry run writes nothing; --write fixes exactly the recoverable in-scope page", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-fixfm-"));
  try {
    writeFileSync(join(vault, "star.yaml"), 'memory:\n  index_scope:\n    exclude:\n      - "skip/**"\n');
    for (const d of ["wiki", "raw", "skip"]) mkdirSync(join(vault, d));
    const obsidian = SHAPES["tags with #"]!;
    const pages: Record<string, string> = {
      "wiki/fixme.md": obsidian,
      "wiki/fine.md": "---\ntitle: Fine\nrelated: [[a]]\n---\nfine\n",
      "wiki/broken.md": "---\ntitle: a: b\n---\nbroken\n",
      "raw/ingest.md": obsidian, // incoming: immutable
      "skip/out-of-scope.md": obsidian,
    };
    for (const [rel, text] of Object.entries(pages)) writeFileSync(join(vault, rel), text);
    const run = async (...args: string[]) => {
      const p = Bun.spawn(["bun", join(import.meta.dir, "fix-frontmatter.ts"), "--vault", vault, ...args], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(p.stdout).text();
      return { code: await p.exited, out };
    };

    const dry = await run();
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("would fix wiki/fixme.md");
    expect(dry.out).toContain("  - tags: [#agent-memory, #cognitive-science]\n  + tags: [agent-memory, cognitive-science]");
    expect(dry.out).toContain("unparsed, fix by hand: wiki/broken.md");
    expect(dry.out).toContain("left alone (incoming zone, immutable): raw/ingest.md");
    expect(dry.out).toContain("1 page(s) to fix, 0 refused, 1 unparsed, 1 in incoming zones — dry run");
    for (const [rel, text] of Object.entries(pages)) expect(readFileSync(join(vault, rel), "utf8")).toBe(text);

    const wrote = await run("--write");
    expect(wrote.code).toBe(0);
    expect(readFileSync(join(vault, "wiki/fixme.md"), "utf8")).toBe(fixFrontmatter(obsidian)!);
    for (const [rel, text] of Object.entries(pages)) if (rel !== "wiki/fixme.md") expect(readFileSync(join(vault, rel), "utf8")).toBe(text);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}, 30_000);
