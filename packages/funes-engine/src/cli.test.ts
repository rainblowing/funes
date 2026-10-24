import { test, expect, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { LibsqlStore } from "./libsql/store.ts";
import { E5Embedder, E5_DIM } from "./embedder.ts";
import { computeTargetGeneration, withPublishLock } from "./publication.ts";
import { scopeHash } from "funes-core";
import { startServe, type RunningServe } from "./serve.ts";
import type { Embedder } from "funes-core";
import { GENERATION_VERSION } from "funes-core/internal";

// The CLI binary end to end (RAI-317, test seam 2): the operator commands, one adapter test per op
// path (local and --url) and the RAI-317 probes. Spawned as a subprocess (cli.ts runs its command at
// module load). No case loads the E5 model: each one refuses, embeds nothing, or goes over --url to an
// in-process `funes serve` with a fake embedder. The op verbs' own mapping is in cli-ops.test.ts.

const CLI = join(import.meta.dir, "cli.ts");
const REPO = resolve(import.meta.dir, "..", "..", "..");

/** Spawn the CLI against a PREPARED vault + index base (no --vault when `vault` is null). Both pipes
 *  are drained concurrently — a child that fills one while the test reads the other deadlocks. */
async function spawnCli(cmd: string, args: string[], o: { vault: string | null; funesHomeDir: string; env?: Record<string, string> }): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", CLI, cmd, ...args, ...(o.vault === null ? [] : ["--vault", o.vault])], {
    cwd: REPO,
    env: { ...process.env, FUNES_HOME: o.funesHomeDir, ...o.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, out, err };
}

/** A throwaway vault and index base around one spawn. `prepare` may arrange either before the CLI
 *  runs — the sync-root cases plant a marker in the base, which only makes sense once its path and
 *  the vault's basename are known. */
async function run(
  cmd: string, args: string[], prepare?: (vault: string, funesHomeDir: string) => void, env?: Record<string, string>,
): Promise<{ code: number; err: string; homes: string[] }> {
  const vault = mkdtempSync(join(tmpdir(), "funes-cli-"));
  // PLAN-0.3.0 P0.3: the CLI's index home is `$FUNES_HOME/libsql/<vault basename>/`, and the default
  // funes home is the REAL `~/.funes`. Unset, every spawn here stamped an owner marker and an
  // index.db into a permanent home named after a vault that this function deletes two lines later —
  // 61 orphaned `funes-cli-*` directories by 0.3.0. Nothing in the CLI can clean that up: for a real
  // vault the same directory is the durable index and must outlive the process. So the fix is to
  // stop pointing a throwaway vault at the real base — the pattern mcp-boundary.test.ts already uses.
  const funesHomeDir = mkdtempSync(join(tmpdir(), "funes-cli-idx-"));
  prepare?.(vault, funesHomeDir);
  const { code, err } = await spawnCli(cmd, args, { vault, funesHomeDir, env });
  // Read before the rm: `homes` is the evidence that the override was honored — the leak was
  // invisible precisely because it landed outside every directory this file owns.
  const homes = existsSync(join(funesHomeDir, "libsql")) ? readdirSync(join(funesHomeDir, "libsql")) : [];
  rmSync(vault, { recursive: true, force: true });
  rmSync(funesHomeDir, { recursive: true, force: true });
  return { code, err, homes };
}
const reindex = (args: string[]) => run("reindex", args);

// The uncaught handler brands every message `funes: `, and sixteen throw sites already brand their
// own (they surface through MCP/daemon/face too, which have no wrapper). The one hard failure this
// artifact has therefore opened "funes: funes: could not load the embedding model …". `forget` on a
// foreign id is the cheapest of the sixteen to reach — it throws in assertOwned, before anything
// touches the embedder — and it exercises the same shared handler.
test("a throw that brands itself is not branded twice — one `funes: `, never two", async () => {
  // An empty HOME: on a machine whose real home is legacy, the item-6 deprecation line (one more
  // `funes: `) would count here — it is a second line, not a second brand.
  const home = mkdtempSync(join(tmpdir(), "funes-cli-home-"));
  const { code, err, homes } = await run("forget", ["some/foreign-id"], undefined, { HOME: home });
  rmSync(home, { recursive: true, force: true });
  expect(code).toBe(2); // the op's refusal is `invalid` (RAI-317 Q5)
  expect(err).toBe('funes forget: refusing to mutate "some/foreign-id" — only items under out_memory/ are mutable.\n');
  // `forget` is the only case in this file that opens a store, so it is the only one that stamps an
  // index home — which makes it the temp-directory-leak regression too. Exactly one home, under the
  // base `run` owns. Drop FUNES_HOME from the spawn env and this reads [] while the home
  // reappears in ~/.funes/libsql.
  expect(homes).toHaveLength(1);
  expect(homes[0]).toStartWith("funes-cli-");
}, 20_000);

// RAI-327 (RAI-306 Q4): the scope bypass is gone. The flag refuses at parse, never silently unread.
test("reindex: --ignore-scope refuses as a retired flag", async () => {
  const { code, err } = await reindex(["--ignore-scope"]);
  expect(code).toBe(2);
  expect(err).toContain("--ignore-scope was removed in funes 0.6.0 — index_scope always applies");
}, 20_000);

test("reindex: --max refuses as a retired flag (RAI-314: a build resumes at its cursor)", async () => {
  const { code, err } = await reindex(["--max", "5"]);
  expect(code).toBe(2);
  expect(err).toContain("--max was removed in funes 0.6.0 — a build resumes where it stopped");
}, 20_000);

// P1.7: --as-of REFUSES garbage rather than dropping it (a dropped date records the memory as
// never-stale). Since RAI-317 the op's own zod is the one gate: the refusal is `invalid`, exit 2,
// before anything is written or embedded.
test("remember/supersede: --as-of rejects an unparseable date through the op's argument gate, exit 2", async () => {
  for (const cmd of ["remember", "supersede"]) {
    const { code, err } = await run(cmd, [...(cmd === "supersede" ? ["out_memory/old"] : []), "--title", "T", "--body", "b", "--as-of", "banana"]);
    expect(code).toBe(2);
    expect(err).toContain("as_of must be an ISO-8601 date");
  }
}, 30_000);

// 0.3.0 item 23 at the PUBLISHER. `makeStore` is not the only construction point — `publish` opens
// libsql directly (its own `open` closure) and so does the servability check underneath it, so both
// skipped the guard entirely. The HOME is what is guarded, not just published.db: the build, the
// swap and every reader's open live inside it, and a provider copying that directory tears them all.
test("publish: a publication HOME inside a sync root refuses — before an embedder is constructed", async () => {
  // The marker as Syncthing writes it, at the root of the funes home the publication home derives from.
  const { code, err } = await run("publish", [], (_vault, base) => writeFileSync(join(base, ".stfolder"), ""));
  expect(code).toBe(1);
  expect(err).toContain("refusing to open an index inside a Syncthing root");
  expect(err).toContain("DERIVED"); // the repair, not just the refusal
}, 20_000);

