// The published index (RAI-306 S1, RAI-331): one `published.db` per home, built off-path and swapped
// in whole. Each test names the prototype probe it ports (docs/research/0.6.0/s1-published-db/).
import { test, expect, spyOn } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { chmodSync, constants, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, closeSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeTargetGeneration, publishReindex, publishedDbPath, publishIo, fullFsync, withPublishLock, parseDuration, rollbackPublished,
  type PublishReindexOpts,
} from "./publication.ts";
import { GENERATION_VERSION, SCHEMA_VERSIONS, parseLstatVersion } from "funes-core/internal";
import { LibsqlStore } from "./libsql/store.ts";
import { anyExclude, buildScopeExclude, configlessExclude } from "funes-core/internal";
import { scopeHash } from "funes-core";
import { FakeEmbedder } from "./__fixtures__/publish-child.ts";

const CHILD = join(import.meta.dir, "__fixtures__", "publish-child.ts");
const embedder = new FakeEmbedder();
const pub = (vault: string, home: string, o: Partial<PublishReindexOpts> = {}) => publishReindex({ vault, home, embedder, ...o });
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `funes-pub-${p}-`));

function makeVault(id?: string): string {
  const vault = tmp("vault");
  mkdirSync(join(vault, "wiki"), { recursive: true });
  if (id) writeFileSync(join(vault, "star.yaml"), `meta:\n  id: ${id}\n`);
  writeFileSync(join(vault, "wiki", "alpha.md"), "---\ntitle: Alpha\n---\nalpha sourdough loaf body\n");
  writeFileSync(join(vault, "wiki", "beta.md"), "---\ntitle: Beta\n---\nbeta telescope mirror body [[alpha]]\n");
  return vault;
}

/** A read-only reader's view of `published.db`: its content generation, or the error it refuses with. */
async function served(home: string): Promise<{ generation: string | null; nodes: number }> {
  const ro = await LibsqlStore.create(embedder, publishedDbPath(home), { readonly: true });
  try { return { generation: (await ro.contentIdentity()).contentGeneration, nodes: (await ro.stats()).nodes }; } finally { await ro.close(); }
}
const leftovers = (home: string) => readdirSync(home).filter((f) => f.startsWith("published.db.building"));
const target = (vault: string) => computeTargetGeneration(vault, { embedder, scopeSignature: null });

/** Spawn the fixture publisher. `ready` resolves on its `paused` line; `done` on its JSON result. */
function child(vault: string, home: string, args: string[] = [], env: Record<string, string | undefined> = {}) {
  const proc = Bun.spawn(["bun", CHILD, vault, home, ...args], { stdout: "pipe", stderr: "ignore", env: { ...process.env, ...env } });
  let out = "";
  let onLine = (): void => {};
  const ready = new Promise<void>((resolve) => { onLine = resolve; });
  const done = (async () => {
    const dec = new TextDecoder();
    for await (const chunk of proc.stdout) {
      out += dec.decode(chunk);
      if (out.includes("paused")) onLine();
    }
    await proc.exited;
    const last = out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
    return { code: proc.exitCode, signal: proc.signalCode, result: last ? JSON.parse(last) : null };
  })();
  return { proc, ready, done };
}

test("p45: equal → skip; a content-equal edit → skip; content change → clone-seeded build; --force → from empty", async () => {
  const vault = makeVault();
  const home = tmp("p45");
  const first = await pub(vault, home);
  expect(first).toMatchObject({ skipped: false, cloned: false, reason: "absent-or-unservable", generation: target(vault) });
  expect(await pub(vault, home)).toMatchObject({ skipped: true, reason: "equal", generation: first.generation });

  utimesSync(join(vault, "wiki", "alpha.md"), 5000, 5000); // the bytes equal the recorded hash (RAI-318)
  expect(await pub(vault, home)).toMatchObject({ skipped: true, reason: "equal", generation: first.generation });

  writeFileSync(join(vault, "wiki", "gamma.md"), "---\ntitle: Gamma\n---\ngamma body\n");
  const content = await pub(vault, home);
  expect(content).toMatchObject({ skipped: false, cloned: true, cloneError: null, reason: "content", generation: target(vault) });
  expect(content.generation).not.toBe(first.generation);

  expect(await pub(vault, home, { force: true })).toMatchObject({ skipped: false, cloned: false, reason: "force" });
  expect((await served(home)).generation).toBe(target(vault));
  expect(readdirSync(home).sort()).toEqual(["owner-vault", "published.db", "published.db.prev"]);
});

/** Everything a reader is served, canonically ordered — the rows, not the labels. */
function dump(home: string): string {
  const d = new BunDatabase(publishedDbPath(home), { readonly: true });
  try {
    const q = (sql: string) => JSON.stringify(d.query(sql).all());
    return [
      q("select id,path,title,type,body,content_hash,embedding_signature,trust,volatile,freshness,description,resource,source,authored,write_actor,hex(embedding) e from nodes order by id"),
      q("select page_id,ord,hex(embedding) from chunks order by page_id,ord"),
      q("select source,type,target,weight from edges order by source,type,target"),
      q("select id,mtime_ms,ctime_ms,size from page_stat order by id"),
      q("select nid,title,description,body from nodes_fts order by nid"),
      q("select key,value from meta where key in ('generation','index_scope_hash','index_scope_ignored','owner_star_id','schema_version','embedding_signature') order by key"),
    ].join("\n");
  } finally { d.close(); }
}

