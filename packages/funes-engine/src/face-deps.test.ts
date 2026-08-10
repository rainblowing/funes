import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { makeFaceDeps } from "./face.ts";
import { publishReindex } from "./publication.ts";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";

// makeFaceDeps — the production store resolution (publication-home unify + RO read face,
// 2026-07-16). Pins: the face engages the PUBLISHED generation at the SAME home the publisher
// writes; a face booted in DIRECT mode adopts a later publish without restart (the split-home bug:
// broker homed at /index/star, sidecar publishing /index — silent direct mode forever); the read
// face's stores are READ-ONLY (writes refuse); read faces refuse non-libsql backends at startup.

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

test("makeFaceDeps read: DIRECT mode when nothing is published, then ADOPTS a later publish (no restart)", async () => {
  await withBackend("libsql", async () => {
    const vault = makeVault();
    const home = mkdtempSync(join(tmpdir(), "funes-facedeps-late-"));
    // the static live index a face boots on before the sidecar's first publish
    const staticDb = join(home, "index.db");
    const direct = await LibsqlStore.create(embedder, staticDb);
    await direct.remember([{ id: "wiki/static", path: "wiki/static.md", title: "Static", body: "static direct body", trust: "trusted" }]);
    await direct.finalizeForPublish(); // an RO fallback open must not need WAL's -shm
    await direct.close();

    const deps = await makeFaceDeps(vault, { face: "read", home, embedder });
    await deps.withStore(async (ctx) => {
      expect(ctx.generation).toBeNull(); // DIRECT fallback — loud in the startup log
      expect((await ctx.store.recall({ query: "static direct body", k: 1 }))[0]!.id).toBe("wiki/static");
    });
    const g = (await publishReindex({ vault, home, embedder, open })).generation;
    await deps.withStore(async (ctx) => {
      expect(ctx.generation).toBe(g); // the sidecar's publish was adopted per-op
      expect((await ctx.store.recall({ query: "sourdough loaf", k: 1 })).length).toBe(1);
    });
    await deps.close();
  });
});

test("makeFaceDeps read: an EMPTY home (no manifest, no index) fails STARTUP loudly, not per-request", async () => {
  await withBackend("libsql", async () => {
    const home = mkdtempSync(join(tmpdir(), "funes-facedeps-empty-"));
    await expect(makeFaceDeps(makeVault(), { face: "read", home, embedder })).rejects.toThrow(/cannot open index read-only/);
  });
});

test("makeFaceDeps read R2-3: a legacy WAL DIRECT index refuses startup with the finalize repair", async () => {
  await withBackend("libsql", async () => {
    const vault = makeVault();
    const home = mkdtempSync(join(tmpdir(), "funes-facedeps-legacywal-"));
    const staticDb = join(home, "index.db");
    const direct = await LibsqlStore.create(embedder, staticDb);
    await direct.remember([{ id: "wiki/x", path: "wiki/x.md", title: "X", body: "legacy wal body", trust: "trusted" }]);
    await direct.close(); // NO finalizeForPublish — the DIRECT index stays WAL-mode (unservable mode=ro)
    await expect(makeFaceDeps(vault, { face: "read", home, embedder }))
      .rejects.toThrow(/WAL-mode and cannot be served read-only|publish a finalized generation/);
  });
});

test("makeFaceDeps F8: the legacy (vault, dbDir) call shape compiles + maps to broker (not read), pre-2026-07-16 semantics", async () => {
  await withBackend(undefined, async () => { // default backend = libsql
    const vault = makeVault();
    const dbDir = join(mkdtempSync(join(tmpdir(), "funes-facedeps-legacy-")), "index.db");
    // OLD 2-arg string form → face:'broker'. A READ face refuses non-libsql ("libsql-only"); the legacy
    // shape must NOT — it opens a static store and serves, exactly the pre-unify behavior. (No
    // embedder param on the old signature; a fresh empty index needs no embed to open + stat.)
    const deps = await makeFaceDeps(vault, dbDir);
    await deps.withStore(async (ctx) => {
      expect(ctx.generation).toBeNull(); // fresh static index, nothing published/stamped
      expect((await ctx.store.stats()).nodes).toBe(0); // opened + queryable
    });
    await deps.close();
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
