// Write mutex (slice 4): structural writes take the cross-process per-index lock — this is what
// makes the single-writer invariant MECHANICAL instead of conventional, unlocking agent remember()
// and multi-star constellations. Cross-process contention is simulated with a FOREIGN lock dir
// (this process's live pid, unknown to the in-process refcount).
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENERATION_VERSION, serialize } from "funes-core/internal";
import { lockPathFor } from "../write-lock.ts";
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
  process.env.FUNES_HOME = home;
});
afterEach(() => {
  delete process.env.FUNES_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

const item = { id: "n/one", title: "One", type: "note", body: "hello world", trust: "trusted" as const };

// The busy refusal itself waits the fixed 10 s; the spawned case in fresh-in-place.test pays it once.
test("remember() waits on a FOREIGN live lock, and proceeds when its holder lets go", async () => {
  const dbPath = join(dbDir, "index.db");
  const s = await LibsqlStore.create(fakeEmbedder, dbPath);
  const lockDir = lockPathFor(dbPath);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid })); // live, foreign
  let settled = false;
  const writing = s.remember([item]).finally(() => { settled = true; });
  await Bun.sleep(300);
  expect(settled).toBe(false);
  rmSync(lockDir, { recursive: true, force: true }); // the holder lets go
  expect((await writing).indexed).toBe(1);
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

test("the begin→remember→remove→finalize fixture holds ONE lock, then releases", async () => {
  const dbPath = join(dbDir, "index.db");
  const s = await LibsqlStore.create(fakeEmbedder, dbPath);
  await s.beginReindex();
  expect(existsSync(lockPathFor(dbPath))).toBe(true);   // held for the whole rebuild
  await s.remember([item]);                              // reentrant — no self-deadlock
  await s.remove(["nothing"]);
  expect(existsSync(lockPathFor(dbPath))).toBe(true);   // still held
  await s.finalizeReindex({ contentGeneration: `${GENERATION_VERSION}:` + "f".repeat(64) });
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

test(":memory: stores and private builds never touch the lock dir (RAI-309 Q2)", async () => {
  for (const s of [await LibsqlStore.create(fakeEmbedder, ":memory:"), await LibsqlStore.create(fakeEmbedder, join(dbDir, "build.db"), { privateBuild: true })]) {
    expect(s.lockResource).toBeNull();
    await s.beginReindex();
    await s.remember([item]);
    await s.finalizeReindex({ contentGeneration: `${GENERATION_VERSION}:` + "f".repeat(64) });
    await s.close();
  }
  expect(existsSync(home) ? readdirSync(home).length : 0).toBe(0);
});

// ── the in-process mutex (0.5.0 item 14; record 24 §5) ──────────────────────────────────────────
// The FIFO and the AsyncLocalStorage reentrancy left write-lock.ts for a module that imports only
// `node:async_hooks`, so the edge writer (funes-cf) takes the same serializer the folder does. These
// tests run on that module directly; the tests above run on the cross-process lock built over it.
describe("serialize: the in-process mutex", () => {
  test("unrelated async contexts hold one at a time, in arrival order", async () => {
    const events: string[] = [];
    const hold = (name: string) => serialize("star", async () => {
      events.push(`${name}+`);
      await Bun.sleep(5);
      events.push(`${name}-`);
    }, 1_000);
    await Promise.all([hold("a"), hold("b"), hold("c")]);
    expect(events).toEqual(["a+", "a-", "b+", "b-", "c+", "c-"]);
  });

  test("a nested hold in the same async context re-enters without waiting", async () => {
    // Without reentrancy the inner call queues behind its own outer frame and times out.
    expect(await serialize("star", () => serialize("star", async () => "inner", 50), 50)).toBe("inner");
  });

  test("different keys do not wait on each other", async () => {
    let releaseA!: () => void;
    const a = serialize("star-a", () => new Promise<void>((r) => { releaseA = r; }), 1_000);
    expect(await serialize("star-b", async () => "b", 50)).toBe("b");
    releaseA();
    await a;
  });

  test("a waiter times out naming the key; the hold is never stolen, and the next caller still gets it", async () => {
    let releaseHolder!: () => void;
    let holding = false;
    const holder = serialize("hung", async () => {
      holding = true;
      await new Promise<void>((r) => { releaseHolder = r; });
      holding = false;
    }, 1_000);
    await Bun.sleep(5);
    await expect(serialize("hung", async () => "never", 40)).rejects.toThrow(/waited 40ms for an in-process holder of hung/);
    expect(holding).toBe(true);
    releaseHolder();
    await holder;
    expect(await serialize("hung", async () => "acquired", 50)).toBe("acquired");
  });

  test("a throwing holder releases the hold", async () => {
    await expect(serialize("boom", async () => { throw new Error("boom"); }, 50)).rejects.toThrow("boom");
    expect(await serialize("boom", async () => "next", 50)).toBe("next");
  });

  test("the module imports only node:async_hooks, so it loads in workerd and in funes-cf", () => {
    const src = readFileSync(join(import.meta.dir, "../../../funes-core/src/mutex.ts"), "utf8");
    const specifiers = [...src.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g)].map((m) => m[1] ?? m[2]);
    expect(specifiers).toEqual(["node:async_hooks"]);
  });
});
