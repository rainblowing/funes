import { test, expect } from "bun:test";
import { parseStarUri, parseCanonicalKey, isCanonicalKey, canonicalKey, refKey, sameStar, formatStarUri, MAX_WORKNAME_DEPTH } from "./star-uri.ts";
import fixture from "./__fixtures__/identity-conformance.json";

// The fixture IS the contract (D12): twinkling runs this same file against the same parser, so a
// grammar change that only passes here has not landed. Everything below drives off it — the
// hand-written tests underneath cover only what a table cannot say.

test("conformance: every accepted form parses to its declared key", () => {
  for (const c of fixture.accepted) {
    const r = parseStarUri(c.uri);
    if (!r.ok) throw new Error(`${c.uri} rejected as ${r.reason} (${r.detail}) — expected key ${c.key}`);
    expect(r.uri.key).toBe(c.key);
    expect(r.uri.access).toBe(c.access as typeof r.uri.access);
    expect(r.uri.path).toEqual(c.path);
    expect(r.uri.params).toBe((c as { params?: string }).params ?? "");
  }
});

test("conformance: every rejected form fails with its declared reason", () => {
  for (const c of fixture.rejected) {
    const r = parseStarUri(c.uri);
    if (r.ok) throw new Error(`${c.uri} was ACCEPTED as ${r.uri.key} — expected rejection ${c.reason}`);
    expect(`${c.uri} -> ${r.reason}`).toBe(`${c.uri} -> ${c.reason}`);
  }
});

test("conformance: the bare canonical key runs the same rules as the URI", () => {
  for (const c of fixture.canonicalKeys) {
    const r = parseCanonicalKey(c.in);
    expect(`${JSON.stringify(c.in)} -> ${r.ok ? r.key : null}`).toBe(`${JSON.stringify(c.in)} -> ${c.key}`);
    expect(isCanonicalKey(c.in)).toBe(c.key !== null);
  }
});

test("the two forms cannot drift: every accepted URI's key parses back as a canonical key", () => {
  // The shared parseDomainAndPath is what guarantees this. If someone ever forks the two paths,
  // this test is the one that notices — a key the key-parser rejects is not a storage key.
  for (const c of fixture.accepted) {
    expect(`${c.uri} -> ${parseCanonicalKey(c.key).ok}`).toBe(`${c.uri} -> true`);
    expect(refKey(c.key)).toBe(c.key);
    expect(refKey(c.uri)).toBe(c.key);
  }
});

test("conformance: sameStar agrees with the table", () => {
  for (const c of fixture.sameStar) expect(`${c.a} ~ ${c.b}: ${sameStar(c.a, c.b)}`).toBe(`${c.a} ~ ${c.b}: ${c.equal}`);
});

test("conformance: the retired forms still PARSE — the renumber retires them, not the grammar", () => {
  for (const c of fixture.legalButRetired) {
    const r = parseStarUri(c.uri);
    if (!r.ok) throw new Error(`${c.uri} rejected as ${r.reason} — the parser must not encode policy`);
    expect(r.uri.key).toBe(c.key);
  }
});

// ── what the table cannot say ────────────────────────────────────────────────

test("the key is scheme-free: every access method over one workname yields one key", () => {
  const keys = new Set(["dropbox", "git", "mcp", "file"].map((a) => canonicalKey(`${a}://example.net/ledger`)));
  expect(keys).toEqual(new Set(["example.net/ledger"]));
});

test("canonicalKey returns null rather than throwing on junk", () => {
  expect(canonicalKey("local-only")).toBeNull();
  expect(canonicalKey("")).toBeNull();
  expect(canonicalKey("   ")).toBeNull();
});

test("sameStar refuses to match two unparsable refs to each other", () => {
  expect(sameStar("local-only", "local-only")).toBe(false);
});

test("surrounding whitespace is trimmed, inner whitespace is not", () => {
  expect(canonicalKey("  git://example.org/engine  ")).toBe("example.org/engine");
  expect(canonicalKey("git://example.org/eng ine")).toBeNull();
});

test("formatStarUri round-trips through the parser, params included", () => {
  const r = parseStarUri("mcp://example.net/atlas/inventory?rev=2");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const rendered = formatStarUri(r.uri.access, r.uri.key, r.uri.params);
  expect(rendered).toBe("mcp://example.net/atlas/inventory?rev=2");
  expect(canonicalKey(rendered)).toBe(r.uri.key);
});

test("formatStarUri tolerates a params string that already carries its ?", () => {
  expect(formatStarUri("git", "example.org/engine", "?a=1")).toBe("git://example.org/engine?a=1");
  expect(formatStarUri("git", "example.org/engine")).toBe("git://example.org/engine");
});

test("re-rendering under a different access method preserves the key", () => {
  const key = canonicalKey("dropbox://example.org/notes")!;
  expect(sameStar(formatStarUri("git", key), "dropbox://example.org/notes")).toBe(true);
});

test("the depth cap is exactly MAX_WORKNAME_DEPTH", () => {
  const seg = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`).join("/");
  expect(parseStarUri(`git://example.net/${seg(MAX_WORKNAME_DEPTH)}`).ok).toBe(true);
  const over = parseStarUri(`git://example.net/${seg(MAX_WORKNAME_DEPTH + 1)}`);
  expect(over.ok).toBe(false);
  if (!over.ok) expect(over.reason).toBe("too-deep");
});

test("rejection order is stable: the most specific structural fault wins", () => {
  // One string, four faults. The reported reason must not drift between releases, because
  // callers turn it into a stable diagnostic (funes catalogue) and an operator reads it.
  const r = parseStarUri("ssh://git@host.example:22/A/../b/c/d/e#f");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe("has-fragment");
  const noFrag = parseStarUri("ssh://git@host.example:22/A");
  if (!noFrag.ok) expect(noFrag.reason).toBe("has-userinfo");
  const noUser = parseStarUri("ssh://host.example:22/A");
  if (!noUser.ok) expect(noUser.reason).toBe("has-port");
  const noPort = parseStarUri("ssh://host.example/A");
  if (!noPort.ok) expect(noPort.reason).toBe("unknown-access");
});
