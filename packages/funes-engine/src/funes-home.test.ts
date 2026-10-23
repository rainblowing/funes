import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ADR-0016 as amended by RAI-311: one funes home per machine — `$FUNES_HOME`, else `~/.funes`.
// `homedir()` is fixed at process start, so every case runs in a FRESH process under a chosen HOME —
// and no case may point HOME at the real estate.

const FACTORY = join(import.meta.dir, "factory.ts");
const EMBEDDER = join(import.meta.dir, "embedder.ts");
const CLI = join(import.meta.dir, "cli.ts");

const freshHome = (): string => realpathSync(mkdtempSync(join(tmpdir(), "funes-home-")));

/** process.env minus every FUNES_* knob, so a case sees only the variables it names. */
const cleanEnv = (home: string, extra: Record<string, string> = {}): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("FUNES_") && v !== undefined) env[k] = v;
  return { ...env, HOME: home, ...extra };
};

/** Run `body` (an async fn body with the resolver's modules in scope) under HOME; it returns JSON. */
async function under(home: string, body: string, env: Record<string, string> = {}): Promise<{ ok: true; value: any } | { ok: false; error: string }> {
  const script = `
    const shared = { ...(await import(${JSON.stringify(join(import.meta.dir, "funes-home.ts"))})), ...(await import(${JSON.stringify(join(import.meta.dir, "write-lock.ts"))})) };
    const factory = await import(${JSON.stringify(FACTORY)});
    const embedder = await import(${JSON.stringify(EMBEDDER)});
    try { console.log(JSON.stringify({ ok: true, value: await (async () => { ${body} })() })); }
    catch (e) { console.log(JSON.stringify({ ok: false, error: String(e.message ?? e) })); }`;
  const proc = Bun.spawn(["bun", "-e", script], { cwd: import.meta.dir, env: cleanEnv(home, env), stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  if (!out.trim()) throw new Error(`no output; stderr: ${err}`);
  return JSON.parse(out.trim());
}

async function cli(home: string, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", CLI, ...args], { env: cleanEnv(home, env), stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

const ALL_PATHS = `return {
  home: shared.funesHome(),
  db: factory.funesDbDir("/vaults/notes"),
  lock: shared.lockPathFor(factory.funesDbDir("/vaults/notes")),
  state: shared.stateDirFor("/vaults/notes"),
  models: embedder.modelCacheDir(),
  cap: shared.capabilityFilePath(),
  endpoints: shared.endpointsFilePath(),
};`;

const derivedFrom = (base: string) => ({
  home: base,
  db: join(base, "libsql", "notes", "index.db"),
  models: join(base, "models"),
  cap: join(base, "funes-cap"),
  endpoints: join(base, "endpoints.json"),
});

test("FUNES_HOME set → every machine-local path derives from it, and ~/.twinkling is never written", async () => {
  const home = freshHome();
  const base = join(home, "scratch-home");
  const r = await under(home, ALL_PATHS, { FUNES_HOME: base });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value).toMatchObject(derivedFrom(base));
  expect(r.value.lock.startsWith(join(base, "locks") + "/")).toBe(true);
  expect(r.value.state.startsWith(join(base, "state") + "/")).toBe(true);
  expect(() => statSync(join(home, ".twinkling"))).toThrow();
});

test("FUNES_HOME unset, no legacy state → ~/.funes; files, models/ and tombstones in ~/.twinkling do not count", async () => {
  const home = freshHome();
  mkdirSync(join(home, ".twinkling", "models"), { recursive: true });
  writeFileSync(join(home, ".twinkling", "funes-cap"), "tok");
  writeFileSync(join(home, ".twinkling", "libsql"), "tombstone"); // a plain file, as `funes home move` leaves
  const r = await under(home, ALL_PATHS);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const fresh = join(home, ".funes");
  expect(r.value).toMatchObject(derivedFrom(fresh));
  expect(r.value.lock.startsWith(join(fresh, "locks") + "/")).toBe(true);
  expect(r.value.state.startsWith(join(fresh, "state") + "/")).toBe(true);
});

test("a legacy home that holds state → the resolver refuses and names `funes home move`", async () => {
  for (const d of ["libsql", "locks", "state"]) {
    const home = freshHome();
    mkdirSync(join(home, ".twinkling", d), { recursive: true });
    mkdirSync(join(home, ".funes", "libsql"), { recursive: true }); // a move cut short refuses the same way
    for (const body of ["return shared.funesHome()", `return factory.funesDbDir("/vaults/notes")`, `return shared.lockPathFor("/x/index.db")`]) {
      const r = await under(home, body);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain(join(home, ".twinkling"));
        expect(r.error).toContain("funes home move");
      }
    }
  }
});

test("FUNES_HOME set → a legacy ~/.twinkling is not looked at", async () => {
  const home = freshHome();
  mkdirSync(join(home, ".twinkling", "libsql"), { recursive: true });
  const r = await under(home, "return shared.funesHome()", { FUNES_HOME: join(home, "h") });
  expect(r).toEqual({ ok: true, value: join(home, "h") });
});

test("a legacy home → every CLI command refuses and names `funes home move`", async () => {
  const home = freshHome();
  mkdirSync(join(home, ".twinkling", "locks"), { recursive: true });
  const vault = join(home, "vault");
  mkdirSync(vault);
  for (const args of [["doctor", "--vault", vault], ["recall", "x", "--vault", vault], ["--version"], ["home"]]) {
    const r = await cli(home, args);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("funes home move");
  }
}, 30_000);

test("each of B2's six retired names refuses and names FUNES_HOME — the resolver and the CLI", async () => {
  const home = freshHome();
  for (const name of ["FUNES_LIBSQL_DIR", "FUNES_LOCK_DIR", "FUNES_STATE_DIR", "FUNES_MODEL_DIR", "FUNES_SYNC_ROOT_OK", "FUNES_WRITE_DESIGNATION"]) {
    for (const value of ["/some/path", ""]) {
      const r = await under(home, ALL_PATHS, { [name]: value, FUNES_HOME: join(home, "h") });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain(name);
        expect(r.error).toContain("FUNES_HOME");
      }
    }
    const c = await cli(home, ["--version"], { [name]: "/some/path" });
    expect(c.code).not.toBe(0);
    expect(c.err).toContain(name);
    expect(c.err).toContain("FUNES_HOME");
  }
}, 60_000);

