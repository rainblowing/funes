// Content identity (PLAN-0.3.0 items 8, 11, 12, 13) — the release's centre, at the store level.
//
// THE BUG THIS FILE PINS: `setGeneration()` was called from exactly one place, inside reindex.ts's
// `if (full)` block, while remember/remove/prune wrote rows and never touched the stamp. Two loci
// could therefore hold ONE generation string over DIFFERENT row sets, on one backend, with nothing
// replicated. The fix is not "invalidate on every write" — that is the same cost bomb from the
// other end (Codex R4#9), because recovery is manual (item 13) and a republish re-embeds. So the
// invalidation is EVIDENCE-driven, and the stamping is ATOMIC.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder, MemoryItem } from "funes-core";
import Database from "libsql";
import { INDEX_SCHEMA_VERSION } from "funes-shared";
import { LibsqlStore } from "./store.ts";

const fakeEmbedder: Embedder = {
  dim: 8,
  async embedQuery() { return new Float32Array(8); },
  async embedPassage() { return new Float32Array(8); },
  async embedPassages(texts) { return texts.map(() => new Float32Array(8)); },
};

const GEN1 = "v2:" + "1".repeat(64);
const GEN2 = "v2:" + "2".repeat(64);

const alpha: MemoryItem = { id: "wiki/alpha", path: "wiki/alpha.md", title: "Alpha", body: "alpha body", trust: "trusted" };

