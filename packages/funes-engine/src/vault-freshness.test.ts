import { test, expect, setSystemTime } from "bun:test";
import { lstatSync, mkdtempSync, mkdirSync, writeFileSync, utimesSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { lstatVersion, parseLstatVersion } from "funes-shared";
import { indexDir, statParity, vaultChangedSince, type Freshness } from "./reindex.ts";
import { buildScopeExclude, configlessExclude, readIndexScopeExcludes } from "./scope.ts";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";
import { FolderVault } from "./folder-vault.ts";

// PLAN-0.5.0 item 12: parity lists the vault through the port; every case here is a folder.
const parity = (v: string, ...rest: Parameters<typeof statParity> extends [unknown, ...infer R] ? R : never) =>
  statParity(new FolderVault(v), ...rest);
const changedSince = (v: string, stamp: () => Promise<string | null>, stats: Parameters<typeof vaultChangedSince>[3]) =>
  vaultChangedSince(new FolderVault(v), readIndexScopeExcludes(v), stamp, stats);

// "Did the vault move under the index?" is the only staleness question worth asking. Age alone nags
// about vaults nobody has touched; this fires exactly when recall is answering from an index that
// predates the notes it cites — the case that makes an agent confidently cite content the vault has
// already superseded.
//
// PLAN-0.4.0 item 6 (RAI-124, ADR-0007) ported this whole file. The answer used to be "is any file's
// mtime newer than the reindex stamp, or is an indexed id missing on disk", and every case here fed
// it a stamp thunk and a fake id list. It is now STAT PARITY against the record the last full build
// wrote, so every case builds a real index and asks it — the record under test is the one indexDir
// writes, never a hand-made one.
const vault = () => mkdtempSync(join(tmpdir(), "funes-fresh-"));
const note = (dir: string, rel: string, mtimeSec?: number, body = "body") => {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, `---\ntitle: T\n---\n${body}\n`);
  if (mtimeSec != null) utimesSync(p, mtimeSec, mtimeSec);
};

class FakeEmbedder implements Embedder {
  readonly dim = 8;
  private vec() { const v = new Float32Array(this.dim); v[0] = 1; return v; }
  async embedQuery() { return this.vec(); }
  async embedPassage() { return this.vec(); }
  async embedPassages(ts: string[]) { return ts.map(() => this.vec()); }
}

/** A FULL build of `v` — the run that writes the stat record — under the exclude a reindex would
 *  apply (the CLI passes configlessExclude() without a star.yaml, the declared globs with one). */
async function built(v: string, exclude?: (rel: string) => boolean) {
  const store = await LibsqlStore.create(new FakeEmbedder());
  await indexDir(store, v, v, { exclude });
  return { store, stamp: async () => (await store.stats()).lastReindexAt, stats: () => store.pageStats() };
}
type Built = Awaited<ReturnType<typeof built>>;
const check = (v: string, b: Built) => changedSince(v, b.stamp, b.stats);
const done = async (b: Built, ...dirs: string[]) => {
  await b.store.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
};
const FRESH: Freshness = { changed: false, basis: "stat" };
const CHANGED: Freshness = { changed: true, basis: "stat" };

// ── the four the plan names ─────────────────────────────────────────────────────────────────────

test("an unchanged replica is not stale", async () => {
  const v = vault();
  note(v, "a.md", 1000);
  note(v, "nested/b.md", 1500);
  const b = await built(v);
  expect(await check(v, b)).toEqual(FRESH);
  await done(b, v);
});

test("a late-delivered old file is detected: content changed, mtime OLDER than the reindex stamp", async () => {
  // THE replica bug (RAI-124). Syncthing preserves the writer's mtime, so a page edited on one host
  // before this host's reindex and delivered after it carries an mtime older than the stamp. The
  // mtime-versus-stamp rule answered "unchanged" here, and a stale replica reported fresh.
  const v = vault();
  note(v, "a.md", 1000);
  const b = await built(v);
  note(v, "a.md", 900, "delivered late, written long ago");
  expect(Date.parse((await b.stamp())!)).toBeGreaterThan(900_000); // older than the stamp, still caught
  expect(await check(v, b)).toEqual(CHANGED);
  await done(b, v);
});

