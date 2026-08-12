import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
