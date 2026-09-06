import { test, expect } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import type { Embedder } from "funes-core";
import { INDEX_SCHEMA_VERSION } from "funes-shared";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { funesBackend, funesDbDir, makeStore, repairIndexForFresh } from "./factory.ts";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";

// FUNES_BACKEND seam: default libsql (the only local backend since PGLite was removed 2026-07-20),
// backend-aware dbDir, and a clear connection-string error for the deferred postgres profile-B.

class FakeEmbedder implements Embedder {
  readonly dim = 8;
  private z() { return new Float32Array(this.dim); }
  async embedQuery() { return this.z(); }
  async embedPassage() { return this.z(); }
  async embedPassages(ts: string[]) { return ts.map(() => this.z()); }
}

test("funesBackend: defaults to libsql, parses arg/env, rejects unknown (incl. the removed pglite)", () => {
  const saved = process.env.FUNES_BACKEND;
  try {
    delete process.env.FUNES_BACKEND;
    expect(funesBackend()).toBe("libsql");
    expect(funesBackend("postgres")).toBe("postgres");
    expect(funesBackend("LibSQL")).toBe("libsql"); // case-insensitive
    expect(() => funesBackend("pglite")).toThrow(/unknown backend/); // PGLite removed 2026-07-20
    expect(() => funesBackend("duckdb")).toThrow(/unknown backend/);
    process.env.FUNES_BACKEND = "postgres";
    expect(funesBackend()).toBe("postgres");
  } finally {
    if (saved === undefined) delete process.env.FUNES_BACKEND;
    else process.env.FUNES_BACKEND = saved;
  }
});

test("funesDbDir: backend-specific path — libsql defaults OFF-vault (~/.twinkling/libsql), env overrides", () => {
  const saved = process.env.FUNES_LIBSQL_DIR;
  try {
    expect(funesDbDir("/v", "postgres").endsWith("/.funes/pgdata")).toBe(true); // unused (postgres = pgUrl), legacy path
    // Stack-review fix 2026-07-02: with the env unset the libsql index must NOT land inside the
    // vault (the old vault/.funes fallback silently forked a second index onto Dropbox).
    delete process.env.FUNES_LIBSQL_DIR;
    const def = funesDbDir("/v", "libsql");
    expect(def.includes("/.twinkling/libsql/v/")).toBe(true);
    expect(def.endsWith("/index.db")).toBe(true);
    expect(def.startsWith("/v/")).toBe(false); // never in-vault by default
    process.env.FUNES_LIBSQL_DIR = "/custom/base";
    expect(funesDbDir("/v", "libsql")).toBe("/custom/base/v/index.db");
  } finally {
    if (saved === undefined) delete process.env.FUNES_LIBSQL_DIR;
    else process.env.FUNES_LIBSQL_DIR = saved;
  }
});

test("makeStore: default backend opens a libsql store (:memory:)", async () => {
  const s = await makeStore({ embedder: new FakeEmbedder() }); // no dbDir → in-memory libsql, fake embedder
  expect((await s.stats()).nodes).toBe(0);
  await s.close();
});

test("makeStore: libsql backend opens a real LibsqlStore implementing the full FunesIndexStore", async () => {
  const s = await makeStore({ backend: "libsql", embedder: new FakeEmbedder() }); // :memory:
  expect((await s.stats()).nodes).toBe(0);
  // step-2b: the full surface is ported — graph() bakes (empty here), neighbors() returns a shape
  const g = await s.graph();
  expect(g.stats.nodes).toBe(0);
  expect((await s.neighbors("nope")).node).toBeNull();
  await s.close();
});

