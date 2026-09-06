// PLAN-0.2.1 Phase 4 (steps 25-27). The twinkling suite ported across, plus the properties v0.2 and
// the transactional promotion added: the timestamp rule, the sources mapping, the honest actor, the
// fail-closed secret gate, and the guarantee that a failed export leaves the previous bundle alone.
import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, resolve } from "node:path";
import { parseFrontmatter } from "./markdown.ts";
import { buildScopeExclude } from "./scope.ts";
import {
  exportOkf, walkPages, pageToOkfConcept, assertSafeOutDir, assertReplaceableTarget,
  okfDefaultOutDir, dumpFrontmatter, isOkfInstant, mapSources, urlSourceId, scanBundle,
} from "./okf-export.ts";

const dump = dumpFrontmatter;
const read = (p: string) => parseFrontmatter(readFileSync(p, "utf8"));
const scratch = (tag: string) => mkdtempSync(join(tmpdir(), `okf-${tag}-`));

// The lock lives under ~/.twinkling/locks by default; a test suite must not contend with the real
// estate for it, nor leave lock dirs behind in the user's home.
beforeEach(() => { process.env.FUNES_LOCK_DIR = scratch("locks"); });

function makeVault(): string {
  const root = scratch("vault");
  mkdirSync(join(root, "notes"), { recursive: true });
  // A non-OKF-shaped index.md (has frontmatter) — must be regenerated, not copied.
  writeFileSync(join(root, "index.md"), dump({ title: "root", kind: "index" }, "| old | table |\n"));
  writeFileSync(
    join(root, "notes/alpha.md"),
    dump(
      { title: "Alpha", type: "note", tags: ["x"], trust: "trusted", created: "2026-01-01", updated: "2026-06-30" },
      "See [[beta]] and [[notes/beta|Bee]] and [[ghost]].",
    ),
  );
  writeFileSync(join(root, "notes/beta.md"), dump({ title: "Beta", type: "reference", updated: "2026-06-01" }, "b"));
  // A page with NO type — the exporter must default it (conformance rule 2).
  writeFileSync(join(root, "notes/gamma.md"), dump({ title: "Gamma" }, "g"));
  return root;
}

// ── ported: the properties v0.1 already had ───────────────────────────────────────────────────

test("concept mapping preserves the funes superset and converts wikilinks", async () => {
  const root = makeVault();
  const out = join(scratch("out"), "bundle");
  const res = await exportOkf(root, out);
  expect(res.concepts).toBe(3); // alpha, beta, gamma — index.md is reserved

  const alpha = read(join(out, "notes/alpha.md"));
  expect(alpha.data.type).toBe("note");
  expect(alpha.data.trust).toBe("trusted");      // funes key preserved as an extension
  expect(alpha.data.created).toBe("2026-01-01"); // original keys still round-trip
  expect(alpha.body).toContain("[beta](./beta.md)");
  expect(alpha.body).toContain("[Bee](./beta.md)");
  expect(alpha.body).toContain("[[ghost]]");     // unresolvable → left untouched, never a dead link
});

test("conformance: every non-reserved page has a non-empty type", async () => {
  const root = makeVault();
  const out = join(scratch("out"), "bundle");
  await exportOkf(root, out);
  for (const rel of walkPages(out)) {
    if (basename(rel) === "index.md" || basename(rel) === "log.md") continue;
    const { data } = read(join(out, rel));
    expect(typeof data.type).toBe("string");
    expect((data.type as string).length).toBeGreaterThan(0);
  }
  expect(read(join(out, "notes/gamma.md")).data.type).toBe("note"); // defaulted
});

