import { test, expect } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import type { Embedder } from "funes-core";
import { SCHEMA_VERSIONS } from "funes-core/internal";
import { funesHome } from "./funes-home.ts";
import { existsSync, rmSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { funesDbDir, makeStore } from "./factory.ts";
import { LibsqlStore } from "./libsql/store.ts";

class FakeEmbedder implements Embedder {
  readonly dim = 8;
  private z() { return new Float32Array(this.dim); }
  async embedQuery() { return this.z(); }
  async embedPassage() { return this.z(); }
  async embedPassages(ts: string[]) { return ts.map(() => this.z()); }
}

test("funesDbDir: libsql lives OFF-vault, under <funes home>/libsql; FUNES_HOME relocates the home", () => {
  const saved = process.env.FUNES_HOME;
  try {
    // Stack-review fix 2026-07-02: the libsql index must NOT land inside the vault (the old
    // vault/.funes fallback silently forked a second index onto Dropbox).
    process.env.FUNES_HOME = "/custom/home";
    const def = funesDbDir("/v");
    expect(def).toBe(join(funesHome(), "libsql", "v", "index.db"));
    expect(def).toBe("/custom/home/libsql/v/index.db");
    expect(def.startsWith("/v/")).toBe(false); // never in-vault
  } finally {
    if (saved === undefined) delete process.env.FUNES_HOME;
    else process.env.FUNES_HOME = saved;
  }
});

test("makeStore: default backend opens a libsql store (:memory:)", async () => {
  const s = await makeStore({ embedder: new FakeEmbedder() }); // no dbDir → in-memory libsql, fake embedder
  expect((await s.stats()).nodes).toBe(0);
  await s.close();
});

test("makeStore: libsql backend opens a real LibsqlStore implementing the full FunesIndexStore", async () => {
  const s = await makeStore({ embedder: new FakeEmbedder() }); // :memory:
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
  const saved = process.env.FUNES_HOME;
  const base = mkdtempSync(join(tmpdir(), "funes-collide-"));
  const roots = mkdtempSync(join(tmpdir(), "funes-vaults-"));
  const vaultA = join(roots, "one", "personal");
  const vaultB = join(roots, "two", "personal"); // same basename, different star
  mkdirSync(vaultA, { recursive: true });
  mkdirSync(vaultB, { recursive: true });
  try {
    process.env.FUNES_HOME = base;
    const a = await makeStore({ vault: vaultA, embedder: new FakeEmbedder() });
    await a.close();
    // reopening the SAME vault is fine
    const a2 = await makeStore({ vault: vaultA, embedder: new FakeEmbedder() });
    await a2.close();
    // a DIFFERENT vault resolving to the same index dir must hard-stop, not silently share/clobber
    await expect(makeStore({ vault: vaultB, embedder: new FakeEmbedder() })).rejects.toThrow(/index collision/);
    // explicit dbDir = caller owns the mapping — no guard
    const explicit = await makeStore({ dbDir: join(base, "libsql", "personal", "index.db"), embedder: new FakeEmbedder() });
    await explicit.close();
  } finally {
    if (saved === undefined) delete process.env.FUNES_HOME;
    else process.env.FUNES_HOME = saved;
    rmSync(base, { recursive: true, force: true });
    rmSync(roots, { recursive: true, force: true });
  }
});

test("makeStore: identity-keyed guard — same star id survives a move; different ids still collide", async () => {
  const { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const saved = process.env.FUNES_HOME;
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
    process.env.FUNES_HOME = base;
    const a = await makeStore({ vault: home, embedder: new FakeEmbedder() });
    await a.close();
    // the marker now records WHICH STAR owns the index (the twinkl.ing ADR-0002 §3.1 ask), not just a path
    const marker = JSON.parse(readFileSync(join(base, "libsql", "inv", "owner-vault"), "utf8"));
    expect(marker.id).toBe("https://github.com/acme/inv");
    expect(marker.star).toBe("inv");
    expect(marker.constellation).toBe("swarming");
    // SAME star id at a NEW path -> no false collision (portability win); marker updates the path
    const m = await makeStore({ vault: moved, embedder: new FakeEmbedder() });
    await m.close();
    expect(JSON.parse(readFileSync(join(base, "libsql", "inv", "owner-vault"), "utf8")).vault).toBe(moved);
    // a DIFFERENT star id on the same index dir still hard-stops
    await expect(makeStore({ vault: other, embedder: new FakeEmbedder() })).rejects.toThrow(/index collision/);
  } finally {
    if (saved === undefined) delete process.env.FUNES_HOME;
    else process.env.FUNES_HOME = saved;
    rmSync(base, { recursive: true, force: true });
    rmSync(roots, { recursive: true, force: true });
  }
});

test("makeStore: legacy bare-path marker is honored, then upgraded once the star declares an id", async () => {
  const { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const saved = process.env.FUNES_HOME;
  const base = mkdtempSync(join(tmpdir(), "funes-legacy-"));
  const roots = mkdtempSync(join(tmpdir(), "funes-legacyvaults-"));
  const vault = join(roots, "leg");
  mkdirSync(vault, { recursive: true });
  mkdirSync(join(base, "libsql", "leg"), { recursive: true });
  // simulate a pre-identity marker: a bare resolved path
  writeFileSync(join(base, "libsql", "leg", "owner-vault"), resolve(vault) + "\n");
  try {
    process.env.FUNES_HOME = base;
    // no star.yaml yet -> path fallback, same path -> OK, marker left as legacy
    const a = await makeStore({ vault, embedder: new FakeEmbedder() });
    await a.close();
    // now the star gains an id -> next open upgrades the marker to structured JSON
    writeFileSync(join(vault, "star.yaml"), "meta:\n  name: leg\n  id: sync://acme/leg\n");
    const b = await makeStore({ vault, embedder: new FakeEmbedder() });
    await b.close();
    const upgraded = JSON.parse(readFileSync(join(base, "libsql", "leg", "owner-vault"), "utf8"));
    expect(upgraded.id).toBe("sync://acme/leg");
  } finally {
    if (saved === undefined) delete process.env.FUNES_HOME;
    else process.env.FUNES_HOME = saved;
    rmSync(base, { recursive: true, force: true });
    rmSync(roots, { recursive: true, force: true });
  }
});

// 0.3.0 item 23 — the guard runs at the ONE construction point, on the INDEX path.
// The live estate arrangement is the second case and it must keep opening: the funes repo itself is
// a Syncthing folder (it carries a .stfolder) while its index lives at ~/.twinkling/libsql/funes.
test("makeStore: refuses an index inside a sync root; a vault inside one with an off-root index opens", async () => {
  const tmp = (n: string) => mkdtempSync(join(realpathSync(tmpdir()), n));
  const synced = tmp("funes-factory-synced-");
  writeFileSync(join(synced, ".stfolder"), "");
  await expect(makeStore({ dbDir: join(synced, "libsql", "index.db"), embedder: new FakeEmbedder() }))
    .rejects.toThrow(/refusing to open an index inside a Syncthing root/);

  const vault = tmp("funes-factory-vault-");           // the star, replicated by Syncthing
  writeFileSync(join(vault, ".stfolder"), "");
  const saved = process.env.FUNES_HOME;
  process.env.FUNES_HOME = tmp("funes-factory-home-"); // the index lives off the sync root
  try {
    const store = await makeStore({ vault, embedder: new FakeEmbedder() });
    await store.close();
  } finally {
    if (saved === undefined) delete process.env.FUNES_HOME; else process.env.FUNES_HOME = saved;
  }
});

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
/** A vault and its own live index path, under a scratch funes home (the caller restores FUNES_HOME). */
const freshFixture = () => {
  process.env.FUNES_HOME = mkdtempSync(join(tmpdir(), "funes-fresh-home-"));
  const vault = mkdtempSync(join(tmpdir(), "funes-fresh-vault-"));
  return { vault, dbPath: funesDbDir(vault) };
};

// RAI-157 (spike F5). The owner-vault marker authenticates the DIRECTORY; another star's index.db
// placed under this path passes it. The stamp INSIDE the db is
// now checked at every writer open and before `--fresh` removes anything.
test("RAI-157: a writer open refuses an index whose stamp names another star, though the marker is ours", async () => {
  const saved = process.env.FUNES_HOME;
  const { vault, dbPath } = freshFixture();
  try {
  writeFileSync(join(vault, "star.yaml"), "meta:\n  id: git://example.org/mine\n");
  await builtIndex(dbPath);
  setMeta(dbPath, "owner_star_id", "git://example.org/theirs");
  await expect(makeStore({ vault, dbDir: dbPath, embedder: new FakeEmbedder() })).rejects.toThrow(/example\.org\/theirs.*example\.org\/mine/);
  const ro = await makeStore({ vault, dbDir: dbPath, readonly: true, embedder: new FakeEmbedder() });
  await ro.close(); // read-only opens are layer 4's job, not this guard's

  // the same star under another access method, or its declared previous id, opens
  setMeta(dbPath, "owner_star_id", "dropbox://example.org/mine");
  await (await makeStore({ vault, dbDir: dbPath, embedder: new FakeEmbedder() })).close();
  setMeta(dbPath, "owner_star_id", "https://github.com/example/old");
  writeFileSync(join(vault, "star.yaml"), "meta:\n  id: git://example.org/mine\n  id_was: https://github.com/example/old\n");
  await (await makeStore({ vault, dbDir: dbPath, embedder: new FakeEmbedder() })).close();

  // a stamp with no id on this side refuses: absence never matches
  writeFileSync(join(vault, "star.yaml"), "meta:\n  name: nameless\n");
  await expect(makeStore({ vault, dbDir: dbPath, embedder: new FakeEmbedder() })).rejects.toThrow(/declares no star id/);
  } finally {
    if (saved === undefined) delete process.env.FUNES_HOME; else process.env.FUNES_HOME = saved;
  }
});