test("psk-clone-equiv: a clone-seeded build is row-identical to a --force build after a delete, a rename, a link removal and a scope narrow", async () => {
  const vault = makeVault();
  mkdirSync(join(vault, "drafts"), { recursive: true });
  writeFileSync(join(vault, "drafts", "wip.md"), "---\ntitle: Wip\n---\nwork in progress [[beta]]\n");
  writeFileSync(join(vault, "wiki", "gone.md"), "---\ntitle: Gone\n---\nto be deleted [[alpha]]\n");
  writeFileSync(join(vault, "wiki", "old-name.md"), "---\ntitle: Old\n---\nto be renamed\n");
  const cloned = tmp("equiv-a");
  const forced = tmp("equiv-b");
  await pub(vault, cloned);

  rmSync(join(vault, "wiki", "gone.md"));
  writeFileSync(join(vault, "wiki", "new-name.md"), readFileSync(join(vault, "wiki", "old-name.md")));
  rmSync(join(vault, "wiki", "old-name.md"));
  writeFileSync(join(vault, "wiki", "beta.md"), "---\ntitle: Beta\n---\nbeta telescope mirror body, no link now\n");
  const narrowed = { exclude: buildScopeExclude(["drafts/**"]), scopeSignature: { hash: scopeHash(["drafts/**"]), ignoreScope: false } };

  expect(await pub(vault, cloned, narrowed)).toMatchObject({ cloned: true, reason: "content" });
  expect(await pub(vault, forced, { ...narrowed, force: true })).toMatchObject({ cloned: false, reason: "force" });
  const a = dump(cloned);
  expect(a).toBe(dump(forced));
  expect(a).not.toContain("wiki/gone");
  expect(a).not.toContain("drafts/wip");
  expect(a).not.toContain("wiki/old-name");
});

test("p2 (reduced): a kill -9 during build, after finalize, between .prev link and rename, and after rename leaves published.db servable; the next run sweeps the leftovers", async () => {
  for (const at of ["build", "finalized", "prev-linked", "swapped"]) {
    const vault = makeVault();
    const home = tmp(`p2-${at}`);
    const before = (await pub(vault, home)).generation;
    writeFileSync(join(vault, "wiki", "gamma.md"), `---\ntitle: Gamma\n---\ngamma body ${at}\n`);
    const after = target(vault);
    const { done } = child(vault, home, ["--crash-at", at]);
    expect((await done).signal).toBe("SIGKILL");
    // Every kill point leaves a complete, servable file under the fixed name: the old build or the new.
    expect([before, after]).toContain((await served(home)).generation!);
    if (at === "build" || at === "finalized") expect(leftovers(home).length).toBeGreaterThan(0);
    const next = await pub(vault, home);
    expect(next.generation).toBe(after);
    expect((await served(home)).generation).toBe(after);
    expect(leftovers(home)).toEqual([]);
    expect(statSync(publishedDbPath(home)).ino).not.toBe(statSync(join(home, "published.db.prev")).ino);
  }
}, 60_000);

test("p139: a reader that holds the old fd keeps its snapshot; a new open after the swap sees the new build; no open sees ENOENT across repeated swaps", async () => {
  const vault = makeVault();
  const home = tmp("p139");
  const first = await pub(vault, home);
  const old = await LibsqlStore.create(embedder, publishedDbPath(home), { readonly: true });
  // A tight open loop in another process, counting every failed open of the fixed name.
  const loop = Bun.spawn(["bun", "-e", `
    const fs = require("node:fs"); let opens = 0, enoent = 0;
    process.on("SIGTERM", () => { console.log(JSON.stringify({ opens, enoent })); process.exit(0); });
    for (;;) { try { fs.closeSync(fs.openSync(${JSON.stringify(publishedDbPath(home))}, "r")); opens++; } catch (e) { if (e.code === "ENOENT") enoent++; } if (opens % 500 === 0) await Bun.sleep(0); }
  `], { stdout: "pipe" });
  try {
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(vault, "wiki", "gamma.md"), `---\ntitle: Gamma\n---\ngamma swap ${i}\n`);
      await pub(vault, home);
    }
    expect((await old.contentIdentity()).contentGeneration).toBe(first.generation); // the old snapshot
    expect(await old.indexedPage({ id: "wiki/gamma" })).toBeNull();
    expect((await served(home)).generation).toBe(target(vault)); // a new open sees the new build
  } finally {
    await old.close();
    loop.kill("SIGTERM");
  }
  const counts = JSON.parse(await new Response(loop.stdout).text());
  expect(counts.opens).toBeGreaterThan(100);
  expect(counts.enoent).toBe(0);
}, 30_000);