test("reserved index.md — the root carries the marker, a non-root index carries no frontmatter", async () => {
  const root = makeVault();
  const out = join(scratch("out"), "bundle");
  await exportOkf(root, out, { starId: "dropbox://example.org/notes" });

  const rootIdx = read(join(out, "index.md"));
  expect(rootIdx.data.okf_version).toBe("0.2");
  expect(rootIdx.data.okf_star_id).toBe("dropbox://example.org/notes");
  expect(Object.keys(rootIdx.data)).toEqual(["okf_version", "okf_star_id"]); // no leftover funes frontmatter
  expect(rootIdx.body).toContain("[notes/](notes/index.md)");

  const notesIdx = read(join(out, "notes/index.md"));
  expect(Object.keys(notesIdx.data).length).toBe(0);
  expect(notesIdx.body).toContain("[alpha](alpha.md)");
});

test("traversal and absolute wikilink targets are never silently resolved", async () => {
  const root = scratch("trav");
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub/a.md"), dump({ title: "A", type: "note" }, "x [[../../etc/passwd]] y [[/abs/x]]"));
  const out = join(scratch("out"), "bundle");
  await exportOkf(root, out);
  const body = read(join(out, "sub/a.md")).body;
  expect(body).toContain("[[../../etc/passwd]]");
  expect(body).toContain("[[/abs/x]]");
});

test("walkPages does not follow symlinked dirs — no external leak, no loop", () => {
  const root = scratch("sym");
  const ext = scratch("ext");
  writeFileSync(join(ext, "leak.md"), dump({ title: "Leak", type: "note" }, "outside"));
  writeFileSync(join(root, "real.md"), dump({ title: "Real", type: "note" }, "ok"));
  symlinkSync(ext, join(root, "linked"));
  const pages = walkPages(root);
  expect(pages).toContain("real.md");
  expect(pages.some((p) => p.includes("linked"))).toBe(false);
});

test("assertSafeOutDir — the destructive-target guard", async () => {
  const root = makeVault();
  expect(() => assertSafeOutDir(root, root)).toThrow(/vault root or an ancestor/);
  expect(() => assertSafeOutDir(join(root, ".."), root)).toThrow(/vault root or an ancestor/);
  const precious = scratch("precious");
  writeFileSync(join(precious, "keep-me.md"), "irreplaceable");
  expect(() => assertSafeOutDir(precious, root)).toThrow(/not a previous OKF bundle/);
  expect(existsSync(join(precious, "keep-me.md"))).toBe(true);
  expect(() => assertSafeOutDir(join(precious, "new-sub"), root)).not.toThrow();
  expect(() => assertSafeOutDir(scratch("empty"), root)).not.toThrow();
});

test("a non-bundle target is refused end-to-end, and nothing in it is touched", async () => {
  const root = makeVault();
  const precious = scratch("precious2");
  writeFileSync(join(precious, "keep-me.md"), "irreplaceable");
  await expect(exportOkf(root, precious)).rejects.toThrow(/not a previous OKF bundle/);
  expect(readFileSync(join(precious, "keep-me.md"), "utf8")).toBe("irreplaceable");
});

test("index_scope is honored — de-indexed is de-exported", async () => {
  const root = makeVault();
  mkdirSync(join(root, "raw/in_secret"), { recursive: true });
  writeFileSync(join(root, "raw/in_secret/dump.md"), dump({ title: "Dump", type: "note" }, "quarantined"));
  writeFileSync(join(root, "notes/skipme.md"), dump({ title: "Skip", type: "note" }, "excluded file"));
  const out = join(scratch("out"), "bundle");
  await exportOkf(root, out, { exclude: buildScopeExclude(["raw/in_secret/**", "notes/skipme.md"]) });
  expect(existsSync(join(out, "raw/in_secret/dump.md"))).toBe(false); // dir pruned
  expect(existsSync(join(out, "notes/skipme.md"))).toBe(false);       // file excluded
  expect(existsSync(join(out, "notes/alpha.md"))).toBe(true);
});

test(".summary.md derivatives are skipped — the walkMd index view", async () => {
  const root = makeVault();
  writeFileSync(join(root, "notes/alpha.summary.md"), dump({ title: "AlphaSum", type: "note" }, "derived"));
  const out = join(scratch("out"), "bundle");
  await exportOkf(root, out);
  expect(existsSync(join(out, "notes/alpha.summary.md"))).toBe(false);
});