test("a same-size rewrite with its mtime restored is detected — ctime is the arm that sees it", async () => {
  // A temp-rename-then-utimes delivery, or any rewrite that puts the mtime back, leaves size AND
  // mtime equal to the record. Only the inode change time moved, and nothing in user space sets it.
  const v = vault();
  const p = join(v, "a.md");
  note(v, "a.md", 1000, "body one");
  const b = await built(v);
  const rec = parseLstatVersion((await b.stats())!.rows.find((r) => r.id === "a")!.version)!;
  await Bun.sleep(25); // Linux file timestamps tick coarsely: let the clock move before the rewrite
  writeFileSync(p, "---\ntitle: T\n---\nbody two\n"); // same byte length
  utimesSync(p, 1000, 1000);                          // …and the mtime restored
  const now = lstatSync(p);
  expect([now.size, now.mtimeMs]).toEqual([rec.size, rec.mtimeMs]); // size and mtime alone say "unchanged"
  expect(await check(v, b)).toEqual(CHANGED);
  await done(b, v);
});

test("a deletion propagated to a replica is detected", async () => {
  // A deleted page leaves nothing on disk to compare, so this half is carried by the record: a
  // recorded file the walk no longer finds is a row the index still serves for a page that is gone.
  const v = vault();
  note(v, "a.md", 1000);
  note(v, "nested/gone.md", 1000);
  const b = await built(v);
  rmSync(join(v, "nested", "gone.md"));
  expect(await check(v, b)).toEqual(CHANGED);
  await done(b, v);
});

// ── edits, wherever they are ────────────────────────────────────────────────────────────────────

test("a note edited after the reindex is detected, including nested", async () => {
  const v = vault();
  note(v, "a.md", 1000);
  note(v, "deep/deeper/c.md", 1000);
  const b = await built(v);
  note(v, "deep/deeper/c.md", 9000, "edited");
  expect(await check(v, b)).toEqual(CHANGED);
  await done(b, v);
});

test("a page the build never walked is a change — a new note has no recorded stat", async () => {
  const v = vault();
  note(v, "a.md", 1000);
  const b = await built(v);
  note(v, "new.md", 500); // older than everything: ordering would never have seen it
  expect(await check(v, b)).toEqual(CHANGED);
  await done(b, v);
});

// ── the indexed scope, and only it ──────────────────────────────────────────────────────────────
// The walk is the scope the index covers, so a file the index never covered cannot have changed
// anything recall can serve — and reporting it is how the warning becomes noise.

test("a configless vault does not go stale because node_modules moved", async () => {
  const v = vault();
  note(v, "a.md", 1000);
  note(v, "node_modules/pkg/readme.md", 1000);
  // The quickstart invites `funes reindex --vault .` in a code repo, and a configless reindex skips
  // node_modules — so counting it here marks such a vault permanently stale, on every query.
  const b = await built(v, configlessExclude());
  note(v, "node_modules/pkg/readme.md", 9000, "a dependency upgraded its docs");
  expect(await check(v, b)).toEqual(FRESH);
  await done(b, v);
});

test("a declared index_scope exclusion is not a change either — an in-scope edit still is", async () => {
  const v = vault();
  note(v, "a.md", 1000);
  note(v, "drafts/wip.md", 1000);
  writeFileSync(join(v, "star.yaml"), 'version: 2\nmemory:\n  index_scope:\n    exclude:\n      - "drafts/**"\n');
  const b = await built(v, buildScopeExclude(["drafts/**"]));
  note(v, "drafts/wip.md", 9000, "still drafting");
  expect(await parity(v, await b.stamp(), await b.stats(), buildScopeExclude(["drafts/**"]))).toEqual(FRESH);
  note(v, "a.md", 9000, "in scope");
  expect(await check(v, b)).toEqual(CHANGED);
  await done(b, v);
});

