import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// PLAN-0.5.0 item 8 (RAI-205, ADR-0016, record 33; RAI-311): `funes home` and `funes home move`, each
// in a fresh process under a scratch HOME — never the real estate. The crash point is a moveHome
// option (`move` below), never an environment variable a real move could inherit.

const CLI = join(import.meta.dir, "cli.ts");
const HOME_MOVE = join(import.meta.dir, "home-move.ts");

const scratch = (): string => realpathSync(mkdtempSync(join(tmpdir(), "funes-move-")));

const cleanEnv = (home: string, extra: Record<string, string> = {}): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("FUNES_") && v !== undefined) env[k] = v;
  return { ...env, HOME: home, ...extra };
};

async function funes(home: string, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", CLI, ...args], { env: cleanEnv(home, env), stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

/** `funes home move` through moveHome, with its crash-point seam. */
async function move(home: string, opts: { crashAfter?: string } = {}) {
  const o = JSON.stringify(opts);
  const script = `const { moveHome } = await import(${JSON.stringify(HOME_MOVE)});
    try { for (const l of moveHome(${o})) console.log(l); } catch (e) { console.error(e.message); process.exit(1); }`;
  const proc = Bun.spawn(["bun", "-e", script], { cwd: import.meta.dir, env: cleanEnv(home), stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

test("`funes home move` refuses when FUNES_HOME is set, and moves nothing", async () => {
  const home = scratch();
  const l = legacyHome(home);
  const r = await funes(home, ["home", "move"], { FUNES_HOME: join(home, "elsewhere") });
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("FUNES_HOME");
  untouched(l);
  expect(existsSync(join(home, ".funes"))).toBe(false);
}, 30_000);

/** A legacy home as 0.4.x leaves it: an index, a released lock, machine state, models, the
 *  capability file and the writer-endpoint file. */
function legacyHome(home: string): string {
  const l = join(home, ".twinkling");
  mkdirSync(join(l, "libsql", "notes"), { recursive: true });
  writeFileSync(join(l, "libsql", "notes", "index.db"), "index bytes");
  mkdirSync(join(l, "locks"), { recursive: true });
  mkdirSync(join(l, "state", "notes-0123456789"), { recursive: true });
  writeFileSync(join(l, "state", "notes-0123456789", "embedding.json"), "{}");
  mkdirSync(join(l, "models", "e5"), { recursive: true });
  writeFileSync(join(l, "models", "e5", "weights"), "w");
  writeFileSync(join(l, "funes-cap"), "tok", { mode: 0o600 });
  writeFileSync(join(l, "endpoints.json"), "{}", { mode: 0o600 });
  mkdirSync(join(l, "constellations")); // twinkl.ing's own: never moved
  return l;
}

const errCode = (f: () => unknown): string => {
  try { f(); return "no error"; } catch (e) { return String((e as NodeJS.ErrnoException).code); }
};

test("N3: after the move an old-formula mkdir of the index dir and lock home fails, and no index appears under ~/.twinkling", async () => {
  const home = scratch();
  const l = legacyHome(home);
  const f = join(home, ".funes");
  const r = await move(home);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);

  expect(readFileSync(join(f, "libsql", "notes", "index.db"), "utf8")).toBe("index bytes");
  expect(readFileSync(join(f, "state", "notes-0123456789", "embedding.json"), "utf8")).toBe("{}");
  expect(readFileSync(join(f, "models", "e5", "weights"), "utf8")).toBe("w");
  expect(readFileSync(join(f, "funes-cap"), "utf8")).toBe("tok");
  expect(statSync(join(f, "funes-cap")).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(f, "endpoints.json"), "utf8")).toBe("{}");
  expect(existsSync(join(l, "constellations"))).toBe(true);
  for (const e of ["models", "funes-cap", "endpoints.json"]) expect(existsSync(join(l, e))).toBe(false);
  for (const t of ["libsql", "locks", "state"]) {
    expect(statSync(join(l, t)).isFile()).toBe(true);
    expect(readFileSync(join(l, t), "utf8")).toContain(join(f, t)); // each tombstone names the new path
  }

  // 0.4.x's formulas (factory.ts:47, write-lock.ts:96 at 12a3cd9)
  expect(["ENOTDIR", "EEXIST"]).toContain(errCode(() => mkdirSync(join(l, "libsql", "notes"), { recursive: true })));
  expect(["ENOTDIR", "EEXIST"]).toContain(errCode(() => mkdirSync(join(l, "locks"), { recursive: true })));
  expect([...new Bun.Glob("**/index.db").scanSync({ cwd: l, dot: true })]).toEqual([]);

  expect((await funes(home, ["home"])).out.trim()).toBe(f);
}, 60_000);

/** Nothing moved: every legacy entry still where it was, no tombstone. */
function untouched(l: string): void {
  for (const e of ["libsql", "locks", "state", "models"]) expect(statSync(join(l, e)).isDirectory()).toBe(true);
  for (const e of ["funes-cap", "endpoints.json"]) expect(existsSync(join(l, e))).toBe(true);
}

test("N4: the move refuses on a live lock owner", async () => {
  const home = scratch();
  const l = legacyHome(home);
  const lock = join(l, "locks", "index.db-0123456789.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token: "t" })); // this test runner: alive
  const r = await move(home);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain(lock);
  untouched(l);
}, 30_000);

test("N4: the move refuses on a held publish lock in a publication home", async () => {
  const home = scratch();
  const l = legacyHome(home);
  const lock = join(l, "libsql", "notes", ".publish.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token: "t" })); // this test runner: alive
  const r = await move(home);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain(lock);
  untouched(l);
}, 30_000);

test("N4: the move refuses on a target already holding state", async () => {
  const home = scratch();
  const l = legacyHome(home);
  mkdirSync(join(home, ".funes", "libsql"), { recursive: true });
  const r = await move(home);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain(join(home, ".funes", "libsql"));
  untouched(l);
}, 30_000);

test("N6: killed after a rename (the crash point), every command refuses; a rerun finishes the move", async () => {
  for (const entry of ["locks", "models", "endpoints.json"]) {
    const home = scratch();
    const l = legacyHome(home);
    const f = join(home, ".funes");
    const crashed = await move(home, { crashAfter: entry });
    expect(crashed.code).not.toBe(0);
    expect(existsSync(join(f, entry))).toBe(true);
    expect(existsSync(join(l, entry))).toBe(false); // killed before its tombstone

    // The legacy home still holds state: every command refuses and names the rerun.
    for (const args of [["home"], ["--version"]]) {
      const r = await funes(home, args);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain(l);
      expect(r.err).toContain("funes home move");
    }

    const rerun = await move(home);
    expect(rerun.err).toBe("");
    expect(rerun.code).toBe(0);
    expect(readFileSync(join(f, "libsql", "notes", "index.db"), "utf8")).toBe("index bytes");
    expect(readFileSync(join(f, "funes-cap"), "utf8")).toBe("tok");
    for (const t of ["libsql", "locks", "state"]) expect(statSync(join(l, t)).isFile()).toBe(true);
    expect((await funes(home, ["home"])).out.trim()).toBe(f);
    // and a third run has nothing left to do
    const again = await move(home);
    expect(again.code).toBe(0);
    expect(again.out).toContain("nothing to move");
  }
}, 60_000);

test("a first creation of ~/.funes/{libsql,locks,state} writes the same tombstones", async () => {
  for (const make of [
    `(await shared.acquireWriteLock("/x/index.db")).release()`,
    `require("node:fs").mkdirSync(require("node:path").dirname(factory.funesDbDir("/vaults/notes")), { recursive: true })`,
    `require("node:fs").mkdirSync(shared.stateDirFor("/vaults/notes"), { recursive: true })`,
  ]) {
    const home = scratch();
    const script = `
      const shared = { ...(await import(${JSON.stringify(join(import.meta.dir, "funes-home.ts"))})), ...(await import(${JSON.stringify(join(import.meta.dir, "write-lock.ts"))})) };
      const factory = await import(${JSON.stringify(join(import.meta.dir, "factory.ts"))});
      ${make};`;
    const proc = Bun.spawn(["bun", "-e", script], { cwd: import.meta.dir, env: cleanEnv(home), stdout: "pipe", stderr: "pipe" });
    const err = await new Response(proc.stderr).text();
    expect(err).toBe("");
    expect(await proc.exited).toBe(0);
    const l = join(home, ".twinkling");
    for (const t of ["libsql", "locks", "state"]) expect(statSync(join(l, t)).isFile()).toBe(true);
    expect(["ENOTDIR", "EEXIST"]).toContain(errCode(() => mkdirSync(join(l, "libsql", "notes"), { recursive: true })));
    expect(["ENOTDIR", "EEXIST"]).toContain(errCode(() => mkdirSync(join(l, "locks"), { recursive: true })));
  }
}, 30_000);

test("N9: the outbox and replica.json survive a move with a pending proposal", async () => {
  const home = scratch();
  const l = legacyHome(home);
  const slot = join("state", "taste-0123456789");
  const files: Record<string, string> = {
    [join(slot, "outbox", "01JPENDING.json")]: JSON.stringify({ proposalId: "01JPENDING", op: "put_page", status: "pending" }),
    [join(slot, "outbox", "dismissed", "01JOLD.json")]: "{}",
    [join(slot, "replica.json")]: JSON.stringify({ starId: "taste", locus: "writer" }),
    [join(slot, "canon", "items", "a.md")]: "# a\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(l, rel, ".."), { recursive: true });
    writeFileSync(join(l, rel), body);
  }
  const r = await move(home);
  expect(r.code).toBe(0);
  for (const [rel, body] of Object.entries(files)) expect(readFileSync(join(home, ".funes", rel), "utf8")).toBe(body);
}, 30_000);
