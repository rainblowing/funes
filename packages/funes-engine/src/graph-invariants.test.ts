// Graph-invariant tests (research N3/N4/N5, 2026-07-13): type-spelling normalization at the
// comparison boundary, extraction-level edge dedupe, and alias-aware reference resolution.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRelationType } from "funes-core";
import { fileToItem } from "./markdown.ts";
import { buildReferenceMaps, resolveEdgeTargets } from "./reindex.ts";

test("N4: normalizeRelationType — underscore/hyphen/case variants compare equal", () => {
  expect(normalizeRelationType("related_to")).toBe("related-to");
  expect(normalizeRelationType("Related_To ")).toBe("related-to");
  expect(normalizeRelationType("derived-from")).toBe("derived-from");
});

test("N4+N3: allEdges — explicit related_to suppresses derived related-to; explicit dupes collapse", () => {
  const root = mkdtempSync(join(tmpdir(), "funes-ginv-"));
  writeFileSync(join(root, "a.md"), [
    "---",
    "title: A",
    "edges:",
    "  - target: b",          // explicit related_to (default) …
    "  - target: b",          // … duplicated explicitly (N3: must collapse at extraction)
    "  - { target: c, type: cites }",
    "---",
    "body links [[b]] and [[c]]", // derived related-to b (dup of explicit via N4) + related-to c (kept)
  ].join("\n"));
  const edges = fileToItem(join(root, "a.md"), root).edges!;
  const keys = edges.map((e) => `${normalizeRelationType(e.type)}>${e.target}`).sort();
  // exactly: one related-to>b (explicit wins, spelling-normalized dedupe), cites>c, related-to>c (derived, distinct type)
  expect(keys).toEqual(["cites>c", "related-to>b", "related-to>c"]);
  expect(edges.find((e) => e.target === "b")!.type).toBe("related_to"); // authored spelling PRESERVED in storage
});

test("N5: buildReferenceMaps + resolveEdgeTargets — alias fallback, collision-to-null, basename shadowing", () => {
  const root = mkdtempSync(join(tmpdir(), "funes-ref-"));
  mkdirSync(join(root, "wiki"), { recursive: true });
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "wiki/rag.md"), "---\ntitle: RAG\naliases: [retrieval-augmented-generation, ragx]\n---\nx");
  writeFileSync(join(root, "notes/other.md"), "---\ntitle: O\naliases: [ragx, dupe-alias]\n---\ny");     // ragx collides -> null
  writeFileSync(join(root, "notes/third.md"), "---\ntitle: T\naliases: [wiki-page]\n---\nz");
  writeFileSync(join(root, "wiki/wiki-page.md"), "---\ntitle: W\n---\nw");                               // basename shadows third's alias
  writeFileSync(join(root, "notes/rag.md"), "---\ntitle: R2\n---\nambig");                               // rag basename now ambiguous
  const { byBase, byAlias } = buildReferenceMaps(root);
  expect(byBase.get("rag")).toBeNull();                                    // ambiguous basename -> null
  expect(byAlias.get("retrieval-augmented-generation")).toBe("wiki/rag");  // unique alias resolves
  expect(byAlias.get("ragx")).toBeNull();                                  // alias collision -> null
  const item = { id: "x", title: "x", body: "", edges: [
    { type: "related_to", target: "retrieval-augmented-generation" }, // alias fallback fires
    { type: "related_to", target: "rag" },                            // ambiguous basename: untouched, alias NOT consulted
    { type: "related_to", target: "wiki-page" },                      // unique basename wins over third's alias
    { type: "related_to", target: "already/qualified" },              // slash: never rewritten
  ] };
  resolveEdgeTargets(item, byBase, byAlias);
  expect(item.edges.map((e) => e.target)).toEqual([
    "wiki/rag", "rag", "wiki/wiki-page", "already/qualified",
  ]);
});
