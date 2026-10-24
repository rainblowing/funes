// RAI-309 + RAI-307 (plan B3): one write lock per star, and `reindex --fresh` in place. Each case runs on
// a scratch FUNES_HOME, so the lock and the index live under it and never under the real funes home.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Embedder } from "funes-core";
import { LibsqlStore, openRawIndex } from "./libsql/store.ts";
import { funesDbDir, makeStore, rebuildFresh } from "./factory.ts";
import { indexDir } from "./reindex.ts";
import { FakeEmbedder } from "./__fixtures__/publish-child.ts";
import { folderFunesStore } from "./funes-store.ts";

/** Another model: another signature and another vector shape. */
class OtherEmbedder extends FakeEmbedder { readonly id = "other"; }
const other = (): Embedder => Object.assign(new OtherEmbedder(), { dim: 8 }) as Embedder;

let home: string;
let vault: string;
beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "funes-b3-")));
  home = join(base, "home");
  vault = join(base, "notes");
  mkdirSync(join(vault, "wiki"), { recursive: true });
  writeFileSync(join(vault, "star.yaml"), "meta:\n  id: git://example.org/notes\n");
  writeFileSync(join(vault, "wiki", "alpha.md"), "---\ntitle: Alpha\n---\nalpha sourdough loaf body\n");
  process.env.FUNES_HOME = home;
});
afterEach(() => {
  delete process.env.FUNES_HOME;
});

/** 0.5.0's index-lock string, from its formula (write-lock.ts at 0.5.0): `<home>/locks/<basename>-<sha256(path)[:10]>.lock`. */
const lockString050 = (): string => {
  const index = join(home, "libsql", basename(vault), "index.db");
  return join(home, "locks", `index.db-${createHash("sha256").update(index).digest("hex").slice(0, 10)}.lock`);
};
const heldByMe = (): boolean => existsSync(lockString050()) && JSON.parse(readFileSync(join(lockString050(), "owner.json"), "utf8")).pid === process.pid;
/** Every page file in the vault (the undo frame removes a written page; a directory it made may stay). */
const pages = (): string[] => (readdirSync(vault, { recursive: true }) as string[]).filter((f) => f.endsWith(".md")).sort();
const meta = (): Record<string, string> => {
  const d = openRawIndex(funesDbDir(vault), false);
  try { return Object.fromEntries((d.prepare("select key, value from meta").all() as Array<{ key: string; value: string }>).map((r) => [r.key, r.value])); } finally { d.close(); }
};
const chunkDecl = (): string => {
  const d = openRawIndex(funesDbDir(vault), false);
  try { return (d.prepare("select sql from sqlite_master where name = 'chunks'").get() as { sql: string }).sql; } finally { d.close(); }
};
const built = async (embedder: Embedder): Promise<void> => {
  const s = await makeStore({ vault, embedder });
  await indexDir(s, vault, { starId: "git://example.org/notes" });
  await s.close();
};

test("RAI-309 test 6: a FunesStore mutation, indexDir and reindex --fresh on one default star take 0.5.0's index-lock string", async () => {
  await built(new FakeEmbedder());
  const seen: Record<string, boolean> = {};
  const live = await makeStore({ vault, embedder: new FakeEmbedder() });
  const funes = folderFunesStore(live, { root: vault, compact: async (b) => { seen.mutation = heldByMe(); return b; } });
  await funes.remember([{ title: "Held", body: "written under the write lock" }]);
  await indexDir(live, vault, { onProgress: () => { seen.indexDir = heldByMe(); } });
  await live.close();
  await rebuildFresh({ vault, embedder: new FakeEmbedder(), onStep: (step) => { if (step === "inspected") seen.fresh = heldByMe(); } }, async () => {});
  expect(seen).toEqual({ mutation: true, indexDir: true, fresh: true });
  expect(existsSync(lockString050())).toBe(false); // released by each
});

test("RAI-307: reindex --fresh rebuilds the index in the same file under a new model, and its walk serves it", async () => {
  await built(new FakeEmbedder());
  const before = readdirSync(join(home, "libsql", "notes")).filter((f) => f === "index.db");
  const r = await rebuildFresh({ vault, embedder: other() }, (store) => indexDir(store, vault, { starId: "git://example.org/notes" }));
  expect(r.indexed).toBe(1);
  expect(before).toEqual(["index.db"]);
  expect(meta()).toMatchObject({ embedding_signature: "other:8:chunk1800o200", owner_star_id: "git://example.org/notes" });
  expect(meta().reindex_dirty).toBeUndefined();
  expect(chunkDecl()).toContain("F32_BLOB(8)");
  const s = await makeStore({ vault, embedder: other() });
  try { expect((await s.recall({ query: "sourdough", k: 1 })).map((h) => h.id)).toEqual(["wiki/alpha"]); } finally { await s.close(); }
});

test("RAI-309 test 1: a remember on a handle opened before an in-place --fresh refuses, and its markdown rolls back", async () => {
  await built(new FakeEmbedder());
  const stale = await makeStore({ vault, embedder: new FakeEmbedder() });
  const funes = folderFunesStore(stale, { root: vault });
  await rebuildFresh({ vault, embedder: other() }, (store) => indexDir(store, vault, {}));
  const before = pages();
  await expect(funes.remember([{ title: "Late", body: "a write from a stale process" }])).rejects.toThrow(/restart this process/);
  expect(pages()).toEqual(before);
  await stale.close();
});

