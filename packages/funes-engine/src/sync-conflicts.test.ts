// 0.4.0 item 7 (RAI-129): a Syncthing conflict copy is a finding, never a page. The predicate, the
// two walkers that apply it, the graph a vault holding one builds, and doctor's finding. The CLI
// halves — `doctor --live --json` on a planted copy, and `grandfather` — are in cli.test.ts.
import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";
import { isSyncConflict, syncConflictFinding } from "./sync-conflicts.ts";
import { indexDir, walkMd } from "./reindex.ts";
import { walkPages } from "./okf-export.ts";

class FakeEmbedder implements Embedder {
  readonly dim = 16;
  private vec(t: string): Float32Array {
    const v = new Float32Array(this.dim);
    for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? [])
      v[[...w].reduce((a, c) => a + c.charCodeAt(0), 0) % this.dim]! += 1;
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i]! /= n;
    return v;
  }
  async embedQuery(t: string) { return this.vec(t); }
  async embedPassage(t: string) { return this.vec(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.vec(t)); }
}

const COPY = "notes.sync-conflict-20260909-120000-ABCDEFG.md";
/** The two names review round 1 (#20) showed a bare substring would silently drop. */
const NEAR_MISSES = ["how.sync-conflict-resolution.md", "notes.sync-conflict-20260909.md"];

test("isSyncConflict matches Syncthing's exact shape — the positive, and never the two near-misses", () => {
  expect(isSyncConflict(COPY)).toBe(true);
  for (const name of NEAR_MISSES) expect(isSyncConflict(name)).toBe(false);
  // the device id is empty when Syncthing has no ModifiedBy; the extension is whatever the page had
  expect(isSyncConflict("notes.sync-conflict-20260909-120000-.md")).toBe(true);
  expect(isSyncConflict("star.sync-conflict-20260909-120000-ABCDEFG.yaml")).toBe(true);
  expect(isSyncConflict("README.sync-conflict-20260909-120000-ABCDEFG")).toBe(true);
  // anchored at the end: the suffix in the middle of a name is not Syncthing's
  expect(isSyncConflict("notes.sync-conflict-20260909-120000-ABCDEFG.md.bak.md")).toBe(false);
});

/** A vault where one page was edited on two loci: `rag.md` won, its copy sits beside it carrying
 *  the same alias and an edge of its own, and `agents.md` reaches rag only through that alias. */
function conflictedVault(): string {
  const root = mkdtempSync(join(tmpdir(), "funes-conflict-"));
  mkdirSync(join(root, "wiki"));
  writeFileSync(join(root, "wiki", "rag.md"), "---\ntitle: RAG\naliases: [retrieval]\n---\nretrieval augmented generation");
  writeFileSync(join(root, "wiki", "rag.sync-conflict-20260909-120000-ABCDEFG.md"),
    "---\ntitle: RAG\naliases: [retrieval]\nedges:\n  - { type: relates_to, target: agents }\n---\nthe other locus's edit");
  writeFileSync(join(root, "wiki", "agents.md"), "---\ntitle: Agents\nedges:\n  - { type: relates_to, target: retrieval }\n---\nagent loops");
  for (const name of NEAR_MISSES) writeFileSync(join(root, "wiki", name), `---\ntitle: ${name}\n---\na page that says the words`);
  return root;
}

test("both walkers skip a conflict copy and keep the near-misses", () => {
  const root = conflictedVault();
  const md = [...walkMd(root)].map((p) => p.slice(root.length + 1)).sort();
  const pages = walkPages(root).sort();
  const expected = ["wiki/agents.md", "wiki/how.sync-conflict-resolution.md", "wiki/notes.sync-conflict-20260909.md", "wiki/rag.md"];
  expect(md).toEqual(expected);
  expect(pages).toEqual(expected);
});