test("the default out dir is in-star out_okf, and FUNES_OKF_DIR restores the off-vault home", () => {
  const root = makeVault();
  delete process.env.FUNES_OKF_DIR;
  expect(okfDefaultOutDir(root)).toBe(join(resolve(root), "out_okf"));
  process.env.FUNES_OKF_DIR = "/tmp/okf-home";
  expect(okfDefaultOutDir(root)).toBe(join("/tmp/okf-home", basename(root)));
  delete process.env.FUNES_OKF_DIR;
});

// ── step 25: tombstones ───────────────────────────────────────────────────────────────────────

test("a tombstoned page is off the index, so it is off the bundle", async () => {
  const root = scratch("tomb");
  writeFileSync(join(root, "live.md"), dump({ title: "Live", type: "note" }, "here"));
  writeFileSync(join(root, "gone.md"), dump({ title: "Gone", type: "note", forgotten: true }, "retired"));
  writeFileSync(join(root, "old.md"), dump({ title: "Old", type: "note", superseded_by: "live" }, "replaced"));
  const out = join(scratch("out"), "bundle");
  const res = await exportOkf(root, out);
  expect(res.concepts).toBe(1);
  expect(existsSync(join(out, "live.md"))).toBe(true);
  expect(existsSync(join(out, "gone.md"))).toBe(false);
  expect(existsSync(join(out, "old.md"))).toBe(false);
});

// ── step 27: the v0.2 value rules ─────────────────────────────────────────────────────────────

test("a timestamp is emitted ONLY for a datetime with an explicit offset (§5)", () => {
  expect(isOkfInstant("2026-06-30T12:00:00Z")).toBe(true);
  expect(isOkfInstant("2026-06-30T12:00:00+03:00")).toBe(true);
  expect(isOkfInstant("2026-06-30")).toBe(false);          // valid ISO-8601, NOT a valid OKF timestamp
  expect(isOkfInstant("2026-06-30T12:00:00")).toBe(false); // naive — no offset
  expect(isOkfInstant(20260630)).toBe(false);

  const pages = new Set<string>();
  const idx = new Map<string, string | null>();
  // date-only: no timestamp, and the date is NOT lost — it stays on the key it rode in on.
  const dateOnly = pageToOkfConcept({ type: "note", updated: "2026-06-30", created: "2026-01-01" }, "b", "a.md", pages, idx);
  const d = parseFrontmatter(dateOnly.text).data;
  expect(d.timestamp).toBeUndefined();
  expect(d.updated).toBe("2026-06-30");
  expect(d.created).toBe("2026-01-01");
  // an explicit-offset value is emitted
  const withOffset = pageToOkfConcept({ type: "note", updated: "2026-06-30T12:00:00Z" }, "b", "a.md", pages, idx);
  expect(parseFrontmatter(withOffset.text).data.timestamp).toBe("2026-06-30T12:00:00Z");
  // a date-only `timestamp` may not masquerade as an OKF one, and is still carried
  const legacyTs = pageToOkfConcept({ type: "note", timestamp: "2025-12-31" }, "b", "a.md", pages, idx);
  const l = parseFrontmatter(legacyTs.text).data;
  expect(l.timestamp).toBeUndefined();
  expect(l.funes_timestamp).toBe("2025-12-31");
});

test("sources: v0.2 objects pass through, ids and URLs are mapped, prose is preserved and reported", () => {
  const pages = new Set(["notes/beta.md"]);
  const idx = new Map<string, string | null>([["beta", "notes/beta.md"]]);
  const m = mapSources(
    [{ id: "already", resource: "https://x.test/a" }, "[[beta]]", "https://example.test/paper.pdf", "some prose I wrote"],
    pages, idx,
  );
  expect(m.sources).toEqual([
    { id: "already", resource: "https://x.test/a" },
    { id: "beta", resource: "/notes/beta.md" },          // ABSOLUTE — the one place it is allowed
    { id: "example-test-paper-pdf", resource: "https://example.test/paper.pdf" },
  ]);
  expect(m.unresolved).toEqual(["some prose I wrote"]);
  expect(urlSourceId("https://example.test/paper.pdf")).toBe("example-test-paper-pdf");

  const r = pageToOkfConcept({ type: "note", sources: ["nowhere at all"] }, "b", "a.md", pages, idx);
  expect(parseFrontmatter(r.text).data.funes_sources_unresolved).toEqual(["nowhere at all"]);
  expect(r.warnings[0]).toContain("neither a resolvable id nor a URL");
});

