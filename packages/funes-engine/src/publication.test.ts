import { test, expect } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import {
  PublishedIndex, computeTargetGeneration, hasPublishedGeneration, manifestPath,
  publishGenerationManifest, publishReindex, readGenerationManifest,
  writePrincipalStatus, gcRetiredGenerations,
} from "./publication.ts";
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
const open = (p: string) => LibsqlStore.create(embedder, p);

function makeVault(): string {
  const vault = mkdtempSync(join(tmpdir(), "funes-pub-vault-"));
  mkdirSync(join(vault, "wiki"), { recursive: true });
  writeFileSync(join(vault, "wiki", "alpha.md"), "---\ntitle: Alpha\n---\nalpha sourdough loaf body\n");
  writeFileSync(join(vault, "wiki", "beta.md"), "---\ntitle: Beta\n---\nbeta telescope mirror body\n");
  return vault;
}

test("publishReindex: builds OFF-path, validates, atomically publishes; SKIPS when the published generation equals the target", async () => {
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-pub-home-"));

  const r1 = await publishReindex({ vault, home, embedder, open });
  expect(r1.skipped).toBe(false);
  expect(r1.generation).toMatch(/^v1:[0-9a-f]{64}$/);
  expect(r1.generation).toBe(computeTargetGeneration(vault, { embedder, scopeSignature: null }));

  const manifest = readGenerationManifest(home);
  expect(manifest?.version).toBe(1);
  expect(manifest?.generation).toBe(r1.generation);
  expect(existsSync(join(home, manifest!.db))).toBe(true); // the OFF-path db the manifest points at
  expect(hasPublishedGeneration(home)).toBe(true);
  // no torn temp file left behind (temp+rename)
  expect(readdirSync(home).filter((f) => f.includes(".tmp-"))).toEqual([]);

  // unchanged vault ⇒ SKIP: nothing rebuilt, manifest untouched
  const before = readdirSync(home).sort();
  const r2 = await publishReindex({ vault, home, embedder, open });
  expect(r2.skipped).toBe(true);
  expect(r2.generation).toBe(r1.generation);
  expect(readdirSync(home).sort()).toEqual(before);

  // content change ⇒ new generation published, previous generation's db retired
  writeFileSync(join(vault, "wiki", "gamma.md"), "---\ntitle: Gamma\n---\nnew gamma page\n");
  const r3 = await publishReindex({ vault, home, embedder, open });
  expect(r3.skipped).toBe(false);
  expect(r3.generation).not.toBe(r1.generation);
  const m3 = readGenerationManifest(home);
  expect(m3?.generation).toBe(r3.generation);
  expect(existsSync(join(home, m3!.db))).toBe(true);
  expect(existsSync(join(home, manifest!.db))).toBe(false); // old generation unlinked (open fds unaffected)
});

test("publishReindex: an ALIAS-resolved edge does NOT fail validation (Codex R1#4 — target/built generation agree)", async () => {
  // The regression: before the shared resolved-item walk, computeTargetGeneration resolved edge
  // targets by BASENAME only while the build (indexDir) also resolved frontmatter ALIASES. A vault
  // whose edge points at a page via its alias hashed one way in the target and another in the build,
  // so publishReindex threw "generation moved during the build" on EVERY publish. Here the edge
  // `target: rag` resolves only through beta.md's `aliases: [rag]` (there is no rag.md basename).
  const vault = mkdtempSync(join(tmpdir(), "funes-pub-alias-"));
  mkdirSync(join(vault, "wiki"), { recursive: true });
  writeFileSync(join(vault, "wiki", "beta.md"), "---\ntitle: Beta\naliases: [rag]\n---\nbeta retrieval body\n");
  writeFileSync(
    join(vault, "wiki", "alpha.md"),
    "---\ntitle: Alpha\nedges:\n  - type: related_to\n    target: rag\n---\nalpha body\n",
  );
  const home = mkdtempSync(join(tmpdir(), "funes-pub-alias-home-"));

  // The target the writer computes MUST equal what a full build stamps — the property that broke.
  const target = computeTargetGeneration(vault, { embedder, scopeSignature: null });
  const r = await publishReindex({ vault, home, embedder, open }); // threw here pre-fix
  expect(r.skipped).toBe(false);
  expect(r.generation).toBe(target);
  expect(readGenerationManifest(home)?.generation).toBe(target);

  // and it's a genuine skip on the second pass (target still agrees with the built generation)
  const r2 = await publishReindex({ vault, home, embedder, open });
  expect(r2.skipped).toBe(true);
  expect(r2.generation).toBe(target);
});