// B3 (RAI-309 Q7): a composition that sets FUNES_COORDINATION_DIR must not believe it is coordinated.
test("FUNES_COORDINATION_DIR refuses and names itself — the resolver and the CLI", async () => {
  const home = freshHome();
  for (const value of ["/star/.twinkling-sync", ""]) {
    const r = await under(home, ALL_PATHS, { FUNES_COORDINATION_DIR: value, FUNES_HOME: join(home, "h") });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("FUNES_COORDINATION_DIR");
      expect(r.error).toContain("write lock");
    }
  }
  const c = await cli(home, ["--version"], { FUNES_COORDINATION_DIR: "/star/.twinkling-sync" });
  expect(c.code).not.toBe(0);
  expect(c.err).toContain("FUNES_COORDINATION_DIR");
}, 30_000);

// B5 (RAI-310 D9, probe 3): a set FUNES_ACTOR must not believe it still names who wrote a row.
test("FUNES_ACTOR refuses and names the grant — the resolver and `funes remember`", async () => {
  const home = freshHome();
  for (const value of ["alice", ""]) {
    const r = await under(home, ALL_PATHS, { FUNES_ACTOR: value, FUNES_HOME: join(home, "h") });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("FUNES_ACTOR");
      expect(r.error).toContain("FUNES_ACTOR_MAP");
    }
  }
  const c = await cli(home, ["remember", "--vault", home, "--title", "T", "--body", "B"], { FUNES_ACTOR: "alice", FUNES_HOME: join(home, "h") });
  expect(c.code).not.toBe(0);
  expect(c.err).toContain("FUNES_ACTOR");
  expect(c.err).toContain("grant");
}, 30_000);

// B8 (RAI-314 Q9, RAI-312): a star's backend comes from its star.yaml, never from a variable.
test("FUNES_BACKEND and FUNES_PG_URL refuse and name memory.substrate — the resolver and the CLI", async () => {
  const home = freshHome();
  for (const name of ["FUNES_BACKEND", "FUNES_PG_URL"]) {
    for (const value of ["libsql", ""]) {
      const r = await under(home, ALL_PATHS, { [name]: value, FUNES_HOME: join(home, "h") });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain(name);
        expect(r.error).toContain("memory.substrate");
      }
    }
    const c = await cli(home, ["--version"], { [name]: "libsql" });
    expect(c.code).not.toBe(0);
    expect(c.err).toContain(name);
    expect(c.err).toContain("memory.substrate");
  }
}, 30_000);

test("a set-but-empty FUNES_HOME or FUNES_CAPABILITY_FILE refuses and names the variable", async () => {
  const home = freshHome();
  for (const [name, body] of [
    ["FUNES_HOME", `return factory.funesDbDir("/vaults/notes")`],
    ["FUNES_HOME", "return embedder.modelCacheDir()"],
    ["FUNES_CAPABILITY_FILE", "return shared.capabilityFilePath()"],
  ] as const) {
    const r = await under(home, body, { [name]: "" });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain(name);
  }
  const c = await cli(home, ["recall", "x", "--vault", home], { FUNES_HOME: "" });
  expect(c.code).not.toBe(0);
  expect(c.err).toContain("FUNES_HOME");
}, 30_000);

test("a non-empty FUNES_CAPABILITY_FILE wins for the capability file only", async () => {
  const home = freshHome();
  const r = await under(home, ALL_PATHS, { FUNES_CAPABILITY_FILE: "/custom/cap" });
  expect(r.ok && r.value.cap).toBe("/custom/cap");
  expect(r.ok && r.value.models).toBe(join(home, ".funes", "models"));
});

test("`funes --help` and `funes home` name the resolved funes home", async () => {
  const home = freshHome();
  expect((await cli(home, ["--help"])).out).toContain(`Model cache: ${join(home, ".funes", "models")}`);
  expect((await cli(home, ["home"])).out.trim()).toBe(join(home, ".funes"));
  expect((await cli(home, ["home"], { FUNES_HOME: join(home, "h") })).out.trim()).toBe(join(home, "h"));
}, 30_000);

test("the default home is memoized: state appearing in ~/.twinkling mid-process does not move it", async () => {
  const home = freshHome();
  const r = await under(home, `
    const first = shared.funesHome();
    (await import("node:fs")).mkdirSync(${JSON.stringify(join(home, ".twinkling", "state"))}, { recursive: true });
    return [first, shared.funesHome()];`);
  expect(r).toEqual({ ok: true, value: [join(home, ".funes"), join(home, ".funes")] });
});