// The pin the plan names: a conflict file yields no node and no edge. And the reason it matters
// beyond one extra row — the copy's duplicate alias collided `retrieval` to null, so the REAL
// page's inbound alias edge dangled.
test("a conflict copy yields no node and no edge, and does not poison the alias it duplicates", async () => {
  const root = conflictedVault();
  const store = await LibsqlStore.create(new FakeEmbedder());
  try {
    const r = await indexDir(store, root, root);
    expect(r.files).toBe(4);
    const { nodeIds, edges } = await store.auditGraph();
    expect(nodeIds.sort()).toEqual(["wiki/agents", "wiki/how.sync-conflict-resolution", "wiki/notes.sync-conflict-20260909", "wiki/rag"]);
    expect(edges.filter((e) => isSyncConflict(e.source) || isSyncConflict(e.target))).toEqual([]);
    expect(edges).toEqual([{ source: "wiki/agents", type: "relates_to", target: "wiki/rag" }]);
  } finally {
    await store.close();
  }
});

test("doctor's finding: every copy on disk (any extension, scope ignored) and every conflict row the index serves", () => {
  const root = conflictedVault();
  writeFileSync(join(root, "star.sync-conflict-20260909-120000-ABCDEFG.yaml"), "meta: {}\n");
  // a star.yaml glob hides the copies from the index, never from the finding
  writeFileSync(join(root, "star.yaml"), 'memory:\n  index_scope:\n    exclude:\n      - "*.sync-conflict-*"\n      - "**/*.sync-conflict-*"\n');
  // skipped as walkMd skips them: a dot-dir, a symlinked tree, and a symlink whose OWN name is a
  // copy (the one the symlink guard decides — lstat never calls a symlink a directory, so the
  // symlinked tree is unwalked with or without it). NOT `build/`: a declared scope is never
  // extended with CONFIGLESS_EXCLUDES, so walkMd indexes pages there and a copy there is a finding.
  for (const d of [".stversions", "build"]) {
    mkdirSync(join(root, d));
    writeFileSync(join(root, d, COPY), "x");
  }
  const ext = mkdtempSync(join(tmpdir(), "funes-conflict-ext-"));
  writeFileSync(join(ext, COPY), "x");
  symlinkSync(ext, join(root, "linked"));
  symlinkSync(join(ext, COPY), join(root, "wiki", "x.sync-conflict-20260909-120000-ABCDEFG.md"));

  const finding = syncConflictFinding(root, [
    "wiki/rag", "wiki/how.sync-conflict-resolution", "wiki/rag.sync-conflict-20260909-120000-ABCDEFG", COPY.replace(/\.md$/, ""),
  ]);
  expect(finding).toEqual({
    onDisk: [`build/${COPY}`, "star.sync-conflict-20260909-120000-ABCDEFG.yaml", "wiki/rag.sync-conflict-20260909-120000-ABCDEFG.md"],
    indexed: [COPY.replace(/\.md$/, ""), "wiki/rag.sync-conflict-20260909-120000-ABCDEFG"],
  });
  expect(syncConflictFinding(mkdtempSync(join(tmpdir(), "funes-conflict-none-")), [])).toEqual({ onDisk: [], indexed: [] });
});

// The prune follows reindex's rule (cli.ts: `scope.kind === "absent"`), never its own: a configless
// vault's dependency trees are pruned, because reindex never reads a page there either.
test("doctor's finding prunes CONFIGLESS_EXCLUDES only in a configless vault, as reindex does", () => {
  const root = conflictedVault();
  for (const d of ["node_modules", "vendor"]) {
    mkdirSync(join(root, d));
    writeFileSync(join(root, d, COPY), "x");
  }
  expect(syncConflictFinding(root, []).onDisk).toEqual(["wiki/rag.sync-conflict-20260909-120000-ABCDEFG.md"]);
});

// Scope is ignored, so the walk enters trees reindex never opens: an unreadable one is skipped,
// never thrown — a throw here is doctor exiting non-zero with no report at all.
test("doctor's finding skips a directory it cannot read and still reports the rest", () => {
  const root = conflictedVault();
  writeFileSync(join(root, "star.yaml"), 'memory:\n  index_scope:\n    exclude:\n      - "locked/**"\n');
  const locked = join(root, "locked");
  mkdirSync(locked);
  writeFileSync(join(locked, COPY), "x");
  chmodSync(locked, 0o000);
  try {
    expect(syncConflictFinding(root, []).onDisk).toEqual(["wiki/rag.sync-conflict-20260909-120000-ABCDEFG.md"]);
  } finally {
    chmodSync(locked, 0o700);
  }
});