test("status normalizes only the three the spec names; a legacy value rides as an extension", () => {
  const pages = new Set<string>();
  const idx = new Map<string, string | null>();
  expect(parseFrontmatter(pageToOkfConcept({ type: "note", status: "Draft" }, "b", "a.md", pages, idx).text).data.status).toBe("draft");
  const legacy = parseFrontmatter(pageToOkfConcept({ type: "note", status: "in-review" }, "b", "a.md", pages, idx).text).data;
  expect(legacy.status).toBeUndefined();
  expect(legacy.funes_status).toBe("in-review");
});

test("valid_until becomes stale_after only when it is an absolute instant", () => {
  const pages = new Set<string>();
  const idx = new Map<string, string | null>();
  const abs = parseFrontmatter(pageToOkfConcept({ type: "note", valid_until: "2027-01-01T00:00:00Z" }, "b", "a.md", pages, idx).text).data;
  expect(abs.stale_after).toBe("2027-01-01T00:00:00Z");
  expect(abs.valid_until).toBeUndefined();               // consumed, not duplicated
  const dateOnly = parseFrontmatter(pageToOkfConcept({ type: "note", valid_until: "2027-01-01" }, "b", "a.md", pages, idx).text).data;
  expect(dateOnly.stale_after).toBeUndefined();
  expect(dateOnly.valid_until).toBe("2027-01-01");       // preserved verbatim, nothing lost
});

test("generated comes ONLY from a validated declaration — never from source or write_actor", () => {
  const pages = new Set<string>();
  const idx = new Map<string, string | null>();
  const good = parseFrontmatter(pageToOkfConcept(
    { type: "note", generated: { by: "funes/distill", at: "2026-06-30T12:00:00Z" } }, "b", "a.md", pages, idx).text).data;
  expect(good.generated).toEqual({ by: "funes/distill", at: "2026-06-30T12:00:00Z" });

  // A DECLARED origin is not an actor, and a stamped write principal is index-only.
  const notAnActor = pageToOkfConcept(
    { type: "note", source: "telegram", write_actor: "agent-7" }, "b", "a.md", pages, idx);
  const n = parseFrontmatter(notAnActor.text).data;
  expect(n.generated).toBeUndefined();
  expect(n.source).toBe("telegram");   // still carried, just never as authorship
  expect(n.write_actor).toBeUndefined(); // dropped outright — an auth detail no reader asked for

  // A malformed declaration is reported, not coerced.
  const bad = pageToOkfConcept({ type: "note", generated: { by: "x", at: "2026-06-30" } }, "b", "a.md", pages, idx);
  expect(parseFrontmatter(bad.text).data.generated).toBeUndefined();
  expect(parseFrontmatter(bad.text).data.funes_generated).toEqual({ by: "x", at: "2026-06-30" });
  expect(bad.warnings[0]).toContain("not v0.2-shaped");
});

// ── step 26: the gate and the promotion ───────────────────────────────────────────────────────

/** Twelve BIP39 words in a row — what the seed detector exists to catch, and not a real secret. */
const FAKE_SEED = "abandon ability able about above absent absorb abstract absurd abuse access accident";

test("the built-in detector runs over every file and its findings are the floor", () => {
  const dir = scratch("scan");
  writeFileSync(join(dir, "clean.md"), "nothing here");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub/leaky.md"), `recovery words: ${FAKE_SEED}`);
  const r = scanBundle(dir);
  expect(r.regexFindings.map((f) => f.file)).toEqual(["sub/leaky.md"]);
  expect(r.regexFindings[0]!.kinds.seed).toBe(1);
});