test("P1.6d ack channel: retain-until-ack GC keeps the prior generation until an inventoried principal swaps", async () => {
  const home = mkdtempSync(join(tmpdir(), "funes-pub-gc-"));
  // pass `now` well after the files' mtime so the grace window (which only guards live consumers) is
  // clearly past — this test exercises the ACK logic, not the grace floor.
  const future = () => Date.now() + 60_000;
  writeFileSync(join(home, "gen-current.db"), "x");
  writeFileSync(join(home, "gen-prior.db"), "x");
  writeFileSync(join(home, "gen-orphan.db"), "x");
  const base = { currentDb: "gen-current.db", currentGeneration: "v1:cur", priorDb: "gen-prior.db", graceMs: 0, staleAckMs: 120_000 };

  // (a) inventory declares [broker, read]; broker still serves the PRIOR gen → prior RETAINED
  writeFileSync(join(home, "principals.json"), JSON.stringify(["broker", "read"]));
  writePrincipalStatus(home, "broker", "v1:prior");
  writePrincipalStatus(home, "read", "v1:cur");
  gcRetiredGenerations(home, { ...base, now: future() });
  expect(existsSync(join(home, "gen-prior.db"))).toBe(true);   // broker hasn't swapped → kept
  expect(existsSync(join(home, "gen-orphan.db"))).toBe(false); // an orphan (not current/prior) is GC'd
  expect(existsSync(join(home, "gen-current.db"))).toBe(true); // never removed

  // (b) broker now swaps to current → prior no longer pinned → removed
  writePrincipalStatus(home, "broker", "v1:cur");
  gcRetiredGenerations(home, { ...base, now: future() });
  expect(existsSync(join(home, "gen-prior.db"))).toBe(false);
});

test("P1.6d ack channel: a DEAD principal (stale status) does not pin a retired generation forever", async () => {
  const home = mkdtempSync(join(tmpdir(), "funes-pub-gc-dead-"));
  writeFileSync(join(home, "gen-current.db"), "x");
  writeFileSync(join(home, "gen-prior.db"), "x");
  writeFileSync(join(home, "principals.json"), JSON.stringify(["broker"]));
  writePrincipalStatus(home, "broker", "v1:prior"); // broker last acked the prior, then died
  // now is far ahead of the status.at, so with a small staleAckMs the status is STALE → dead → does
  // not block GC; no fresh consumers ⇒ no grace ⇒ the prior is removed.
  gcRetiredGenerations(home, { currentDb: "gen-current.db", currentGeneration: "v1:cur", priorDb: "gen-prior.db", now: Date.now() + 60_000, graceMs: 0, staleAckMs: 5_000 });
  expect(existsSync(join(home, "gen-prior.db"))).toBe(false);
  expect(existsSync(join(home, "gen-current.db"))).toBe(true);
});

test("publishReindex: --force republishes the SAME generation without building into the live file", async () => {
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-pub-force-"));
  const r1 = await publishReindex({ vault, home, embedder, open });
  const m1 = readGenerationManifest(home)!;
  const r2 = await publishReindex({ vault, home, embedder, open, force: true });
  expect(r2.skipped).toBe(false);
  expect(r2.generation).toBe(r1.generation);
  const m2 = readGenerationManifest(home)!;
  expect(m2.db).not.toBe(m1.db); // rebuilt beside, never INTO, the generation a consumer may hold
  expect(existsSync(join(home, m2.db))).toBe(true);
});