// RAI-306 Q3 + Q7: `republish` merged into `publish` / `publish --force`, and `--retain-prior` went
// with the pins. Both fail as unknown, exit 2, before any model is loaded (an EMPTY model dir).
test("`funes republish`, `publish --retain-prior` and `publish --home` fail at parse, before any model is loaded", async () => {
  const home = mkdtempSync(join(tmpdir(), "funes-republish-gone-"));
  const fhome = mkdtempSync(join(tmpdir(), "funes-republish-nomodel-"));
  const models = join(fhome, "models");
  const gone = await run("republish", [], undefined, { FUNES_HOME: fhome });
  expect(gone.code).toBe(2);
  expect(gone.err).toContain('unknown command "republish"');
  const flag = await run("publish", ["--retain-prior", "24h"], undefined, { FUNES_HOME: fhome });
  expect(flag.code).toBe(2);
  expect(flag.err).toContain("unknown flag --retain-prior");
  const homeFlag = await run("publish", ["--home", home], undefined, { FUNES_HOME: fhome });
  expect(homeFlag.code).toBe(2);
  expect(homeFlag.err).toContain("--home was removed in funes 0.6.0 — the index home comes from the vault");
  expect(existsSync(models) ? readdirSync(models) : []).toEqual([]);
  rmSync(home, { recursive: true, force: true });
  rmSync(fhome, { recursive: true, force: true });
}, 20_000);

// 0.3.0 item 23 at the OTHER THREE direct opens in cli.ts. `eval --draft`, `eval` and `doctor` each
// hand LibsqlStore.create a path of their own, so none inherits makeStore's guard and each carries
// its own assertIndexNotInSyncRoot call — three lines that, until these tests, nothing held. In all
// three verbs the guard sits BEFORE `new E5Embedder()` and before the open. The refusal TEXT is what
// proves the ordering: with the guard line deleted each verb goes on to open the path read-only and
// dies on a DIFFERENT message ("cannot open index read-only" for a missing file, "not a funes index"
// for the empty one doctor is handed) — the exit code is 1 either way, so only the text can tell the
// two apart. Each was confirmed to fail exactly that way with its line removed.
test("eval --draft: a live index inside a sync root refuses before the store is opened", async () => {
  const { code, err } = await run("eval", ["--draft"], (_vault, base) => writeFileSync(join(base, ".stfolder"), ""));
  expect(code).toBe(1);
  expect(err).toContain("refusing to open an index inside a Syncthing root");
}, 20_000);

test("eval: a live index inside a sync root refuses before the store is opened", async () => {
  const home = mkdtempSync(join(tmpdir(), "funes-eval-sync-"));
  // A fixture that passes validateFixture, so the refusal is the guard's and not the validator's.
  const fixture = join(home, "fixture.json");
  writeFileSync(fixture, JSON.stringify({
    vault: "synthetic", k: 5,
    thresholds: { pAtK: 0.5, mrr: 0.5, negativeRate: 0.5, unseenPAtK: 0.5 },
    cases: [{ id: "c1", query: "which page answers this", relevant: ["wiki/a"], split: "unseen" }],
  }));
  const { code, err } = await run("eval", ["--fixture", fixture], (vault, base) => {
    writeFileSync(join(base, ".stfolder"), "");
    // index.db's existence is all the verb reads before the guard; it never has to be a database.
    mkdirSync(join(base, "libsql", basename(vault)), { recursive: true });
    writeFileSync(join(base, "libsql", basename(vault), "index.db"), "");
  });
  expect(code).toBe(1);
  expect(err).toContain("refusing to open an index inside a Syncthing root");
  rmSync(home, { recursive: true, force: true });
}, 20_000);

// RAI-303: the taste pieces left funes. `replica`, `outbox` and `seed` are unknown verbs (exit 2, no
// hint at where they went: a retired name is not a pointer), and `eval --taste` is an unknown flag,
// refused before anything opens, so no unpinned taste baseline runs here (taste-bot's
// scripts/taste-eval.ts holds the pins).
test("replica, outbox and seed are unknown verbs: exit 2 and no retired-name hint", async () => {
  for (const verb of ["replica", "outbox", "seed"]) {
    const { code, err, homes } = await run(verb, ["--once"]);
    expect({ verb, code }).toEqual({ verb, code: 2 });
    expect(err).toContain(`unknown command "${verb}"`);
    expect(err).not.toMatch(/funes-cf|replica\/cli|taste-bot|retired/);
    expect(homes).toEqual([]);
  }
}, 20_000);

test("eval --taste is a retired flag: exit 2 before anything opens", async () => {
  const { code, err } = await run("eval", ["--taste", "core", "--fixture", "/nonexistent.json"]);
  expect(code).toBe(2);
  expect(err).toContain("--taste was removed in funes 0.6.0");
  expect(err).not.toContain("no fixture");
}, 20_000);

test("doctor: a live index inside a sync root refuses before the store is opened", async () => {
  const { code, err } = await run("doctor", [], (vault, base) => {
    writeFileSync(join(base, ".stfolder"), "");
    // The verb checks the file EXISTS before it reaches the guard; an empty file satisfies that and
    // is not a funes index, so an open past the guard cannot masquerade as this refusal.
    mkdirSync(join(base, "libsql", basename(vault)), { recursive: true });
    writeFileSync(join(base, "libsql", basename(vault), "index.db"), "");
  });
  expect(code).toBe(1);
  expect(err).toContain("refusing to open an index inside a Syncthing root");
}, 20_000);