let lockDir: string;
let dbDir: string;
const dbPath = (): string => join(dbDir, "index.db");
beforeEach(() => {
  lockDir = mkdtempSync(join(tmpdir(), "funes-identity-lock-"));
  dbDir = mkdtempSync(join(tmpdir(), "funes-identity-db-"));
  process.env.FUNES_LOCK_DIR = lockDir;
});
afterEach(() => {
  delete process.env.FUNES_LOCK_DIR;
  rmSync(lockDir, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

/** A store holding one stamped page — the shape every "does this invalidate?" case starts from. */
async function stamped(opts: { writeActor?: string; trackRecalls?: boolean } = {}): Promise<LibsqlStore> {
  const s = await LibsqlStore.create(fakeEmbedder, dbPath(), opts);
  await s.remember([alpha]);
  await s.finalizeReindex({ contentGeneration: GEN1, scope: { hash: "scope-a", ignoreScope: false } });
  expect((await s.contentIdentity()).contentGeneration).toBe(GEN1);
  return s;
}

// ── item 8: the two fields, and what a legacy stamp is allowed to claim ──────────────────────────

test("item 8: the publication id is IMMUTABLE — restamping a DIFFERENT one throws, the same one is a no-op", async () => {
  const s = await LibsqlStore.create(fakeEmbedder, dbPath());
  await s.setPublicationId("pub:aaaa");
  await s.setPublicationId("pub:aaaa"); // idempotent retry (a publisher that crashed after stamping)
  expect((await s.contentIdentity()).publicationId).toBe("pub:aaaa");
  // The whole point of immutability: local state — a principal's ack, a retention decision — binds
  // to this id. A database that quietly renamed itself would strand every one of them.
  await expect(s.setPublicationId("pub:bbbb")).rejects.toThrow(/immutable/);
  expect((await s.contentIdentity()).publicationId).toBe("pub:aaaa");
  await s.close();
});

test("item 8: a LEGACY v1 stamp reports contentGeneration NULL with a reason — it does not crash, and it is not reinterpreted", async () => {
  const s = await LibsqlStore.create(fakeEmbedder, dbPath());
  await s.remember([alpha]);
  // A v1 index, exactly as 0.2.1 left it. v1 was computed over a NARROWER field set and incremental
  // writes never cleared it, so reading it as a content generation would re-assert the very lie
  // this release removes — and crashing on it would strand every existing index.
  const db = (s as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }).db;
  db.prepare("insert into meta(key,value) values ('generation',?) on conflict(key) do update set value=excluded.value").run("v1:" + "e".repeat(64));
  const id = await s.contentIdentity();
  expect(id.contentGeneration).toBeNull();
  expect(id.invalidatedReason).toMatch(/legacy v1/);
  expect((await s.stats()).contentGeneration).toBeNull();     // …and health says the same
  expect((await s.recall({ query: "alpha", k: 1 })).length).toBe(1); // …while the index still serves
  await s.close();
});

// ── item 12: finalizeReindex is ONE transaction ─────────────────────────────────────────────────

test("item 12: finalizeReindex commits stamp + cleared invalidation + built scope + dirty marker together", async () => {
  const s = await LibsqlStore.create(fakeEmbedder, dbPath());
  await s.beginReindex();
  await s.remember([alpha]);
  expect((await s.stats()).reindexDirty).toBe(true);
  await s.finalizeReindex({ contentGeneration: GEN1, scope: { hash: "scope-a", ignoreScope: false } });
  const st = await s.stats();
  expect(st.contentGeneration).toBe(GEN1);
  expect(st.invalidatedAt).toBeNull();
  expect(st.invalidatedReason).toBeNull();
  expect(st.scopeHash).toBe("scope-a");
  expect(st.reindexDirty).toBe(false);
  expect(st.lastReindexAt).not.toBeNull();
  await s.close();
});

test("item 12: a finalizeReindex that FAILS part-way leaves the prior stamp and scope untouched (one transaction, not four)", async () => {
  const s = await stamped();
  // The trap: before item 12 this was setGeneration + set/clearScopeSignature + endReindex — four
  // statements in four implicit transactions. The generation would have advanced and the scope
  // would not, leaving a stamp that names rows built under a scope the index does not record.
  // A non-bindable scope hash makes the SECOND statement fail after the first has run.
  await expect(s.finalizeReindex({ contentGeneration: GEN2, scope: { hash: {} as unknown as string, ignoreScope: false } }))
    .rejects.toThrow();
  const st = await s.stats();
  expect(st.contentGeneration).toBe(GEN1); // rolled back with everything else
  expect(st.scopeHash).toBe("scope-a");
  await s.close();
});

test("item 12/13: finalizeReindex clears an invalidation atomically with the new stamp", async () => {
  const s = await stamped();
  await s.remember([{ ...alpha, body: "alpha body, edited" }]);
  expect((await s.contentIdentity()).invalidatedAt).not.toBeNull();
  await s.finalizeReindex({ contentGeneration: GEN2 });
  const id = await s.contentIdentity();
  expect(id.contentGeneration).toBe(GEN2);
  expect(id.invalidatedAt).toBeNull();   // a fresh stamp beside a stale invalidation reads as
  expect(id.invalidatedReason).toBeNull(); // invalid on the very build that repaired it
  await s.close();
});

// ── item 11: invalidation is EVIDENCE-driven ────────────────────────────────────────────────────

test("item 11: a WRITE_ACTOR-only sync does NOT invalidate — the actor is advisory, not identity", async () => {
  const first = await stamped({ writeActor: "alice" });
  await first.close();
  // Same page, same content hash, different writer. The metadata-sync UPDATE fires (its WHERE
  // covers write_actor) — but nothing a reader can observe moved, and forcing a manual republish
  // for it is exactly the cost bomb R4#9 named.
  const second = await LibsqlStore.create(fakeEmbedder, dbPath(), { writeActor: "bob" });
  const r = await second.remember([alpha]);
  expect(r.indexed).toBe(0);                                             // hash-skipped
  expect((await second.indexedPage({ id: alpha.id }))!.writeActor).toBe("bob"); // …the stamp DID move
  const id = await second.contentIdentity();
  expect(id.contentGeneration).toBe(GEN1);                               // …and the identity did not
  expect(id.invalidatedAt).toBeNull();
  await second.close();
});

test("item 11: a metadata-only edit that DOES change a served row invalidates, with a reason", async () => {
  const s = await stamped();
  // trust is hash-skipped (it never reaches the embedder) but it IS a generation input — the rows
  // this index holds are no longer the rows GEN1 named.
  const r = await s.remember([{ ...alpha, trust: "untrusted" }]);
  expect(r.indexed).toBe(0);
  const id = await s.contentIdentity();
  expect(id.contentGeneration).toBeNull();
  expect(id.invalidatedReason).toMatch(/metadata sync moved 1 row/);
  expect(Date.parse(id.invalidatedAt!)).not.toBeNaN(); // item 13: persisted, and readable
  await s.close();
});

test("item 11: a no-op REMOVE does not invalidate; one that deletes a row does", async () => {
  const s = await stamped();
  expect(await s.remove(["wiki/nothing-here"])).toBe(0);
  expect((await s.contentIdentity()).contentGeneration).toBe(GEN1); // a stale id, a double-forget
  expect(await s.remove([alpha.id])).toBe(1);
  const id = await s.contentIdentity();
  expect(id.contentGeneration).toBeNull();
  expect(id.invalidatedReason).toMatch(/^remove: 1 page row deleted/);
  await s.close();
});

test("item 11: a PRUNE that deletes nothing does not invalidate; one that deletes does", async () => {
  const s = await stamped();
  expect(await s.prune([alpha.id])).toBe(0);
  expect((await s.contentIdentity()).contentGeneration).toBe(GEN1); // every clean full reindex ends here
  expect(await s.prune([])).toBe(1);
  const id = await s.contentIdentity();
  expect(id.contentGeneration).toBeNull();
  expect(id.invalidatedReason).toMatch(/^prune: 1 stale page row deleted/);
  await s.close();
});

test("item 11: a re-indexed page invalidates; RECALL never does", async () => {
  const s = await stamped({ trackRecalls: true });
  // recordRecalls writes hit counts on the READ path. A generation that moved when someone merely
  // READ the index would name nothing at all.
  await s.recall({ query: "alpha", k: 3 });
  expect((await s.contentIdentity()).contentGeneration).toBe(GEN1);
  await s.remember([{ ...alpha, body: "alpha body, materially different" }]);
  const id = await s.contentIdentity();
  expect(id.contentGeneration).toBeNull();
  expect(id.invalidatedReason).toMatch(/^remember: 1 page re-indexed/);
  await s.close();
});

test("item 8/13: the publication id SURVIVES an invalidation — only the content generation is nullable", async () => {
  const s = await stamped();
  await s.setPublicationId("pub:cafe");
  await s.remove([alpha.id]);
  const id = await s.contentIdentity();
  expect(id.publicationId).toBe("pub:cafe"); // immutable: local state stays bound to it
  expect(id.contentGeneration).toBeNull();   // nullable: the rows moved
  await s.close();
});

// ── the schema fence (PLAN-0.3.0 R2#2; the rollout matrix, dual-read at step 30) ─────────────────

/** A finalized one-page index (DELETE journal, no sidecars — a mode=ro open needs no -shm) whose
 *  `schema_version` row is set to `v`; null DELETES it, which is what a pre-2 index looks like. */
async function stampedAs(v: string | null): Promise<string> {
  const p = join(dbDir, `fence-${v ?? "pre2"}.db`);
  const s = await LibsqlStore.create(fakeEmbedder, p);
  await s.remember([alpha]);
  await s.finalizeForPublish();
  await s.close();
  const raw = new Database(p);
  if (v == null) raw.exec("delete from meta where key='schema_version'");
  else raw.prepare("insert into meta(key,value) values ('schema_version',?) on conflict(key) do update set value=excluded.value").run(v);
  raw.close();
  return p;
}

test("schema fence: RO opens dual-read 3|4 and refuse pre-2|2; RW opens accept ONLY 4", async () => {
  // The rollout matrix (PLAN-0.3.0 "Rollout and rollback") as one table. Read-only: the v4 readers
  // are deployed everywhere BEFORE any home is republished (step 30), so a v4 reader must serve a
  // "3" artefact; pre-2 has a different fts shape and "2" predates provenance, neither is servable.
  // Read-write: exact equality — an in-place upgrade is the one thing that would let a stale index
  // cross the fence without the rebuild the matrix assumes. Written against "4" on purpose: a later
  // bump must revisit which older versions a reader may still dual-read, not inherit this list.
  expect(INDEX_SCHEMA_VERSION).toBe("4");
  const cases: Array<[stored: string | null, roServes: boolean, rwOpens: boolean]> = [
    [null, false, false],
    ["2", false, false],
    ["3", true, false],
    ["4", true, true],
  ];
  for (const [v, roServes, rwOpens] of cases) {
    const p = await stampedAs(v);
    const ro = LibsqlStore.create(fakeEmbedder, p, { readonly: true });
    if (roServes) {
      const s = await ro;
      expect((await s.recall({ query: "alpha", k: 1 })).length).toBe(1); // serves, not merely opens
      await s.close();
    } else {
      await expect(ro).rejects.toThrow(/schema_version/);
    }
    const rw = LibsqlStore.create(fakeEmbedder, p);
    if (rwOpens) await (await rw).close();
    else await expect(rw).rejects.toThrow(/does not migrate in place.*reindex --fresh/s);
  }
});