test("publishReindex FINALIZES the generation db: journal_mode=delete, no -wal/-shm — consumable from an RO mount", async () => {
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-pub-fin-"));
  const r = await publishReindex({ vault, home, embedder, open });
  const dbPath = r.dbPath!;
  // no WAL sidecars remain beside the published generation
  expect(existsSync(dbPath + "-wal")).toBe(false);
  expect(existsSync(dbPath + "-shm")).toBe(false);
  // SQLite header bytes 18/19 (file-format read/write version): 1 = legacy/DELETE journal, 2 = WAL
  const header = readFileSync(dbPath);
  expect(header[18]).toBe(1);
  expect(header[19]).toBe(1);
  // and the read face's open mode serves it with ZERO write access (no sidecars appear either)
  const ro = await LibsqlStore.create(embedder, dbPath, { readonly: true });
  expect((await ro.recall({ query: "sourdough loaf", k: 1 })).length).toBe(1);
  await ro.close();
  expect(existsSync(dbPath + "-wal")).toBe(false);
  expect(existsSync(dbPath + "-shm")).toBe(false);
});

test("PublishedIndex fallback: DIRECT mode (generation null) before any publish; the FIRST publish is adopted mid-loop, no restart", async () => {
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-pub-fallback-"));
  // a static live index at the face's default path — the pre-publication (Mac / booted-early) layout
  const staticDb = join(home, "index.db");
  const direct = await LibsqlStore.create(embedder, staticDb);
  await direct.remember([{ id: "wiki/static", path: "wiki/static.md", title: "Static", body: "static direct body", trust: "trusted" }]);
  await direct.close();

  const consumer = new PublishedIndex(home, open, { fallbackDbPath: staticDb });
  await consumer.with(async (store, generation) => {
    expect(generation).toBeNull(); // DIRECT mode: nothing published yet
    expect((await store.recall({ query: "static direct body", k: 1 }))[0]!.id).toBe("wiki/static");
  });
  expect(consumer.generation).toBeNull();
  // the sidecar publishes AFTER the consumer booted — the very next op swaps to the generation
  const g = (await publishReindex({ vault, home, embedder, open })).generation;
  await consumer.with(async (store, generation) => {
    expect(generation).toBe(g);
    expect((await store.recall({ query: "sourdough loaf", k: 1 })).length).toBe(1);
  });
  expect(consumer.generation).toBe(g);
  await consumer.close();
});

test("publishReindex F1: two CONCURRENT publishes (coordination disabled) — both resolve, no corrupted/missing final db", async () => {
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-pub-concurrent-"));
  const [a, b] = await Promise.all([
    publishReindex({ vault, home, embedder, open }),
    publishReindex({ vault, home, embedder, open }),
  ]);
  expect(a.generation).toBe(b.generation); // same vault ⇒ same target generation, both succeeded
  // the published manifest points at a real, finalized, RO-openable db — never a clobbered build
  const m = readGenerationManifest(home)!;
  const dbPath = join(home, m.db);
  expect(existsSync(dbPath)).toBe(true);
  expect(existsSync(dbPath + "-wal")).toBe(false);
  expect(existsSync(dbPath + "-shm")).toBe(false);
  const ro = await LibsqlStore.create(embedder, dbPath, { readonly: true });
  expect((await ro.recall({ query: "sourdough loaf", k: 1 })).length).toBe(1);
  await ro.close();
  // the loser left no half-built temp behind (collision-proof name + rename-into-place)
  expect(readdirSync(home).filter((f) => f.includes(".building.db"))).toEqual([]);
});