// RAI-327 (RAI-306): the machine-state file and the instance-id stamp are gone. A full reindex
// writes nothing under the state root and stamps no instance id; `doctor --json` still carries the
// one operator state (item 20), without a `machineState` field. An EMPTY vault is enough: a full run
// over zero files still prunes and finalizes a generation, and embeds nothing.
test("reindex writes no machine state and no instance id; doctor --json audits the live index and reports operator state without machineState", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-cli-state-vault-"));
  const funesHomeDir = mkdtempSync(join(tmpdir(), "funes-cli-state-idx-"));
  const stateRoot = join(funesHomeDir, "state");
  try {
    writeFileSync(join(vault, "star.yaml"), 'memory:\n  index_scope:\n    exclude:\n      - "raw/**"\n');
    const r = await spawnCli("reindex", [], { vault, funesHomeDir });
    expect(r.code).toBe(0);
    expect(r.out).toContain("reindex complete: 0 files");
    expect(existsSync(stateRoot) ? readdirSync(stateRoot) : []).toEqual([]);
    const db = new Database(join(funesHomeDir, "libsql", basename(vault), "index.db"), { readonly: true });
    expect(db.query("select value from meta where key='instance_id'").get()).toBeNull();
    db.close();

    type Doctor = { state: Record<string, unknown> };
    const doc = await spawnCli("doctor", ["--json"], { vault, funesHomeDir, env: { FUNES_LOCUS: " Host-A " } });
    expect(doc.code).toBe(0);
    expect(JSON.parse(doc.out)).toMatchObject({ db: "live", verified: false }); // the live index is the default (RAI-317)
    const s = (JSON.parse(doc.out) as Doctor).state;
    expect(s.schemaVersion).toBeTruthy();
    expect(s.buildState).toBe("built");
    expect(s.contentGeneration).toBeTruthy(); // RAI-308: doctor --json state = contractState + the operator fields
    expect("generationValid" in s).toBe(false);
    expect(s.builtScopeHash).toBe(scopeHash(["raw/**"]));
    expect(s.scopeMatches).toBe(true);
    expect(s.locus).toBe("host-a");
    expect("machineState" in s).toBe(false);
  } finally {
    for (const d of [vault, funesHomeDir]) rmSync(d, { recursive: true, force: true });
  }
}, 60_000);
// ── 0.4.0 item 7 (RAI-129) on the CLI: a Syncthing conflict copy is a finding, never a page ─────
// Each vault holds ONLY a conflict copy and declares no star.yaml glob, so the structural skip is
// the one thing between the copy and the index. With it, nothing is embedded and no model loads.
// Without it, the CLI would embed the copy: the model cache is an empty dir and every fetch goes to
// a dead proxy, so a regression fails in seconds instead of downloading 135MB. Models, locks and
// machine state live under the scratch FUNES_HOME — never the real ~/.funes.
const COPY = "notes.sync-conflict-20260909-120000-ABCDEFG.md";
function conflictOnlyVault(zone = ""): { vault: string; funesHomeDir: string; env: Record<string, string>; dirs: string[] } {
  const vault = mkdtempSync(join(tmpdir(), "funes-cli-conflict-vault-"));
  const funesHomeDir = mkdtempSync(join(tmpdir(), "funes-cli-conflict-idx-"));
  if (zone) mkdirSync(join(vault, zone));
  writeFileSync(join(vault, zone, COPY), "---\ntitle: Notes\n---\nthe other locus's edit");
  const env = {
    HTTPS_PROXY: "http://127.0.0.1:1", HTTP_PROXY: "http://127.0.0.1:1", NO_PROXY: "",
  };
  return { vault, funesHomeDir, env, dirs: [vault, funesHomeDir] };
}

