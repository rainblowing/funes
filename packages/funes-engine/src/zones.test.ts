import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Embedder } from "funes-core";
import { zoneOfDir, zoneOfFile, memoryZoneOf } from "funes-shared";
import { walkMd } from "./reindex.ts";
import { fileToItem } from "./markdown.ts";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";
import { FunesStore } from "./funes-store.ts";

// ── zone resolution (vault-v2 brief T1.1 — THE trust-regression gate) ────────────────────

test("zoneOfFile: in_* at any depth and the raw/ container are incoming; filenames never count", () => {
  expect(zoneOfFile("in_telegram/x.md")).toBe("incoming"); // legacy top-level
  expect(zoneOfFile("raw/in_telegram/x.md")).toBe("incoming"); // v2 container
  expect(zoneOfFile("raw/stray.md")).toBe("incoming"); // stray directly under raw/
  expect(zoneOfFile("raw/in_dropbox/2025/deep/x.md")).toBe("incoming"); // nested
  expect(zoneOfFile("projects/in_progress.md")).toBe("wiki"); // FILE named in_* is not a zone
  expect(zoneOfFile("projects/client/in_briefs/x.md")).toBe("incoming"); // in_* dir inside wiki
  expect(zoneOfFile("wiki/page.md")).toBe("wiki");
  expect(zoneOfFile("top.md")).toBe("wiki");
});

test("zoneOfFile/zoneOfDir: out zones — out_* at any depth and the out/ container", () => {
  expect(zoneOfFile("out_memory/x.md")).toBe("output"); // legacy
  expect(zoneOfFile("out/out_memory/x.md")).toBe("output"); // v2
  expect(zoneOfFile("out/stray.md")).toBe("output");
  expect(zoneOfFile("projects/mindslop/out_decks/d.md")).toBe("output"); // project-attributed
  expect(zoneOfDir("raw/out_weird")).toBe("incoming"); // deny-biased: incoming wins
});

test("trust default follows the zone: raw/in_* untrusted, wiki trusted, explicit frontmatter wins", () => {
  const root = mkdtempSync(join(tmpdir(), "funes-zones-"));
  mkdirSync(join(root, "raw/in_tg"), { recursive: true });
  mkdirSync(join(root, "wiki"), { recursive: true });
  writeFileSync(join(root, "raw/in_tg/dump.md"), "---\ntitle: D\n---\nbody");
  writeFileSync(join(root, "raw/in_tg/elevated.md"), "---\ntitle: E\ntrust: trusted\n---\nbody");
  writeFileSync(join(root, "wiki/page.md"), "---\ntitle: W\n---\nbody");
  expect(fileToItem(join(root, "raw/in_tg/dump.md"), root).trust).toBe("untrusted");
  expect(fileToItem(join(root, "raw/in_tg/elevated.md"), root).trust).toBe("trusted"); // frontmatter canonical
  expect(fileToItem(join(root, "wiki/page.md"), root).trust).toBe("trusted");
  rmSync(root, { recursive: true, force: true });
});

// ── walkMd: symlinks invisible; exclude predicate prunes ─────────────────────────────────

test("walkMd skips symlinks and honors the exclude predicate (dirs pruned with trailing /)", () => {
  const root = mkdtempSync(join(tmpdir(), "funes-walk-"));
  mkdirSync(join(root, "wiki"), { recursive: true });
  mkdirSync(join(root, "raw/in_big"), { recursive: true });
  const outside = mkdtempSync(join(tmpdir(), "funes-outside-"));
  writeFileSync(join(outside, "linked.md"), "---\ntitle: L\n---\nx");
  writeFileSync(join(root, "wiki/keep.md"), "---\ntitle: K\n---\nx");
  writeFileSync(join(root, "raw/in_big/drop.md"), "---\ntitle: X\n---\nx");
  symlinkSync(outside, join(root, "assets")); // symlinked dir → invisible
  symlinkSync(join(outside, "linked.md"), join(root, "wiki/link.md")); // symlinked file → invisible

  const seenDirs: string[] = [];
  const exclude = (rel: string) => {
    if (rel.endsWith("/")) seenDirs.push(rel);
    return rel === "raw/in_big/" || rel.startsWith("raw/in_big/");
  };
  const rels = [...walkMd(root, { exclude })].map((f) => relative(root, f));
  expect(rels).toEqual(["wiki/keep.md"]);
  expect(seenDirs).toContain("raw/in_big/"); // dir offered for pruning with trailing slash
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

// ── memory zone: layout-detected; assertOwned never widens ──────────────────────────────

class Fake implements Embedder {
  readonly dim = 16;
  readonly id = "fake-v1";
  private vec(t: string) {
    const v = new Float32Array(this.dim);
    for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) v[[...w].reduce((a, c) => a + c.charCodeAt(0), 0) % this.dim]! += 1;
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i]! /= n;
    return v;
  }
  async embedQuery(t: string) { return this.vec(t); }
  async embedPassage(t: string) { return this.vec(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.vec(t)); }
}

test("memoryZoneOf: out/ container flips the agent-memory zone; FunesStore writes there and guards it", async () => {
  const legacy = mkdtempSync(join(tmpdir(), "funes-mz-legacy-"));
  expect(memoryZoneOf(legacy)).toBe("out_memory");

  const v2 = mkdtempSync(join(tmpdir(), "funes-mz-v2-"));
  mkdirSync(join(v2, "out"), { recursive: true });
  expect(memoryZoneOf(v2)).toBe("out/out_memory");

  const store = new FunesStore(await LibsqlStore.create(new Fake()), { root: v2, now: () => "2026-06-12T00:00:00Z" });
  const { ids } = await store.remember([{ title: "V2 item", body: "lives in the container" }]);
  expect(ids[0]!.startsWith("out/out_memory/")).toBe(true);
  await store.forget(ids[0]!); // owned under the v2 zone → ok

  // the guard tracks the ACTIVE zone only — legacy zone ids and raw/ are rejected
  await expect(store.forget("out_memory/legacy-id")).rejects.toThrow(/only items under out\/out_memory/);
  await expect(store.forget("raw/in_tg/dump")).rejects.toThrow(/only items under out\/out_memory/);
  await store.close();
  rmSync(legacy, { recursive: true, force: true });
  rmSync(v2, { recursive: true, force: true });
});
