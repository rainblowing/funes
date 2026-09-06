import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { INDEX_SCHEMA_VERSION } from "funes-shared";
import { makeFaceDeps } from "./face.ts";
import { publishReindex, readGenerationManifest } from "./publication.ts";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";

// makeFaceDeps — the production store resolution (publication-home unify + RO read face,
// 2026-07-16; DIRECT removed 0.3.0 item 15). Pins: the face engages the PUBLISHED generation at the
// SAME home the publisher writes; a home with nothing published REFUSES at startup rather than
// serving the live index.db next to it (the split-home bug — broker homed at /index/star, sidecar
// publishing /index — used to be a silent DIRECT mode forever, and is now a refusal naming both
// paths); the read face's stores are READ-ONLY (writes refuse); read faces refuse non-libsql
// backends at startup.

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
const open = (p: string) => LibsqlStore.create(embedder, p);

function makeVault(): string {
  const vault = mkdtempSync(join(tmpdir(), "funes-facedeps-vault-"));
  mkdirSync(join(vault, "wiki"), { recursive: true });
  writeFileSync(join(vault, "wiki", "alpha.md"), "---\ntitle: Alpha\n---\nalpha sourdough loaf body\n");
  return vault;
}

/** Run fn with FUNES_BACKEND forced (saved/restored — the factory.test.ts env pattern). */
async function withBackend(backend: string | undefined, fn: () => Promise<void>): Promise<void> {
  const saved = process.env.FUNES_BACKEND;
  try {
    if (backend === undefined) delete process.env.FUNES_BACKEND;
    else process.env.FUNES_BACKEND = backend;
    await fn();
  } finally {
    if (saved === undefined) delete process.env.FUNES_BACKEND;
    else process.env.FUNES_BACKEND = saved;
  }
}

test("makeFaceDeps: a read face on postgres refuses at startup — readonly faces are libsql-only", async () => {
  await withBackend("postgres", async () => { // the only non-libsql backend since PGLite was removed
    await expect(makeFaceDeps(makeVault(), { face: "read", embedder })).rejects.toThrow(/libsql-only/);
  });
});

test("makeFaceDeps item 15: the BROKER face on postgres refuses too — no served face falls back to a live index", async () => {
  // The hole: item 15's refusal only covered the read face, so the broker fell through to a live
  // `makeStore` announcing "mode DIRECT" — the mode item 15 removed — and
  // `FUNES_BACKEND=postgres FUNES_PG_UNSAFE=1 funes face` served it. It must refuse before it opens
  // anything, whether or not FUNES_PG_UNSAFE is set (that flag gates the STORE, not servability).
  const savedUnsafe = process.env.FUNES_PG_UNSAFE;
  try {
    process.env.FUNES_PG_UNSAFE = "1";
    await withBackend("postgres", async () => {
      const err = await makeFaceDeps(makeVault(), { face: "broker", embedder }).then(() => null, (e: Error) => e);
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/refusing to serve a broker face on the postgres backend/); // the problem
      expect(err!.message).toMatch(/libsql-only/);                                             // the rule
      expect(err!.message).toMatch(/PARKED for 0\.3\.0/);                                      // the reason
      expect(err!.message).toMatch(/FUNES_BACKEND=libsql/);                                    // what to do instead
      expect(err!.message).not.toMatch(/DIRECT/);
    });
  } finally {
    if (savedUnsafe === undefined) delete process.env.FUNES_PG_UNSAFE;
    else process.env.FUNES_PG_UNSAFE = savedUnsafe;
  }
});

test("makeFaceDeps read: engages the PUBLISHED generation at --home; the leased stores are READ-ONLY", async () => {
  await withBackend("libsql", async () => {
    const vault = makeVault();
    const home = mkdtempSync(join(tmpdir(), "funes-facedeps-home-"));
    const g = (await publishReindex({ vault, home, embedder, open })).generation;
    const deps = await makeFaceDeps(vault, { face: "read", home, embedder });
    await deps.withStore(async (ctx) => {
      expect(ctx.generation).toBe(g); // PublishedIndex mode, not a silent direct open
      expect((await ctx.store.recall({ query: "sourdough loaf", k: 1 })).length).toBe(1);
      // RO defense in depth UNDER the op allowlist: a write op reaching the store still refuses
      await expect(ctx.store.remember([{ id: "x", title: "X", body: "b" }])).rejects.toThrow(/READ-ONLY/);
    });
    await deps.close();
  });
});

