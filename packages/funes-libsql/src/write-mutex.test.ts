// Write mutex (slice 4): structural writes take the cross-process per-index lock — this is what
// makes the single-writer invariant MECHANICAL instead of conventional, unlocking agent remember()
// and multi-star constellations. Cross-process contention is simulated with a FOREIGN lock dir
// (this process's live pid, unknown to the in-process refcount).
import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockPathFor } from "funes-shared";
import { LibsqlStore } from "./store.ts";
import type { Embedder } from "funes-core";

const fakeEmbedder: Embedder = {
  dim: 8,
  async embedQuery() { return new Float32Array(8); },
  async embedPassage() { return new Float32Array(8); },
  async embedPassages(texts) { return texts.map(() => new Float32Array(8)); },
};

let home: string;
let dbDir: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "funes-mutex-"));
  dbDir = mkdtempSync(join(tmpdir(), "funes-mutex-db-"));
  process.env.FUNES_LOCK_DIR = home;
});
afterEach(() => {
  delete process.env.FUNES_LOCK_DIR;
  delete process.env.FUNES_LOCK_TIMEOUT_MS;
  rmSync(home, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

const item = { id: "n/one", title: "One", type: "note", body: "hello world", trust: "trusted" as const };

test("remember() under a FOREIGN live lock fails loud with 'write lock busy'", async () => {
  process.env.FUNES_LOCK_TIMEOUT_MS = "250";
  const dbPath = join(dbDir, "index.db");
  const s = await LibsqlStore.create(fakeEmbedder, dbPath);
  const lockDir = lockPathFor(dbPath);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid })); // live, foreign
  await expect(s.remember([item])).rejects.toThrow(/write lock busy/);
  rmSync(lockDir, { recursive: true, force: true });
  await s.close();
});

test("remember() reclaims a DEAD-pid lock and proceeds", async () => {
  const dbPath = join(dbDir, "index.db");
  const s = await LibsqlStore.create(fakeEmbedder, dbPath);
  const lockDir = lockPathFor(dbPath);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: 99999999 })); // dead
  const r = await s.remember([item]);
  expect(r.indexed).toBe(1);
  expect(existsSync(lockDir)).toBe(false); // released after the write
  await s.close();
});

test("full reindex flow holds ONE lock across begin→remember→prune→end, then releases", async () => {
  const dbPath = join(dbDir, "index.db");
  const s = await LibsqlStore.create(fakeEmbedder, dbPath);
  await s.beginReindex();
  expect(existsSync(lockPathFor(dbPath))).toBe(true);   // held for the whole rebuild
  await s.remember([item]);                              // reentrant — no self-deadlock
  await s.prune([item.id]);
  expect(existsSync(lockPathFor(dbPath))).toBe(true);   // still held
  await s.endReindex();
  expect(existsSync(lockPathFor(dbPath))).toBe(false);  // released with the dirty-marker clear
  await s.close();
});

test("close() releases an abandoned reindex lock (belt)", async () => {
  const dbPath = join(dbDir, "index.db");
  const s = await LibsqlStore.create(fakeEmbedder, dbPath);
  await s.beginReindex();
  expect(existsSync(lockPathFor(dbPath))).toBe(true);
  await s.close(); // no endReindex — crash-path belt
  expect(existsSync(lockPathFor(dbPath))).toBe(false);
});

test(":memory: stores never touch the lock dir", async () => {
  const s = await LibsqlStore.create(fakeEmbedder, ":memory:");
  await s.remember([item]);
  expect(existsSync(home) ? readdirSync(home).length : 0).toBe(0);
  await s.close();
});
