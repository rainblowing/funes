// manifest-v3 read path and the owner-vault marker, the index directory's guard (PRD 2026-08-27, RAI-42, RAI-311).
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readStarIdentity, assertIndexOwner } from "./factory.ts";
import { DEFAULT_STAR_CAPABILITIES } from "funes-core/internal";

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
    expect(readStarIdentity(s.vault).okfInvalid).toBeNull();
  } finally { s.cleanup(); }
  const bad = scratch('version: 3\nmeta:\n  id: git://example.org/engine\nmemory:\n  okf: "2.0"\n  graph: "yes"\n');
  try {
    expect(readStarIdentity(bad.vault).capabilities).toEqual(DEFAULT_STAR_CAPABILITIES);
    expect(readStarIdentity(bad.vault).okfInvalid).toBe('"2.0"'); // …and says so (RAI-45)
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

test("RAI-311: the marker accepts the star's meta.id_was and upgrades in place (`twinkling star reid` needs no marker layer)", () => {
  const s = scratch("meta:\n  name: notes\n  id: dropbox://example.org/vault/notes\n  constellation: example-org\n");
  try {
    assertIndexOwner(s.indexDir, s.vault);
    // A reid writes the new id and keeps the old one as id_was.
    writeFileSync(join(s.vault, "star.yaml"), "meta:\n  name: notes\n  id: git://example.net/notes\n  id_was: dropbox://example.org/vault/notes\n  constellation: example-org\n");
    expect(() => assertIndexOwner(s.indexDir, s.vault)).not.toThrow();
    expect(marker(s.indexDir).id).toBe("git://example.net/notes");
    expect(marker(s.indexDir).star).toBe("notes");
    // Without id_was the same change is another star, and refuses.
    const t = scratch("meta:\n  name: notes\n  id: dropbox://example.org/vault/notes\n");
    try {
      assertIndexOwner(t.indexDir, t.vault);
      writeFileSync(join(t.vault, "star.yaml"), "meta:\n  name: notes\n  id: git://example.net/notes\n");
      expect(() => assertIndexOwner(t.indexDir, t.vault)).toThrow(/index collision/);
    } finally { t.cleanup(); }
  } finally { s.cleanup(); }
});

test("RAI-311: a basename collision refuses and names a folder rename, never a retired variable", () => {
  const s = scratch("meta:\n  name: engine\n  id: git://example.org/engine\n");
  try {
    assertIndexOwner(s.indexDir, s.vault);
    writeFileSync(join(s.vault, "star.yaml"), "meta:\n  name: other\n  id: git://example.net/engine\n");
    expect(() => assertIndexOwner(s.indexDir, s.vault)).toThrow(/rename/i);
    expect(() => assertIndexOwner(s.indexDir, s.vault)).not.toThrow(/FUNES_LIBSQL_DIR/);
  } finally { s.cleanup(); }
  const p = scratch(); // id-less: the path fallback
  try {
    writeFileSync(join(p.indexDir, "owner-vault"), "/some/other/vault\n");
    expect(() => assertIndexOwner(p.indexDir, p.vault)).toThrow(/rename/i);
    expect(() => assertIndexOwner(p.indexDir, p.vault)).not.toThrow(/FUNES_LIBSQL_DIR/);
  } finally { p.cleanup(); }
});

// Integration review (2026-09-26): twinkling's validator reads `okf: ~` (YAML null) as the default,
// so funes must not call it invalid.
test("RAI-45: memory.okf null is the default, not an invalid value", () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-okf-null-"));
  writeFileSync(join(vault, "star.yaml"), "meta:\n  id: git://example.com/s\nmemory:\n  okf: ~\n");
  const id = readStarIdentity(vault);
  expect(id.okfInvalid).toBeNull();
  expect(id.capabilities.okf).toBe("0.2");
});