// 0.3.0 item 15. This test used to assert DIRECT mode: a face at a home with nothing published
// served the live index.db (generation null) and adopted the first publish later. It never worked —
// `funes reindex` rebuilds index.db in place and the face's already-open SQLite handle does not
// follow, so the face served boot-time bytes for its whole life while honestly reporting "no
// generation". A served face serves published generations only; the finalized live index next door
// is not a lesser mode, and is refused with the same message as an empty home.
test("makeFaceDeps read: a home with nothing published REFUSES at startup, even with a finalized live index next to it", async () => {
  await withBackend("libsql", async () => {
    const vault = makeVault();
    const home = mkdtempSync(join(tmpdir(), "funes-facedeps-late-"));
    // the static live index a face used to boot on before the sidecar's first publish
    const staticDb = join(home, "index.db");
    const direct = await LibsqlStore.create(embedder, staticDb);
    await direct.remember([{ id: "wiki/static", path: "wiki/static.md", title: "Static", body: "static direct body", trust: "trusted" }]);
    await direct.finalizeForPublish(); // RO-openable, WAL retired — still not servable
    await direct.close();

    // problem, fix, and the absence of an override — the sync-root guard's voice
    await expect(makeFaceDeps(vault, { face: "read", home, embedder })).rejects.toThrow(/no published generation/);
    await expect(makeFaceDeps(vault, { face: "read", home, embedder })).rejects.toThrow(new RegExp(`funes publish --home ${home}`));
    await expect(makeFaceDeps(vault, { face: "read", home, embedder })).rejects.toThrow(/no fallback and no override/);
    // and it names the live index it declined to serve, so a split-home operator sees both paths
    await expect(makeFaceDeps(vault, { face: "read", home, embedder })).rejects.toThrow(new RegExp(staticDb));

    // publish into that home and the identical call now serves the generation
    const g = (await publishReindex({ vault, home, embedder, open })).generation;
    const deps = await makeFaceDeps(vault, { face: "read", home, embedder });
    await deps.withStore(async (ctx) => {
      expect(ctx.generation).toBe(g);
      expect((await ctx.store.recall({ query: "sourdough loaf", k: 1 })).length).toBe(1);
    });
    await deps.close();
  });
});

test("makeFaceDeps read: an EMPTY home (no manifest, no index) fails STARTUP loudly, not per-request", async () => {
  await withBackend("libsql", async () => {
    const home = mkdtempSync(join(tmpdir(), "funes-facedeps-empty-"));
    // item 15: this used to fall through to a DIRECT open of a nonexistent index.db and surface the
    // libsql error ("cannot open index read-only"). The refusal is now the publication one — same
    // startup-not-per-request guarantee, a message that names the actual repair.
    await expect(makeFaceDeps(makeVault(), { face: "read", home, embedder })).rejects.toThrow(/no published generation/);
  });
});

test("makeFaceDeps read R2-3: a legacy WAL live index refuses startup — now for being unpublished, not for being WAL", async () => {
  await withBackend("libsql", async () => {
    const vault = makeVault();
    const home = mkdtempSync(join(tmpdir(), "funes-facedeps-legacywal-"));
    const staticDb = join(home, "index.db");
    const direct = await LibsqlStore.create(embedder, staticDb);
    await direct.remember([{ id: "wiki/x", path: "wiki/x.md", title: "X", body: "legacy wal body", trust: "trusted" }]);
    await direct.close(); // NO finalizeForPublish — the live index stays WAL-mode (unservable mode=ro)
    // The R2-3 SQLite-header sniff is gone: an unpublished home refuses whatever its journal mode,
    // so the WAL-specific message bought nothing. The guarantee it existed for — never a cryptic
    // per-request "cannot open index read-only" — is what this still pins.
    const err = await makeFaceDeps(vault, { face: "read", home, embedder }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/no published generation/);
    expect(err?.message).not.toMatch(/cannot open index read-only/); // the refusal beat the libsql open
  });
});