test("publishReindex R2-1: concurrent top-level publishes are MUTUALLY EXCLUSIVE + ordered (later-started wins)", async () => {
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-pub-mutex-"));
  let active = 0, maxActive = 0;
  const serOpen = async (p: string) => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 25)); // widen the window a missing-mutex bug would expose
    active--;
    return open(p);
  };
  // force BOTH to build (else the 2nd would skip): A enters the per-home chain first, B serializes after
  const [a, b] = await Promise.all([
    publishReindex({ vault, home, embedder, open: serOpen, force: true }),
    publishReindex({ vault, home, embedder, open: serOpen, force: true }),
  ]);
  expect(maxActive).toBe(1);            // strict mutual exclusion — never two builds overlapping in-process
  expect(a.dbPath).not.toBe(b.dbPath!); // both forced builds ran, into distinct db files
  // the later-STARTED build serialized LAST, so ITS manifest wins — never an older build rolling it back
  const m = readGenerationManifest(home)!;
  expect(join(home, m.db)).toBe(b.dbPath!);
  const ro = await LibsqlStore.create(embedder, join(home, m.db), { readonly: true });
  expect((await ro.recall({ query: "sourdough loaf", k: 1 })).length).toBe(1);
  await ro.close();
});

test("publishReindex F5: a matching-generation LEGACY WAL publication is FINALIZED, not skipped", async () => {
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-pub-legacy-"));
  const target = computeTargetGeneration(vault, { embedder, scopeSignature: null });
  // Hand-build a pre-2026-07-16 (pre-finalize) publication: a WAL-mode gen db (LibsqlStore WAL-
  // creates a new db and we never finalize it) + a manifest whose generation MATCHES the target.
  // This is the NAS's live state — generation current, but unservable mode=ro.
  const legacyDb = join(home, "gen-legacy.db");
  const legacy = await LibsqlStore.create(embedder, legacyDb);
  await legacy.remember([{ id: "wiki/alpha", path: "wiki/alpha.md", title: "Alpha", body: "alpha sourdough loaf body", trust: "trusted" }]);
  await legacy.close(); // NO finalizeForPublish — the db stays WAL (header byte 18 == 2)
  expect(readFileSync(legacyDb)[18]).toBe(2);
  publishGenerationManifest(home, { version: 1, generation: target, db: "gen-legacy.db", publishedAt: new Date().toISOString() });

  // a DEFAULT publish (generation MATCHES the target) must NOT skip — it rebuilds a finalized generation
  const r = await publishReindex({ vault, home, embedder, open });
  expect(r.skipped).toBe(false);
  expect(r.generation).toBe(target); // unchanged content ⇒ same generation, but a fresh finalized db
  const m2 = readGenerationManifest(home)!;
  expect(m2.db).not.toBe("gen-legacy.db");
  const finalized = join(home, m2.db);
  expect(existsSync(finalized + "-wal")).toBe(false);
  expect(existsSync(finalized + "-shm")).toBe(false);
  expect(readFileSync(finalized)[18]).toBe(1); // DELETE journal — RO-mount consumable
  const ro = await LibsqlStore.create(embedder, finalized, { readonly: true });
  expect((await ro.recall({ query: "sourdough loaf", k: 1 })).length).toBe(1);
  await ro.close();
});

test("publishReindex R2-2: a DIRTY equal-generation target is NOT skipped — rebuilt (a shallow header check would have skipped it)", async () => {
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-pub-dirty-"));
  const target = computeTargetGeneration(vault, { embedder, scopeSignature: null });
  // a FINALIZED (DELETE, no sidecars) gen db whose generation MATCHES — but flagged dirty (an
  // interrupted reindex): passes header+sidecar checks, fails the read face's RO validation.
  const dbP = join(home, "gen-dirty.db");
  const s = await LibsqlStore.create(embedder, dbP);
  await s.remember([{ id: "wiki/alpha", path: "wiki/alpha.md", title: "Alpha", body: "alpha sourdough loaf body", trust: "trusted" }]);
  await s.setGeneration(target);
  await s.finalizeForPublish(); // DELETE journal, no -wal/-shm
  await s.beginReindex();       // sets reindex_dirty=1
  await s.close();              // belt-releases the reindex lock; dirty persists
  expect(readFileSync(dbP)[18]).toBe(1); // header still DELETE — the shallow check would skip
  publishGenerationManifest(home, { version: 1, generation: target, db: "gen-dirty.db", publishedAt: new Date().toISOString() });

  const r = await publishReindex({ vault, home, embedder, open });
  expect(r.skipped).toBe(false);
  expect(readGenerationManifest(home)!.db).not.toBe("gen-dirty.db");
  const ro = await LibsqlStore.create(embedder, join(home, readGenerationManifest(home)!.db), { readonly: true }); // rebuilt = clean + servable
  expect((await ro.recall({ query: "sourdough loaf", k: 1 })).length).toBe(1);
  await ro.close();
});