test("p78 + k4: a second publisher fails fast; of several publishers released together exactly one swaps; publish never opens index.db", async () => {
  const vault = makeVault();
  const home = tmp("p78");
  // The live index beside it, in WAL mode as the surface holds it (closed, so the WAL is checkpointed).
  const live = new BunDatabase(join(home, "index.db"));
  live.run("pragma journal_mode=wal");
  live.run("create table meta(key text primary key, value text)");
  live.close();
  const liveFiles = () => readdirSync(home).filter((f) => f.startsWith("index.db")).sort().map((f) => { const st = statSync(join(home, f)); return [f, st.ino, st.size, st.mtimeMs]; });
  const before = liveFiles();

  const holder = child(vault, home, ["--pause-at", "target", "--pause-ms", "4000"]);
  await holder.ready;
  const t = performance.now();
  await expect(pub(vault, home)).rejects.toThrow(/another publish is already running/);
  expect(performance.now() - t).toBeLessThan(1_000);
  expect((await holder.done).result).toMatchObject({ ok: true, skipped: false });

  writeFileSync(join(vault, "wiki", "gamma.md"), "---\ntitle: Gamma\n---\ngamma body\n");
  const go = join(home, "go");
  const racers = Array.from({ length: 8 }, () => child(vault, home, ["--wait-for", go]));
  await Bun.sleep(300);
  writeFileSync(go, "");
  const results = (await Promise.all(racers.map((r) => r.done))).map((r) => r.result);
  expect(results.filter((r) => r.ok && !r.skipped).length).toBe(1);
  for (const r of results.filter((r) => !(r.ok && !r.skipped))) expect(r.ok ? r.reason : r.error).toMatch(/equal|already running/);
  expect((await served(home)).generation).toBe(target(vault));

  // index.db, and whatever -wal/-shm its last writer left, are byte-for-byte where they were.
  expect(liveFiles()).toEqual(before);
}, 60_000);

test("Q18-6: a writer holds a write transaction on index.db for the whole publish, and publish completes; a writer proceeds while .publish.lock is held", async () => {
  const vault = makeVault();
  const home = tmp("q186");
  const live = await LibsqlStore.create(embedder, join(home, "index.db"));
  await live.remember([{ id: "wiki/alpha", path: "wiki/alpha.md", title: "Alpha", body: "alpha sourdough loaf body", trust: "trusted" }]);
  const writer = new BunDatabase(join(home, "index.db"));
  writer.run("begin immediate");
  writer.run("insert into meta(key,value) values ('q186','held') on conflict(key) do update set value=excluded.value");
  try {
    expect(await pub(vault, home)).toMatchObject({ skipped: false });
  } finally {
    writer.run("commit");
    writer.close();
  }
  const holder = child(vault, home, ["--force", "--pause-at", "target", "--pause-ms", "3000"]);
  await holder.ready;
  const t = performance.now();
  await live.remember([{ id: "wiki/fenced", path: "wiki/fenced.md", title: "Fenced", body: "written while the fence is held", trust: "trusted" }]);
  expect(performance.now() - t).toBeLessThan(2_000);
  expect(holder.proc.exitCode).toBeNull(); // the publisher still holds it
  await live.close();
  expect((await holder.done).result).toMatchObject({ ok: true });
}, 30_000);

test("a re-identified star (meta.id_was) clones its published.db instead of building from empty, restamps the owner, then skips", async () => {
  const OLD = "dropbox://example.org/old", NEW = "dropbox://example.org/new";
  const vault = makeVault(OLD);
  const home = tmp("reid");
  await pub(vault, home, { starId: OLD });
  writeFileSync(join(vault, "star.yaml"), `meta:\n  id: ${NEW}\n  id_was: ${OLD}\n`);
  expect(await pub(vault, home, { starId: NEW })).toMatchObject({ skipped: false, cloned: true, cloneError: null, reason: "owner" });
  const d = new BunDatabase(publishedDbPath(home), { readonly: true });
  try { expect(d.query("select value from meta where key = 'owner_star_id'").get()).toEqual({ value: NEW }); } finally { d.close(); }
  expect(await pub(vault, home, { starId: NEW })).toMatchObject({ skipped: true, reason: "equal" });
});

test("pmid: an edit to a page that the walk has not read yet makes built === target refuse", async () => {
  const vault = makeVault();
  const home = tmp("pmid");
  const first = await pub(vault, home);
  writeFileSync(join(vault, "wiki", "gamma.md"), "---\ntitle: Gamma\n---\ngamma body\n");
  const edit = (s: string) => { if (s === "target") writeFileSync(join(vault, "wiki", "beta.md"), "---\ntitle: Beta\n---\nedited after the target, before the walk\n"); };
  await expect(pub(vault, home, { onStep: edit })).rejects.toThrow(/the vault moved during the build/);
  expect((await served(home)).generation).toBe(first.generation); // nothing swapped in
  expect(leftovers(home)).toEqual([]);
  expect((await pub(vault, home)).generation).toBe(target(vault)); // the next run heals
});

test("p-fence: the publish lock is <home>/.publish.lock; publishers under two FUNES_HOME values meet on it, and a publisher never swaps in another run's build", async () => {
  const vault = makeVault();
  const home = tmp("pfence");
  const holder = child(vault, home, ["--pause-at", "finalized", "--pause-ms", "2500"], { FUNES_HOME: tmp("fh-a") });
  await holder.ready;
  expect(JSON.parse(readFileSync(join(home, ".publish.lock", "owner.json"), "utf8")).pid).toBe(holder.proc.pid);
  const second = await child(vault, home, [], { FUNES_HOME: tmp("fh-b") }).done;
  expect(second.result).toMatchObject({ ok: false, error: expect.stringMatching(/another publish is already running/) });
  // The holder's build carries its own pid; a stranger's build beside it is never what it renames.
  expect(leftovers(home).every((f) => f.startsWith(`published.db.building.${holder.proc.pid}.`))).toBe(true);
  const stranger = join(home, "published.db.building.1.stranger");
  writeFileSync(stranger, "not a database");
  expect((await holder.done).result).toMatchObject({ ok: true, skipped: false });
  expect(existsSync(stranger)).toBe(true);
  expect(existsSync(join(home, ".publish.lock"))).toBe(false);
  expect((await served(home)).generation).toBe(target(vault));
}, 30_000);

