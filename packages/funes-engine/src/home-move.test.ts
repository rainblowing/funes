import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// PLAN-0.5.0 item 8 (RAI-205, ADR-0016, record 33): `funes home` and `funes home move`, each in a
// fresh process under a scratch HOME — never the real estate. The move runs through moveHome's own
// test seams (`move` below), which the CLI never reads: the sweep's pgrep list is pointed at a
// scratch path, so a session MCP running from this checkout cannot make a case refuse, and the
// crash point is an option, not an environment variable a real move could inherit.

const CLI = join(import.meta.dir, "cli.ts");
const HOME_MOVE = join(import.meta.dir, "home-move.ts");

// A move that completes needs the reader sweep's pgrep and lsof; where they are absent (the slim
// reader image, PLAN-0.5.0 item 58 C2) the move refuses, fail-closed, and these cases cannot run.
const sweepTest = Bun.which("pgrep") && Bun.which("lsof") ? test : test.skip;

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

/** `funes home move` through moveHome, with its test seams: `enginePath` defaults to a scratch path. */
async function move(home: string, opts: { enginePath?: string; crashAfter?: string } = {}) {
  const o = JSON.stringify({ enginePath: join(home, "no-engine-here"), ...opts });
  const script = `const { moveHome } = await import(${JSON.stringify(HOME_MOVE)});
    try { for (const l of moveHome(${o})) console.log(l); } catch (e) { console.error(e.message); process.exit(1); }`;
  const proc = Bun.spawn(["bun", "-e", script], { cwd: import.meta.dir, env: cleanEnv(home), stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

test("`funes home` prints the resolved funes home", async () => {
  const home = scratch();
  mkdirSync(join(home, ".twinkling", "libsql"), { recursive: true });
  const r = await funes(home, ["home"]);
  expect(r.code).toBe(0);
  expect(r.out.trim()).toBe(join(home, ".twinkling"));
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

sweepTest("N3: after the move an old-formula mkdir of the index dir and lock home fails, and no index appears under ~/.twinkling", async () => {
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

sweepTest("N4: the move refuses on a reader the sweep finds — an idle engine process, or an open file under the old home", async () => {
  const home = scratch();
  const l = legacyHome(home);
  const engine = join(home, "checkout", "packages", "funes-engine", "src");
  // an idle session MCP: runs from the checkout, holds nothing open under the home
  const idle = Bun.spawn(["bun", "-e", "setTimeout(() => {}, 60_000)", join(engine, "mcp.ts")], { stdout: "ignore", stderr: "ignore" });
  // a reader holding a file open under the old home
  const open = Bun.spawn(["bun", "-e", `require("node:fs").openSync(${JSON.stringify(join(l, "libsql", "notes", "index.db"))}, "r"); console.log("ready"); setTimeout(() => {}, 60_000)`], { stdout: "pipe", stderr: "ignore" });
  try {
    await open.stdout.getReader().read(); // the file is open
    const a = await move(home, { enginePath: engine });
    expect(a.code).not.toBe(0);
    expect(a.err).toContain(String(idle.pid));
    expect(a.err).toContain(String(open.pid));
    untouched(l);
    idle.kill(); await idle.exited;
    const b = await move(home, { enginePath: engine });
    expect(b.code).not.toBe(0);
    expect(b.err).not.toContain(String(idle.pid));
    expect(b.err).toContain(String(open.pid));
    untouched(l);
  } finally { idle.kill(); open.kill(); }
}, 60_000);

sweepTest("the sweep covers only the moved entries: a file held open under twinkl.ing's own dirs does not refuse", async () => {
  const home = scratch();
  const l = legacyHome(home);
  mkdirSync(join(l, "cc-sessions"));
  const session = join(l, "cc-sessions", "s1.json");
  writeFileSync(session, "{}");
  const open = Bun.spawn(["bun", "-e", `require("node:fs").openSync(${JSON.stringify(session)}, "r"); console.log("ready"); setTimeout(() => {}, 60_000)`], { stdout: "pipe", stderr: "ignore" });
  try {
    await open.stdout.getReader().read(); // the file is open
    const r = await move(home);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(readFileSync(join(home, ".funes", "libsql", "notes", "index.db"), "utf8")).toBe("index bytes");
  } finally { open.kill(); }
}, 30_000);

// The CLI reads none of moveHome's test seams from the environment: a stale shell exporting a dead
// sweep path or a crash point must neither blind the sweep nor kill a real move.
sweepTest("`funes home move` ignores FUNES_HOME_MOVE_* in the environment", async () => {
  const home = scratch();
  const l = legacyHome(home);
  // an idle engine process running from THIS engine's own source dir, the path the real sweep matches
  const idle = Bun.spawn(["bun", "-e", "setTimeout(() => {}, 60_000)", join(import.meta.dir, "mcp.ts")], { stdout: "ignore", stderr: "ignore" });
  try {
    const r = await funes(home, ["home", "move"], { FUNES_HOME_MOVE_SWEEP_PATH: join(home, "dead"), FUNES_HOME_MOVE_CRASH_AFTER: "models" });
    expect(r.code).toBe(1);
    expect(r.err).toContain(String(idle.pid));
    untouched(l);
  } finally { idle.kill(); }
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

sweepTest("N5: a 0.5.0 process alive across the move fails closed on its next lock, and no second lock file appears", async () => {
  const home = scratch();
  const l = legacyHome(home);
  const f = join(home, ".funes");
  // Takes and releases the index lock on the legacy home, waits for a line on stdin, then locks again.
  const script = `
    const shared = await import("funes-shared");
    const factory = await import(${JSON.stringify(join(import.meta.dir, "factory.ts"))});
    const db = factory.funesDbDir("/vaults/notes", "libsql");
    (await shared.acquireWriteLock(db)).release();
    console.log("ready");
    for await (const _ of console) break;
    try { (await shared.acquireWriteLock(db, { timeoutMs: 500 })).release(); console.log("locked"); }
    catch (e) { console.log("refused " + e.code); }`;
  const survivor = Bun.spawn(["bun", "-e", script], { cwd: import.meta.dir, env: cleanEnv(home), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = survivor.stdout.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
    const r = await move(home);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    survivor.stdin.write("go\n");
    survivor.stdin.end();
    let rest = "";
    for (let c = await reader.read(); !c.done; c = await reader.read()) rest += new TextDecoder().decode(c.value);
    expect(rest).toMatch(/refused (EEXIST|ENOTDIR)/);
    expect(readdirSync(join(f, "locks"))).toEqual([]);
    expect(statSync(join(l, "locks")).isFile()).toBe(true);
  } finally { survivor.kill(); }
}, 60_000);

sweepTest("N6: killed after a rename (the crash point), every command refuses; a rerun finishes the move", async () => {
  for (const entry of ["locks", "models", "endpoints.json"]) {
    const home = scratch();
    const l = legacyHome(home);
    const f = join(home, ".funes");
    const crashed = await move(home, { crashAfter: entry });
    expect(crashed.code).not.toBe(0);
    expect(existsSync(join(f, entry))).toBe(true);
    expect(existsSync(join(l, entry))).toBe(false); // killed before its tombstone

    // From the FIRST rename, not only once locks/ has moved, both homes count: every 0.5.0 command
    // refuses, naming both. Served on the legacy home instead, a reindex would fetch a fresh
    // ~/.twinkling/models (a re-mint, a fresh funes-cap) and the rerun would refuse to merge it.
    for (const args of [["home"], ["--version"]]) {
      const r = await funes(home, args);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain(l);
      expect(r.err).toContain(f);
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
    `require("node:fs").mkdirSync(require("node:path").dirname(factory.funesDbDir("/vaults/notes", "libsql")), { recursive: true })`,
    `require("node:fs").mkdirSync(machineState.stateDirFor("/vaults/notes"), { recursive: true })`,
  ]) {
    const home = scratch();
    const script = `
      const shared = await import("funes-shared");
      const factory = await import(${JSON.stringify(join(import.meta.dir, "factory.ts"))});
      const machineState = await import(${JSON.stringify(join(import.meta.dir, "machine-state.ts"))});
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

sweepTest("N9: the outbox and replica.json survive a move with a pending proposal", async () => {
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