test("publishReindex R2-2: a MISSING-CORE-TABLE equal-generation target is NOT skipped — rebuilt", async () => {
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-pub-missingtable-"));
  await publishReindex({ vault, home, embedder, open });
  const m1 = readGenerationManifest(home)!;
  const raw = new BunDatabase(join(home, m1.db)); // drop a core table via a raw SQLite handle
  raw.run("drop table nodes");
  raw.close();
  const r = await publishReindex({ vault, home, embedder, open });
  expect(r.skipped).toBe(false); // RO validation rejects the missing table ⇒ rebuild
  expect(readGenerationManifest(home)!.db).not.toBe(m1.db);
});

test("publishReindex R2-2: a hot -journal sidecar on the target blocks skip — rebuilt", async () => {
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-pub-hotjournal-"));
  await publishReindex({ vault, home, embedder, open });
  const m1 = readGenerationManifest(home)!;
  writeFileSync(join(home, m1.db + "-journal"), ""); // a hot rollback journal beside a finalized db
  const r = await publishReindex({ vault, home, embedder, open });
  expect(r.skipped).toBe(false); // -journal ⇒ not finalized ⇒ rebuild
  expect(readGenerationManifest(home)!.db).not.toBe(m1.db);
});

test("PublishedIndex F2: a running consumer ADOPTS a --force republish (same generation, new db)", async () => {
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-pub-force-adopt-"));
  const g = (await publishReindex({ vault, home, embedder, open })).generation;
  const m1 = readGenerationManifest(home)!;
  const opens: string[] = [];
  const countingOpen = (p: string) => { opens.push(p); return open(p); };
  const consumer = new PublishedIndex(home, countingOpen);
  await consumer.with(async (_s, gen) => expect(gen).toBe(g)); // open #1: m1.db

  await publishReindex({ vault, home, embedder, open, force: true }); // SAME generation, NEW db file
  const m2 = readGenerationManifest(home)!;
  expect(m2.generation).toBe(g);
  expect(m2.db).not.toBe(m1.db);

  await consumer.with(async (store, gen) => {
    expect(gen).toBe(g);
    expect((await store.recall({ query: "sourdough loaf", k: 1 })).length).toBe(1);
  });
  // the generation is UNCHANGED, yet the consumer swapped (identity is the (gen,db) PAIR): a 2nd
  // open happened, onto the new db — pre-F2 the consumer would have kept the retired m1.db handle
  expect(opens.length).toBe(2);
  expect(opens[1]).toBe(join(home, m2.db));
  await consumer.close();
});

test("PublishedIndex F4: the served db is unlinked between manifest read and open — retries onto the republished target", async () => {
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-pub-toctou-"));
  const g1 = (await publishReindex({ vault, home, embedder, open })).generation;
  const m1 = readGenerationManifest(home)!;

  let raced = false;
  const roOpen = (p: string) => LibsqlStore.create(embedder, p, { readonly: true });
  const racingOpen = async (p: string) => {
    if (!raced && p === join(home, m1.db)) {
      raced = true;
      // the publisher swaps + POSIX-unlinks g1 UNDER us, between the consumer's manifest read and this open
      writeFileSync(join(vault, "wiki", "gamma.md"), "---\ntitle: Gamma\n---\ngamma page\n");
      await publishReindex({ vault, home, embedder, open }); // publishes g2, unlinks g1's db
    }
    return roOpen(p); // for the now-gone g1 path this THROWS → openTarget re-reads the manifest and retries onto g2
  };
  const consumer = new PublishedIndex(home, racingOpen);
  const served = await consumer.with(async (store, generation) => {
    expect((await store.recall({ query: "sourdough loaf", k: 1 })).length).toBe(1); // never a torn/closed handle
    return generation;
  });
  expect(served).not.toBe(g1); // did NOT fail on the vanished g1 — retried onto the republished target
  expect(served).toBe(readGenerationManifest(home)!.generation);
  await consumer.close();
});

