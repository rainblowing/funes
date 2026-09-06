import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { indexDir, vaultChangedSince, vaultNewerThan } from "./reindex.ts";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";

// "Did I change notes since the last reindex?" is the only staleness question worth asking. Age
// alone nags about vaults nobody has touched; this fires exactly when recall is answering from an
// index that predates the notes it cites — the case that makes an agent confidently cite content
// the vault has already superseded.
const vault = () => mkdtempSync(join(tmpdir(), "funes-fresh-"));
const note = (dir: string, rel: string, mtimeSec: number) => {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "---\ntitle: T\n---\nbody\n");
  utimesSync(p, mtimeSec, mtimeSec);
};

test("a note edited after the reindex is detected", () => {
  const v = vault();
  note(v, "a.md", 2000);
  expect(vaultNewerThan(v, 1000 * 1000)).toBe(true);   // note at 2000s, indexed at 1000s
  rmSync(v, { recursive: true, force: true });
});

test("an untouched vault is quiet", () => {
  const v = vault();
  note(v, "a.md", 1000);
  note(v, "nested/b.md", 1500);
  expect(vaultNewerThan(v, 3000 * 1000)).toBe(false);
  rmSync(v, { recursive: true, force: true });
});

test("it finds the change wherever it is, including nested", () => {
  const v = vault();
  note(v, "a.md", 1000);
  note(v, "deep/deeper/c.md", 9000);
  expect(vaultNewerThan(v, 5000 * 1000)).toBe(true);
  rmSync(v, { recursive: true, force: true });
});

// vaultChangedSince is the version health, recall and the CLI all call. It answers the same
// question against the INDEXED corpus, which is the difference that matters: a file the index never
// covered cannot have changed anything recall can serve, and reporting it as a change is how the
// warning becomes noise. `stamp` is a thunk so the memo can skip the stats() round-trip too.
const stamp = (sec: number) => async () => new Date(sec * 1000).toISOString();

test("a configless vault does not go stale because node_modules moved", async () => {
  const v = vault();
  note(v, "a.md", 1000);
  note(v, "node_modules/pkg/readme.md", 9000);
  // The quickstart invites `funes reindex --vault .` in a code repo, and a configless reindex skips
  // node_modules — so counting it here marks such a vault permanently stale, forever, on every query.
  expect(vaultNewerThan(v, 5000 * 1000)).toBe(true);                 // the raw walk still sees it…
  expect(await vaultChangedSince(v, stamp(5000))).toBe(false);       // …the scoped question does not
  rmSync(v, { recursive: true, force: true });
});

test("a declared index_scope exclusion is not a change either", async () => {
  const v = vault();
  note(v, "a.md", 1000);
  note(v, "drafts/wip.md", 9000);
  writeFileSync(join(v, "star.yaml"), 'version: 2\nmemory:\n  index_scope:\n    exclude:\n      - "drafts/**"\n');
  expect(await vaultChangedSince(v, stamp(5000))).toBe(false);
  rmSync(v, { recursive: true, force: true });
});

test("an in-scope edit is still detected, and a missing reindex stamp is unknown rather than false", async () => {
  const v = vault();
  note(v, "a.md", 9000);
  note(v, "node_modules/pkg/readme.md", 9000);
  expect(await vaultChangedSince(v, stamp(5000))).toBe(true);
  const never = vault();
  note(never, "a.md", 9000);
  // null, not false: "never reindexed" is not "up to date", and health reports the difference.
  expect(await vaultChangedSince(never, async () => null)).toBe(null);
  rmSync(v, { recursive: true, force: true });
  rmSync(never, { recursive: true, force: true });
});

// Deletions are the half mtimes cannot see (Codex R2, HIGH): the file is gone, so nothing is left
// behind to be newer, the walk returns false and health reports "ok" — for an index that still
// serves the deleted row. The index's own id set is the record of what the last full reindex
// covered, so the comparison needs nothing persisted; `indexedIds` is that set.
const indexed = (...ids: string[]) => async () => ids;

