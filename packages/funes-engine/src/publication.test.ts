import { test, expect } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import {
  PublishedIndex, computeTargetGeneration, hasPublishedGeneration, manifestPath,
  publishGenerationManifest, publicationIdOf, publishReindex, readGenerationManifest,
  writePrincipalStatus, readPrincipalStatuses, gcRetiredGenerations,
  withPublicationFence, startPrincipalHeartbeat, pinRetention, retainUntilOf,
  fleetReport, fleetAdvance, fleetPhaseOf, readFleetJournal, FLEET_PHASES,
  republishDecision,
} from "./publication.ts";
import { FUNES_VERSION } from "./version.ts";
import { GENERATION_VERSION, INDEX_SCHEMA_VERSION } from "funes-shared";
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
  expect(r1.generation).toMatch(new RegExp(`^${GENERATION_VERSION}:[0-9a-f]{64}$`));
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
  expect(r2.publicationId).toBe(r1.publicationId); // a skip REPORTS the publication it left standing
  expect(r1.publicationId).toBe(manifest!.publicationId!);
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
  const base = { currentDb: "gen-current.db", currentPublicationId: "pub:cur", priorDb: "gen-prior.db", graceMs: 0, staleAckMs: 120_000 };

  // (a) inventory declares [broker, read]; broker still serves the PRIOR publication → prior RETAINED
  writeFileSync(join(home, "principals.json"), JSON.stringify(["broker", "read"]));
  writePrincipalStatus(home, "broker", "pub:prior", "v1:prior");
  writePrincipalStatus(home, "read", "pub:cur", "v1:cur");
  gcRetiredGenerations(home, { ...base, now: future() });
  expect(existsSync(join(home, "gen-prior.db"))).toBe(true);   // broker hasn't swapped → kept
  expect(existsSync(join(home, "gen-orphan.db"))).toBe(false); // an orphan (not current/prior) is GC'd
  expect(existsSync(join(home, "gen-current.db"))).toBe(true); // never removed

  // (b) broker now swaps to current → prior no longer pinned → removed
  writePrincipalStatus(home, "broker", "pub:cur", "v1:cur");
  gcRetiredGenerations(home, { ...base, now: future() });
  expect(existsSync(join(home, "gen-prior.db"))).toBe(false);
});

test("item 8: retention keys on the PUBLICATION id — an ack whose content generation drifted still counts as swapped", async () => {
  // The hole this closes: `contentGeneration` is nullable and MUTATES (a broker write invalidates it
  // in the very database the principal is serving), so comparing it made a principal that HAD
  // swapped to the current artefact look un-acked and pin the prior db forever. The publication id
  // is immutable, so the ack survives the mutation.
  const home = mkdtempSync(join(tmpdir(), "funes-pub-gc-idack-"));
  const future = () => Date.now() + 60_000;
  writeFileSync(join(home, "gen-current.db"), "x");
  writeFileSync(join(home, "gen-prior.db"), "x");
  writeFileSync(join(home, "principals.json"), JSON.stringify(["broker"]));
  const base = { currentDb: "gen-current.db", currentPublicationId: "pub:cur", priorDb: "gen-prior.db", graceMs: 0, staleAckMs: 120_000 };

  // (a) the broker acked the OLD publication id — it is still serving the retired artefact → BLOCKED
  writePrincipalStatus(home, "broker", "pub:prior", "v1:cur"); // note: same content generation as current
  gcRetiredGenerations(home, { ...base, now: future() });
  expect(existsSync(join(home, "gen-prior.db"))).toBe(true);

  // (b) it acked the CURRENT id, and its content generation has since been invalidated to null by a
  //     broker write — the id still matches, so the prior is collectable.
  writePrincipalStatus(home, "broker", "pub:cur", null);
  gcRetiredGenerations(home, { ...base, now: future() });
  expect(existsSync(join(home, "gen-prior.db"))).toBe(false);
  expect(existsSync(join(home, "gen-current.db"))).toBe(true);
});

test("item 8: a LEGACY status file carrying no publication id BLOCKS collection (fail safe)", async () => {
  // A principal running a build older than item 8 writes `{principal, generation, at}`. We cannot
  // tell which artefact it opened, and collecting one a live principal might still be serving is the
  // outcome the ack channel exists to prevent — so an id-less status blocks. The staleAckMs TTL is
  // what still bounds it: the retention ends when that principal stops writing, not before.
  const home = mkdtempSync(join(tmpdir(), "funes-pub-gc-legacy-"));
  writeFileSync(join(home, "gen-current.db"), "x");
  writeFileSync(join(home, "gen-prior.db"), "x");
  writeFileSync(join(home, "principals.json"), JSON.stringify(["broker"]));
  mkdirSync(join(home, ".status"), { recursive: true });
  const now = Date.now();
  writeFileSync(join(home, ".status", "broker.json"), JSON.stringify({ principal: "broker", generation: "v1:cur", at: now }));
  const base = { currentDb: "gen-current.db", currentPublicationId: "pub:cur", priorDb: "gen-prior.db", graceMs: 0, staleAckMs: 120_000 };

  // Even though its `generation` EQUALS the current content generation — the old predicate's
  // "acked" — the missing id blocks.
  gcRetiredGenerations(home, { ...base, now: now + 1_000 });
  expect(existsSync(join(home, "gen-prior.db"))).toBe(true);

  // ...and only the staleness TTL releases it (the legacy principal died).
  gcRetiredGenerations(home, { ...base, now: now + 200_000 });
  expect(existsSync(join(home, "gen-prior.db"))).toBe(false);
  expect(existsSync(join(home, "gen-current.db"))).toBe(true);
});