test("a secret ABORTS the export and leaves the previous bundle exactly as it was", async () => {
  const root = makeVault();
  const out = join(scratch("out"), "bundle");
  await exportOkf(root, out);
  const before = readdirSync(join(out, "notes")).sort();
  expect(before.length).toBeGreaterThan(0);

  writeFileSync(join(root, "notes/leaky.md"), dump({ title: "Leaky", type: "note" }, `seed: ${FAKE_SEED}`));
  await expect(exportOkf(root, out)).rejects.toThrow(/secret material in the bundle/);

  // The point of the transaction: the old bundle survived a failed replacement.
  expect(readdirSync(join(out, "notes")).sort()).toEqual(before);
  expect(existsSync(join(out, "notes/leaky.md"))).toBe(false);
});

test("a bundle stamped with ANOTHER star's id is refused, not backed up and taken", async () => {
  const root = makeVault();
  const out = join(scratch("out"), "bundle");
  await exportOkf(root, out, { starId: "dropbox://example.org/first" });
  expect(() => assertReplaceableTarget(out, "dropbox://example.org/second")).toThrow(/must not overwrite each other/);
  await expect(exportOkf(root, out, { starId: "dropbox://example.org/second" })).rejects.toThrow(/must not overwrite each other/);
  expect(read(join(out, "index.md")).data.okf_star_id).toBe("dropbox://example.org/first");
  // Its own star may replace it, repeatedly.
  await expect(exportOkf(root, out, { starId: "dropbox://example.org/first" })).resolves.toBeDefined();
});

test("a successful export leaves no temp or backup residue behind", async () => {
  const root = makeVault();
  const home = scratch("out");
  const out = join(home, "bundle");
  await exportOkf(root, out);
  await exportOkf(root, out); // the interesting one: a replacement, which uses the backup path
  expect(readdirSync(home)).toEqual(["bundle"]);
});

test("an interrupted run's backup is restored when no target survived it", async () => {
  const root = makeVault();
  const home = scratch("out");
  const out = join(home, "bundle");
  await exportOkf(root, out);
  // Simulate the crash window: the backup rename happened, the promote rename did not.
  const { renameSync } = await import("node:fs");
  renameSync(out, join(home, `.okf-bak-bundle-${Date.now()}-abc123`));
  expect(existsSync(out)).toBe(false);
  await exportOkf(root, out);            // recovery runs under the lock, before anything else
  expect(readdirSync(home)).toEqual(["bundle"]);
  expect(existsSync(join(out, "notes/alpha.md"))).toBe(true);
});

test("a sibling bundle's backup is never adopted by a target whose name is a prefix of it", async () => {
  const root = makeVault();
  const home = scratch("out");
  mkdirSync(join(home, ".okf-bak-bundleX-1-abc"), { recursive: true });
  writeFileSync(join(home, ".okf-bak-bundleX-1-abc/index.md"), "someone else's");
  await exportOkf(root, join(home, "bundle"));
  // `bundle` must not have restored `bundleX`'s backup over itself.
  expect(existsSync(join(home, ".okf-bak-bundleX-1-abc"))).toBe(true);
  expect(read(join(home, "bundle/index.md")).data.okf_version).toBe("0.2");
});

// ADR-0006's fail-closed guard: an in-vault bundle that recall would index is refused; the same
// target passes once the scope excludes it (the CLI always passes a predicate; bare API calls fail).
test("an in-vault out dir is refused unless index_scope excludes it", async () => {
  const root = makeVault();
  const inVault = join(root, "out_okf");
  await expect(exportOkf(root, inVault)).rejects.toThrow(/not excluded from index_scope/);
  const res = await exportOkf(root, inVault, { exclude: buildScopeExclude(["out_okf/**"]) });
  expect(res.concepts).toBeGreaterThan(0);
  expect(existsSync(join(inVault, "index.md"))).toBe(true);
});