test("makeFaceDeps F8: the legacy (vault, dbDir) call shape still maps to broker — and item 15 binds it too", async () => {
  await withBackend(undefined, async () => { // default backend = libsql
    const vault = makeVault();
    const home = mkdtempSync(join(tmpdir(), "funes-facedeps-legacy-"));
    const dbDir = join(home, "index.db");
    // OLD 2-arg string form → face:'broker' at dirname(dbDir). It used to open that static path and
    // serve a fresh empty index (generation null) — the pre-2026-07-16 semantics. Item 15 ends that:
    // the string overload is a SERVED face like any other, so it needs a published generation in the
    // home holding that path. The overload survives (the call shape still compiles and still means
    // broker); what it no longer does is open a live index.
    // "face broker:", not "face read:" — the overload still resolves to the broker principal.
    // (No embedder param on the old signature, so this stops at the refusal rather than opening a
    // published db the fake embedder built — an embedding-signature mismatch is a different test.)
    // ...and it names dirname(dbDir) as the home it checked, the pre-existing home derivation
    await expect(makeFaceDeps(vault, dbDir)).rejects.toThrow(new RegExp(`no published generation in ${home}`));
  });
});

test("makeFaceDeps broker: stays READ-WRITE over the same published home (remember must work)", async () => {
  await withBackend("libsql", async () => {
    const vault = makeVault();
    const home = mkdtempSync(join(tmpdir(), "funes-facedeps-broker-"));
    const g = (await publishReindex({ vault, home, embedder, open })).generation;
    const deps = await makeFaceDeps(vault, { face: "broker", home, embedder });
    await deps.withStore(async (ctx) => {
      expect(ctx.generation).toBe(g);
      const r = await ctx.store.remember([{ id: "out_memory/m1", title: "M1", body: "broker write body" }]);
      expect(r.indexed).toBe(1); // the broker's write authority is intact
    });
    await deps.close();
  });
});

test("makeFaceDeps: the deps carry the HOME (item 9's fence key) and a status refresher (RAI-144)", async () => {
  await withBackend("libsql", async () => {
    const vault = makeVault();
    const home = mkdtempSync(join(tmpdir(), "funes-facedeps-status-"));
    await publishReindex({ vault, home, embedder, open });
    const id = readGenerationManifest(home)!.publicationId!;
    const deps = await makeFaceDeps(vault, { face: "broker", home, embedder });
    try {
      // item 9: the broker's mutation fence is keyed on THIS, and it has to be the same home the
      // publisher writes — a fence on the wrong dir serializes nothing while looking like it does.
      expect(deps.home).toBe(home);

      // The eager first open already acked, via onServe.
      const statusFile = join(home, ".status", "broker.json");
      const acked = JSON.parse(readFileSync(statusFile, "utf8")) as { publicationId: string; contentGeneration: string; protocolVersion: string; at: number };
      expect(acked.publicationId).toBe(id);
      expect(acked.protocolVersion).toBe(INDEX_SCHEMA_VERSION);

      // RAI-144 / item 8: a mutation invalidates the content generation in the very database this
      // principal is serving, so the refresher the face calls after every write must re-stamp BOTH
      // halves — the id unchanged (immutable), the content generation now null.
      await deps.withStore((ctx) => ctx.store.remember([{ id: "out_memory/m2", title: "M2", body: "a broker write" }]));
      await deps.refreshStatus!();
      const after = JSON.parse(readFileSync(statusFile, "utf8")) as { publicationId: string; contentGeneration: string | null; at: number };
      expect(after.publicationId).toBe(id);
      expect(after.contentGeneration).toBeNull();
      expect(after.at).toBeGreaterThanOrEqual(acked.at);
    } finally {
      await deps.close(); // also stops the heartbeat — a face that exits stops acking
    }
  });
});
