import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile, patchFrontmatter, writeMemoryItem } from "./write.ts";

// P3.15: the canonical markdown IS the source of truth (D7) — the index is derived and rebuildable,
// this file is not. Both write paths used to `writeFileSync` in place, so a crash, a full disk, or a
// kill mid-write left a truncated or empty file where the memory used to be.

const vault = () => mkdtempSync(join(tmpdir(), "funes-atomic-"));

test("atomicWriteFile round-trips and leaves no temp files behind", () => {
  const dir = vault();
  try {
    const f = join(dir, "note.md");
    atomicWriteFile(f, "first\n");
    atomicWriteFile(f, "second\n");
    expect(readFileSync(f, "utf8")).toBe("second\n");
    expect(readdirSync(dir)).toEqual(["note.md"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a failed write leaves the ORIGINAL intact and cleans up its temp", () => {
  const dir = vault();
  const sub = join(dir, "ro");
  try {
    mkdirSync(sub);
    const f = join(sub, "note.md");
    atomicWriteFile(f, "original\n");
    chmodSync(sub, 0o500); // no writes in this directory -> the temp open fails
    expect(() => atomicWriteFile(f, "replacement\n")).toThrow();
    chmodSync(sub, 0o700);
    expect(readFileSync(f, "utf8")).toBe("original\n"); // not truncated, not empty
    expect(readdirSync(sub)).toEqual(["note.md"]);      // no orphan temp
  } finally { chmodSync(sub, 0o700); rmSync(dir, { recursive: true, force: true }); }
});

// The mechanism guard. Replace-by-rename gives the target a NEW inode every time; truncate-in-place
// keeps the same one. That difference is exactly what makes a reader or a crash safe, and unlike a
// kill-timing test it is deterministic — verified to fail when atomicWriteFile is reverted to
// writeFileSync. (A SIGKILL test was tried first and dropped: even at 24 MB it passed against the
// old code on macOS, so it asserted nothing.)
test("each write replaces the file by rename — the inode changes, it is never truncated in place", () => {
  const dir = vault();
  try {
    const f = join(dir, "note.md");
    atomicWriteFile(f, "one\n");
    const first = statSync(f).ino;
    atomicWriteFile(f, "two\n");
    const second = statSync(f).ino;
    expect(second).not.toBe(first);
    expect(readFileSync(f, "utf8")).toBe("two\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("patchFrontmatter and writeMemoryItem both go through the atomic path", () => {
  const dir = vault();
  try {
    mkdirSync(join(dir, "out_memory"));
    const meta = { created: "2026-01-01", updated: "2026-01-01", trust: "untrusted" as const };
    writeMemoryItem(dir, { id: "out_memory/x", title: "X", body: "hello" }, meta);
    patchFrontmatter(dir, "out_memory/x", { trust: "trusted" });
    expect(readFileSync(join(dir, "out_memory/x.md"), "utf8")).toContain("trust: trusted");
    // a crash-orphaned temp would be a dotfile, which walkMd skips — so it can never be indexed
    expect(readdirSync(join(dir, "out_memory")).filter((n) => !n.startsWith("."))).toEqual(["x.md"]);
    expect(existsSync(join(dir, "out_memory/x.md"))).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