test("a deleted note is a change, even though nothing left on disk is newer", async () => {
  const v = vault();
  note(v, "a.md", 1000);
  note(v, "nested/b.md", 1000);   // every survivor predates the stamp: the mtime arm sees nothing
  expect(await vaultChangedSince(v, stamp(5000), indexed("a", "nested/b", "nested/gone"))).toBe(true);
  rmSync(v, { recursive: true, force: true });
});

test("an index that covers exactly what is on disk stays quiet", async () => {
  const v = vault();
  note(v, "a.md", 1000);
  note(v, "nested/b.md", 1000);
  expect(await vaultChangedSince(v, stamp(5000), indexed("a", "nested/b"))).toBe(false);
  rmSync(v, { recursive: true, force: true });
});

// The comparison is one-directional (an indexed id with no file) precisely so the two ways a vault
// legitimately holds a file the index does not cover stay silent: tombstones and index_scope.
// Counting them the other way would mark such a vault stale forever — the cry-wolf failure again.
test("a file the index deliberately does not cover is not a deletion", async () => {
  const v = vault();
  note(v, "a.md", 1000);
  note(v, "tomb.md", 1000);     // e.g. superseded_by/forgotten: on disk, never an index row
  note(v, "drafts/wip.md", 1000);
  writeFileSync(join(v, "star.yaml"), 'version: 2\nmemory:\n  index_scope:\n    exclude:\n      - "drafts/**"\n');
  expect(await vaultChangedSince(v, stamp(5000), indexed("a"))).toBe(false);
  rmSync(v, { recursive: true, force: true });
});

test("a store that cannot enumerate keeps the mtime answer rather than going unknown", async () => {
  const v = vault();
  note(v, "a.md", 1000);
  expect(await vaultChangedSince(v, stamp(5000), async () => undefined)).toBe(false);
  const never = vault();
  note(never, "a.md", 1000);
  // …and a missing stamp still outranks it: unknown is not "up to date", even with an id set.
  expect(await vaultChangedSince(never, async () => null, indexed("a", "gone"))).toBe(null);
  rmSync(v, { recursive: true, force: true });
  rmSync(never, { recursive: true, force: true });
});

// The warning's own goal (dfa9886) is that a user who sees it reindexes. Before this, doing so left
// the memo answering TRUE against the stamp the reindex had just replaced — so for up to 30 more
// seconds funes kept telling them the index was stale, right after they fixed it. A warning that
// survives its own remedy is one a reader learns to ignore, which is the failure dfa9886 set out to
// avoid. Same-process only; a reindex in another process still rides out the TTL (see the comment).
class FakeEmbedder implements Embedder {
  readonly dim = 8;
  private vec() { const v = new Float32Array(this.dim); v[0] = 1; return v; }
  async embedQuery() { return this.vec(); }
  async embedPassage() { return this.vec(); }
  async embedPassages(ts: string[]) { return ts.map(() => this.vec()); }
}

test("a completed full reindex clears the memo, so the warning does not outlive the reindex it asked for", async () => {
  const v = vault();
  note(v, "a.md", 1000); // mtime well before any reindex stamp, so only the memo can make it stale
  const store = await LibsqlStore.create(new FakeEmbedder());

  // A query BEFORE the reindex: correctly stale against the old stamp — and memoized as such.
  expect(await vaultChangedSince(v, stamp(500))).toBe(true);

  await indexDir(store, v, v, {});

  // The stamp is now newer than every note. Without the invalidation the memo is still inside its
  // 30s window and answers true — the cry-wolf case.
  expect(await vaultChangedSince(v, async () => (await store.stats()).lastReindexAt)).toBe(false);

  await store.close();
  rmSync(v, { recursive: true, force: true });
});

test("it inherits walkMd's rules — dot-dirs and symlinks are not the vault", () => {
  const v = vault();
  note(v, "a.md", 1000);
  // the index itself lives in a dot-dir; if it counted, every query after a reindex would warn
  // about the reindex it just did.
  note(v, ".funes/derived.md", 9999);
  const outside = mkdtempSync(join(tmpdir(), "funes-outside-"));
  note(outside, "linked.md", 9999);
  symlinkSync(join(outside, "linked.md"), join(v, "linked.md"));
  expect(vaultNewerThan(v, 5000 * 1000)).toBe(false);
  rmSync(v, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
