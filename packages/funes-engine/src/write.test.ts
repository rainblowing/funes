import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { memoryId, slugify, writeMemoryItem, readMemoryFile, patchFrontmatter, deleteMemoryFile } from "./write.ts";

test("slugify + memoryId are deterministic and filesystem-safe", () => {
  expect(slugify("Hello, World! 2026")).toBe("hello-world-2026");
  const a = memoryId({ title: "Note A", body: "same body" }, "out_memory");
  const b = memoryId({ title: "Note A", body: "same body" }, "out_memory");
  expect(a).toBe(b);
  expect(a.startsWith("out_memory/note-a-")).toBe(true);
  // explicit id wins
  expect(memoryId({ id: "out_memory/explicit", title: "x", body: "y" }, "out_memory")).toBe("out_memory/explicit");
});

test("writeMemoryItem -> readMemoryFile round-trips frontmatter + body", () => {
  const root = mkdtempSync(join(tmpdir(), "funes-write-"));
  try {
    const item = writeMemoryItem(root, { id: "out_memory/t", title: "T", body: "  the body  ", type: "memory",
      edges: [{ type: "related_to", target: "out_memory/u" }] },
      { created: "2026-06-08T00:00:00Z", updated: "2026-06-08T00:00:00Z", tags: ["x"], trust: "trusted" });
    expect(item.id).toBe("out_memory/t");

    const f = readMemoryFile(root, "out_memory/t")!;
    expect(f.data.title).toBe("T");
    expect(f.data.trust).toBe("trusted");
    expect(f.data.tags).toEqual(["x"]);
    expect((f.data.edges as any[])[0].target).toBe("out_memory/u");
    expect(f.body).toContain("the body"); // trimmed into the body
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patchFrontmatter merges fields and preserves the body; delete removes the file", () => {
  const root = mkdtempSync(join(tmpdir(), "funes-write-"));
  try {
    writeMemoryItem(root, { id: "out_memory/p", title: "P", body: "keep this body" },
      { created: "2026-06-08T00:00:00Z", updated: "2026-06-08T00:00:00Z" });
    patchFrontmatter(root, "out_memory/p", { forgotten: true, updated: "2026-06-09T00:00:00Z" });

    const f = readMemoryFile(root, "out_memory/p")!;
    expect(f.data.forgotten).toBe(true);
    expect(f.data.updated).toBe("2026-06-09T00:00:00Z");
    expect(f.data.title).toBe("P");          // untouched
    expect(f.body).toContain("keep this body"); // body preserved

    expect(deleteMemoryFile(root, "out_memory/p")).toBe(true);
    expect(readMemoryFile(root, "out_memory/p")).toBe(null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// PLAN-0.4.0 item 11(a): a page whose frontmatter does not parse reads as `data: {}` and the whole
// file as body, so the rewrite stacked a second fence on the old one — the page's metadata became
// prose under a frontmatter holding only the patch. It refuses now, and leaves the bytes alone. A
// page the tolerant retry recovers is rewritten, and what it writes is YAML a strict parse reads.
test("patchFrontmatter refuses a page whose frontmatter does not parse, and rewrites a recovered page in valid YAML", () => {
  const root = mkdtempSync(join(tmpdir(), "funes-write-"));
  try {
    mkdirSync(join(root, "out_memory"));
    const broken = "---\ntitle: a: b\ntrust: trusted\n---\nbody\n";
    writeFileSync(join(root, "out_memory/broken.md"), broken);
    expect(readMemoryFile(root, "out_memory/broken")!.error).toContain("Nested mappings");
    expect(() => patchFrontmatter(root, "out_memory/broken", { forgotten: true })).toThrow(/does not parse/);
    expect(readFileSync(join(root, "out_memory/broken.md"), "utf8")).toBe(broken); // untouched

    writeFileSync(join(root, "out_memory/obs.md"), "---\ntitle: Obs\ntags: [#a, #b]\nrelated: [[x]], [[y]]\n---\nobs body\n");
    patchFrontmatter(root, "out_memory/obs", { forgotten: true });
    const text = readFileSync(join(root, "out_memory/obs.md"), "utf8");
    const fm = parseYaml(text.split("---\n")[1]!); // STRICT: no retry involved
    expect(fm).toMatchObject({ title: "Obs", tags: ["a", "b"], related: ["[[x]]", "[[y]]"], forgotten: true });
    expect(text.match(/^---$/gm)).toHaveLength(2); // one frontmatter, not two
    expect(readMemoryFile(root, "out_memory/obs")!.body).toBe("obs body\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