test("p-sidecars: stray published.db-journal/-wal/-shm are removed before the swap, and a read-write open of published.db fails", async () => {
  const vault = makeVault();
  const home = tmp("psidecars");
  await pub(vault, home);
  for (const s of ["-journal", "-wal", "-shm"]) writeFileSync(publishedDbPath(home) + s, "stray bytes of the old inode");
  const r = await pub(vault, home);
  expect(r).toMatchObject({ skipped: false, cloned: false }); // a sidecar makes the file unservable: no skip, no clone
  expect(readdirSync(home).filter((f) => /^published\.db-/.test(f))).toEqual([]);
  expect(statSync(publishedDbPath(home)).mode & 0o777).toBe(0o444);
  expect(statSync(join(home, "published.db.prev")).mode & 0o777).toBe(0o444);
  await expect(LibsqlStore.create(embedder, publishedDbPath(home))).rejects.toThrow(/readonly|read-only/i);
  expect(readdirSync(home).filter((f) => /^published\.db-/.test(f))).toEqual([]);
});

test("k5 / §3b-4: a 0644 published.db placed by hand is not served under an unchanged label", async () => {
  const vault = makeVault();
  const home = tmp("k5");
  const first = await pub(vault, home);
  chmodSync(publishedDbPath(home), 0o644);
  const raw = new BunDatabase(publishedDbPath(home));
  raw.run("update nodes set title = 'TAMPERED' where id = 'wiki/alpha'");
  raw.run("pragma journal_mode=delete");
  raw.close();
  const r = await pub(vault, home);
  expect(r).toMatchObject({ skipped: false, cloned: false, generation: first.generation });
  expect(statSync(publishedDbPath(home)).mode & 0o777).toBe(0o444);
  const d = new BunDatabase(publishedDbPath(home), { readonly: true });
  try { expect(d.query("select title from nodes where id = 'wiki/alpha'").get()).toEqual({ title: "Alpha" }); } finally { d.close(); }
});

/** Zero the root page of the FTS data table: torn bytes that `stats()` never reads. */
function tearFts(dbPath: string): void {
  const d = new BunDatabase(dbPath, { readonly: true });
  const { page_size } = d.query("pragma page_size").get() as { page_size: number };
  const { rootpage } = d.query("select rootpage from sqlite_master where name = 'nodes_fts_data'").get() as { rootpage: number };
  d.close();
  chmodSync(dbPath, 0o644);
  const fd = openSync(dbPath, "r+");
  try { writeSync(fd, Buffer.alloc(page_size), 0, page_size, (rootpage - 1) * page_size); } finally { closeSync(fd); }
  chmodSync(dbPath, 0o444);
}

test("pd-tornfts / pd-tornskip: a file with torn FTS pages is not skipped and is not cloned; a corrupt clone is built from empty instead", async () => {
  const vault = makeVault();
  const home = tmp("torn");
  const first = await pub(vault, home);
  tearFts(publishedDbPath(home));
  const r = await pub(vault, home);
  expect(r).toMatchObject({ skipped: false, cloned: false, reason: "absent-or-unservable", generation: first.generation });

  // A clone that comes out corrupt (the source passed quick_check, the copy did not) seeds nothing.
  writeFileSync(join(vault, "wiki", "gamma.md"), "---\ntitle: Gamma\n---\ngamma body\n");
  const spy = spyOn(publishIo, "clone").mockImplementation((src: string, dst: string) => {
    writeFileSync(dst, readFileSync(src));
    tearFts(dst);
    chmodSync(dst, 0o644);
  });
  try {
    const c = await pub(vault, home);
    expect(c).toMatchObject({ skipped: false, cloned: false, reason: "content", generation: target(vault) });
    expect(c.cloneError).toMatch(/quick_check/);
  } finally { spy.mockRestore(); }
  expect((await served(home)).generation).toBe(target(vault));
});

test("k2 / §3b-6: publish refuses a home whose published index belongs to another star", async () => {
  const mine = makeVault("dropbox://example.org/mine");
  const theirs = makeVault("dropbox://example.org/theirs");
  const home = tmp("k2");
  await pub(mine, home, { starId: "dropbox://example.org/mine" });
  await expect(pub(theirs, home, { starId: "dropbox://example.org/theirs" })).rejects.toThrow();
  // The marker is the directory's claim; the stamp in the bytes refuses even without it.
  rmSync(join(home, "owner-vault"));
  await expect(pub(theirs, home, { starId: "dropbox://example.org/theirs" })).rejects.toThrow(/belongs to|refus/i);
  expect((await served(home)).generation).toBe(target(mine));
});

