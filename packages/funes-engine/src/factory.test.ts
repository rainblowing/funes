import { test, expect } from "bun:test";
import type { Embedder } from "funes-core";
import { funesBackend, funesDbDir, makeStore } from "./factory.ts";

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

test("makeStore: postgres backend requires a connection string (FUNES_PG_URL or opts.pgUrl)", async () => {
  const saved = process.env.FUNES_PG_URL;
  try {
    delete process.env.FUNES_PG_URL;
    await expect(makeStore({ backend: "postgres", embedder: new FakeEmbedder() })).rejects.toThrow(/FUNES_PG_URL/);
    expect(funesBackend("postgres")).toBe("postgres");
  } finally {
    if (saved === undefined) delete process.env.FUNES_PG_URL;
    else process.env.FUNES_PG_URL = saved;
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
