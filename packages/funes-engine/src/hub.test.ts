// The hub over REAL published generations (RAI-39, PLAN-0.2.1 Ticket A). Nothing here is faked
// except the embedder: the stars are real vaults, the generations are real publishes, and the
// identity layers are the ones a live catalogue carries.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { INDEX_SCHEMA_VERSION } from "funes-shared";
import { Hub, readCatalogue } from "./hub.ts";
import { publishReindex, readGenerationManifest } from "./publication.ts";
import { scopeHash } from "./scope.ts";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";

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
const embedder = new FakeEmbedder();

interface Star { name: string; id: string; vault: string; home: string; constellation: string }

async function makeStar(base: string, name: string, id: string, constellation: string, body: string): Promise<Star> {
  const vault = join(base, name);
  const home = join(base, `${name}-home`);
  mkdirSync(join(vault, "wiki"), { recursive: true });
  mkdirSync(home, { recursive: true });
  // A DECLARED (and valid) index_scope is what makes a cross-star read possible at all —
  // crossStarExpectedHash refuses a vault without one, which is the guard the hub rides on.
  writeFileSync(join(vault, "star.yaml"), [
    "version: 3", "meta:", `  name: ${name}`, `  id: ${id}`, `  constellation: ${constellation}`,
    "memory:", "  substrate: libsql", "  index_scope:", "    exclude: []", "",
  ].join("\n"));
  writeFileSync(join(vault, "wiki", `${name}.md`), `---\ntitle: ${name} page\n---\n${body}\n`);
  // A SECOND page per star, so the fan-out has something to truncate — a one-page star cannot
  // exercise a budget rule, and a bound that is never reached is a bound that is never tested.
  writeFileSync(join(vault, "wiki", `${name}-2.md`), `---\ntitle: ${name} second page\n---\n${body} again\n`);
  await publishReindex({
    vault, home, embedder, starId: id,
    open: (p) => LibsqlStore.create(embedder, p),
    scopeSignature: { hash: scopeHash([]), ignoreScope: false },
  });
  return { name, id, vault, home, constellation };
}