test("a tombstone is recorded, so a file the index deliberately does not index is not a change", async () => {
  // A superseded/forgotten page sits on disk with no index row, forever. The build walks it and
  // records its stat like any other page — so it matches, and a vault holding tombstones stays quiet.
  const v = vault();
  note(v, "a.md", 1000);
  writeFileSync(join(v, "tomb.md"), "---\ntitle: Tomb\nforgotten: true\n---\ngone from recall\n");
  const b = await built(v);
  expect((await b.stats())!.rows.map((r) => r.id).sort()).toEqual(["a", "tomb"]);
  expect(await check(v, b)).toEqual(FRESH);
  await done(b, v);
});

test("narrowing index_scope without reindexing IS a change — those rows are live and out of policy", async () => {
  const v = vault();
  note(v, "a.md", 1000);
  note(v, "drafts/wip.md", 1000);
  const b = await built(v, configlessExclude());
  writeFileSync(join(v, "star.yaml"), 'version: 2\nmemory:\n  index_scope:\n    exclude:\n      - "drafts/**"\n');
  expect(await check(v, b)).toEqual(CHANGED);
  await done(b, v);
});

test("it inherits walkMd's rules — dot-dirs and symlinks are not the vault", async () => {
  const v = vault();
  note(v, "a.md", 1000);
  const b = await built(v);
  // the index itself lives in a dot-dir; if it counted, every query after a reindex would warn
  // about the reindex it just did.
  note(v, ".funes/derived.md", 9999);
  const outside = mkdtempSync(join(tmpdir(), "funes-outside-"));
  note(outside, "linked.md", 9999);
  symlinkSync(join(outside, "linked.md"), join(v, "linked.md"));
  expect(await check(v, b)).toEqual(FRESH);
  await done(b, v, outside);
});

// ── no basis is unknown, never fresh ────────────────────────────────────────────────────────────

test("no record to compare against answers null with basis \"none\" — never reindexed, no table, another build's record", async () => {
  const v = vault();
  note(v, "a.md", 1000);
  // null, not false: "never reindexed" is not "up to date", and health reports the difference.
  expect(await changedSince(v, async () => null, async () => ({ at: null, rows: [] }))).toEqual({ changed: null, basis: "none" });
  const b = await built(v);
  const stamp = await b.stamp();
  const record = await b.stats();
  // An index built before the table existed (a read-only handle over a 0.3.x artefact).
  expect(await parity(v, stamp, null)).toEqual({ changed: null, basis: "none" });
  // A record whose stamp is not this index's last_reindex_at describes some other build.
  expect(await parity(v, stamp, { ...record!, at: "2020-01-01T00:00:00.000Z" })).toEqual({ changed: null, basis: "none" });
  expect(await parity(v, stamp, record)).toEqual(FRESH); // …the same record, stamped by this build
  await done(b, v);
});

test("every field is an arm on its own — mtime alone, size alone, each reads as a change", async () => {
  // Every on-disk edit moves ctime too, so a case built from real writes cannot tell the arms apart:
  // `ctime` alone would pass all of them. mtime and size are what is left where ctime is not a
  // reliable change signal (a network or emulated filesystem), so each is pinned against the record.
  const v = vault();
  note(v, "a.md", 1000);
  note(v, "b.md", 1000);
  const b = await built(v);
  const stamp = await b.stamp();
  const record = (await b.stats())!;
  const bump = (field: "mtimeMs" | "size") => ({
    ...record,
    rows: record.rows.map((r) => {
      if (r.id !== "a") return r;
      const t = parseLstatVersion(r.version)!;
      return { ...r, version: lstatVersion({ ...t, [field]: t[field] + 1 }) };
    }),
  });
  expect(await parity(v, stamp, bump("mtimeMs"))).toEqual(CHANGED);
  expect(await parity(v, stamp, bump("size"))).toEqual(CHANGED);
  await done(b, v);
});