// RAI-327 (RAI-306): the finding is the on-disk half only. A conflict row planted in the index (the
// pre-0.4.0 residue the indexed half used to name) is not reported.
test("reindex skips a planted conflict copy with no glob; doctor names it on disk and reports no indexed half", async () => {
  const { vault, funesHomeDir, env, dirs } = conflictOnlyVault();
  const ROW = "wiki/rag.sync-conflict-20260909-120000-ABCDEFG";
  try {
    const r = await spawnCli("reindex", [], { vault, funesHomeDir, env });
    expect(r.code).toBe(0);
    expect(r.out).toContain("reindex complete: 0 files");
    const db = new Database(join(funesHomeDir, "libsql", basename(vault), "index.db"));
    db.query("insert into nodes(id, path, title, type, body) values (?, ?, 'RAG', 'page', 'the other edit')").run(ROW, `${ROW}.md`);
    db.close();
    const json = await spawnCli("doctor", ["--json"], { vault, funesHomeDir, env });
    expect(json.code).toBe(0); // a finding, never an exit code
    expect((JSON.parse(json.out) as { syncConflicts: unknown }).syncConflicts).toEqual({ onDisk: [COPY] });
    const text = await spawnCli("doctor", [], { vault, funesHomeDir, env });
    expect(text.code).toBe(0);
    expect(text.out).toContain(`SYNC CONFLICTS: 1 on disk — `);
    expect(text.out).toContain(`      ${COPY}`);
    expect(text.out).not.toContain("indexed (");
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
}, 60_000);

// ── 0.4.0 item 11 (RAI-134) on the CLI: `vault.unparsed` is a walk of the indexed scope, not the rows ─
// The index is built over an EMPTY vault (no model loads) and the pages are dropped in after — which
// is also the point: doctor names them though no row describes them. A page the tolerant retry
// recovers is not named, and a broken page outside index_scope is not either.
test("doctor names the pages whose frontmatter does not parse, as vault.unparsed — the scope walked now", async () => {
  const { vault, funesHomeDir, env, dirs } = conflictOnlyVault();
  try {
    rmSync(join(vault, COPY));
    writeFileSync(join(vault, "star.yaml"), 'memory:\n  index_scope:\n    exclude:\n      - "raw/**"\n');
    expect((await spawnCli("reindex", [], { vault, funesHomeDir, env })).code).toBe(0);
    mkdirSync(join(vault, "wiki"));
    mkdirSync(join(vault, "raw"));
    for (let i = 1; i <= 6; i++) writeFileSync(join(vault, `wiki/broken-${i}.md`), "---\ntitle: a: b\n---\nbody");
    writeFileSync(join(vault, "wiki/obsidian.md"), "---\ntitle: Obs\ntags: [#a]\nrelated: [[x]], [[y]]\n---\nbody");
    writeFileSync(join(vault, "raw/broken.md"), "---\ntitle: a: b\n---\nout of scope");
    const json = await spawnCli("doctor", ["--json"], { vault, funesHomeDir, env });
    expect(json.code).toBe(0); // a finding, never an exit code
    // six pages: the count is all of them, `first` the first five in walk order
    expect((JSON.parse(json.out) as Record<string, unknown>)["vault.unparsed"]).toEqual({
      count: 6, first: ["wiki/broken-1", "wiki/broken-2", "wiki/broken-3", "wiki/broken-4", "wiki/broken-5"],
    });
    const text = await spawnCli("doctor", [], { vault, funesHomeDir, env });
    expect(text.out).toContain("VAULT UNPARSED: 6 page(s) whose frontmatter does not parse");
    expect(text.out).toContain("      wiki/broken-5\n      … 1 more");
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
}, 60_000);

// ── 0.5.0 item 20 (ADR-0012) on the CLI: doctor reports the OKF counters a FULL reindex stamped ──
// No page in the fixture is indexed — the malformed one is skipped, the tombstone never enters, the
// reserved files are checked only — so nothing embeds and no model loads.
test("doctor reports okf_nonconformant and okf_malformed from the full build, in JSON and in text", async () => {
  const { vault, funesHomeDir, env, dirs } = conflictOnlyVault();
  try {
    rmSync(join(vault, COPY));
    mkdirSync(join(vault, "wiki"));
    writeFileSync(join(vault, "wiki/broken.md"), "---\ntitle: a: b\n---\nbody");                  // malformed
    writeFileSync(join(vault, "wiki/gone.md"), "---\ntitle: Gone\nforgotten: true\n---\nbody");  // no `type`
    writeFileSync(join(vault, "wiki/index.md"), "---\nkind: index\n---\n# Wiki\n");             // reserved, out of shape
    writeFileSync(join(vault, "log.md"), "## 2026-10-13\n- one\n");                             // reserved, in shape
    const r = await spawnCli("reindex", [], { vault, funesHomeDir, env });
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 unparsed");
    const json = await spawnCli("doctor", ["--json"], { vault, funesHomeDir, env });
    expect(json.code).toBe(0); // a finding, never an exit code
    expect((JSON.parse(json.out) as { state: { okf: unknown } }).state.okf).toEqual({ nonconformant: 3, malformed: 1 });
    expect((await spawnCli("doctor", [], { vault, funesHomeDir, env })).out).toContain("    okf nonconformant 3   malformed 1");
    // `memory.okf: false`: the next full build counts nothing, and doctor says the star opted out
    writeFileSync(join(vault, "star.yaml"), "memory:\n  okf: false\n");
    expect((await spawnCli("reindex", [], { vault, funesHomeDir, env })).code).toBe(0);
    expect((await spawnCli("doctor", [], { vault, funesHomeDir, env })).out).toContain("    okf not counted");
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
}, 60_000);

// ── 0.3.0 items 24 + 25 on the CLI (RAI-148): the six mutators' startup ─────────────────────────
// The designation and the actor are resolved BEFORE the store is opened, so a bad value is a
// startup refusal rather than a throw after stdin was read. `homes` is the proof of "before": an
// opened store stamps an index home, and the base stays empty.
test("RAI-310 D1/D9: --actor and the other retired flags refuse on a verb at STARTUP, naming the replacement, before a store is opened", async () => {
  for (const [flag, replacement] of [["--actor", "the grant names the actor"], ["--readonly", "--ops"], ["--capability", "--access"], ["--actor-map", "--access"]] as const) {
    const { code, err, homes } = await run("remember", ["--title", "T", "--body", "x", flag, "v"]);
    expect(code, flag).toBe(2);
    expect(err).toContain(`${flag} was removed in funes 0.6.0`);
    expect(err).toContain(replacement);
    expect(homes).toEqual([]); // refused before the open — nothing was stamped
  }
}, 30_000);

// RAI-304: no op hard-deletes. `funes purge` is the only hard delete; `forget --hard` refuses naming it,
// before any store opens, and `link` is no verb at all.
test("forget --hard refuses naming funes purge; link is an unknown command", async () => {
  const hard = await run("forget", ["out_memory/a", "--hard"]);
  expect(hard.code).toBe(2);
  expect(hard.err).toContain("`funes purge <id>` is the hard delete");
  expect(hard.homes).toEqual([]);
  const link = await run("link", ["out_memory/a", "out_memory/b"]);
  expect(link.code).toBe(2);
  expect(link.err).toContain('unknown command "link"');
}, 30_000);

// RAI-302: the locus is the process's (FUNES_LOCUS over the short hostname), never a flag: `--locus`
// refuses on every verb, naming FUNES_LOCUS, before any store is opened (eval's too, RAI-317 C4).
test("--locus refuses on remember, supersede, forget, purge, doctor, okf normalize and eval, naming FUNES_LOCUS", async () => {
  const cases: Array<[cmd: string, args: string[]]> = [
    ["remember", ["--title", "T", "--body", "x"]],
    ["supersede", ["out_memory/a", "--title", "T", "--body", "x"]],
    ["forget", ["out_memory/a"]],
    ["purge", ["out_memory/a"]],
    ["doctor", []],
    ["okf", ["normalize", "--apply"]],
    ["eval", ["--baseline"]],
  ];
  for (const [cmd, args] of cases) {
    const { code, err, homes } = await run(cmd, [...args, "--locus", "host-a"]);
    expect({ cmd, code, named: err.includes("--locus was removed in funes 0.6.0 — the locus is FUNES_LOCUS") }).toEqual({ cmd, code: 2, named: true });
    expect(homes).toEqual([]);
  }
}, 60_000);

// PLAN-0.4.0 item 10: a refused locus is a usage error at startup — exit 2 before any store is opened
// (`homes` stays empty) — on doctor, on a mutator and on the per-star stdio server.
test("a refused locus exits 2 at startup: doctor, the mutators and the stdio MCP", async () => {
  const doctor = await run("doctor", [], undefined, { FUNES_LOCUS: "a@b" });
  expect(doctor.code).toBe(2);
  expect(doctor.err).toContain('FUNES_LOCUS "a@b" carries "@"');
  expect(doctor.homes).toEqual([]);
  const remember = await run("remember", ["--title", "T", "--body", "x"], undefined, { FUNES_LOCUS: "host/a" });
  expect(remember.code).toBe(2);
  expect(remember.err).toContain('FUNES_LOCUS "host/a" carries "/"');
  expect(remember.homes).toEqual([]);
  // the per-star server: the environment, before the store opens; `--locus` is retired (RAI-305)
  const mcpEnv = await run("mcp", [], undefined, { FUNES_LOCUS: "a@b" });
  expect(mcpEnv.code).toBe(2);
  expect(mcpEnv.err).toContain('FUNES_LOCUS "a@b" carries "@"');
  expect(mcpEnv.homes).toEqual([]);
  const mcpFlag = await run("mcp", ["--locus", "host-a"]);
  expect(mcpFlag.code).toBe(2);
  expect(mcpFlag.err).toContain("--locus was removed in funes 0.6.0 — the locus is FUNES_LOCUS");
  expect(mcpFlag.homes).toEqual([]);
}, 60_000);

// RAI-329 (RAI-306 Q19): the hub is gone. Both of its spellings — `--hub` and the `--stars-file`
// that twinkl.ing's derived `.mcp.hub.json` passed — are retired flags (RAI-310 D1): they fail at
// startup and name the replacement, rather than falling through to a per-star server.
test("funes mcp --hub, --stars-file and eval --hub exit 2 naming the hub's removal in 0.6.0", async () => {
  for (const [cmd, args] of [["mcp", ["--hub"]], ["mcp", ["--stars-file", "/nonexistent/stars.json"]], ["eval", ["--hub", "/nonexistent/stars.json"]]] as const) {
    const r = await run(cmd, [...args]);
    expect({ cmd, args, code: r.code }).toEqual({ cmd, args, code: 2 });
    expect(r.err).toContain(`${args[0]} was removed in funes 0.6.0 — the hub went with the generation manifest`);
    expect(r.homes).toEqual([]);
  }
}, 60_000);

// RAI-302: a decision is allowed or refused, and an allowed one is silent — the per-write audit line
// is gone. `forget` on a foreign id is the cheapest mutator to drive: the write rule allows it (the
// star declares no writer), and assertOwned refuses before any embed, so stderr holds that refusal
// and nothing else.
test("mutators: an allowed write rule decision prints nothing — stderr is the op's own refusal alone", async () => {
  const { code, err } = await run("forget", ["some/foreign-id"], undefined, { FUNES_LOCUS: "host-b" });
  expect(code).toBe(2);
  expect(err.trim().split("\n")).toEqual([expect.stringContaining("funes forget: refusing to mutate")]);
}, 20_000);

// ── 0.3.0 item 16 + the paired open on the CLI (RAI-148) ────────────────────────────────────────

/** The real E5Embedder's IDENTITY over a fake's arithmetic. `embeddingSignature` reads id, dim,
 *  revision, dtype, pooling, truncation, forward width, platform, arch, isa class and onnxruntime version — all
 *  inherited — so an index this builds carries exactly
 *  the signature the spawned CLI's real E5Embedder expects at open. The model is loaded on NEITHER
 *  side: here the three embed methods are overridden, and in the child a scope REFUSAL fires before
 *  the retrieval that would embed the query. A served (non-refused) query would load it, which is
 *  why every spawn below asserts a refusal. */
class SpoofedE5 extends E5Embedder {
  private fakeVec(t: string): Float32Array {
    const v = new Float32Array(E5_DIM);
    for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) v[[...w].reduce((a, c) => a + c.charCodeAt(0), 0) % E5_DIM]! += 1;
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i]! /= n;
    return v;
  }
  override async embedQuery(t: string) { return this.fakeVec(t); }
  override async embedPassage(t: string) { return this.fakeVec(t); }
  override async embedPassages(ts: string[]) { return ts.map((t) => this.fakeVec(t)); }
}

const SCOPE_BUILT = "memory:\n  index_scope:\n    exclude:\n      - 'raw/**'\n";
const SCOPE_NARROWED = "memory:\n  index_scope:\n    exclude:\n      - 'raw/**'\n      - 'secrets/**'\n";

/** A vault + isolated index base, with the CLI's default home for that vault. */
function prepared(starYaml: string): { vault: string; funesHomeDir: string; home: string; cleanup: () => void } {
  const vault = mkdtempSync(join(tmpdir(), "funes-cli-guard-"));
  writeFileSync(join(vault, "star.yaml"), starYaml);
  const funesHomeDir = mkdtempSync(join(tmpdir(), "funes-cli-guard-idx-"));
  const home = join(funesHomeDir, "libsql", basename(vault)); // funesDbDir's dirname under this funes home
  return { vault, funesHomeDir, home, cleanup: () => { rmSync(vault, { recursive: true, force: true }); rmSync(funesHomeDir, { recursive: true, force: true }); } };
}

/** One indexed page under the built scope, stamped as the publisher would stamp it. */
async function buildIndex(dbPath: string, opts: { generation?: string; starId?: string; finalize?: boolean } = {}): Promise<void> {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const store = await LibsqlStore.create(new SpoofedE5(), dbPath);
  await store.remember([{ id: "wiki/keep", path: "wiki/keep.md", title: "Keep", body: "alpha kept tokens", trust: "trusted" }]);
  await store.setScopeSignature({ hash: scopeHash(["raw/**"]), ignoreScope: false });
  if (opts.starId) await store.setOwnerStarId(opts.starId);
  if (opts.generation) await store.finalizeReindex({ contentGeneration: opts.generation });
  if (opts.finalize) await store.finalizeForPublish(); // journal_mode=DELETE, as published.db is
  await store.close();
  if (opts.finalize) chmodSync(dbPath, 0o444);
}

// The local op path (RAI-317): `funes recall` goes through dispatchToolCall, so the scope guard every
// MCP client meets is the CLI's too — a star.yaml narrowed since the build refuses with the MCP
// message, `out-of-scope`, exit 3, before any embedding.
test("recall: a star.yaml narrowed after the build refuses with the MCP message and exit 3 — before any embedding", async () => {
  const p = prepared(SCOPE_BUILT);
  try {
    await buildIndex(join(p.home, "index.db"));
    writeFileSync(join(p.vault, "star.yaml"), SCOPE_NARROWED); // narrowed, not reindexed
    const { code, out, err } = await spawnCli("recall", ["alpha kept tokens", "--json"], p);
    expect(code).toBe(3);
    expect(err).toContain("scope-hash mismatch"); // scopeRefusalReason's wording — the same string the MCP op throws
    expect(out).toBe(""); // the --json contract prints no partial result on a refusal
  } finally { p.cleanup(); }
}, 30_000);

// `funes eval --published` opens <home>/published.db (its owner checked against star.yaml) and scores
// recalls through it; the generation it reports is the one stamped in those bytes, and the guarded
// read refuses a narrowed scope (exit 3). Without --published it reads the live index (RAI-317 Q6).
test("eval --published: published.db is scored under its own generation; the default reads the live index; a narrowed scope refuses", async () => {
  const p = prepared(`meta:\n  id: git://example.org/ev\n${SCOPE_BUILT}`);
  try {
    const manifest = { generation: `${GENERATION_VERSION}:` + "f".repeat(64) };
    await buildIndex(join(p.home, "published.db"), { generation: manifest.generation, starId: "git://example.org/ev", finalize: true });
    // The fixture the eval scores; at the default path, so the spawn needs no --fixture.
    mkdirSync(join(p.vault, "out", "out_eval"), { recursive: true });
    // Pretty-printed, as --draft writes it, so a hash over RE-SERIALISED bytes cannot pass for one
    // over the bytes as read.
    const fixturePath = join(p.vault, "out", "out_eval", "recall-eval.json");
    writeFileSync(fixturePath, JSON.stringify({
      vault: "test", k: 5, thresholds: { pAtK: 0, mrr: 0, negativeRate: 1, unseenPAtK: 0 },
      cases: [{ id: "c1", query: "alpha kept tokens", relevant: ["wiki/keep"], split: "unseen" }],
    }, null, 2) + "\n");
    // PLAN-0.4.0 item 17: the --json document the release gate parses, off the real wiring — the
    // pure evalJson is tested in recall-eval.test.ts, and nothing else spawns `eval --json` to exit.
    const live = await spawnCli("eval", ["--json"], p);
    expect(live.code).toBe(2);
    expect(live.err).toContain("eval: no live index at"); // the default is the live index, and there is none
    const ok = await spawnCli("eval", ["--published", "--json"], p);
    expect(ok.code).toBe(0);
    const doc = JSON.parse(ok.out.split("\n").reverse().find((l) => l.startsWith("{"))!);
    expect(doc).not.toHaveProperty("publicationId"); // RAI-306 Q9: no publication id is reported
    expect(doc.generation).toBe(manifest.generation);
    expect(doc.fixtureSha256).toBe(createHash("sha256").update(readFileSync(fixturePath)).digest("hex")); // the bytes as read
    expect(doc.cases[0].returned).toEqual(["wiki/keep"]);
    expect(doc.cases[0].scores).toHaveLength(1); // one fused score per returned id
    // What a publish of this vault would stamp: its scope signature included, and not the stamped one.
    expect(doc.vaultGeneration).toBe(computeTargetGeneration(p.vault, {
      embedder: new E5Embedder(), scopeSignature: { hash: scopeHash(["raw/**"]), ignoreScope: false },
    }));
    expect(doc.vaultGeneration).not.toBe(manifest.generation);

    // PLAN-0.5.0 item 25: --baseline writes THIS locus's file beside the fixture, never into it, and
    // a later run at the same locus re-reads it.
    const fixtureBefore = readFileSync(fixturePath);
    // RAI-302: no --locus — the file is keyed on the resolved locus (FUNES_LOCUS here).
    const base = await spawnCli("eval", ["--published", "--baseline"], { ...p, env: { FUNES_LOCUS: "host-a" } });
    expect(base.code).toBe(0);
    const baselineFile = join(p.vault, "out", "out_eval", "recall-eval.baseline.host-a.json");
    expect(JSON.parse(readFileSync(baselineFile, "utf8"))).toMatchObject({
      format: 1, locus: "host-a", generation: manifest.generation, fixtureSha256: doc.fixtureSha256,
      signature: { embedding: expect.stringContaining("multilingual-e5-small"), serving: "libsql:rank/2" },
      triples: { c1: [["wiki/keep", 1, doc.cases[0].scores[0]]] },
    });
    expect(readFileSync(fixturePath)).toEqual(fixtureBefore);
    const reread = await spawnCli("eval", ["--published"], { ...p, env: { FUNES_LOCUS: "host-a" } });
    expect(reread.code).toBe(0);
    expect(reread.out).toContain("IDENTICAL");
    // …and with FUNES_LOCUS unset the resolved locus is the short hostname, as `hostname -s` names it.
    const short = Bun.spawnSync(["hostname", "-s"]).stdout.toString().trim().toLowerCase();
    const byHost = await spawnCli("eval", ["--published", "--baseline"], { ...p, env: { FUNES_LOCUS: undefined as unknown as string } });
    expect(byHost.code).toBe(0);
    expect(JSON.parse(readFileSync(join(p.vault, "out", "out_eval", `recall-eval.baseline.${short}.json`), "utf8")).locus).toBe(short);

    writeFileSync(join(p.vault, "star.yaml"), `meta:\n  id: git://example.org/ev\n${SCOPE_NARROWED}`);
    const refused = await spawnCli("eval", ["--published"], p);
    expect(refused.code).toBe(3);
    expect(refused.err).toContain("scope-hash mismatch");
  } finally { p.cleanup(); }
}, 90_000);

// RAI-306 Q19: `doctor --published` audits <home>/published.db, and the owner stamped in its bytes
// must be star.yaml's meta.id — the only identity that travels with a copied file.
test("doctor --published audits published.db under star.yaml's id; nothing published names `funes publish`; a foreign owner refuses", async () => {
  const p = prepared(`meta:\n  id: git://example.org/doc\n${SCOPE_BUILT}`);
  try {
    const none = await spawnCli("doctor", ["--published", "--json"], p);
    expect(none.code).toBe(1);
    expect(none.err).toContain(`run \`funes publish --vault ${p.vault}\``);
    const generation = `${GENERATION_VERSION}:` + "d".repeat(64);
    await buildIndex(join(p.home, "published.db"), { generation, starId: "git://example.org/doc", finalize: true });
    const ok = await spawnCli("doctor", ["--published", "--json"], p);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toMatchObject({ db: "published", generation, verified: true, source: join(p.home, "published.db") });
    rmSync(join(p.home, "published.db"), { force: true });
    await buildIndex(join(p.home, "published.db"), { generation, starId: "git://example.org/other", finalize: true });
    const foreign = await spawnCli("doctor", ["--published", "--json"], p);
    expect(foreign.code).toBe(1);
    expect(foreign.err).toContain('carries star identity "git://example.org/other"');
  } finally { p.cleanup(); }
}, 60_000);

// PLAN-0.5.0 item 22 (ADR-0012 §The decision): the exporter retired, and its one live duty — the
// share-clean gate — is `funes scan`: the secret detectors over the INDEX SCOPE, read-only. A planted
// secret fails it; the same secret in an excluded path does not, because the scope is what travels.
/** Twelve BIP39 words in a row — what the seed detector exists to catch, and not a real secret. */
const FAKE_SEED = "abandon ability able about above absent absorb abstract absurd abuse access accident";

test("scan flags a planted secret in the index scope, ignores an excluded one, and writes nothing", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-scan-"));
  const funesHomeDir = mkdtempSync(join(tmpdir(), "funes-scan-idx-"));
  try {
    writeFileSync(join(vault, "star.yaml"), "version: 3\nmemory:\n  index_scope:\n    exclude: [\"private/**\"]\n");
    mkdirSync(join(vault, "wiki"));
    mkdirSync(join(vault, "private"));
    writeFileSync(join(vault, "wiki", "clean.md"), "---\ntitle: Clean\n---\nnothing here\n");
    writeFileSync(join(vault, "private", "keys.md"), `---\ntitle: Keys\n---\n${FAKE_SEED}\n`);
    const tree = () => [...new Bun.Glob("**/*").scanSync({ cwd: vault, dot: true })].sort();
    const before = tree();

    const clean = await spawnCli("scan", [], { vault, funesHomeDir });
    expect(clean.code).toBe(0);
    expect(clean.out).toContain("scan: clean");

    writeFileSync(join(vault, "wiki", "leaky.md"), `---\ntitle: Leaky\n---\nrecovery words: ${FAKE_SEED}\n`);
    const leaky = await spawnCli("scan", [], { vault, funesHomeDir });
    expect(leaky.code).toBe(1);
    expect(leaky.err).toContain("wiki/leaky.md: seed×1");
    expect(leaky.err).not.toContain("private/keys.md");
    expect(leaky.err).not.toContain(FAKE_SEED); // a finding names the file, never the value

    expect(tree()).toEqual([...before, "wiki/leaky.md"].sort()); // read-only: nothing added but the plant
    expect(readdirSync(funesHomeDir)).toEqual([]); // no index home opened
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(funesHomeDir, { recursive: true, force: true });
  }
}, 30_000);