test("pd-lockrb (a): a corrupt owner.json in .publish.lock refuses inside the grace, and publish heals after it", async () => {
  const vault = makeVault();
  const home = tmp("lockrb");
  const lock = join(home, ".publish.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), "{ torn");
  await expect(pub(vault, home)).rejects.toThrow(new RegExp(`another publish is already running.*${lock}`));
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old); // past the 30 s ownerless grace
  expect(await pub(vault, home)).toMatchObject({ skipped: false });
  expect(existsSync(lock)).toBe(false);
}, 30_000);

test("p-fullfsync: the swap syncs the build and the home directory, and a failed sync throws", async () => {
  const vault = makeVault();
  const home = tmp("fullfsync");
  const synced: string[] = [];
  const spy = spyOn(publishIo, "sync").mockImplementation(async (p: string) => { synced.push(p); await fullFsync(p); });
  try {
    await pub(vault, home);
  } finally { spy.mockRestore(); }
  expect(synced.length).toBe(3);
  expect(synced[0]).toMatch(/published\.db\.building\.\d+\.[0-9a-f]+$/); // the build, before any name points at it
  expect(synced.slice(1)).toEqual([home, home]); // the directory, before and after the rename

  // The real thing: F_FULLFSYNC on darwin succeeds on a file and a directory, and fails loudly on a
  // descriptor that cannot honour it.
  await fullFsync(publishedDbPath(home));
  await fullFsync(home);
  if (process.platform === "darwin") await expect(fullFsync("/dev/null")).rejects.toThrow(/F_FULLFSYNC failed/);

  // A failed sync swaps nothing in and leaves no build behind.
  writeFileSync(join(vault, "wiki", "gamma.md"), "---\ntitle: Gamma\n---\ngamma body\n");
  const before = statSync(publishedDbPath(home)).ino;
  const failing = spyOn(publishIo, "sync").mockImplementation(async () => { throw new Error("F_FULLFSYNC failed on test"); });
  try {
    await expect(pub(vault, home)).rejects.toThrow(/F_FULLFSYNC failed/);
  } finally { failing.mockRestore(); }
  expect(statSync(publishedDbPath(home)).ino).toBe(before);
  expect(leftovers(home)).toEqual([]);
});

test("p-guard: publish refuses a home in a sync root, before anything is built or written", async () => {
  const vault = makeVault();
  const home = tmp("guard");
  writeFileSync(join(home, ".stfolder"), ""); // the marker as Syncthing writes it — INSIDE its root
  await expect(pub(vault, home)).rejects.toThrow(/refusing to open an index inside a Syncthing root/);
  expect(readdirSync(home)).toEqual([".stfolder"]);
});

test("p-diskfull: a full disk swaps nothing in, and the error names ENOSPC", async () => {
  // The real probe ran on a 110 MB APFS sparse volume (hdiutil); the suite cannot mount one, so the
  // disk fills at the last write before the swap. libsql's own half (txn keeps SQLITE_FULL rather
  // than "no transaction is active") is store-txn.test.ts.
  const vault = makeVault();
  const home = tmp("diskfull");
  await pub(vault, home);
  writeFileSync(join(vault, "wiki", "gamma.md"), "---\ntitle: Gamma\n---\ngamma body\n");
  const before = statSync(publishedDbPath(home)).ino;
  const full = spyOn(publishIo, "sync").mockImplementation(async () => {
    throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
  });
  try {
    await expect(pub(vault, home)).rejects.toThrow(/ENOSPC/);
  } finally { full.mockRestore(); }
  expect(statSync(publishedDbPath(home)).ino).toBe(before);
  expect(leftovers(home)).toEqual([]);
});

// ── ported: what the skip predicate and the build already guaranteed ────────────────────────────

test("an ALIAS-resolved edge does not fail validation — the target and the build agree (Codex R1#4)", async () => {
  const vault = tmp("alias");
  mkdirSync(join(vault, "wiki"), { recursive: true });
  writeFileSync(join(vault, "wiki", "beta.md"), "---\ntitle: Beta\naliases: [rag]\n---\nbeta retrieval body\n");
  writeFileSync(join(vault, "wiki", "alpha.md"), "---\ntitle: Alpha\nedges:\n  - type: related_to\n    target: rag\n---\nalpha body\n");
  const home = tmp("alias-home");
  expect(await pub(vault, home)).toMatchObject({ skipped: false, generation: target(vault) });
  expect(await pub(vault, home)).toMatchObject({ skipped: true, generation: target(vault) });
});

test("published.db is finalized: DELETE journal, no sidecars, served with zero write access", async () => {
  const vault = makeVault();
  const home = tmp("fin");
  const r = await pub(vault, home);
  expect(r.dbPath).toBe(publishedDbPath(home));
  const header = readFileSync(publishedDbPath(home));
  expect([header[18], header[19]]).toEqual([1, 1]); // 1 = DELETE journal, 2 = WAL
  const ro = await LibsqlStore.create(embedder, publishedDbPath(home), { readonly: true });
  try { expect((await ro.recall({ query: "sourdough loaf", k: 1 })).length).toBe(1); } finally { await ro.close(); }
  expect(readdirSync(home).filter((f) => /^published\.db-/.test(f))).toEqual([]);
});

test("a DIRTY, a WAL-mode or a missing-core-table published.db carrying the target is rebuilt, never skipped", async () => {
  for (const spoil of ["dirty", "wal", "drop"] as const) {
    const vault = makeVault();
    const home = tmp(`spoil-${spoil}`);
    await pub(vault, home);
    chmodSync(publishedDbPath(home), 0o644);
    if (spoil === "dirty") {
      const s = await LibsqlStore.create(embedder, publishedDbPath(home));
      await s.beginReindex(); // sets reindex_dirty=1
      await s.finalizeForPublish();
      await s.close();
    } else {
      const raw = new BunDatabase(publishedDbPath(home));
      raw.run(spoil === "wal" ? "pragma journal_mode=wal" : "drop table nodes");
      raw.close();
      for (const s of ["-wal", "-shm"]) rmSync(publishedDbPath(home) + s, { force: true });
    }
    chmodSync(publishedDbPath(home), 0o444);
    expect(await pub(vault, home)).toMatchObject({ skipped: false, cloned: false });
    expect((await served(home)).generation).toBe(target(vault));
  }
});

async function publishedStats(home: string) {
  const ro = await LibsqlStore.create(embedder, publishedDbPath(home), { readonly: true });
  try { return { record: await ro.pageStats(), lastReindexAt: (await ro.stats()).lastReindexAt }; } finally { await ro.close(); }
}

test("ADR-0007 as amended (RAI-318): a content-equal edit skips — the content check reads the one file, and the record stays", async () => {
  const vault = makeVault();
  const home = tmp("statrefresh");
  const r1 = await pub(vault, home);
  const s1 = await publishedStats(home);
  utimesSync(join(vault, "wiki", "alpha.md"), 5000, 5000);
  expect(await pub(vault, home)).toMatchObject({ skipped: true, reason: "equal", generation: r1.generation });
  const s2 = await publishedStats(home);
  expect(s2.record).toEqual(s1.record);
  expect(parseLstatVersion(s2.record!.rows.find((r) => r.id === "wiki/alpha")!.version)!.mtimeMs).not.toBe(5_000_000);
});

test("ADR-0007: a published.db with NO stat record never skips — it self-heals on its first pass", async () => {
  const vault = makeVault();
  const home = tmp("nostat");
  const r1 = await pub(vault, home);
  chmodSync(publishedDbPath(home), 0o644);
  const raw = new BunDatabase(publishedDbPath(home));
  raw.run("drop table page_stat");
  raw.run("pragma journal_mode=delete");
  raw.close();
  chmodSync(publishedDbPath(home), 0o444);
  expect(await pub(vault, home)).toMatchObject({ skipped: false, cloned: true, generation: r1.generation });
  expect((await pub(vault, home)).skipped).toBe(true);
});

test("ADR-0007: the skip's parity walk takes the publish's own exclude — a scoped star or a configless node_modules skips", async () => {
  for (const [rel, exclude] of [
    ["drafts/wip.md", buildScopeExclude(["drafts/**"])],
    ["node_modules/pkg/README.md", anyExclude(buildScopeExclude([]), configlessExclude())],
  ] as const) {
    const vault = makeVault();
    mkdirSync(join(vault, rel, ".."), { recursive: true });
    writeFileSync(join(vault, rel), "---\ntitle: Out\n---\nnever indexed\n");
    const home = tmp("scopedskip");
    expect((await pub(vault, home, { exclude })).skipped).toBe(false);
    expect((await pub(vault, home, { exclude })).skipped).toBe(true);
  }
});

test("schema fence: a published \"3\" file with unchanged content is neither skipped nor cloned — the next publish lands a \"4\"", async () => {
  const vault = makeVault();
  const home = tmp("fence3");
  const first = await pub(vault, home);
  chmodSync(publishedDbPath(home), 0o644);
  const raw = new BunDatabase(publishedDbPath(home));
  raw.run("update meta set value='3' where key='schema_version'");
  raw.close();
  chmodSync(publishedDbPath(home), 0o444);
  expect(await pub(vault, home)).toMatchObject({ skipped: false, cloned: false, generation: first.generation });
  const ro = await LibsqlStore.create(embedder, publishedDbPath(home), { readonly: true });
  try { expect((await ro.stats()).schemaVersion).toBe(SCHEMA_VERSIONS.libsql); } finally { await ro.close(); }
});

test("withPublishLock: a held fence refuses at once in the same process too", async () => {
  const home = tmp("inproc");
  let release!: () => void;
  const held = withPublishLock(home, () => new Promise<void>((r) => { release = r; }));
  await Bun.sleep(10);
  const t = performance.now();
  await expect(withPublishLock(home, async () => {})).rejects.toThrow(/already running/);
  expect(performance.now() - t).toBeLessThan(500);
  release();
  await held;
  await withPublishLock(home, async () => {}); // released: the next one enters
});

test("parseDuration is the one grammar watch and replica share, and names the flag it was given", () => {
  expect(parseDuration("--interval", undefined)).toBeUndefined();
  expect(parseDuration("--interval", "5s")).toBe(5_000);
  expect(parseDuration("--interval", "90m")).toBe(90 * 60_000);
  expect(parseDuration("--interval", "250")).toBe(250);
  expect(() => parseDuration("--min-interval", "soon")).toThrow(/--min-interval "soon" is not a duration/);
});

// ── RAI-332: publish --rollback ─────────────────────────────────────────────────────────────────
const RB_ID = "dropbox://example.org/rb";
const rbPub = (vault: string, home: string, o: Partial<PublishReindexOpts> = {}) => pub(vault, home, { starId: RB_ID, ...o });
const rollback = (vault: string, home: string, from?: string) => rollbackPublished({ vault, home, embedder, scopeSignature: null, from });
const edit = (vault: string) => writeFileSync(join(vault, "wiki", "alpha.md"), `---\ntitle: Alpha\n---\nalpha ${Math.random()}\n`);

test("p-rollback R0: an absent target refuses, and nothing is swapped", async () => {
  const vault = makeVault(RB_ID);
  const home = tmp("rb0");
  const first = await rbPub(vault, home); // the first publish leaves no .prev
  await expect(rollback(vault, home)).rejects.toThrow(/no rollback target/);
  expect((await served(home)).generation).toBe(first.generation);
});

test("p-rollback R1: rollback to .prev serves the prior build, 0444, and keeps the rolled-back build as .prev", async () => {
  const vault = makeVault(RB_ID);
  const home = tmp("rb1");
  const g0 = (await rbPub(vault, home)).generation;
  edit(vault);
  const g1 = (await rbPub(vault, home)).generation;
  expect(g1).not.toBe(g0);
  const r = await rollback(vault, home);
  expect(r.generation).toBe(g0);
  expect((await served(home)).generation).toBe(g0);
  expect(statSync(publishedDbPath(home)).mode & 0o777).toBe(0o444);
  const prev = new BunDatabase(join(home, "published.db.prev"), { readonly: true });
  try { expect(prev.query("select value from meta where key = 'generation'").get()).toEqual({ value: g1 }); } finally { prev.close(); }
  expect(leftovers(home)).toEqual([]);
});

test("p-rollback R2: a held fence fails fast and changes nothing", async () => {
  const vault = makeVault(RB_ID);
  const home = tmp("rb2");
  const g0 = (await rbPub(vault, home)).generation;
  edit(vault);
  const g1 = (await rbPub(vault, home)).generation;
  let release!: () => void;
  const held = withPublishLock(home, () => new Promise<void>((r) => { release = r; }));
  await Bun.sleep(10);
  const t = performance.now();
  await expect(rollback(vault, home)).rejects.toThrow(/already running/);
  expect(performance.now() - t).toBeLessThan(500);
  release();
  await held;
  expect((await served(home)).generation).toBe(g1);
  const prev = new BunDatabase(join(home, "published.db.prev"), { readonly: true });
  try { expect(prev.query("select value from meta where key = 'generation'").get()).toEqual({ value: g0 }); } finally { prev.close(); }
});

test("p-rollback R3: a target that is the served inode refuses (a kill at prev-linked leaves .prev = published.db)", async () => {
  const vault = makeVault(RB_ID);
  const home = tmp("rb3");
  const g0 = (await rbPub(vault, home)).generation;
  rmSync(join(home, "published.db.prev"), { force: true });
  linkSync(publishedDbPath(home), join(home, "published.db.prev"));
  await expect(rollback(vault, home)).rejects.toThrow(/served file itself/);
  await expect(rollback(vault, home, publishedDbPath(home))).rejects.toThrow(/served file itself/);
  expect((await served(home)).generation).toBe(g0);
});

test("p-rollback R4: an unservable target (a stray -journal, a dirty build) refuses", async () => {
  const vault = makeVault(RB_ID);
  const home = tmp("rb4");
  await rbPub(vault, home);
  edit(vault);
  const g1 = (await rbPub(vault, home)).generation;
  const prev = join(home, "published.db.prev");
  writeFileSync(prev + "-journal", "");
  await expect(rollback(vault, home)).rejects.toThrow(/not servable/);
  rmSync(prev + "-journal");
  chmodSync(prev, 0o644);
  const raw = new BunDatabase(prev);
  raw.run("insert into meta(key, value) values ('reindex_dirty', '1') on conflict(key) do update set value = '1'");
  raw.close();
  await expect(rollback(vault, home)).rejects.toThrow(/not servable/);
  expect(statSync(prev).mode & 0o777).toBe(0o644); // a refused target keeps its mode
  expect((await served(home)).generation).toBe(g1);
  expect(leftovers(home)).toEqual([]);
});

test("p-rollback R5: when the walk's publish skips, the T0 copy (not .prev, which is older) is restored", async () => {
  const vault = makeVault(RB_ID);
  const home = tmp("rb5");
  const a = (await rbPub(vault, home)).generation;
  edit(vault);
  const b = (await rbPub(vault, home)).generation; // T0 serves B; .prev is A
  const t0 = join(home, `published.db.t0.${process.pid}`);
  copyFileSync(publishedDbPath(home), t0, constants.COPYFILE_FICLONE); // the walk's `cp -c`
  expect(await rbPub(vault, home)).toMatchObject({ skipped: true }); // the walk's publish
  const prev = new BunDatabase(join(home, "published.db.prev"), { readonly: true });
  try { expect(prev.query("select value from meta where key = 'generation'").get()).toEqual({ value: a }); } finally { prev.close(); }
  expect((await rollback(vault, home, t0)).generation).toBe(b);
  expect((await served(home)).generation).toBe(b);
  rmSync(t0); // the walk removes its copy
  expect(readdirSync(home).sort()).toEqual(["owner-vault", "published.db", "published.db.prev"]);
});

test("psk-rollback-guard: a target with another index_scope_hash, with index_scope_ignored set, or with a foreign owner_star_id refuses", async () => {
  const vault = makeVault(RB_ID);
  const home = tmp("rbguard");
  const g0 = (await rbPub(vault, home)).generation;
  edit(vault);
  const g1 = (await rbPub(vault, home)).generation;
  const prev = join(home, "published.db.prev");
  const setMeta = (key: string, value: string | null) => {
    chmodSync(prev, 0o644);
    const d = new BunDatabase(prev);
    if (value === null) d.run("delete from meta where key = ?", [key]);
    else d.run("insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value", [key, value]);
    d.close();
    chmodSync(prev, 0o444);
  };
  // the live star.yaml scope is absent (null) while the target was built under a narrowed scope
  setMeta("index_scope_hash", scopeHash(["drafts/**"]));
  await expect(rollback(vault, home)).rejects.toThrow(/index scope/);
  // and the other way: star.yaml now declares a scope the target was not built under
  setMeta("index_scope_hash", null);
  await expect(rollbackPublished({ vault, home, embedder, scopeSignature: { hash: scopeHash(["drafts/**"]), ignoreScope: false } })).rejects.toThrow(/index scope/);
  setMeta("index_scope_ignored", "1");
  await expect(rollback(vault, home)).rejects.toThrow(/scope ignored/);
  setMeta("index_scope_ignored", null);
  setMeta("owner_star_id", "dropbox://example.org/someone-else");
  await expect(rollback(vault, home)).rejects.toThrow(/belongs to dropbox:\/\/example.org\/someone-else/);
  setMeta("owner_star_id", RB_ID);
  expect((await served(home)).generation).toBe(g1);
  // the star id is required: a vault with no meta.id cannot roll back
  rmSync(join(vault, "star.yaml"));
  await expect(rollback(vault, home)).rejects.toThrow(/meta\.id/);
  writeFileSync(join(vault, "star.yaml"), `meta:\n  id: ${RB_ID}\n`);
  expect((await rollback(vault, home)).generation).toBe(g0); // the guards refused for their reasons only
});

test("pd-lockrb (b)(c): a torn target refuses (quick_check), and the served file is 0444 after a rollback from a 0644 copy", async () => {
  const vault = makeVault(RB_ID);
  const home = tmp("rblock");
  const g0 = (await rbPub(vault, home)).generation;
  const torn = join(home, "t0-torn.db");
  const copy = join(home, "t0-copy.db");
  copyFileSync(publishedDbPath(home), torn);
  copyFileSync(publishedDbPath(home), copy);
  tearFts(torn);
  edit(vault);
  const g1 = (await rbPub(vault, home)).generation;
  await expect(rollback(vault, home, torn)).rejects.toThrow(/quick_check/);
  expect((await served(home)).generation).toBe(g1);
  chmodSync(copy, 0o644);
  expect((await rollback(vault, home, copy)).generation).toBe(g0);
  expect(statSync(publishedDbPath(home)).mode & 0o777).toBe(0o444);
});

test("rollback refuses a --from outside the home", async () => {
  const vault = makeVault(RB_ID);
  const home = tmp("rbout");
  await rbPub(vault, home);
  const elsewhere = join(tmp("rbelse"), "published.db");
  copyFileSync(publishedDbPath(home), elsewhere);
  await expect(rollback(vault, home, elsewhere)).rejects.toThrow(/not in the home/);
});

// RAI-331 acceptance: the 0.3.0-0.5.0 protocol is gone from the source, not merely unused.
test("no source file names generation.json, gen- file names, publicationId, republish, --retain-prior, principals or GC", () => {
  const forbidden = [/generation\.json/, /\bgen-[\w*<[]/, /publicationId/, /republish/i, /--retain-prior/, /PrincipalStatus|principals\.json|principal status/i, /gcRetired|retainedArtefacts|RETAIN_PRIOR/];
  const root = join(import.meta.dir, "..", "..");
  const hits: string[] = [];
  for (const f of new Bun.Glob("*/src/**/*.ts").scanSync({ cwd: root })) {
    if (/\.test\.ts$|\.workerd\.ts$|__fixtures__/.test(f)) continue;
    readFileSync(join(root, f), "utf8").split("\n").forEach((line, i) => {
      for (const re of forbidden) if (re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  expect(hits).toEqual([]);
});

test("RAI-318 Q1c on publish: no star.yaml over a published.db built under a declared scope refuses; --force rebuilds without it", async () => {
  const vault = makeVault();
  mkdirSync(join(vault, "drafts"), { recursive: true });
  writeFileSync(join(vault, "drafts", "wip.md"), "---\ntitle: Wip\n---\nexcluded draft body\n");
  const home = tmp("lost-scope");
  const narrowed = { exclude: buildScopeExclude(["drafts/**"]), scopeSignature: { hash: scopeHash(["drafts/**"]), ignoreScope: false } };
  await pub(vault, home, narrowed);
  const before = (await served(home)).generation;
  await expect(pub(vault, home, { scopeSignature: null })).rejects.toThrow(/scope declared at the last publish is gone/);
  expect((await served(home)).generation).toBe(before);
  expect(await pub(vault, home, { scopeSignature: null, force: true })).toMatchObject({ skipped: false, reason: "force" });
});