test("the record is WHOLESALE — a page deleted before the next full build leaves no row behind", async () => {
  // An upsert would keep the deleted page's row, and parity would count one recorded row nothing on
  // disk matches — CHANGED after every later reindex, so the publish skip never fires again.
  const v = vault();
  note(v, "a.md", 1000);
  note(v, "gone.md", 1000);
  const b = await built(v);
  rmSync(join(v, "gone.md"));
  await indexDir(b.store, v, v, {});
  expect((await b.stats())!.rows.map((r) => r.id)).toEqual(["a"]);
  expect(await check(v, b)).toEqual(FRESH);
  await done(b, v);
});

test("a vault that cannot be walked answers null with basis \"unreadable\"", async () => {
  const v = vault();
  note(v, "a.md", 1000);
  const b = await built(v);
  rmSync(v, { recursive: true, force: true });
  expect(await check(v, b)).toEqual({ changed: null, basis: "unreadable" });
  await done(b);
});

test("an index that cannot be read answers \"unreadable\" and never throws — the stamp or the record", async () => {
  // Not "none": that would tell the reader to republish an index that is merely busy. And a REJECTED
  // promise here would be the one the memo holds, failing every recall and health for 30 seconds.
  const busy = async (): Promise<never> => { throw new Error("SQLITE_BUSY"); };
  const [v1, v2] = [vault(), vault()]; // two vaults: the memo is module state
  expect(await changedSince(v1, async () => "2026-01-01T00:00:00.000Z", busy)).toEqual({ changed: null, basis: "unreadable" });
  expect(await changedSince(v2, busy, async () => null)).toEqual({ changed: null, basis: "unreadable" });
  for (const d of [v1, v2]) rmSync(d, { recursive: true, force: true });
});

// ── the memo: keyed by (vault, last_reindex_at), holding the walk's promise ─────────────────────

test("a reindex is seen at once, from any process — the memo is keyed by the stamp", async () => {
  // Before 0.4.0 the memo was keyed by vault alone and cleared by an in-process hook after indexDir,
  // so a reindex in ANOTHER process — a terminal `funes reindex` beside `funes mcp`, a watcher's
  // child publish — left the stale answer standing for up to 30s. That hook is gone: only the key
  // can explain the second answer here.
  const v = vault();
  note(v, "a.md", 1000);
  const b = await built(v);
  note(v, "a.md", 9000, "edited");
  expect(await check(v, b)).toEqual(CHANGED); // memoized under the first stamp
  await Bun.sleep(5); // a new millisecond, so the reindex stamps a new last_reindex_at
  await indexDir(b.store, v, v, {});
  expect(await check(v, b)).toEqual(FRESH);
  await done(b, v);
});

test("concurrent cold checks share ONE walk", async () => {
  const v = vault();
  note(v, "a.md", 1000);
  const b = await built(v);
  let reads = 0;
  const stats = async () => { reads++; return b.stats(); };
  const answers = await Promise.all([1, 2, 3].map(() => changedSince(v, b.stamp, stats)));
  expect(reads).toBe(1);
  expect(answers).toEqual([FRESH, FRESH, FRESH]);
  await done(b, v);
});

test("the memo holds for 30 seconds and not forever", async () => {
  const v = vault();
  note(v, "a.md", 1000);
  const b = await built(v);
  try {
    expect(await check(v, b)).toEqual(FRESH);
    note(v, "a.md", 9000, "edited, no reindex");
    expect(await check(v, b)).toEqual(FRESH);      // inside the window: the memo answers
    setSystemTime(new Date(Date.now() + 30_001));
    expect(await check(v, b)).toEqual(CHANGED);    // past it: walked again
  } finally {
    setSystemTime(); // never leak the fake clock into the next test
    await done(b, v);
  }
});
