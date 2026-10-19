import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// PLAN-0.5.0 item 7 (RAI-204, ADR-0016): one funes home per machine, chosen by what it holds and
// resolved once per process. `homedir()` is fixed at process start, so every case runs in a FRESH
// process under a chosen HOME — and no case may point HOME at the real estate.

const FACTORY = join(import.meta.dir, "factory.ts");
const EMBEDDER = join(import.meta.dir, "embedder.ts");
const MACHINE_STATE = join(import.meta.dir, "machine-state.ts");
const CLI = join(import.meta.dir, "cli.ts");

const freshHome = (): string => realpathSync(mkdtempSync(join(tmpdir(), "funes-home-")));

/** process.env minus every FUNES_* knob, so a case sees only the overrides it names. */
const cleanEnv = (home: string, extra: Record<string, string> = {}): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("FUNES_") && v !== undefined) env[k] = v;
  return { ...env, HOME: home, ...extra };
};

/** Run `body` (an async fn body with the resolver's modules in scope) under HOME; it returns JSON. */
async function under(home: string, body: string, env: Record<string, string> = {}): Promise<{ ok: true; value: any } | { ok: false; error: string }> {
  const script = `
    const shared = await import("funes-shared");
    const factory = await import(${JSON.stringify(FACTORY)});
    const embedder = await import(${JSON.stringify(EMBEDDER)});
    const machineState = await import(${JSON.stringify(MACHINE_STATE)});
    try { console.log(JSON.stringify({ ok: true, value: await (async () => { ${body} })() })); }
    catch (e) { console.log(JSON.stringify({ ok: false, error: String(e.message ?? e) })); }`;
  const proc = Bun.spawn(["bun", "-e", script], { cwd: import.meta.dir, env: cleanEnv(home, env), stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  if (!out.trim()) throw new Error(`no output; stderr: ${err}`);
  return JSON.parse(out.trim());
}

const ALL_PATHS = `return {
  home: shared.funesHome(),
  db: factory.funesDbDir("/vaults/notes", "libsql"),
  lock: shared.lockPathFor(factory.funesDbDir("/vaults/notes", "libsql")),
  state: machineState.stateDirFor("/vaults/notes"),
  models: embedder.modelCacheDir(),
  cap: shared.capabilityFilePath(),
  endpoints: shared.endpointsFilePath(),
};`;

/** 0.4.x's formulas, written out literally (factory.ts:47, write-lock.ts:41-48 at 12a3cd9). */
const v04 = (home: string) => {
  const db = join(home, ".twinkling", "libsql", "notes", "index.db");
  const h = createHash("sha256").update(db).digest("hex").slice(0, 10);
  return { db, lock: join(home, ".twinkling", "locks", `index.db-${h}.lock`) };
};

test("a legacy home: the index path is 0.4.x's byte for byte, and both versions take one lock file", async () => {
  const home = freshHome();
  mkdirSync(join(home, ".twinkling", "libsql"), { recursive: true });
  mkdirSync(join(home, ".funes")); // exists, empty: the existence of ~/.funes never selects
  const r = await under(home, ALL_PATHS);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const legacy = join(home, ".twinkling");
  expect(r.value.home).toBe(legacy);
  expect(r.value.db).toBe(v04(home).db);
  expect(r.value.lock).toBe(v04(home).lock);
  expect(r.value.state.startsWith(join(legacy, "state") + "/")).toBe(true);
  expect(r.value.models).toBe(join(legacy, "models"));
  expect(r.value.cap).toBe(join(legacy, "funes-cap"));
  expect(r.value.endpoints).toBe(join(legacy, "endpoints.json"));
});

test("a legacy home holding only locks/ is still the home — the lock home never splits", async () => {
  const home = freshHome();
  mkdirSync(join(home, ".twinkling", "locks"), { recursive: true });
  const r = await under(home, ALL_PATHS, { FUNES_LIBSQL_DIR: join(home, "elsewhere") });
  expect(r.ok && r.value.lock).toBe(join(home, ".twinkling", "locks", `index.db-${createHash("sha256").update(join(home, "elsewhere", "notes", "index.db")).digest("hex").slice(0, 10)}.lock`));
});

test("neither home holds state → ~/.funes; files, models/ and tombstones do not count", async () => {
  const home = freshHome();
  mkdirSync(join(home, ".twinkling", "models"), { recursive: true });
  writeFileSync(join(home, ".twinkling", "funes-cap"), "tok");
  writeFileSync(join(home, ".twinkling", "libsql"), "tombstone"); // a plain file, as `funes home move` leaves
  const r = await under(home, ALL_PATHS);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const fresh = join(home, ".funes");
  expect(r.value).toMatchObject({
    home: fresh,
    db: join(fresh, "libsql", "notes", "index.db"),
    models: join(fresh, "models"),
    cap: join(fresh, "funes-cap"),
    endpoints: join(fresh, "endpoints.json"),
  });
  expect(r.value.lock.startsWith(join(fresh, "locks") + "/")).toBe(true);
  expect(r.value.state.startsWith(join(fresh, "state") + "/")).toBe(true);
});

test("both homes holding state → the resolver refuses and names both", async () => {
  const home = freshHome();
  mkdirSync(join(home, ".twinkling", "locks"), { recursive: true }); // a legacy home with only locks/
  mkdirSync(join(home, ".funes", "libsql"), { recursive: true });
  for (const body of ["return shared.funesHome()", `return factory.funesDbDir("/vaults/notes", "libsql")`, `return shared.lockPathFor("/x/index.db")`]) {
    const r = await under(home, body);
    expect(r.ok).toBe(false);
    if (r.ok) continue;
    expect(r.error).toContain(join(home, ".twinkling"));
    expect(r.error).toContain(join(home, ".funes"));
  }
});

test("both homes holding state → every CLI command refuses and names both", async () => {
  const home = freshHome();
  mkdirSync(join(home, ".twinkling", "locks"), { recursive: true });
  mkdirSync(join(home, ".funes", "state"), { recursive: true });
  const vault = join(home, "vault");
  mkdirSync(vault);
  for (const args of [["doctor", "--vault", vault], ["query", "x", "--vault", vault], ["--version"]]) {
    const proc = Bun.spawn(["bun", CLI, ...args], { env: cleanEnv(home, { FUNES_DAEMON_PORT: "1" }), stdout: "pipe", stderr: "pipe" });
    const [, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(await proc.exited).not.toBe(0);
    expect(err).toContain(join(home, ".twinkling"));
    expect(err).toContain(join(home, ".funes"));
  }
}, 30_000);

test("`funes --help` names the model cache under the resolved funes home, not a fixed ~/.twinkling", async () => {
  const help = async (home: string) => {
    const proc = Bun.spawn(["bun", CLI, "--help"], { env: cleanEnv(home), stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    return out;
  };
  const fresh = freshHome();
  expect(await help(fresh)).toContain(`FUNES_MODEL_DIR (default ${join(fresh, ".funes", "models")})`);
  const legacy = freshHome();
  mkdirSync(join(legacy, ".twinkling", "libsql"), { recursive: true });
  expect(await help(legacy)).toContain(`FUNES_MODEL_DIR (default ${join(legacy, ".twinkling", "models")})`);
}, 30_000);

test("the home is memoized: state appearing in the other home mid-process does not move it", async () => {
  const home = freshHome();
  mkdirSync(join(home, ".twinkling", "state"), { recursive: true });
  const r = await under(home, `
    const first = shared.funesHome();
    (await import("node:fs")).mkdirSync(${JSON.stringify(join(home, ".funes", "libsql"))}, { recursive: true });
    return [first, shared.funesHome(), shared.lockPathFor("/x/index.db")];`);
  expect(r.ok && r.value[1]).toBe(join(home, ".twinkling"));
  expect(r.ok && r.value[2].startsWith(join(home, ".twinkling", "locks") + "/")).toBe(true);
});

test("a non-empty override wins for its own resource only", async () => {
  const home = freshHome();
  const r = await under(home, ALL_PATHS, { FUNES_LIBSQL_DIR: "/custom/base", FUNES_CAPABILITY_FILE: "/custom/cap" });
  expect(r.ok && r.value.db).toBe("/custom/base/notes/index.db");
  expect(r.ok && r.value.cap).toBe("/custom/cap");
  expect(r.ok && r.value.models).toBe(join(home, ".funes", "models"));
});

test("a set-but-empty FUNES_* override refuses and names the variable", async () => {
  const home = freshHome();
  const cases: [string, string][] = [
    ["FUNES_LIBSQL_DIR", `return factory.funesDbDir("/vaults/notes", "libsql")`],
    ["FUNES_LOCK_DIR", `return shared.lockPathFor("/x/index.db")`],
    ["FUNES_STATE_DIR", `return machineState.stateDirFor("/vaults/notes")`],
    ["FUNES_MODEL_DIR", "return embedder.modelCacheDir()"],
    ["FUNES_CAPABILITY_FILE", "return shared.capabilityFilePath()"],
    ["FUNES_CAPABILITY_FILE", `return await (await import(${JSON.stringify(join(import.meta.dir, "daemon-client.ts"))})).daemonProbe(1, "/v")`],
  ];
  for (const [name, body] of cases) {
    const r = await under(home, body, { [name]: "" });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain(name);
  }
});

test("a set-but-empty FUNES_LIBSQL_DIR makes the CLI refuse, naming it", async () => {
  const home = freshHome();
  const vault = join(home, "vault");
  mkdirSync(vault);
  const proc = Bun.spawn(["bun", CLI, "query", "x", "--vault", vault], { env: cleanEnv(home, { FUNES_LIBSQL_DIR: "", FUNES_DAEMON_PORT: "1" }), stdout: "pipe", stderr: "pipe" });
  const [, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect(await proc.exited).not.toBe(0);
  expect(err).toContain("FUNES_LIBSQL_DIR");
}, 30_000);