// PLAN-0.5.0 item 21 (ADR-0012 "The conversion"): `funes okf normalize` — the dry run is the lint and
// exits 1 while a nonconformant file remains; `--apply` converts at the write locus and keeps the
// pre-image as a history object; the dry run after it reports 0.
test("okf normalize: dry run -> --apply -> dry run reports 0, with the history objects present", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-okf-"));
  const funesHomeDir = mkdtempSync(join(tmpdir(), "funes-okf-idx-"));
  try {
    writeFileSync(join(vault, "star.yaml"), "meta:\n  id: git://example/okf\n  write_locus: host-a\n");
    mkdirSync(join(vault, "wiki"));
    writeFileSync(join(vault, "wiki", "bare.md"), "# Bare\n");
    writeFileSync(join(vault, "wiki", "untyped.md"), "---\ntitle: Untyped\n---\nbody\n");
    const dry = await spawnCli("okf", ["normalize"], { vault, funesHomeDir });
    expect(dry.code).toBe(1);
    expect(dry.out).toContain("wiki/bare.md  prepend  generation");
    expect(dry.out).toContain("wiki/untyped.md  insert-type  generation");
    expect(dry.out).toContain("okf normalize: 2 file(s) to normalize, 0 refused");

    const away = await spawnCli("okf", ["normalize", "--apply"], { vault, funesHomeDir, env: { FUNES_LOCUS: "host-b" } });
    expect(away.code).toBe(3);
    expect(away.err).toContain('not-write-locus: operation okf-normalize: this locus is not the write locus — the star\'s writer is "host-a"');

    const applied = await spawnCli("okf", ["normalize", "--apply"], { vault, funesHomeDir, env: { FUNES_LOCUS: "host-a" } });
    expect(applied.code).toBe(0);
    expect(applied.out).toContain("okf normalize --apply: 2 file(s) normalized");
    expect(readFileSync(join(vault, "wiki", "bare.md"), "utf8")).toBe("---\ntype: note\n---\n# Bare\n");
    const sha = createHash("sha256").update("# Bare\n").digest("hex");
    expect(readFileSync(join(vault, ".history", "wiki", "bare.md", sha), "utf8")).toBe("# Bare\n");
    expect(readdirSync(join(vault, ".history", "wiki", "untyped.md")).length).toBe(1);

    const again = await spawnCli("okf", ["normalize"], { vault, funesHomeDir });
    expect(again.code).toBe(0);
    expect(again.out).toContain("okf normalize: 0 file(s) to normalize, 0 refused");
    expect(existsSync(join(funesHomeDir, "libsql"))).toBe(false); // no index opened: reindex is its own step
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(funesHomeDir, { recursive: true, force: true });
  }
}, 30_000);