test("readGenerationManifest: unreadable/traversing manifests are null (fail-closed consumer)", () => {
  const home = mkdtempSync(join(tmpdir(), "funes-pub-bad-"));
  expect(readGenerationManifest(home)).toBeNull();
  writeFileSync(manifestPath(home), "not json");
  expect(readGenerationManifest(home)).toBeNull();
  publishGenerationManifest(home, { version: 1, generation: "v1:x", db: "../escape.db", publishedAt: "now" });
  expect(readGenerationManifest(home)).toBeNull(); // db path may never escape the home
  expect(hasPublishedGeneration(home)).toBe(false);
});

test("PublishedIndex: a reader looping ops flips generations mid-republish with NO torn read", async () => {
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-pub-swap-"));
  const g1 = (await publishReindex({ vault, home, embedder, open })).generation;

  const consumer = new PublishedIndex(home, open); // checkIntervalMs 0 = stat the manifest per op
  const seen = new Set<string>();
  let g2: string | null = null;

  for (let i = 0; i < 24; i++) {
    if (i === 10) {
      // the WRITER republishes while the reader loop is live — no reader restart, no coordination
      writeFileSync(join(vault, "wiki", "delta.md"), "---\ntitle: Delta\n---\nmid-loop delta page\n");
      g2 = (await publishReindex({ vault, home, embedder, open })).generation;
      expect(g2).not.toBe(g1);
    }
    // every op leases a coherent (store, generation) pair — a swap can never close a leased store
    await consumer.with(async (store, generation) => {
      seen.add(generation!); // no fallback configured — generation is always a published string here
      const res = await store.recall({ query: "sourdough loaf", k: 2 });
      expect(res.length).toBeGreaterThan(0); // never a torn/closed handle
      const stamped = await store.getGeneration();
      expect(stamped).toBe(generation); // the leased store IS the generation the lease names
      if (generation === g2) {
        // the new generation serves the new content
        const d = await store.recall({ query: "delta page", k: 3 });
        expect(d.map((r) => r.id)).toContain("wiki/delta");
      }
    });
  }
  expect([...seen].sort()).toEqual([g1, g2!].sort()); // exactly the two generations, nothing torn
  expect(consumer.generation).toBe(g2!); // the reader ENDS on the republished generation
  await consumer.close();
});

test("PublishedIndex: no published generation -> loud refusal; a lease held across a swap drains before close", async () => {
  const emptyHome = mkdtempSync(join(tmpdir(), "funes-pub-empty-"));
  const c = new PublishedIndex(emptyHome, open);
  await expect(c.with(async () => 0)).rejects.toThrow(/no published generation/);

  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-pub-lease-"));
  const g1 = (await publishReindex({ vault, home, embedder, open })).generation;
  const consumer = new PublishedIndex(home, open);

  // hold a lease OPEN across a republish: the old store must stay usable for the whole op
  let releaseHold!: () => void;
  const holdGate = new Promise<void>((r) => { releaseHold = r; });
  const held = consumer.with(async (store, generation) => {
    expect(generation).toBe(g1);
    await holdGate; // a republish happens while we hold this store
    const res = await store.recall({ query: "telescope mirror", k: 1 }); // still serving the OLD generation
    expect(res.length).toBe(1);
    return generation;
  });
  writeFileSync(join(vault, "wiki", "epsilon.md"), "---\ntitle: Epsilon\n---\nepsilon body\n");
  const g2 = (await publishReindex({ vault, home, embedder, open })).generation;
  // a FRESH op swaps to g2 even while the old lease is still held
  await consumer.with(async (_store, generation) => expect(generation).toBe(g2));
  releaseHold();
  expect(await held).toBe(g1); // the draining lease finished on its own generation, unclosed
  await consumer.close();
});