test("makeStore: basename-collision guard — two DIFFERENT vaults sharing a folder name refuse to share an index", async () => {
  const { mkdtempSync, rmSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const saved = process.env.FUNES_LIBSQL_DIR;
  const base = mkdtempSync(join(tmpdir(), "funes-collide-"));
  const roots = mkdtempSync(join(tmpdir(), "funes-vaults-"));
  const vaultA = join(roots, "one", "personal");
  const vaultB = join(roots, "two", "personal"); // same basename, different star
  mkdirSync(vaultA, { recursive: true });
  mkdirSync(vaultB, { recursive: true });
  try {
    process.env.FUNES_LIBSQL_DIR = base;
    const a = await makeStore({ backend: "libsql", vault: vaultA, embedder: new FakeEmbedder() });
    await a.close();
    // reopening the SAME vault is fine
    const a2 = await makeStore({ backend: "libsql", vault: vaultA, embedder: new FakeEmbedder() });
    await a2.close();
    // a DIFFERENT vault resolving to the same index dir must hard-stop, not silently share/clobber
    await expect(makeStore({ backend: "libsql", vault: vaultB, embedder: new FakeEmbedder() })).rejects.toThrow(/index collision/);
    // explicit dbDir = caller owns the mapping — no guard
    const explicit = await makeStore({ backend: "libsql", dbDir: join(base, "personal", "index.db"), embedder: new FakeEmbedder() });
    await explicit.close();
  } finally {
    if (saved === undefined) delete process.env.FUNES_LIBSQL_DIR;
    else process.env.FUNES_LIBSQL_DIR = saved;
    rmSync(base, { recursive: true, force: true });
    rmSync(roots, { recursive: true, force: true });
  }
});

test("makeStore: identity-keyed guard — same star id survives a move; different ids still collide", async () => {
  const { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const saved = process.env.FUNES_LIBSQL_DIR;
  const base = mkdtempSync(join(tmpdir(), "funes-id-"));
  const roots = mkdtempSync(join(tmpdir(), "funes-idvaults-"));
  // three vaults, ALL basename "inv" -> all map to <base>/inv/ (the collision surface)
  const home = join(roots, "home", "inv");     // star A
  const moved = join(roots, "moved", "inv");   // star A, relocated on disk (same id)
  const other = join(roots, "other", "inv");   // star B (different id)
  const starYaml = (id: string, name: string, c: string) => `meta:\n  name: ${name}\n  id: ${id}\n  constellation: ${c}\n`;
  for (const [p, id, name] of [[home, "https://github.com/acme/inv", "inv"], [moved, "https://github.com/acme/inv", "inv"], [other, "https://github.com/acme/OTHER", "other-inv"]] as const) {
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "star.yaml"), starYaml(id, name, "swarming"));
  }
  try {
    process.env.FUNES_LIBSQL_DIR = base;
    const a = await makeStore({ backend: "libsql", vault: home, embedder: new FakeEmbedder() });
    await a.close();
    // the marker now records WHICH STAR owns the index (the ADR-0002 ask), not just a path
    const marker = JSON.parse(readFileSync(join(base, "inv", "owner-vault"), "utf8"));
    expect(marker.id).toBe("https://github.com/acme/inv");
    expect(marker.star).toBe("inv");
    expect(marker.constellation).toBe("swarming");
    // SAME star id at a NEW path -> no false collision (portability win); marker updates the path
    const m = await makeStore({ backend: "libsql", vault: moved, embedder: new FakeEmbedder() });
    await m.close();
    expect(JSON.parse(readFileSync(join(base, "inv", "owner-vault"), "utf8")).vault).toBe(moved);
    // a DIFFERENT star id on the same index dir still hard-stops
    await expect(makeStore({ backend: "libsql", vault: other, embedder: new FakeEmbedder() })).rejects.toThrow(/index collision/);
  } finally {
    if (saved === undefined) delete process.env.FUNES_LIBSQL_DIR;
    else process.env.FUNES_LIBSQL_DIR = saved;
    rmSync(base, { recursive: true, force: true });
    rmSync(roots, { recursive: true, force: true });
  }
});