test("the retired `export --okf` is gone from help, and the verb is unknown", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-help-"));
  try {
    const help = await spawnCli("--help", [], { vault, funesHomeDir: vault });
    expect(help.code).toBe(0);
    expect(help.out).toContain("  scan\n");
    expect(help.out).not.toContain("export");
    expect(help.out).not.toContain("--okf");
    const gone = await spawnCli("export", ["--okf"], { vault, funesHomeDir: vault });
    expect(gone.code).toBe(2);
    expect(gone.err).toContain('unknown command "export"');
  } finally { rmSync(vault, { recursive: true, force: true }); }
}, 30_000);

// RAI-332: `publish --rollback [--from <file>]` serves an older build again, through the publish
// swap. A held fence exits 75 (RAI-317), a refusal exits 1, a flag misuse exits 2.
test("publish --rollback: serves .prev, keeps the outgoing build as .prev, refuses a held fence with 75", async () => {
  const p = prepared(`meta:\n  id: git://example.org/rb\n${SCOPE_BUILT}`);
  try {
    const genA = `${GENERATION_VERSION}:` + "a".repeat(64), genB = `${GENERATION_VERSION}:` + "b".repeat(64);
    await buildIndex(join(p.home, "published.db.prev"), { generation: genA, starId: "git://example.org/rb", finalize: true });
    await buildIndex(join(p.home, "published.db"), { generation: genB, starId: "git://example.org/rb", finalize: true });
    const misuse = await spawnCli("publish", ["--from", join(p.home, "published.db.prev")], p);
    expect(misuse.code).toBe(2);
    expect(misuse.err).toContain("--from needs --rollback");
    expect((await spawnCli("publish", ["--rollback", "--force"], p)).code).toBe(2);
    const gen = (f: string) => { const d = new Database(join(p.home, f), { readonly: true }); try { return (d.query("select value from meta where key='generation'").get() as { value: string }).value; } finally { d.close(); } };
    const r = await spawnCli("publish", ["--rollback", "--json"], p);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, rollback: true, generation: genA, home: p.home, from: join(p.home, "published.db.prev") });
    expect([gen("published.db"), gen("published.db.prev")]).toEqual([genA, genB]);
    let release!: () => void;
    const held = withPublishLock(p.home, () => new Promise<void>((res) => { release = res; }));
    const busy = await spawnCli("publish", ["--rollback"], p);
    const busyPublish = await spawnCli("publish", [], p); // a plain publish too: busy is not a failed build
    release();
    await held;
    expect(busy.code).toBe(75);
    expect(busy.err).toContain("already running");
    expect(busyPublish.code).toBe(75);
    expect(busyPublish.err).toContain("already running");
    expect(gen("published.db")).toBe(genA);
    const absent = await spawnCli("publish", ["--rollback", "--from", "nope.db"], p);
    expect(absent.code).toBe(1);
    expect(absent.err).toContain("no rollback target");
  } finally { p.cleanup(); }
}, 60_000);

