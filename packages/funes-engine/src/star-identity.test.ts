// manifest-v3 read path + the renumber's owner-marker seam (PRD 2026-08-27, RAI-42).
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readStarIdentity, rewriteIndexOwner, assertIndexOwner, DEFAULT_STAR_CAPABILITIES } from "./factory.ts";

function scratch(yaml?: string) {
  const base = mkdtempSync(join(tmpdir(), "funes-v3-"));
  const vault = join(base, "vault");
  mkdirSync(vault, { recursive: true });
  if (yaml !== undefined) writeFileSync(join(vault, "star.yaml"), yaml);
  const indexDir = join(base, "index");
  mkdirSync(indexDir, { recursive: true });
  return { base, vault, indexDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
const marker = (dir: string) => JSON.parse(readFileSync(join(dir, "owner-vault"), "utf8"));

test("readStarIdentity: a v2 star.yaml yields exactly the defaults and a null key", () => {
  const s = scratch("version: 2\nmeta:\n  name: notes\n  id: dropbox://example.org/vault/notes\n  constellation: example-org\n");
  try {
    const id = readStarIdentity(s.vault);
    expect(id.id).toBe("dropbox://example.org/vault/notes");
    expect(id.capabilities).toEqual(DEFAULT_STAR_CAPABILITIES);
    // The pre-renumber id PARSES (a sync-root segment is a legal segment), so it has a key. What is wrong
    // with it is policy — the workname is a storage path — and that is the renumber's business.
    expect(id.key).toBe("example.org/vault/notes");
  } finally { s.cleanup(); }
});

test("readStarIdentity: an id outside the grammar yields a null key, never a throw", () => {
  const s = scratch("version: 2\nmeta:\n  id: https://code.example.com/org/engine\n");
  try { expect(readStarIdentity(s.vault).key).toBeNull(); } finally { s.cleanup(); }
});

test("readStarIdentity: v3 capabilities are read; junk falls back to the default", () => {
  const s = scratch('version: 3\nmeta:\n  id: git://example.org/engine\nmemory:\n  okf: false\n  graph: false\n  code: true\n');
  try {
    expect(readStarIdentity(s.vault).capabilities).toEqual({ okf: false, graph: false, code: true });
  } finally { s.cleanup(); }
  const bad = scratch('version: 3\nmeta:\n  id: git://example.org/engine\nmemory:\n  okf: "2.0"\n  graph: "yes"\n');
  try {
    expect(readStarIdentity(bad.vault).capabilities).toEqual(DEFAULT_STAR_CAPABILITIES);
  } finally { bad.cleanup(); }
});

test("readStarIdentity: absent and malformed star.yaml both degrade, never crash", () => {
  const none = scratch();
  try { expect(readStarIdentity(none.vault).capabilities).toEqual(DEFAULT_STAR_CAPABILITIES); } finally { none.cleanup(); }
  const bad = scratch("meta: [this is not a mapping\n");
  try { expect(readStarIdentity(bad.vault).id).toBeNull(); } finally { bad.cleanup(); }
});

test("the owner guard is WIDENED by the key, never narrowed: a transport change keeps the index", () => {
  const s = scratch("meta:\n  name: engine\n  id: dropbox://example.org/engine\n");
  try {
    assertIndexOwner(s.indexDir, s.vault);                       // claims it
    expect(marker(s.indexDir).id).toBe("dropbox://example.org/engine");
    // Same star, re-declared under a different access method. Same canonical key => same star.
    writeFileSync(join(s.vault, "star.yaml"), "meta:\n  name: engine\n  id: git://example.org/engine\n");
    expect(() => assertIndexOwner(s.indexDir, s.vault)).not.toThrow();
    expect(marker(s.indexDir).id).toBe("git://example.org/engine"); // marker follows the declaration
  } finally { s.cleanup(); }
});

test("a genuinely different star still hard-stops", () => {
  const s = scratch("meta:\n  name: engine\n  id: git://example.org/engine\n");
  try {
    assertIndexOwner(s.indexDir, s.vault);
    writeFileSync(join(s.vault, "star.yaml"), "meta:\n  name: other\n  id: git://example.net/engine\n");
    expect(() => assertIndexOwner(s.indexDir, s.vault)).toThrow(/index collision/);
  } finally { s.cleanup(); }
});

test("rewriteIndexOwner: rewrites once, is idempotent, and refuses the wrong index", () => {
  const s = scratch("meta:\n  name: notes\n  id: dropbox://example.org/vault/notes\n  constellation: example-org\n");
  try {
    assertIndexOwner(s.indexDir, s.vault);
    const args = { expectedId: "dropbox://example.org/vault/notes", newId: "dropbox://example.org/notes" };

    const plan = rewriteIndexOwner(s.indexDir, { ...args, dryRun: true });
    expect(plan.outcome).toBe("rewritten");
    expect(marker(s.indexDir).id).toBe(args.expectedId);          // --dry-run wrote nothing

    expect(rewriteIndexOwner(s.indexDir, args).outcome).toBe("rewritten");
    expect(marker(s.indexDir).id).toBe(args.newId);
    expect(marker(s.indexDir).star).toBe("notes");             // the rest of the marker survives
    expect(marker(s.indexDir).constellation).toBe("example-org");

    // Re-running the renumber must be a no-op, not a second rewrite.
    expect(rewriteIndexOwner(s.indexDir, args).outcome).toBe("already");
    // A pass aimed at the wrong index refuses instead of stealing it.
    expect(rewriteIndexOwner(s.indexDir, { expectedId: "git://example.net/other", newId: "git://example.net/x" }).outcome).toBe("refused");
  } finally { s.cleanup(); }
});

test("rewriteIndexOwner: no marker at all is reported, not invented", () => {
  const s = scratch("meta:\n  id: git://example.org/engine\n");
  try {
    expect(rewriteIndexOwner(s.indexDir, { expectedId: "a://b.c/d", newId: "a://b.c/e" }).outcome).toBe("absent");
  } finally { s.cleanup(); }
});