test("makeStore: legacy bare-path marker is honored, then upgraded once the star declares an id", async () => {
  const { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const saved = process.env.FUNES_LIBSQL_DIR;
  const base = mkdtempSync(join(tmpdir(), "funes-legacy-"));
  const roots = mkdtempSync(join(tmpdir(), "funes-legacyvaults-"));
  const vault = join(roots, "leg");
  mkdirSync(vault, { recursive: true });
  mkdirSync(join(base, "leg"), { recursive: true });
  // simulate a pre-identity marker: a bare resolved path
  writeFileSync(join(base, "leg", "owner-vault"), resolve(vault) + "\n");
  try {
    process.env.FUNES_LIBSQL_DIR = base;
    // no star.yaml yet -> path fallback, same path -> OK, marker left as legacy
    const a = await makeStore({ backend: "libsql", vault, embedder: new FakeEmbedder() });
    await a.close();
    // now the star gains an id -> next open upgrades the marker to structured JSON
    writeFileSync(join(vault, "star.yaml"), "meta:\n  name: leg\n  id: sync://acme/leg\n");
    const b = await makeStore({ backend: "libsql", vault, embedder: new FakeEmbedder() });
    await b.close();
    const upgraded = JSON.parse(readFileSync(join(base, "leg", "owner-vault"), "utf8"));
    expect(upgraded.id).toBe("sync://acme/leg");
  } finally {
    if (saved === undefined) delete process.env.FUNES_LIBSQL_DIR;
    else process.env.FUNES_LIBSQL_DIR = saved;
    rmSync(base, { recursive: true, force: true });
    rmSync(roots, { recursive: true, force: true });
  }
});

test("makeStore: postgres is PARKED (0.3.0 P0.4) — refused unless FUNES_PG_UNSAFE=1, then wants a connection string", async () => {
  const savedUrl = process.env.FUNES_PG_URL;
  const savedUnsafe = process.env.FUNES_PG_UNSAFE;
  try {
    delete process.env.FUNES_PG_URL;
    delete process.env.FUNES_PG_UNSAFE;
    // The refusal must name the escape, or an operator has nowhere to go from the error.
    await expect(makeStore({ backend: "postgres", embedder: new FakeEmbedder() }))
      .rejects.toThrow(/parked for 0\.3\.0[\s\S]*FUNES_PG_UNSAFE=1/);
    // Escape set (the live smoke test's posture): the tier opens again and the NEXT gate is the
    // connection string, exactly as before the park — so CI's pg coverage is untouched.
    process.env.FUNES_PG_UNSAFE = "1";
    await expect(makeStore({ backend: "postgres", embedder: new FakeEmbedder() })).rejects.toThrow(/FUNES_PG_URL/);
    expect(funesBackend("postgres")).toBe("postgres");
  } finally {
    if (savedUrl === undefined) delete process.env.FUNES_PG_URL;
    else process.env.FUNES_PG_URL = savedUrl;
    if (savedUnsafe === undefined) delete process.env.FUNES_PG_UNSAFE;
    else process.env.FUNES_PG_UNSAFE = savedUnsafe;
  }
});

test("postgresDriver: builds the full PgDriver surface without connecting (pool is lazy)", async () => {
  const { postgresDriver } = await import("./postgres-driver.ts");
  const d = await postgresDriver("postgres://star_role@localhost:1/star_db"); // nothing listens on :1 — must not matter
  expect(typeof d.query).toBe("function");
  expect(typeof d.exec).toBe("function");
  expect(typeof d.transaction).toBe("function");
  await d.close();
});

// 0.3.0 item 23 — the guard runs at the ONE construction point, on the INDEX path.
// The live estate arrangement is the second case and it must keep opening: the funes repo itself is
// a Syncthing folder (it carries a .stfolder) while its index lives at ~/.twinkling/libsql/funes.
test("makeStore: refuses an index inside a sync root; a vault inside one with an off-root index opens", async () => {
  const tmp = (n: string) => mkdtempSync(join(realpathSync(tmpdir()), n));
  const synced = tmp("funes-factory-synced-");
  writeFileSync(join(synced, ".stfolder"), "");
  await expect(makeStore({ dbDir: join(synced, "libsql", "index.db"), backend: "libsql", embedder: new FakeEmbedder() }))
    .rejects.toThrow(/refusing to open an index inside a Syncthing root/);

  const vault = tmp("funes-factory-vault-");           // the star, replicated by Syncthing
  writeFileSync(join(vault, ".stfolder"), "");
  const home = join(tmp("funes-factory-twinkling-"), "libsql", "funes"); // ~/.twinkling/libsql/<star>
  mkdirSync(home, { recursive: true });
  const store = await makeStore({ vault, dbDir: join(home, "index.db"), backend: "libsql", embedder: new FakeEmbedder() });
  await store.close();
});

// ── reindex --fresh's pre-open repair (0.3.0 schema fence, PLAN-0.3.0 R2#2) ──────────────────────
// The fence makes a read-write open REFUSE a stale schema_version, and --fresh used to wipe INSIDE
// the open store — so the repair verb refused its own patient. repairIndexForFresh removes the
// files before the open, but only after the checks an open runs, in their order; every case below
// asserts on the FILE, because the guard that matters is "refused before removal, not after".

/** A built one-page index at `dbPath` (WAL, as a live index is). */
async function builtIndex(dbPath: string): Promise<void> {
  const s = await LibsqlStore.create(new FakeEmbedder(), dbPath);
  await s.remember([{ id: "wiki/a", path: "wiki/a.md", title: "A", body: "a body", trust: "trusted" }]);
  await s.close();
}
function setMeta(dbPath: string, key: string, value: string): void {
  const raw = new BunDatabase(dbPath);
  raw.run("insert into meta(key,value) values (?,?) on conflict(key) do update set value=excluded.value", [key, value]);
  raw.close();
}
const freshFixture = () => ({
  vault: mkdtempSync(join(tmpdir(), "funes-fresh-vault-")),
  dbPath: join(mkdtempSync(join(tmpdir(), "funes-fresh-idx-")), "index.db"),
});

test("fresh repair: a current index is KEPT; a \"3\" live index is removed and rebuilt as \"4\"", async () => {
  const { vault, dbPath } = freshFixture();
  const embedder = new FakeEmbedder();
  await builtIndex(dbPath);
  // Current and matching: nothing to repair — the ordinary in-epoch wipe (prune([])) handles it and
  // keeps the dirty marker over the rebuild. Removing here would drop that protection for nothing.
  expect(await repairIndexForFresh({ vault, dbPath, embedder })).toBe("kept");
  expect(existsSync(dbPath)).toBe(true);
  setMeta(dbPath, "schema_version", "3");
  await expect(LibsqlStore.create(embedder, dbPath)).rejects.toThrow(/reindex --fresh/); // the patient the open refuses
  expect(await repairIndexForFresh({ vault, dbPath, embedder })).toBe("removed");
  expect(existsSync(dbPath)).toBe(false);
  expect(existsSync(dbPath + "-wal")).toBe(false); // the sidecars go with it — a stray -wal over a new file is a torn index
  const rebuilt = await LibsqlStore.create(embedder, dbPath);
  try { expect((await rebuilt.stats()).schemaVersion).toBe(INDEX_SCHEMA_VERSION); } finally { await rebuilt.close(); }
});

test("fresh repair: a mismatched embedding signature is removed and rebuilt", async () => {
  const { vault, dbPath } = freshFixture();
  const embedder = new FakeEmbedder();
  await builtIndex(dbPath);
  setMeta(dbPath, "embedding_signature", "someone-else:8:chunk");
  await expect(LibsqlStore.create(embedder, dbPath)).rejects.toThrow(/embedding drift/); // the H1 refusal
  expect(await repairIndexForFresh({ vault, dbPath, embedder })).toBe("removed");
  expect(existsSync(dbPath)).toBe(false);
  const rebuilt = await LibsqlStore.create(embedder, dbPath);
  try { expect((await rebuilt.stats()).schemaVersion).toBe(INDEX_SCHEMA_VERSION); } finally { await rebuilt.close(); }
});

test("fresh repair: a FOREIGN owner marker is refused BEFORE removal — the file survives", async () => {
  const { vault, dbPath } = freshFixture();
  writeFileSync(join(vault, "star.yaml"), "meta:\n  id: star:mine\n");
  writeFileSync(join(dirname(dbPath), "owner-vault"), JSON.stringify({ id: "star:theirs", vault: "/elsewhere" }) + "\n");
  await builtIndex(dbPath);
  setMeta(dbPath, "schema_version", "3"); // stale, so the only thing standing between it and rm is the guard
  await expect(repairIndexForFresh({ vault, dbPath, embedder: new FakeEmbedder() })).rejects.toThrow(/index collision/);
  expect(existsSync(dbPath)).toBe(true);
});

test("fresh repair: an index home under a .stfolder marker is refused before removal — the file survives", async () => {
  const { vault, dbPath } = freshFixture();
  await builtIndex(dbPath);
  setMeta(dbPath, "schema_version", "3");
  writeFileSync(join(dirname(dbPath), ".stfolder"), ""); // the home itself is a Syncthing folder
  await expect(repairIndexForFresh({ vault, dbPath, embedder: new FakeEmbedder() })).rejects.toThrow(/Syncthing root/);
  expect(existsSync(dbPath)).toBe(true);
});