test("P1.6d ack channel: a DEAD principal (stale status) does not pin a retired generation forever", async () => {
  const home = mkdtempSync(join(tmpdir(), "funes-pub-gc-dead-"));
  writeFileSync(join(home, "gen-current.db"), "x");
  writeFileSync(join(home, "gen-prior.db"), "x");
  writeFileSync(join(home, "principals.json"), JSON.stringify(["broker"]));
  writePrincipalStatus(home, "broker", "pub:prior", "v1:prior"); // broker last acked the prior, then died
  // now is far ahead of the status.at, so with a small staleAckMs the status is STALE → dead → does
  // not block GC; no fresh consumers ⇒ no grace ⇒ the prior is removed.
  gcRetiredGenerations(home, { currentDb: "gen-current.db", currentPublicationId: "pub:cur", priorDb: "gen-prior.db", now: Date.now() + 60_000, graceMs: 0, staleAckMs: 5_000 });
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

// 0.3.0 item 15. This test used to assert the opposite: a `fallbackDbPath` consumer served the live
// index.db (generation null) until the first publish arrived. That mode was not a lesser guarantee,
// it was a broken one — `funes reindex` rebuilds index.db IN PLACE, and replacing that file does not
// move the SQLite handle the consumer already holds, so what it served was frozen at open time and
// nothing in the protocol could tell it. A consumer serves published generations only, and the
// live index sitting right there is not a substitute.
test("PublishedIndex: nothing published REFUSES with the repair, never a live-index fallback — and the first publish still needs no restart", async () => {
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-pub-nofallback-"));
  // a static live index at the face's default path — the pre-publication (Mac / booted-early) layout
  const staticDb = join(home, "index.db");
  const direct = await LibsqlStore.create(embedder, staticDb);
  await direct.remember([{ id: "wiki/static", path: "wiki/static.md", title: "Static", body: "static direct body", trust: "trusted" }]);
  await direct.close();

  const consumer = new PublishedIndex(home, open);
  // the refusal names the problem, the fix, and the absence of an override (sync-root guard voice)
  await expect(consumer.with(async () => {})).rejects.toThrow(/no published generation/);
  await expect(consumer.with(async () => {})).rejects.toThrow(new RegExp(`funes publish --home ${home}`));
  await expect(consumer.with(async () => {})).rejects.toThrow(/no fallback and no override/);
  expect(consumer.generation).toBeNull(); // no handle was ever taken — not even a silent one
  // ...and the live index next door was NOT served, however tempting it was
  await expect(consumer.with(async () => {})).rejects.toThrow(); // still refusing while index.db sits there
  expect(existsSync(staticDb)).toBe(true);

  // the sidecar publishes AFTER the consumer was constructed — the very next op picks it up; the
  // late-adoption property that motivated the fallback survives without it
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
  await s.finalizeReindex({ contentGeneration: target });
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
      const stamped = (await store.contentIdentity()).contentGeneration;
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

// ── PLAN-0.3.0 item 14: clone-and-incremental off-path build ─────────────────────────────────────

test("item 14: a republish CLONES the prior generation and produces the generation a from-empty build would", async () => {
  // The correctness property that has to hold before the saving is worth anything: an incremental
  // build into a copy must stamp EXACTLY what a build from empty stamps, or the artefact is
  // mislabeled and item 10's recheck starts failing every publish.
  const vault = makeVault();
  const cloned = mkdtempSync(join(tmpdir(), "funes-pub-clone-"));
  const empty = mkdtempSync(join(tmpdir(), "funes-pub-empty-"));
  const first = await publishReindex({ vault, home: cloned, embedder, open });
  expect(first.clonedFrom).toBeNull(); // nothing to clone from on the first publish
  const priorDb = readGenerationManifest(cloned)!.db;
  const priorId = readGenerationManifest(cloned)!.publicationId;

  // one page edited, one added, one REMOVED — the prune path is what a clone could most plausibly
  // get wrong, because the stale row is already sitting in the copy.
  writeFileSync(join(vault, "wiki", "alpha.md"), "---\ntitle: Alpha\n---\nalpha rewritten body\n");
  writeFileSync(join(vault, "wiki", "gamma.md"), "---\ntitle: Gamma\n---\ngamma new body\n");
  rmSync(join(vault, "wiki", "beta.md"));

  const inc = await publishReindex({ vault, home: cloned, embedder, open });
  expect(inc.clonedFrom).toBe(priorDb);
  const fromEmpty = await publishReindex({ vault, home: empty, embedder, open, clonePrior: false });
  expect(fromEmpty.clonedFrom).toBeNull();
  expect(inc.generation).toBe(fromEmpty.generation);
  expect(inc.generation).toBe(computeTargetGeneration(vault, { embedder, scopeSignature: null }));

  // A NEW publication, not the prior one wearing new rows: the id is what acks and retention pins
  // bind to, so a clone that kept it would strand every one of them.
  const m = readGenerationManifest(cloned)!;
  expect(m.publicationId).not.toBe(priorId);
  const ro = await LibsqlStore.create(embedder, join(cloned, m.db), { readonly: true });
  try {
    expect((await ro.contentIdentity()).publicationId).toBe(m.publicationId!);
    expect((await ro.contentIdentity()).contentGeneration).toBe(inc.generation);
    // the removed page is GONE from the clone, not merely absent from the walk
    expect(await ro.indexedPage({ id: "wiki/beta" })).toBeNull();
    expect(await ro.indexedPage({ id: "wiki/gamma" })).not.toBeNull();
  } finally { await ro.close(); }
});

test("item 14: --force never clones, and an UNSERVABLE prior falls back to an empty build", async () => {
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-pub-clone-force-"));
  await publishReindex({ vault, home, embedder, open });

  // --force is the REPAIR verb; a repair that starts from the bytes it is repairing is not a repair.
  const forced = await publishReindex({ vault, home, embedder, open, force: true });
  expect(forced.clonedFrom).toBeNull();

  // A hot -wal sidecar beside the published db means the bytes may be torn — the read face's own
  // servability check already refuses it, and the clone rides on exactly that check.
  writeFileSync(join(vault, "wiki", "gamma.md"), "---\ntitle: Gamma\n---\ngamma body\n");
  writeFileSync(join(home, readGenerationManifest(home)!.db + "-wal"), "not really a wal");
  const fallback = await publishReindex({ vault, home, embedder, open });
  expect(fallback.clonedFrom).toBeNull();
  expect(fallback.generation).toBe(computeTargetGeneration(vault, { embedder, scopeSignature: null }));
});

// ── PLAN-0.3.0 item 23 at the publisher's ENTRY ──────────────────────────────────────────────────

test("item 23: a publication HOME inside a sync root refuses before anything is built or written", async () => {
  // `publishReindex` has two openers that bypass makeStore — the caller's `open` closure and the
  // servability RO open under it — so the guard on the HOME at its entry is the only one either
  // path gets. It runs before mkdirSync and before the per-home chain: a refused home is not a home
  // to create. Confirmed to fail with that line removed — the publish then builds and publishes
  // into the synced directory, and `opens` is no longer empty.
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-pub-syncroot-"));
  writeFileSync(join(home, ".stfolder"), ""); // the marker as Syncthing writes it — INSIDE its root
  const opens: string[] = [];
  const countingOpen = (p: string) => { opens.push(p); return open(p); };
  await expect(publishReindex({ vault, home, embedder, open: countingOpen })).rejects.toThrow(/refusing to open an index inside a Syncthing root/);
  expect(opens).toEqual([]);                        // no builder, no servability probe
  expect(readdirSync(home)).toEqual([".stfolder"]); // no manifest, no gen-*.db, no lock, no temp file
  expect(hasPublishedGeneration(home)).toBe(false);
});

// ── PLAN-0.3.0 item 9: ONE publication-home mutation fence ───────────────────────────────────────

test("item 9: the publication fence and the publisher share ONE key — a held fence blocks a publish", async () => {
  // The hole: the store lock is keyed by DATABASE PATH (three different ones in a publication home)
  // and the broker's own wrapper was a PASS-THROUGH unless FUNES_COORDINATION_DIR was set, so a
  // broker write and a publish into the same home were serialized by nothing. This asserts the two
  // sides now contend: a fence held by an unrelated async context holds the publisher out.
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-pub-fence-"));
  const events: string[] = [];
  const gate = Promise.withResolvers<void>();
  const held = withPublicationFence(home, async () => {
    events.push("fence:acquired");
    await gate.promise;
    events.push("fence:released");
  });
  await Bun.sleep(10); // let the holder actually take it
  const pub = publishReindex({ vault, home, embedder, open }).then((r) => { events.push("publish:done"); return r; });
  // Generous on purpose: a two-page fake-embedder publish is tens of milliseconds, so an UNFENCED
  // publish finishes well inside this window and the assertion fails on ORDER, not on timing luck.
  await Bun.sleep(400);
  gate.resolve();
  const [, r] = await Promise.all([held, pub]);
  expect(events).toEqual(["fence:acquired", "fence:released", "publish:done"]);
  expect(r.skipped).toBe(false);
});

// ── PLAN-0.3.0 item 10: recompute the target UNDER the fence, immediately before the swap ─────────

test("item 10: a page changed AFTER the walker read it is caught by the pre-swap recheck, not published", async () => {
  // The exact failure the item names: `target` is computed before the build walk, so a page mutated
  // after the walker read it leaves built === oldTarget and validation waves the stale artefact
  // through. `onProgress` fires after each batch — with batch:1, after alpha has been read and
  // remembered and before beta is read — so rewriting alpha there reproduces it deterministically.
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-pub-recheck-"));
  let mutated = false;
  await expect(publishReindex({
    vault, home, embedder, open, batch: 1,
    onProgress: () => {
      if (mutated) return;
      mutated = true;
      writeFileSync(join(vault, "wiki", "alpha.md"), "---\ntitle: Alpha\n---\nalpha body REWRITTEN mid-build\n");
    },
  })).rejects.toThrow(/moved between the build and the swap/);
  expect(mutated).toBe(true);
  // Nothing published, and no half-built generation left for a later publish to trust.
  expect(hasPublishedGeneration(home)).toBe(false);
  expect(readdirSync(home).filter((f) => f.endsWith(".db"))).toEqual([]);
  // The retry the message asks for succeeds, because the vault is now still.
  const r = await publishReindex({ vault, home, embedder, open });
  expect(r.skipped).toBe(false);
  expect(readGenerationManifest(home)?.generation).toBe(r.generation);
});

// ── RAI-143 clause 3 + item 33: the status file's shape ──────────────────────────────────────────

test("item 33: a status file names publicationId, contentGeneration, principal, protocolVersion, softwareVersion, at", async () => {
  const home = mkdtempSync(join(tmpdir(), "funes-pub-status-shape-"));
  writePrincipalStatus(home, "read", "pub:abc", "v2:def");
  const raw = JSON.parse(readFileSync(join(home, ".status", "read.json"), "utf8")) as Record<string, unknown>;
  expect(Object.keys(raw).sort()).toEqual(["at", "contentGeneration", "principal", "protocolVersion", "publicationId", "softwareVersion"]);
  expect(raw.publicationId).toBe("pub:abc");
  expect(raw.contentGeneration).toBe("v2:def"); // renamed from `generation` — see PrincipalStatus
  expect(raw.protocolVersion).toBe(INDEX_SCHEMA_VERSION);
  expect(raw.softwareVersion).toBe(FUNES_VERSION);
  // ...and a status written by an older build still READS: a rollout has to be able to inventory the
  // fleet it is migrating, and a pre-item-33 principal names its content generation `generation`.
  writeFileSync(join(home, ".status", "legacy.json"), JSON.stringify({ principal: "legacy", generation: "v1:old", at: Date.now() }));
  const legacy = readPrincipalStatuses(home).find((s) => s.principal === "legacy")!;
  expect(legacy.contentGeneration).toBe("v1:old");
  expect(legacy.protocolVersion).toBeNull(); // "a build too old to say" — the fleet gate reads this as LEGACY
  expect(legacy.publicationId).toBeNull();
});

// ── DEFECT RAI-144: the heartbeat ────────────────────────────────────────────────────────────────

test("RAI-144: a principal's status is refreshed on a HEARTBEAT, not only on a publication swap", async () => {
  // Before this, writePrincipalStatus fired only from `onServe`. A face that swapped once at boot and
  // then served quietly crossed DEFAULT_STALE_ACK_MS (15 min), read as DEAD to the publisher's GC,
  // stopped blocking collection, and had the artefact it was still holding open retired under it.
  const home = mkdtempSync(join(tmpdir(), "funes-pub-heartbeat-"));
  let served = "pub:first";
  const readAt = () => JSON.parse(readFileSync(join(home, ".status", "read.json"), "utf8")) as { at: number; publicationId: string };
  const hb = startPrincipalHeartbeat(home, "read", async () => ({ publicationId: served, contentGeneration: "v2:x" }), { intervalMs: 1_000 });
  try {
    await hb.refresh(); // the swap-equivalent first stamp
    const first = readAt();
    expect(first.publicationId).toBe("pub:first");
    // No swap happens; the sample simply moves, and the next beat must pick it up.
    served = "pub:second";
    await Bun.sleep(1_400);
    const second = readAt();
    expect(second.publicationId).toBe("pub:second");
    expect(second.at).toBeGreaterThan(first.at);
  } finally {
    hb.stop();
  }
  // stop() means stop: the stale-ack TTL is only meaningful if a dead principal really stops writing.
  const atStop = readAt().at;
  await Bun.sleep(1_400);
  expect(readAt().at).toBe(atStop);
});

// ── PLAN-0.3.0 item 38: rollback retention is a STORED PIN ───────────────────────────────────────

test("item 38: a retainUntil pin holds the prior artefact even with NO live consumer recorded", async () => {
  // The case the item names: collection deleted the prior artefact IMMEDIATELY when nothing was
  // acking the home — which is every CLI publish, and every home mid-rollout — so "retain for the
  // rollback window" was an adjective with no mechanism behind it.
  const home = mkdtempSync(join(tmpdir(), "funes-pub-retain-"));
  writeFileSync(join(home, "gen-current.db"), "x");
  writeFileSync(join(home, "gen-prior.db"), "x");
  const base = { currentDb: "gen-current.db", currentPublicationId: "pub:cur", priorDb: "gen-prior.db", graceMs: 0, staleAckMs: 120_000 };
  const now = Date.now();
  pinRetention(home, "gen-prior.db", now + 60_000);
  expect(retainUntilOf(home, "gen-prior.db")).toBe(now + 60_000);

  gcRetiredGenerations(home, { ...base, now: now + 1_000 }); // no principals reporting at all
  expect(existsSync(join(home, "gen-prior.db"))).toBe(true);

  // ...and the pin EXPIRES — retention is bounded, not permanent.
  gcRetiredGenerations(home, { ...base, now: now + 61_000 });
  expect(existsSync(join(home, "gen-prior.db"))).toBe(false);
  expect(existsSync(join(home, "gen-prior.db.retain"))).toBe(false); // the pin goes with the db it named
  expect(existsSync(join(home, "gen-current.db"))).toBe(true);
});

test("item 38: publishReindex --retain-prior pins the OUTGOING generation; the default pins nothing", async () => {
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-pub-retain-pub-"));
  const r1 = await publishReindex({ vault, home, embedder, open });
  const db1 = readGenerationManifest(home)!.db;

  writeFileSync(join(vault, "wiki", "gamma.md"), "---\ntitle: Gamma\n---\ngamma body\n");
  await publishReindex({ vault, home, embedder, open, retainPriorMs: 3_600_000 });
  // The prior db survived the publish's own collection — with no principal reporting it would
  // otherwise have been unlinked on the spot (the test above).
  expect(existsSync(join(home, db1))).toBe(true);
  expect(retainUntilOf(home, db1)).toBeGreaterThan(Date.now());
  expect(r1.generation).not.toBe(readGenerationManifest(home)!.generation);

  // Default (no window): today's behaviour, unchanged.
  const home2 = mkdtempSync(join(tmpdir(), "funes-pub-retain-off-"));
  await publishReindex({ vault, home: home2, embedder, open });
  const db2 = readGenerationManifest(home2)!.db;
  writeFileSync(join(vault, "wiki", "delta.md"), "---\ntitle: Delta\n---\ndelta body\n");
  await publishReindex({ vault, home: home2, embedder, open });
  expect(existsSync(join(home2, db2))).toBe(false);
});

// ── PLAN-0.3.0 items 33 + 39: the fleet gate ─────────────────────────────────────────────────────

test("item 39: fleet reports each home's schema version, publication id, content generation and validity", async () => {
  const vault = makeVault();
  const good = mkdtempSync(join(tmpdir(), "funes-fleet-good-"));
  const empty = mkdtempSync(join(tmpdir(), "funes-fleet-empty-"));
  await publishReindex({ vault, home: good, embedder, open });

  const [g, e] = await fleetReport([good, empty]);
  expect(g!.problems).toEqual([]);
  expect(g!.schemaVersion).toBe(INDEX_SCHEMA_VERSION);
  expect(g!.publicationId).toBe(readGenerationManifest(good)!.publicationId!);
  expect(g!.contentGeneration).toBe(readGenerationManifest(good)!.generation);
  expect(g!.phase).toBeNull();
  // An unreachable home is a REPORT, never a throw: a gate that dies on the first broken home tells
  // the operator about one home instead of eight.
  expect(e!.problems.join(" ")).toMatch(/nothing is published/);
});

test("item 39: the fleet REFUSES to advance while any home or LIVE principal is inconsistent, and nothing is written", async () => {
  const vault = makeVault();
  const a = mkdtempSync(join(tmpdir(), "funes-fleet-a-"));
  const b = mkdtempSync(join(tmpdir(), "funes-fleet-b-"));
  await publishReindex({ vault, home: a, embedder, open });
  await publishReindex({ vault, home: b, embedder, open });
  // A LIVE principal on b is a pre-item-33 build: it names no protocol, and step 33's gate is
  // POSITIVE — a process that cannot say what it speaks is legacy, not unknown.
  mkdirSync(join(b, ".status"), { recursive: true });
  writeFileSync(join(b, ".status", "broker.json"), JSON.stringify({ principal: "broker", generation: "v1:old", at: Date.now() }));

  const refused = await fleetAdvance([a, b], "readers");
  expect(refused.advanced).toEqual([]);
  expect(refused.refusals.join(" ")).toMatch(/live principal "broker" advertises protocol none/);
  expect(fleetPhaseOf(a)).toBeNull(); // ALL-or-none: the healthy home was not advanced either
  expect(fleetPhaseOf(b)).toBeNull();

  // The legacy principal is stopped (its status goes stale) → the fleet advances.
  writeFileSync(join(b, ".status", "broker.json"), JSON.stringify({ principal: "broker", generation: "v1:old", at: Date.now() - 60 * 60_000 }));
  const ok = await fleetAdvance([a, b], "readers");
  expect(ok.refusals).toEqual([]);
  expect(fleetPhaseOf(a)).toBe("readers");
  expect(fleetPhaseOf(b)).toBe("readers");

  // Resume: re-running an already-recorded phase is an idempotent no-op, which is what makes an
  // interrupted run safe to simply re-run.
  const again = await fleetAdvance([a, b], "readers");
  expect(again.refusals).toEqual([]);
  expect(readFleetJournal(a).length).toBe(1);

  // Skipping a rung is refused — the journal is a ladder, not a label.
  const skipped = await fleetAdvance([a, b], "proven");
  expect(skipped.refusals.join(" ")).toMatch(/would skip quiesced, published/);
  expect(fleetPhaseOf(a)).toBe("readers");
});

test("item 39: an acking live principal does not block; the journal is durable and a non-swapped one does block", async () => {
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-fleet-ack-"));
  await publishReindex({ vault, home, embedder, open });
  const manifest = readGenerationManifest(home)!;
  writePrincipalStatus(home, "read", manifest.publicationId!, manifest.generation);

  const [r] = await fleetReport([home]);
  expect(r!.problems).toEqual([]);
  expect(r!.principals[0]!.live).toBe(true);
  expect(r!.principals[0]!.acked).toBe(true);
  expect(r!.principals[0]!.protocolVersion).toBe(INDEX_SCHEMA_VERSION);
  expect(r!.principals[0]!.softwareVersion).toBe(FUNES_VERSION);

  await fleetAdvance([home], "readers");
  await fleetAdvance([home], "quiesced");
  // The journal is a FILE in the home, so a fresh process reads the same ladder position.
  expect(fleetPhaseOf(home)).toBe("quiesced");
  expect(readFleetJournal(home).map((e) => e.phase)).toEqual(["readers", "quiesced"]);
  expect(readFleetJournal(home)[0]!.publicationId).toBe(manifest.publicationId!);

  // A principal that has NOT swapped blocks the gate: it is serving an artefact the rollout is
  // about to move past, which is exactly what the transition manifest exists to hold.
  writePrincipalStatus(home, "read", "pub:somethingelse", "v2:x");
  const refused = await fleetAdvance([home], "published");
  expect(refused.refusals.join(" ")).toMatch(/has not swapped/);
});

// ── the heartbeat's sample must be ONE artefact, not two halves of two ───────────────────────────

test("startPrincipalHeartbeat: a beat that DISCOVERS a swap writes a self-consistent pair, not the old id with the new content", async () => {
  // The race this closes: the sample used to be built as an object literal —
  //   { publicationId: published.publicationId, contentGeneration: await published.with(...) }
  // — and a literal evaluates the getter FIRST, synchronously, before the awaited with() that runs
  // maybeSwap. So the beat that happens to be the one to notice a republish read the PRE-swap id
  // and then the POST-swap content, and wrote that pair into the status file. Retention keys on the
  // id (item 8), so the publisher would pin the retired artefact and leave the live one unacked.
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-pub-beat-swap-"));
  await publishReindex({ vault, home, embedder, open });
  const p1 = publicationIdOf(readGenerationManifest(home)!);

  const consumer = new PublishedIndex(home, open);
  // A very long interval: every beat in this test is an explicit refresh(), so the assertions are
  // about which CALL observed the swap, never about timer luck.
  const heartbeat = startPrincipalHeartbeat(home, "beat-test", () => consumer.sampleIdentity(), { intervalMs: 3_600_000 });

  await heartbeat.refresh(); // the consumer is now serving p1 and has acked it
  expect(readPrincipalStatuses(home).find((s) => s.principal === "beat-test")!.publicationId).toBe(p1);

  // Republish behind the consumer's back. It has not run an op since, so its `current` still names
  // p1 — the next thing to call with() is the beat itself, which is the racing case exactly.
  writeFileSync(join(vault, "wiki", "gamma.md"), "---\ntitle: Gamma\n---\ngamma page body\n");
  await publishReindex({ vault, home, embedder, open });
  const m2 = readGenerationManifest(home)!;
  const p2 = publicationIdOf(m2);
  expect(p2).not.toBe(p1);

  await heartbeat.refresh(); // THIS beat discovers the swap
  heartbeat.stop();

  const status = readPrincipalStatuses(home).find((s) => s.principal === "beat-test")!;
  // Self-consistency, checked against the artefact itself rather than against a remembered value:
  // both halves of the status must be what the database the manifest points at actually stamps.
  const served = await open(join(home, m2.db));
  const identity = await served.contentIdentity();
  await served.close();
  expect(status.publicationId).toBe(identity.publicationId);
  expect(status.contentGeneration).toBe(identity.contentGeneration);
  // and the specific incoherent pair the old code produced — the retired id beside live content
  expect(status.publicationId).not.toBe(p1);
  expect(status.publicationId).toBe(p2);

  await consumer.close();
});

// ── the schema fence at the publication home (PLAN-0.3.0 R2#2; rollout steps 30 and 32) ─────────

test("schema fence: a published \"3\" artefact with UNCHANGED content is neither SKIPPED nor CLONED — the next publish lands a \"4\"; the \"3\" still serves read-only meanwhile", async () => {
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-pub-fence-"));
  const first = await publishReindex({ vault, home, embedder, open });
  const m1 = readGenerationManifest(home)!;
  // Downgrade the published artefact's stamp to "3": a 0.2.x publication of this exact content. The
  // rows are identical — "4" changed none — so only the stamp separates the two.
  const raw = new BunDatabase(join(home, m1.db));
  raw.run("update meta set value='3' where key='schema_version'");
  raw.close();

  // Step 30, dual-read: the v4 readers are deployed BEFORE the home is republished, so they must
  // keep serving it — the store's RO open directly, and through the consumer the faces use.
  const ro = await LibsqlStore.create(embedder, join(home, m1.db), { readonly: true });
  try {
    expect((await ro.stats()).schemaVersion).toBe("3");
    expect((await ro.recall({ query: "sourdough loaf", k: 1 })).length).toBe(1);
  } finally { await ro.close(); }
  const consumer = new PublishedIndex(home, (p) => LibsqlStore.create(embedder, p, { readonly: true }));
  try {
    await consumer.with(async (store) => expect((await store.recall({ query: "sourdough loaf", k: 1 })).length).toBe(1));
  } finally { await consumer.close(); }

  // Step 32, publish the v4 artefact. Equal content would SKIP, and item 14 would CLONE the prior —
  // a copy of a "3" file that the builder's own read-write open refuses. Neither may happen: the
  // build starts from empty and the artefact it lands is stamped "4". Without the schema condition
  // in publishedTargetIsServable this is a skip (the dual-read RO open passes, the generation is
  // equal), and the "3" artefact stays published forever.
  const r = await publishReindex({ vault, home, embedder, open });
  expect(r.skipped).toBe(false);
  expect(r.clonedFrom).toBeNull();
  expect(r.generation).toBe(first.generation); // same content ⇒ same generation; only the schema moved
  const m2 = readGenerationManifest(home)!;
  expect(m2.db).not.toBe(m1.db);
  const ro2 = await LibsqlStore.create(embedder, join(home, m2.db), { readonly: true });
  try { expect((await ro2.stats()).schemaVersion).toBe(INDEX_SCHEMA_VERSION); } finally { await ro2.close(); }
});

// ── rollout step 34 DROPPED: the manifest-v2 rung leaves the ladder ──────────────────────────────

test("step 34 dropped: there is no manifest-v2 rung, and a journal entry that still names it is ignored", () => {
  // The rung journaled a phase no code could perform (RAI-148). A home whose journal was written
  // while it existed must not read as parked on it: readFleetJournal filters unknown phases, so the
  // entry vanishes and the home's position is the last REAL rung it reached. Before the rung was
  // removed this journal read as ["proven", "manifest-v2"] and the home sat at "manifest-v2".
  const home = mkdtempSync(join(tmpdir(), "funes-fleet-dropped-rung-"));
  writeFileSync(join(home, "fleet-journal.json"), JSON.stringify({ entries: [
    { phase: "proven", at: "2026-09-01T00:00:00Z", publicationId: "pub:x" },
    { phase: "manifest-v2", at: "2026-09-02T00:00:00Z", publicationId: "pub:x" },
  ] }));
  expect(FLEET_PHASES as readonly string[]).not.toContain("manifest-v2");
  expect(FLEET_PHASES.indexOf("verified")).toBe(FLEET_PHASES.indexOf("proven") + 1); // proven → verified, nothing between
  expect(readFleetJournal(home).map((e) => e.phase)).toEqual(["proven"]);
  expect(fleetPhaseOf(home)).toBe("proven");
});

// ── RAI-143 clause 1: `funes republish` — the recovery matrix, in order ──────────────────────────
// Integrity and pairing are classified BEFORE validity: the content stamp is read out of the bytes,
// so bytes that are dirty, unreadable, drifted, or not the pair the manifest names are reported as
// that fault, never as "invalidated" — which would send the operator to the wrong repair.

const decide = (home: string, force = false) => republishDecision(home, { embedder, force });

test("republish 1/5: no manifest → REFUSE, naming `funes publish` — and --force does not change that", async () => {
  const home = mkdtempSync(join(tmpdir(), "funes-republish-none-"));
  const v = await decide(home);
  expect(v).toMatchObject({ action: "refuse", why: "no-manifest" });
  expect(v.detail).toMatch(/funes publish/);
  expect((await decide(home, true)).action).toBe("refuse"); // nothing to repair, forced or not
});

test("republish 2/5: a DIRTY artefact is an INTEGRITY fault, classified before the invalidation it also carries — never-finalized is not a separate case", async () => {
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-republish-dirty-"));
  const target = computeTargetGeneration(vault, { embedder, scopeSignature: null });
  // A manifest-named artefact that was never finalized: stamped and paired, then a full run began
  // in it and died. It ALSO carries an invalidation, so the ORDER is what this asserts: a database
  // that is dirty and invalidated is reported dirty, because the stamp is read out of bytes the
  // dirty marker says not to trust.
  const dbP = join(home, "gen-dirty.db");
  const s = await LibsqlStore.create(embedder, dbP);
  await s.remember([{ id: "wiki/alpha", path: "wiki/alpha.md", title: "Alpha", body: "alpha sourdough loaf body", trust: "trusted" }]);
  await s.finalizeReindex({ contentGeneration: target });
  await s.setPublicationId("pub:dirty");
  await s.finalizeForPublish();
  await s.remember([{ id: "wiki/alpha", path: "wiki/alpha.md", title: "Alpha", body: "alpha edited after publish", trust: "trusted" }]); // invalidates
  expect((await s.contentIdentity()).invalidatedAt).not.toBeNull();
  await s.beginReindex(); // reindex_dirty=1, and the run never finishes
  await s.close();
  publishGenerationManifest(home, { version: 1, generation: target, publicationId: "pub:dirty", db: "gen-dirty.db", publishedAt: new Date().toISOString() });
  const v = await decide(home);
  expect(v).toMatchObject({ action: "rebuild", why: "integrity" });
  expect(v.detail).toMatch(/dirty/);
});

test("republish 2/5: a db that is not the artefact its manifest names → INTEGRITY (pairing), naming both ids; a legacy id-less manifest is not a pairing failure", async () => {
  const vault = makeVault();
  const a = mkdtempSync(join(tmpdir(), "funes-republish-pair-a-"));
  const b = mkdtempSync(join(tmpdir(), "funes-republish-pair-b-"));
  await publishReindex({ vault, home: a, embedder, open });
  await publishReindex({ vault, home: b, embedder, open });
  const ma = readGenerationManifest(a)!;
  const mb = readGenerationManifest(b)!;
  expect(ma.generation).toBe(mb.generation); // same content, two publications — the swap the pair check exists to catch
  expect(ma.publicationId).not.toBe(mb.publicationId);
  copyFileSync(join(b, mb.db), join(a, ma.db)); // b's bytes under a's manifest
  // ...and INVALIDATED on top, so the order is asserted here as well: mispaired beats invalidated,
  // because the invalidation was read out of an artefact the manifest does not name.
  const broker = await LibsqlStore.create(embedder, join(a, ma.db));
  await broker.remember([{ id: "wiki/alpha", path: "wiki/alpha.md", title: "Alpha", body: "alpha body, edited under the wrong manifest", trust: "trusted" }]);
  await broker.close();
  const v = await decide(a);
  expect(v).toMatchObject({ action: "rebuild", why: "integrity" });
  expect(v.detail).toContain(ma.publicationId!);
  expect(v.detail).toContain(mb.publicationId!);
  // A LEGACY manifest names no id, and its derived id is unvalidatable by design, so the same
  // foreign-but-sound bytes (b's, copied afresh) under an id-less manifest are NOT a pairing
  // failure: the stamp decides, and it is valid → refuse.
  copyFileSync(join(b, mb.db), join(a, ma.db));
  publishGenerationManifest(a, { version: 1, generation: ma.generation, db: ma.db, publishedAt: ma.publishedAt });
  expect(await decide(a)).toMatchObject({ action: "refuse", why: "valid" });
});

test("republish 3/5: an INVALIDATED content generation (a broker write through the published db) → rebuild, naming the instant and the reason", async () => {
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-republish-invalidated-"));
  await publishReindex({ vault, home, embedder, open });
  const m = readGenerationManifest(home)!;
  // Broker-style: a RW open of the published file and an incremental write into it (item 11). The
  // file stays a finalized DELETE-journal db, so the read face still opens it — integrity holds,
  // and the matrix moves on to validity.
  const broker = await LibsqlStore.create(embedder, join(home, m.db));
  await broker.remember([{ id: "wiki/alpha", path: "wiki/alpha.md", title: "Alpha", body: "alpha body, edited by the broker", trust: "trusted" }]);
  const at = (await broker.contentIdentity()).invalidatedAt!;
  await broker.close();
  const v = await decide(home);
  expect(v).toMatchObject({ action: "rebuild", why: "invalidated" });
  expect(v.detail).toContain(at);
  expect(v.detail).toMatch(/remember: 1 page re-indexed/);
});

test("republish 4/5: a LEGACY v1 stamp → rebuild, named as a legacy stamp", async () => {
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-republish-legacy-"));
  await publishReindex({ vault, home, embedder, open });
  const m = readGenerationManifest(home)!;
  const raw = new BunDatabase(join(home, m.db)); // a 0.2.1 index, exactly as that release left it
  raw.prepare("update meta set value=? where key='generation'").run("v1:" + "e".repeat(64));
  raw.close();
  const v = await decide(home);
  expect(v).toMatchObject({ action: "rebuild", why: "legacy-stamp" });
  expect(v.detail).toMatch(/legacy v1 stamp/);
});

test("republish 5/5: valid and paired → REFUSE; --force → rebuild under ONE fence, a NEW publication of the same content, never cloned", async () => {
  const vault = makeVault();
  const home = mkdtempSync(join(tmpdir(), "funes-republish-valid-"));
  const first = await publishReindex({ vault, home, embedder, open });
  const refused = await decide(home);
  expect(refused).toMatchObject({ action: "refuse", why: "valid" });
  expect(refused.detail).toContain(first.publicationId);
  expect(refused.detail).toMatch(/--force/);
  expect(readGenerationManifest(home)!.publicationId).toBe(first.publicationId); // nothing moved

  // The CLI's exact shape: decision and rebuild under one OUTER hold of the fence. Both inner calls
  // take the fence too; were it not reentrant for this async owner, the nested publish would wait
  // on the outer hold until the coordination timeout and this test would fail on it.
  const r = await withPublicationFence(home, async () => {
    const v = await decide(home, true);
    expect(v).toMatchObject({ action: "rebuild", why: "forced" });
    return publishReindex({ vault, home, embedder, open, force: true });
  });
  expect(r.skipped).toBe(false);
  expect(r.clonedFrom).toBeNull();                        // the repair verb never clones (item 14)
  expect(r.generation).toBe(first.generation);            // the same content...
  expect(r.publicationId).not.toBe(first.publicationId);  // ...as a NEW publication of it
  const m = readGenerationManifest(home)!;
  expect(m.publicationId).toBe(r.publicationId);          // reported, and it is what the home now names
  expect(await decide(home)).toMatchObject({ action: "refuse", why: "valid" }); // repaired ⇒ nothing left to repair
});