function catalogueFile(base: string, stars: Star[], extra: unknown[] = []): string {
  const file = join(base, "stars.json");
  writeFileSync(file, JSON.stringify([
    ...stars.map((s) => ({
      id: s.id, key: s.id.replace(/^[a-z]+:\/\//, ""), name: s.name, constellation: s.constellation,
      locus: "local", path: s.vault, access: {}, serves: ["graph"], okf: "0.2", backend: "libsql",
    })),
    ...extra,
  ], null, 2));
  return file;
}

async function estate(): Promise<{ base: string; file: string; stars: Star[]; homeOf: (e: { name: string }) => string; cleanup: () => void }> {
  const base = mkdtempSync(join(tmpdir(), "funes-hub-"));
  const alpha = await makeStar(base, "alpha", "dropbox://example.org/alpha", "one", "sourdough loaf starter hydration");
  const beta = await makeStar(base, "beta", "git://example.org/beta", "one", "telescope mirror collimation");
  const stars = [alpha, beta];
  return {
    base, stars, file: catalogueFile(base, stars),
    homeOf: (e) => join(base, `${e.name}-home`),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

// ── the catalogue is fail-closed ──────────────────────────────────────────────────────────────

test("a catalogue that is not a top-level ARRAY fails startup — it never degrades to empty", async () => {
  const base = mkdtempSync(join(tmpdir(), "funes-hub-bad-"));
  try {
    for (const bad of ["null", "{}", "42", '"stars"', "not json at all"]) {
      const f = join(base, "stars.json");
      writeFileSync(f, bad);
      expect(() => readCatalogue(f)).toThrow();
    }
    expect(() => readCatalogue(join(base, "absent.json"))).toThrow(/cannot read the catalogue/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("invalid entries become DIAGNOSTICS with stable reasons, never servable rows", async () => {
  const e = await estate();
  try {
    const file = catalogueFile(e.base, e.stars, [
      { name: "no-id", constellation: "one", path: e.stars[0]!.vault, backend: "libsql" },
      { id: "dropbox://example.org/alpha", name: "dupe-id", constellation: "one", path: e.stars[0]!.vault, backend: "libsql" },
      { id: "dropbox://example.org/pg", name: "pg", constellation: "one", path: e.stars[1]!.vault, backend: "postgres" },
      { id: "dropbox://example.org/env", name: "env", constellation: "one", path: e.stars[1]!.vault, backend: "libsql", env: { TOKEN: "x" } },
      { id: "dropbox://example.org/gone", name: "gone", constellation: "one", path: "/nope/not/here", backend: "libsql" },
      { id: "dropbox://example.org/rel", name: "rel", constellation: "one", path: "relative/path", backend: "libsql" },
    ]);
    const c = readCatalogue(file);
    expect(c.entries.map((x) => x.name).sort()).toEqual(["alpha", "beta"]);
    expect(c.diagnostics.map((d) => d.reason)).toEqual([
      "no id",
      "duplicate id example.org/alpha",
      "non-libsql backend (postgres) — the hub opens libsql generations only",
      "carries an `env` field — a catalogue never transports environment",
      "path does not resolve: /nope/not/here",
      "path is not absolute: relative/path",
    ]);
  } finally { e.cleanup(); }
});

// ── serving ───────────────────────────────────────────────────────────────────────────────────

test("recall fans out and answers in PER-STAR groups, in canonical key order", async () => {
  const e = await estate();
  try {
    const hub = await Hub.open(e.file, { embedder, homeOf: e.homeOf, log: () => {} });
    const r = await hub.recall({ query: "sourdough hydration", k: 5 });
    expect(r.errors).toEqual([]);
    expect(r.groups.map((g) => g.star)).toEqual(["alpha", "beta"]); // key order, not completion order
    expect(r.groups[0]!.generation).toBe(readGenerationManifest(e.homeOf({ name: "alpha" }))!.generation);
    expect(r.groups[0]!.hits.some((h) => String(h.title).includes("alpha"))).toBe(true);
    // the answer carries no absolute path of another star's vault
    expect(JSON.stringify(r)).not.toContain(e.base);
    await hub.close();
  } finally { e.cleanup(); }
});

test("RAI-144: a hub-served home gets an ACKING principal, not just a log line", async () => {
  // The hub opened a PublishedIndex per star and only LOGGED its swaps, so every home a hub served
  // looked to the publisher's retain-until-ack GC like a home with no consumers at all — which is
  // precisely the case where it unlinks the prior artefact immediately, out from under the hub.
  const e = await estate();
  try {
    const hub = await Hub.open(e.file, { embedder, homeOf: e.homeOf, log: () => {} });
    await hub.recall({ query: "sourdough hydration", k: 1 }); // opens both slots
    for (const name of ["alpha", "beta"]) {
      const home = e.homeOf({ name });
      const status = JSON.parse(readFileSync(join(home, ".status", "hub.json"), "utf8")) as { publicationId: string; contentGeneration: string; protocolVersion: string };
      expect(status.publicationId).toBe(readGenerationManifest(home)!.publicationId!);
      expect(status.contentGeneration).toBe(readGenerationManifest(home)!.generation);
      expect(status.protocolVersion).toBe(INDEX_SCHEMA_VERSION); // item 33: it says what it speaks
    }
    await hub.close();
  } finally { e.cleanup(); }
});

test("stars() opens NOTHING and health() projects the vault path out", async () => {
  const e = await estate();
  try {
    const hub = await Hub.open(e.file, { embedder, homeOf: e.homeOf, log: () => {} });
    const listed = hub.stars();
    expect(listed.stars.map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(listed.stars.every((s) => s.allowlisted)).toBe(true);
    expect(Object.keys(listed.stars[0]!)).not.toContain("path"); // the DTO carries no locator

    const h = await hub.health();
    expect(h.errors).toEqual([]);
    expect(h.stars.map((s) => s.star)).toEqual(["alpha", "beta"]);
    expect(JSON.stringify(h)).not.toContain(e.base); // `vault` is projected out by guarded_health
    expect((h.stars[0]!.health as { nodes: number }).nodes).toBeGreaterThan(0);
    await hub.close();
  } finally { e.cleanup(); }
});

test("the total output bound truncates deterministically and SAYS it truncated", async () => {
  const e = await estate();
  try {
    const hub = await Hub.open(e.file, { embedder, homeOf: e.homeOf, log: () => {} });
    const r = await hub.recall({ query: "page", perStar: 5, total: 1 });
    const kept = r.groups.reduce((n, g) => n + g.hits.length, 0);
    expect(kept).toBe(1);
    expect(r.groups[0]!.star).toBe("alpha");           // the first unit of budget goes in key order
    expect(r.groups[1]!.hits).toEqual([]);
    expect(r.groups.some((g) => g.truncated)).toBe(true);
    await hub.close();
  } finally { e.cleanup(); }
});

test("the budget is spent round-robin: every star gets its best hit before any star gets a second", async () => {
  const e = await estate();
  try {
    const hub = await Hub.open(e.file, { embedder, homeOf: e.homeOf, log: () => {} });
    // Two stars, two hits each available, a budget of 2: one EACH, never both to the first star.
    const r = await hub.recall({ query: "page", perStar: 2, total: 2 });
    expect(r.groups.map((g) => g.hits.length)).toEqual([1, 1]);
    expect(r.groups.every((g) => g.truncated === 1)).toBe(true);
    // and with room for everything, nothing is trimmed and nothing claims to be
    const full = await hub.recall({ query: "page", perStar: 2, total: 50 });
    expect(full.groups.every((g) => g.truncated === undefined)).toBe(true);
    await hub.close();
  } finally { e.cleanup(); }
});

// ── the refusals ──────────────────────────────────────────────────────────────────────────────

test("a mixed-constellation catalogue is refused WHOLESALE, and served when the stars are named", async () => {
  const base = mkdtempSync(join(tmpdir(), "funes-hub-mixed-"));
  try {
    const a = await makeStar(base, "alpha", "dropbox://example.org/alpha", "one", "sourdough");
    const b = await makeStar(base, "beta", "git://other.example/beta", "two", "telescope");
    const file = catalogueFile(base, [a, b]);
    const homeOf = (e: { name: string }) => join(base, `${e.name}-home`);
    await expect(Hub.open(file, { embedder, homeOf, log: () => {} })).rejects.toThrow(/spans 2 constellations/);
    const hub = await Hub.open(file, { embedder, homeOf, log: () => {}, stars: ["example.org/alpha"] });
    expect(hub.stars().stars.map((s) => s.name)).toEqual(["alpha"]);   // beta is not even listed
    const r = await hub.recall({ query: "telescope" });
    expect(r.groups.map((g) => g.star)).toEqual(["alpha"]);            // and never answers
    await hub.close();
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a generation stamped with ANOTHER star's identity is refused, not served", async () => {
  const e = await estate();
  try {
    // The catalogue claims alpha's vault is beta. Every layer disagrees; the hub must not pick one.
    const file = join(e.base, "swapped.json");
    writeFileSync(file, JSON.stringify([{
      id: "git://example.org/beta", key: "example.org/beta", name: "beta", constellation: "one",
      locus: "local", path: e.stars[0]!.vault, access: {}, serves: ["graph"], okf: "0.2", backend: "libsql",
    }]));
    const hub = await Hub.open(file, { embedder, homeOf: () => e.homeOf({ name: "alpha" }), log: () => {} });
    const r = await hub.recall({ query: "anything" });
    expect(r.groups).toEqual([]);
    expect(r.errors[0]!.code).toBe("identity-mismatch");
    await hub.close();
  } finally { e.cleanup(); }
});

test("a SWAPPED db is caught by the id inside the bytes, even when every file beside it agrees", async () => {
  const e = await estate();
  try {
    // beta's home, beta's manifest, beta's catalogue entry, beta's star.yaml — and ALPHA's database
    // file underneath. Only the stamp inside the bytes can tell, which is why it is stamped.
    const beta = e.stars[1]!;
    const betaHome = e.homeOf({ name: "beta" });
    const alphaManifest = readGenerationManifest(e.homeOf({ name: "alpha" }))!;
    const stolen = "gen-stolen.db";
    writeFileSync(join(betaHome, stolen), readFileSync(join(e.homeOf({ name: "alpha" }), alphaManifest.db)));
    writeFileSync(join(betaHome, "generation.json"), JSON.stringify({
      version: 1, generation: alphaManifest.generation, db: stolen,
      publishedAt: new Date(0).toISOString(), starId: beta.id,
    }));

    const hub = await Hub.open(catalogueFile(e.base, [beta]), { embedder, homeOf: e.homeOf, log: () => {} });
    const r = await hub.recall({ query: "sourdough" });
    expect(r.groups).toEqual([]);
    expect(r.errors[0]!.code).toBe("identity-mismatch");
    expect(r.errors[0]!.message).toMatch(/refusing to answer in another star's name/);
    await hub.close();
  } finally { e.cleanup(); }
});

test("a star with no published generation is an error, never a live-index fallback", async () => {
  const e = await estate();
  try {
    const hub = await Hub.open(e.file, { embedder, homeOf: () => join(e.base, "empty-home"), log: () => {} });
    const r = await hub.recall({ query: "anything" });
    expect(r.groups).toEqual([]);
    expect(r.errors.every((x) => x.code === "open-failed")).toBe(true);
    expect(r.errors[0]!.message).toMatch(/no published generation/);
    await hub.close();
  } finally { e.cleanup(); }
});

test("a generation published WITHOUT an identity is refused — absence never reads as a match", async () => {
  const base = mkdtempSync(join(tmpdir(), "funes-hub-noid-"));
  try {
    const a = await makeStar(base, "alpha", "dropbox://example.org/alpha", "one", "sourdough");
    // Re-publish the same corpus with no starId, exactly as a pre-step-12 publisher would have.
    const home = join(base, "alpha-home");
    const bare = join(base, "bare-home");
    mkdirSync(bare, { recursive: true });
    await publishReindex({
      vault: a.vault, home: bare, embedder, open: (p) => LibsqlStore.create(embedder, p),
      scopeSignature: { hash: scopeHash([]), ignoreScope: false },
    });
    expect(readGenerationManifest(bare)!.starId).toBeUndefined();
    expect(readGenerationManifest(home)!.starId).toBe(a.id); // the identity-aware one, for contrast

    const hub = await Hub.open(catalogueFile(base, [a]), { embedder, homeOf: () => bare, log: () => {} });
    const r = await hub.recall({ query: "sourdough" });
    expect(r.errors[0]!.message).toMatch(/NO star identity/);
    await hub.close();
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the BUILD stamps owner_star_id, so the live index carries it — not only the published generation", async () => {
  const base = mkdtempSync(join(tmpdir(), "funes-owner-"));
  try {
    const vault = join(base, "alpha");
    mkdirSync(join(vault, "wiki"), { recursive: true });
    writeFileSync(join(vault, "star.yaml"), "version: 3\nmeta:\n  name: alpha\n  id: dropbox://example.org/alpha\n");
    writeFileSync(join(vault, "wiki", "a.md"), "---\ntitle: A\n---\nbody\n");
    writeFileSync(join(vault, "wiki", "b.md"), "---\ntitle: B\n---\nmore body\n");
    const { indexDir } = await import("./reindex.ts");

    // A BOUNDED run has not built the whole index and must not claim it.
    const partial = await LibsqlStore.create(embedder, join(base, "partial.db"));
    await indexDir(partial, vault, vault, { maxFiles: 1, starId: "dropbox://example.org/alpha" });
    expect(await partial.getOwnerStarId()).toBeNull();
    await partial.close();

    // A FULL run stamps, on the same gate as the scope signature and the generation.
    const full = await LibsqlStore.create(embedder, join(base, "full.db"));
    await indexDir(full, vault, vault, { starId: "dropbox://example.org/alpha" });
    expect(await full.getOwnerStarId()).toBe("dropbox://example.org/alpha");

    // An unmanifested rebuild leaves the prior stamp alone rather than clearing it: un-stamping an
    // index is how a gate that trusts the stamp starts refusing a database that was always fine.
    await indexDir(full, vault, vault, {});
    expect(await full.getOwnerStarId()).toBe("dropbox://example.org/alpha");
    await full.close();
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the identity-aware skip predicate REBUILDS a generation that lacks the id, instead of skipping forever", async () => {
  const base = mkdtempSync(join(tmpdir(), "funes-hub-skip-"));
  try {
    const vault = join(base, "alpha");
    const home = join(base, "home");
    mkdirSync(join(vault, "wiki"), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(vault, "star.yaml"), "version: 3\nmeta:\n  name: alpha\n  id: dropbox://example.org/alpha\nmemory:\n  index_scope:\n    exclude: []\n");
    writeFileSync(join(vault, "wiki", "a.md"), "---\ntitle: A\n---\nbody\n");
    const args = { vault, home, embedder, open: (p: string) => LibsqlStore.create(embedder, p), scopeSignature: { hash: scopeHash([]), ignoreScope: false } };

    const first = await publishReindex(args);                                   // no identity
    expect(first.skipped).toBe(false);
    expect(readGenerationManifest(home)!.starId).toBeUndefined();

    const second = await publishReindex({ ...args, starId: "dropbox://example.org/alpha" });
    expect(second.skipped).toBe(false);                                          // SAME content, still rebuilt
    expect(second.generation).toBe(first.generation);                            // identity is not in the hash
    expect(readGenerationManifest(home)!.starId).toBe("dropbox://example.org/alpha");

    const third = await publishReindex({ ...args, starId: "dropbox://example.org/alpha" });
    expect(third.skipped).toBe(true);                                            // now it may skip
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the bulkhead: a star that misses its soft deadline is marked busy, and the others still answer", async () => {
  const e = await estate();
  try {
    let release: (() => void) | undefined;
    const stall = new Promise<void>((r) => { release = r; });
    const hub = await Hub.open(e.file, {
      embedder, homeOf: e.homeOf, log: () => {}, softTimeoutMs: 25, concurrency: 2,
      open: async (dbPath, emb) => {
        const store = await LibsqlStore.create(emb, dbPath, { readonly: true });
        if (dbPath.includes("alpha")) {
          const slow = { ...store, recall: async (a: Parameters<typeof store.recall>[0]) => { await stall; return store.recall(a); } };
          return Object.setPrototypeOf(slow, Object.getPrototypeOf(store)) as typeof store;
        }
        return store;
      },
    });
    const r = await hub.recall({ query: "telescope" });
    expect(r.errors.map((x) => x.code)).toEqual(["timeout"]);
    expect(r.errors[0]!.star).toBe("alpha");
    expect(r.groups.map((g) => g.star)).toEqual(["beta"]);            // beta answered anyway

    const second = await hub.recall({ query: "telescope" });          // alpha is still outstanding
    expect(second.errors.map((x) => x.code)).toEqual(["busy"]);       // skipped, NOT queued behind it
    release!();
    await hub.close();
  } finally { e.cleanup(); }
});