test("help describes publish --rollback, its refusals and the stop-publish-and-watch condition", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-help-rb-"));
  try {
    const help = await spawnCli("--help", [], { vault, funesHomeDir: vault });
    expect(help.out).toContain("publish --rollback [--from <file>]");
    expect(help.out).toMatch(/holds only while publish and watch are stopped/);
    expect(help.out).toMatch(/refuses.*absent.*served file.*index_scope.*owner.*quick_check/s);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

// ── RAI-317: the op paths and the probes ───────────────────────────────────────────────────────────

// The local op path through the binary: `health` embeds nothing, so a real spawn answers it. --json is
// the MCP answer; the default is YAML of the same object.
test("local op path: `funes health --json` answers the health envelope; the default prints it as YAML", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-cli-health-"));
  const funesHomeDir = mkdtempSync(join(tmpdir(), "funes-cli-health-idx-"));
  try {
    expect((await spawnCli("reindex", [], { vault, funesHomeDir })).code).toBe(0);
    const json = await spawnCli("health", ["--json"], { vault, funesHomeDir, env: { FUNES_LOCUS: "host-a" } });
    expect(json.code).toBe(0);
    expect(json.out).toStartWith("{\n  ");
    expect(JSON.parse(json.out)).toMatchObject({ locus: "host-a", nodes: 0 });
    const yaml = await spawnCli("health", [], { vault, funesHomeDir, env: { FUNES_LOCUS: "host-a" } });
    expect(yaml.out).toContain("locus: host-a\n");
  } finally {
    for (const d of [vault, funesHomeDir]) rmSync(d, { recursive: true, force: true });
  }
}, 30_000);

class FakeEmbedder implements Embedder {
  readonly dim = 16;
  private vec(t: string) {
    const v = new Float32Array(this.dim);
    for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) v[[...w].reduce((a, c) => a + c.charCodeAt(0), 0) % this.dim]! += 1;
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    return v.map((x) => x / n);
  }
  async embedQuery(t: string) { return this.vec(t); }
  async embedPassage(t: string) { return this.vec(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.vec(t)); }
}
const TOKEN = "funes_" + "C".repeat(43);
const serves: RunningServe[] = [];
const scratch: string[] = [];
afterAll(async () => {
  for (const s of serves) await s.close();
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** A loopback `funes serve` (in process, fake embedder) over a star whose writer is `writeLocus`, at the
 *  locus `host-a`, behind an access file whose agent may recall, read health and remember. */
async function served(writeLocus: string): Promise<{ url: string; tokenFile: string; funesHomeDir: string }> {
  const vault = mkdtempSync(join(tmpdir(), "funes-cli-remote-"));
  const funesHomeDir = mkdtempSync(join(tmpdir(), "funes-cli-remote-idx-"));
  scratch.push(vault, funesHomeDir);
  writeFileSync(join(vault, "star.yaml"), `meta:\n  id: git://example.org/remote\n  write_locus: ${writeLocus}\n`);
  const store = await LibsqlStore.create(new FakeEmbedder());
  await store.remember([{ id: "wiki/bread", path: "wiki/bread.md", title: "Bread", body: "sourdough hydration", trust: "trusted" }]);
  await store.finalizeReindex({ contentGeneration: `${GENERATION_VERSION}:` + "e".repeat(64), scope: { hash: scopeHash([]), ignoreScope: false } });
  const access = join(funesHomeDir, "access.json");
  writeFileSync(access, JSON.stringify({
    version: 2,
    roles: { agent: { ops: ["recall", "health", "remember"] } },
    actors: { "cli@host-a": { token_sha256: createHash("sha256").update(TOKEN).digest("hex"), role: "agent", stars: ["*"] } },
  }));
  chmodSync(access, 0o600);
  const tokenFile = join(funesHomeDir, "token");
  writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
  const was = process.env.FUNES_LOCUS;
  process.env.FUNES_LOCUS = "host-a";
  try {
    const s = await startServe({ vault, bind: "127.0.0.1", port: 0, access, store });
    serves.push(s);
    return { url: `${s.url}/mcp`, tokenFile, funesHomeDir };
  } finally {
    if (was === undefined) delete process.env.FUNES_LOCUS; else process.env.FUNES_LOCUS = was;
  }
}

// The --url op path: the same call over HTTP MCP. The answer is the server's; a refusal keeps its code
// across the wire (RAI-310 D4), so a remote not-write-locus exits 3 as a local one does.
test("--url op path: recall answers from the server; a remote not-write-locus exits 3; --url refuses --vault", async () => {
  const s = await served("host-b");
  const remote = (args: string[]) => spawnCli(args[0]!, [...args.slice(1), "--url", s.url, "--token-file", s.tokenFile], { vault: null, funesHomeDir: s.funesHomeDir });
  const r = await remote(["recall", "sourdough", "--json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out).results[0].id).toBe("wiki/bread");
  const w = await remote(["remember", "--title", "-draft", "--body", "- [ ] buy milk"]); // dash values parse
  expect(w.code).toBe(3);
  expect(w.err).toContain("not-write-locus");
  const both = await spawnCli("recall", ["q", "--url", s.url], { vault: s.funesHomeDir, funesHomeDir: s.funesHomeDir });
  expect(both.code).toBe(2);
  expect(both.err).toContain("--url and --vault exclude each other");
}, 30_000);

test("a non-loopback --url without --token-file exits 2 and names the flag, before any connection", async () => {
  const funesHomeDir = mkdtempSync(join(tmpdir(), "funes-cli-nolo-"));
  scratch.push(funesHomeDir);
  const r = await spawnCli("health", ["--url", "https://203.0.113.9/mcp"], { vault: null, funesHomeDir });
  expect(r.code).toBe(2);
  expect(r.err).toContain("is not loopback: name its token with --token-file");
  const clear = await spawnCli("health", ["--url", "http://203.0.113.9/mcp", "--token-file", "/nonexistent"], { vault: null, funesHomeDir });
  expect(clear.code).toBe(2);
  // funes serve answers its exact Host, 127.0.0.1:<port>: a localhost url would only ever get 421
  const named = await spawnCli("health", ["--url", "http://localhost:8787/mcp"], { vault: null, funesHomeDir });
  expect(named.code).toBe(2);
  expect(named.err).toContain("http://127.0.0.1:8787/mcp");
}, 20_000);

// RAI-317 Q12: FUNES_DEBUG is gone and ignored: a set value changes nothing. A user error prints one
// line, never a stack.
test("a set FUNES_DEBUG changes nothing: the same one line, the same exit code", async () => {
  const a = await run("forget", ["some/foreign-id"]);
  const b = await run("forget", ["some/foreign-id"], undefined, { FUNES_DEBUG: "1" });
  const norm = (e: string) => e.replaceAll(/funes-cli-[\w-]+/g, "<tmp>"); // each run has its own temp vault
  expect(b.code).toBe(a.code);
  expect(norm(b.err)).toBe(norm(a.err));
  expect(b.err.trim().split("\n")).toHaveLength(1);
}, 30_000);

// RAI-310 probe 3: a config that still passes --readonly refuses at startup and names --ops.
test("funes mcp --readonly exits 2 and names --ops", async () => {
  const r = await run("mcp", ["--readonly"]);
  expect(r.code).toBe(2);
  expect(r.err).toContain("--readonly was removed in funes 0.6.0 — the tier's ceiling and --ops cover it");
  expect(r.homes).toEqual([]);
}, 20_000);

// taste-bot's scripts/taste-eval.ts spawns `funes eval --fixture <f> --json <flags>`: its flags parse,
// so the answer is about the index (none here), never a usage error about the flags.
test("taste-bot's `eval --fixture … --json` and `eval --baseline --fixture …` parse", async () => {
  const fixture = join(mkdtempSync(join(tmpdir(), "funes-cli-taste-")), "taste-core.json");
  scratch.push(dirname(fixture));
  writeFileSync(fixture, JSON.stringify({
    vault: "taste", k: 5, thresholds: { pAtK: 0.5, mrr: 0.5, negativeRate: 0.5, unseenPAtK: 0.5 },
    cases: [{ id: "c1", query: "q", relevant: ["wiki/a"], split: "unseen" }],
  }));
  for (const args of [["--fixture", fixture, "--json"], ["--baseline", "--fixture", fixture]]) {
    const r = await run("eval", args);
    expect(r.code).toBe(2);
    expect(r.err).toContain("eval: no live index at");
  }
}, 20_000);

// RAI-318 Q1c: a configless NEW star reindexes silently; a star whose index was built under a
// declared scope and whose star.yaml is now gone refuses, and names `--fresh`. Zero pages: no embed.
test("reindex: a configless new star prints no index_scope line; a lost scope refuses and names --fresh", async () => {
  const p = prepared(SCOPE_BUILT);
  try {
    rmSync(join(p.vault, "star.yaml"));
    const first = await spawnCli("reindex", [], p);
    expect(first.code).toBe(0);
    expect(first.err).not.toContain("index_scope");
    expect(first.err).not.toContain("star.yaml");

    writeFileSync(join(p.vault, "star.yaml"), SCOPE_BUILT);
    expect((await spawnCli("reindex", [], p)).code).toBe(0); // the build stamps the declared scope
    rmSync(join(p.vault, "star.yaml"));
    const lost = await spawnCli("reindex", [], p);
    expect(lost.code).not.toBe(0);
    expect(lost.err).toContain("the scope declared at the last build is gone; restore star.yaml, or run `funes reindex --fresh` to rebuild without it");
    expect(lost.out).not.toContain("reindex complete");

    const fresh = await spawnCli("reindex", ["--fresh"], p);
    expect(fresh.code).toBe(0);
    expect((await spawnCli("reindex", [], p)).code).toBe(0); // rebuilt without a scope: a configless star again
  } finally { p.cleanup(); }
}, 60_000);