test("RAI-309 test 5: a session that opens between the steps of --fresh neither creates tables nor stamps a signature", async () => {
  await built(new FakeEmbedder());
  const tries: string[] = [];
  const session = async (embedder: Embedder, label: string) => {
    try { await (await LibsqlStore.create(embedder, funesDbDir(vault))).close(); tries.push(`${label}: opened`); }
    catch (e) { tries.push(`${label}: ${(e as Error).message.match(/embedding drift|dirty/)?.[0] ?? (e as Error).message}`); }
  };
  const state = () => ({ sig: meta().embedding_signature, dirty: meta().reindex_dirty ?? null, chunks: chunkDecl().match(/F32_BLOB\(\d+\)/)?.[0] });
  const seen: Array<ReturnType<typeof state>> = [];
  await rebuildFresh({
    vault, embedder: other(),
    onStep: async (step) => {
      if (step !== "reset") return;
      await session(new FakeEmbedder(), "old model");
      await session(other(), "new model");
      seen.push(state());
    },
  }, async (store) => {
    await session(new FakeEmbedder(), "old model, mid-walk");
    seen.push(state());
    await indexDir(store, vault, {});
  });
  expect(tries).toEqual(["old model: embedding drift", "new model: dirty", "old model, mid-walk: embedding drift"]);
  const rebuilt = { sig: "other:8:chunk1800o200", dirty: "1", chunks: "F32_BLOB(8)" };
  expect(seen).toEqual([rebuilt, rebuilt]);
});

test("reindex --fresh refuses an index it cannot inspect, a foreign marker, a sync-root home and another star's stamp — before it changes a byte", async () => {
  mkdirSync(join(home, "libsql", "notes"), { recursive: true });
  writeFileSync(funesDbDir(vault), "not a database, at all, not even close to one");
  await expect(rebuildFresh({ vault, embedder: other() }, async () => {})).rejects.toThrow(/cannot inspect/);
  expect(readFileSync(funesDbDir(vault), "utf8")).toContain("not a database");
  rmSync(funesDbDir(vault));
  await built(new FakeEmbedder());
  const marker = join(home, "libsql", "notes", "owner-vault");
  const ours = readFileSync(marker, "utf8");
  writeFileSync(marker, JSON.stringify({ id: "git://example.org/theirs", vault: "/elsewhere" }) + "\n");
  await expect(rebuildFresh({ vault, embedder: other() }, async () => {})).rejects.toThrow(/index collision/);
  writeFileSync(marker, ours);
  writeFileSync(join(home, "libsql", "notes", ".stfolder"), ""); // the index home is a Syncthing folder
  await expect(rebuildFresh({ vault, embedder: other() }, async () => {})).rejects.toThrow(/Syncthing root/);
  rmSync(join(home, "libsql", "notes", ".stfolder"));
  writeFileSync(join(vault, "star.yaml"), "meta:\n  id: git://example.org/another\n");
  writeFileSync(join(home, "libsql", "notes", "owner-vault"), JSON.stringify({ id: "git://example.org/another", vault }) + "\n");
  await expect(rebuildFresh({ vault, embedder: other() }, async () => {})).rejects.toThrow(/example\.org\/notes/);
  expect(meta().embedding_signature).toBe("e:16:chunk1800o200");
});

test("makeStore refuses a read-write index path that is not the star's own; read-only keeps any path", async () => {
  await built(new FakeEmbedder());
  const elsewhere = join(home, "elsewhere", "index.db");
  await expect(makeStore({ vault, dbDir: elsewhere, embedder: new FakeEmbedder() })).rejects.toThrow(/write lock/);
  expect(existsSync(elsewhere)).toBe(false);
  await (await makeStore({ vault, dbDir: funesDbDir(vault), embedder: new FakeEmbedder() })).close();
  await (await makeStore({ vault, dbDir: funesDbDir(vault), readonly: true, embedder: new FakeEmbedder() })).close();
});

// RAI-309 test 2: the fixed 10 s wait, paid once. The parent holds the star's write lock through a full
// --fresh rebuild; a remember in another process waits it out, refuses naming the lock, and writes nothing.
test("RAI-309 test 2: a spawned remember against a process that holds the write lock through a full reindex refuses after 10 s", async () => {
  await built(new FakeEmbedder());
  const child = `
    const { makeStore } = await import(${JSON.stringify(join(import.meta.dir, "factory.ts"))});
    const { folderFunesStore } = await import(${JSON.stringify(join(import.meta.dir, "funes-store.ts"))});
    const { FakeEmbedder } = await import(${JSON.stringify(join(import.meta.dir, "__fixtures__", "publish-child.ts"))});
    const store = await makeStore({ vault: ${JSON.stringify(vault)}, embedder: new FakeEmbedder() });
    try { await folderFunesStore(store, { root: ${JSON.stringify(vault)} }).remember([{ title: "Blocked", body: "waits on the lock" }]); console.log("wrote"); }
    catch (e) { console.log(e.message); process.exitCode = 1; }`;
  const before = pages();
  let out = "";
  let ms = 0;
  await rebuildFresh({ vault, embedder: new FakeEmbedder() }, async (store) => {
    await indexDir(store, vault, {});
    const t = performance.now();
    const p = Bun.spawn(["bun", "-e", child], { env: { ...process.env, FUNES_HOME: home }, stdout: "pipe", stderr: "inherit" });
    out = await new Response(p.stdout).text();
    await p.exited;
    ms = performance.now() - t;
  });
  expect(out).toContain("write lock busy");
  expect(out).toContain(lockString050());
  expect(ms).toBeGreaterThanOrEqual(10_000);
  expect(pages()).toEqual(before);
}, 30_000);
