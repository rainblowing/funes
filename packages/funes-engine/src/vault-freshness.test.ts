import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vaultNewerThan } from "./reindex.ts";

// "Did I change notes since the last reindex?" is the only staleness question worth asking. Age
// alone nags about vaults nobody has touched; this fires exactly when recall is answering from an
// index that predates the notes it cites — the case that makes an agent confidently cite content
// the vault has already superseded.
const vault = () => mkdtempSync(join(tmpdir(), "funes-fresh-"));
const note = (dir: string, rel: string, mtimeSec: number) => {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "---\ntitle: T\n---\nbody\n");
  utimesSync(p, mtimeSec, mtimeSec);
};

test("a note edited after the reindex is detected", () => {
  const v = vault();
  note(v, "a.md", 2000);
  expect(vaultNewerThan(v, 1000 * 1000)).toBe(true);   // note at 2000s, indexed at 1000s
  rmSync(v, { recursive: true, force: true });
});

test("an untouched vault is quiet", () => {
  const v = vault();
  note(v, "a.md", 1000);
  note(v, "nested/b.md", 1500);
  expect(vaultNewerThan(v, 3000 * 1000)).toBe(false);
  rmSync(v, { recursive: true, force: true });
});

test("it finds the change wherever it is, including nested", () => {
  const v = vault();
  note(v, "a.md", 1000);
  note(v, "deep/deeper/c.md", 9000);
  expect(vaultNewerThan(v, 5000 * 1000)).toBe(true);
  rmSync(v, { recursive: true, force: true });
});

test("it inherits walkMd's rules — dot-dirs and symlinks are not the vault", () => {
  const v = vault();
  note(v, "a.md", 1000);
  // the index itself lives in a dot-dir; if it counted, every query after a reindex would warn
  // about the reindex it just did.
  note(v, ".funes/derived.md", 9999);
  const outside = mkdtempSync(join(tmpdir(), "funes-outside-"));
  note(outside, "linked.md", 9999);
  symlinkSync(join(outside, "linked.md"), join(v, "linked.md"));
  expect(vaultNewerThan(v, 5000 * 1000)).toBe(false);
  rmSync(v, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
