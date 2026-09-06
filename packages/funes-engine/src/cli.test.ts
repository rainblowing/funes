import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";
import { E5Embedder, E5_DIM } from "./embedder.ts";
import { publishGenerationManifest } from "./publication.ts";
import { scopeHash } from "./scope.ts";

// H3 CLI arg-validation for `funes reindex` — the scope-bypass guards that must fail closed BEFORE
// any store is opened. Spawned as a subprocess (cli.ts runs its command at module load); each case
// exits non-zero in the arg-parse stage, so no E5 model / PGLite is touched (fast).

const CLI = join(import.meta.dir, "cli.ts");
const REPO = resolve(import.meta.dir, "..", "..", "..");

/** Spawn the CLI against a PREPARED vault + index base. `args` go before `--vault` because `query`
 *  reads its question from argv[1]; every other verb parses positionals past value-flags, so the
 *  order is indifferent to them. Both pipes are drained concurrently — a child that fills one while
 *  the test reads the other deadlocks. */
async function spawnCli(cmd: string, args: string[], o: { vault: string; libsqlBase: string; env?: Record<string, string> }): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", CLI, cmd, ...args, "--vault", o.vault], {
    cwd: REPO,
    env: { ...process.env, FUNES_BACKEND: "libsql", FUNES_LIBSQL_DIR: o.libsqlBase, FUNES_DAEMON_PORT: "1", ...o.env },
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
  cmd: string, args: string[], prepare?: (vault: string, libsqlBase: string) => void, env?: Record<string, string>,
): Promise<{ code: number; err: string; homes: string[] }> {
  const vault = mkdtempSync(join(tmpdir(), "funes-cli-"));
  // PLAN-0.3.0 P0.3: the CLI's index home is `$FUNES_LIBSQL_DIR/<vault basename>/`, and the default
  // base is the REAL `~/.twinkling/libsql`. Unset, every spawn here stamped an owner marker and an
  // index.db into a permanent home named after a vault that this function deletes two lines later —
  // 61 orphaned `funes-cli-*` directories by 0.3.0. Nothing in the CLI can clean that up: for a real
  // vault the same directory is the durable index and must outlive the process. So the fix is to
  // stop pointing a throwaway vault at the real base — the pattern mcp-boundary.test.ts already uses.
  const libsqlBase = mkdtempSync(join(tmpdir(), "funes-cli-idx-"));
  prepare?.(vault, libsqlBase);
  const { code, err } = await spawnCli(cmd, args, { vault, libsqlBase, env });
  // Read before the rm: `homes` is the evidence that the override was honored — the leak was
  // invisible precisely because it landed outside every directory this file owns.
  const homes = readdirSync(libsqlBase);
  rmSync(vault, { recursive: true, force: true });
  rmSync(libsqlBase, { recursive: true, force: true });
  return { code, err, homes };
}
const reindex = (args: string[]) => run("reindex", args);

// The uncaught handler brands every message `funes: `, and sixteen throw sites already brand their
// own (they surface through MCP/daemon/face too, which have no wrapper). The one hard failure this
// artifact has therefore opened "funes: funes: could not load the embedding model …". `forget` on a
// foreign id is the cheapest of the sixteen to reach — it throws in assertOwned, before anything
// touches the embedder — and it exercises the same shared handler.
test("a throw that brands itself is not branded twice — one `funes: `, never two", async () => {
  const { code, err, homes } = await run("forget", ["some/foreign-id"]);
  expect(code).toBe(1);
  expect(err).toContain("funes: refusing to mutate");
  expect(err).not.toContain("funes: funes: ");
  expect(err.match(/funes: /g)?.length).toBe(1);
  // `forget` is the only case in this file that opens a store, so it is the only one that stamps an
  // index home — which makes it the temp-directory-leak regression too. Exactly one home, under the
  // base `run` owns. Drop FUNES_LIBSQL_DIR from the spawn env and this reads [] while the home
  // reappears in ~/.twinkling/libsql.
  expect(homes).toHaveLength(1);
  expect(homes[0]).toStartWith("funes-cli-");
}, 20_000);

test("reindex: --ignore-scope + --max is rejected (a scope-bypassing run must be full)", async () => {
  const { code, err } = await reindex(["--ignore-scope", "--max", "5"]);
  expect(code).toBe(2);
  expect(err).toContain("--ignore-scope cannot be combined with --max");
}, 20_000);

test("reindex: --max must be a positive integer — abc / 0 / negative all rejected before opening a store", async () => {
  for (const bad of ["abc", "0", "-3", "2.5"]) {
    const { code, err } = await reindex(["--max", bad]);
    expect(code).toBe(2);
    expect(err).toContain("--max must be a positive integer");
  }
}, 30_000);

test("reindex: --fresh + --max is rejected (a fresh rebuild wipes first, so it must be FULL)", async () => {
  const { code, err } = await reindex(["--fresh", "--max", "5"]);
  expect(code).toBe(2);
  expect(err).toContain("--fresh cannot be combined with --max");
}, 20_000);

// P1.7: `remember`/`supersede` grew --volatile and --as-of so a human at the terminal can write a
// STATE, which only the MCP op could do. --as-of matches the op's `isoDate` and REFUSES garbage
// rather than dropping it — silently discarding it records the memory as never-stale, the exact
// failure the field exists to prevent. The refusal must land before the body is read, or the
// process blocks on stdin waiting for a body it is going to throw away.
test("remember/supersede: --as-of rejects an unparseable date before stdin or a store is opened", async () => {
  for (const cmd of ["remember", "supersede"]) {
    const { code, err } = await run(cmd, ["oldId", "--title", "T", "--as-of", "banana"]);
    expect(code).toBe(2);
    expect(err).toContain("--as-of must be an ISO-8601 date");
  }
}, 30_000);

// 0.3.0 item 23 at the PUBLISHER. `makeStore` is not the only construction point — `publish` opens
// libsql directly (its own `open` closure) and so does the servability check underneath it, so both
// skipped the guard entirely. The HOME is what is guarded, not just the gen-*.db path: every
// generation, the manifest and the read faces' RO opens live inside it, and a provider copying that
// directory tears all of them at once.
test("publish: a publication HOME inside a sync root refuses — before an embedder is constructed", async () => {
  const home = mkdtempSync(join(tmpdir(), "funes-publish-sync-"));
  writeFileSync(join(home, ".stfolder"), ""); // the marker as Syncthing writes it, INSIDE its root
  const { code, err } = await run("publish", ["--home", home]);
  expect(code).toBe(1);
  expect(err).toContain("refusing to open an index inside a Syncthing root");
  expect(err).toContain("DERIVED"); // the repair, not just the refusal
  rmSync(home, { recursive: true, force: true });
}, 20_000);

// RAI-143 clause 1: `funes republish` refuses a home with nothing published — exit 2, distinct from a
// failed build's 1 — and the refusal names `publish`. It lands BEFORE the model is touched: the
// embedder's cache is pointed at an EMPTY directory, so any attempt to load E5 would fail (or hang on
// a 135MB download and trip this test's timeout) instead of exiting 2 with this message, and the
// directory is asserted still empty afterwards.
test("republish: a home with no manifest refuses with exit 2, naming publish, before any model is loaded", async () => {
  const home = mkdtempSync(join(tmpdir(), "funes-republish-empty-"));
  const models = mkdtempSync(join(tmpdir(), "funes-republish-nomodel-"));
  const { code, err } = await run("republish", ["--home", home], undefined, { FUNES_MODEL_DIR: models });
  expect(code).toBe(2);
  expect(err).toContain("republish: REFUSED");
  expect(err).toContain("funes publish");
  expect(readdirSync(models)).toEqual([]);
  rmSync(home, { recursive: true, force: true });
  rmSync(models, { recursive: true, force: true });
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

test("eval: a PUBLISHED generation inside a sync root refuses before the store is opened", async () => {
  const home = mkdtempSync(join(tmpdir(), "funes-eval-sync-"));
  writeFileSync(join(home, ".stfolder"), "");
  // A manifest is all the verb reads before the guard; the db it names never has to exist.
  publishGenerationManifest(home, { version: 1, generation: "v2:" + "a".repeat(64), db: "gen-a.db", publishedAt: "2026-09-06T00:00:00.000Z" });
  // ...and a fixture that passes validateFixture, so the refusal is the guard's and not the validator's.
  const fixture = join(home, "fixture.json");
  writeFileSync(fixture, JSON.stringify({
    vault: "synthetic", k: 5,
    thresholds: { pAtK: 0.5, mrr: 0.5, negativeRate: 0.5, unseenPAtK: 0.5 },
    cases: [{ id: "c1", query: "which page answers this", relevant: ["wiki/a"], split: "unseen" }],
  }));
  const { code, err } = await run("eval", ["--fixture", fixture, "--home", home]);
  expect(code).toBe(1);
  expect(err).toContain("refusing to open an index inside a Syncthing root");
  rmSync(home, { recursive: true, force: true });
}, 20_000);

test("doctor --live: a live index inside a sync root refuses before the store is opened", async () => {
  const { code, err } = await run("doctor", ["--live"], (vault, base) => {
    writeFileSync(join(base, ".stfolder"), "");
    // The verb checks the file EXISTS before it reaches the guard; an empty file satisfies that and
    // is not a funes index, so an open past the guard cannot masquerade as this refusal.
    mkdirSync(join(base, basename(vault)));
    writeFileSync(join(base, basename(vault), "index.db"), "");
  });
  expect(code).toBe(1);
  expect(err).toContain("refusing to open an index inside a Syncthing root");
}, 20_000);

// 0.3.0 item 17 (the PRODUCER) + item 20 (the CONSUMER), through the CLI. machine-state.test.ts pins
// the assembly and the file format; nothing pinned that `funes reindex` actually WRITES the file, or
// that `funes doctor` actually spreads the state into its JSON — the two wirings in cli.ts that
// connect the module to an operator. An EMPTY vault is enough: a full run over zero files still
// prunes, still finalizes a generation, still stamps an instance id, and embeds nothing, so no
// model is loaded. Confirmed to fail with the writeMachineState call removed (no file) and with
// `state` dropped from doctor's JSON (the state assertions read undefined).
test("reindex writes this machine's state, bound to the database's instance id; doctor --json reports it", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-cli-state-vault-"));
  const libsqlBase = mkdtempSync(join(tmpdir(), "funes-cli-state-idx-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "funes-cli-state-root-"));
  const otherMachine = mkdtempSync(join(tmpdir(), "funes-cli-state-other-"));
  try {
    // A declared scope, so the third field the producer records is a real hash and not a null that
    // would also be written by a producer that forgot the field.
    writeFileSync(join(vault, "star.yaml"), 'memory:\n  index_scope:\n    exclude:\n      - "raw/**"\n');
    const r = await spawnCli("reindex", [], { vault, libsqlBase, env: { FUNES_STATE_DIR: stateRoot } });
    expect(r.code).toBe(0);
    expect(r.out).toContain("reindex complete: 0 files");

    // item 17: the file, under the isolated root, bound to the id INSIDE the database it describes —
    // never to the path (the path is unchanged when a different database replaces the file at it).
    const dirs = readdirSync(stateRoot);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toStartWith(`${basename(vault)}-`);
    const state = JSON.parse(readFileSync(join(stateRoot, dirs[0]!, "machine-state.json"), "utf8")) as Record<string, unknown>;
    const db = new Database(join(libsqlBase, basename(vault), "index.db"), { readonly: true });
    const instanceId = (db.query("select value from meta where key='instance_id'").get() as { value: string }).value;
    db.close();
    expect(state).toMatchObject({ v: 1, boundTo: instanceId, authoredHere: true, desiredScopeHash: scopeHash(["raw/**"]) });

    // item 20: doctor's JSON carries the shared operator state. On a machine with NO state file the
    // binding is UNKNOWN — with the reason — and never "authored here" by default.
    type Doctor = { state: { schemaVersion: string | null; buildState: string; generationValid: boolean; builtScopeHash: string | null; scopeMatches: boolean | null; machineState: Record<string, unknown> } };
    const fresh = await spawnCli("doctor", ["--live", "--json"], { vault, libsqlBase, env: { FUNES_STATE_DIR: otherMachine } });
    expect(fresh.code).toBe(0);
    const s1 = (JSON.parse(fresh.out) as Doctor).state;
    expect(s1.schemaVersion).toBeTruthy();
    expect(s1.buildState).toBe("built");
    expect(s1.generationValid).toBe(true);
    expect(s1.builtScopeHash).toBe(scopeHash(["raw/**"]));
    expect(s1.scopeMatches).toBe(true);
    expect(s1.machineState).toEqual({ kind: "unknown", reason: "no machine-state file on this machine" });
    // ...and on the machine that built it, the same verb reads the file the reindex just wrote.
    const here = await spawnCli("doctor", ["--live", "--json"], { vault, libsqlBase, env: { FUNES_STATE_DIR: stateRoot } });
    expect(here.code).toBe(0);
    expect((JSON.parse(here.out) as Doctor).state.machineState).toMatchObject({ kind: "known", boundTo: instanceId, authoredHere: true });
  } finally {
    for (const d of [vault, libsqlBase, stateRoot, otherMachine]) rmSync(d, { recursive: true, force: true });
  }
}, 60_000);
// ── 0.3.0 items 24 + 25 on the CLI (RAI-148): the six mutators' startup ─────────────────────────
// The designation and the actor are resolved BEFORE the store is opened, so a bad value is a
// startup refusal rather than a throw after stdin was read. `homes` is the proof of "before": an
// opened store stamps an index home, and every case here leaves the base empty.
test("mutators: enforce, a misspelled designation mode and an unusable --actor all refuse at STARTUP, before a store is opened", async () => {
  const cases: Array<[args: string[], env: Record<string, string>, msg: string]> = [
    [["--title", "T", "--body", "x"], { FUNES_WRITE_DESIGNATION: "enforce" }, "not available in this release"],
    [["--title", "T", "--body", "x"], { FUNES_WRITE_DESIGNATION: "audti" }, 'unknown mode "audti"'],
    [["--title", "T", "--body", "x", "--actor", "bad name"], {}, "not a usable actor name"],
  ];
  for (const [args, env, msg] of cases) {
    const { code, err, homes } = await run("remember", args, undefined, env);
    expect(code).toBe(1);
    expect(err).toContain(msg);
    expect(homes).toEqual([]); // refused before the open — nothing was stamped
  }
}, 45_000);

// The audit line is the whole of item 25 in this release (audit permits, never refuses), so its
// presence and its contents are what a test can hold. `forget` on a foreign id is again the cheapest
// mutator to drive: the audit is written before the open, and assertOwned refuses before any embed.
test("mutators: the authorization audit line names the op and the --actor, and is written before the store call", async () => {
  const { code, err } = await run("forget", ["some/foreign-id", "--actor", "operator:ada"]);
  expect(code).toBe(1);
  expect(err).toContain("funes: refusing to mutate");
  const audit = err.split("\n").find((l) => l.includes("write-designation"));
  expect(audit).toContain("[audit] AUDIT: star declares no write_authority (op=forget");
  expect(audit).toContain("actor=operator:ada");
  expect(err.indexOf("write-designation")).toBeLessThan(err.indexOf("refusing to mutate")); // audit first, then the refusal
}, 20_000);

// ── 0.3.0 item 16 + the paired open on the CLI (RAI-148) ────────────────────────────────────────

/** The real E5Embedder's IDENTITY over a fake's arithmetic. `embeddingSignature` reads id, dim,
 *  revision, dtype, pooling and truncation — all inherited — so an index this builds carries exactly
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
function prepared(starYaml: string): { vault: string; libsqlBase: string; home: string; cleanup: () => void } {
  const vault = mkdtempSync(join(tmpdir(), "funes-cli-guard-"));
  writeFileSync(join(vault, "star.yaml"), starYaml);
  const libsqlBase = mkdtempSync(join(tmpdir(), "funes-cli-guard-idx-"));
  const home = join(libsqlBase, basename(vault)); // funesDbDir's dirname under this base
  return { vault, libsqlBase, home, cleanup: () => { rmSync(vault, { recursive: true, force: true }); rmSync(libsqlBase, { recursive: true, force: true }); } };
}

/** One indexed page under the built scope, stamped as the publisher would stamp it. */
async function buildIndex(dbPath: string, opts: { publicationId?: string; starId?: string; finalize?: boolean } = {}): Promise<void> {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const store = await LibsqlStore.create(new SpoofedE5(), dbPath);
  await store.remember([{ id: "wiki/keep", path: "wiki/keep.md", title: "Keep", body: "alpha kept tokens", trust: "trusted" }]);
  await store.setScopeSignature({ hash: scopeHash(["raw/**"]), ignoreScope: false });
  if (opts.starId) await store.setOwnerStarId(opts.starId);
  if (opts.publicationId) await store.setPublicationId(opts.publicationId);
  if (opts.finalize) await store.finalizeForPublish(); // journal_mode=DELETE, as a published generation is
  await store.close();
}

// `funes query --json` is the surface a harness scrapes, and it was the one serving surface with no
// scope recheck: an operator who narrowed star.yaml and had not reindexed kept receiving the
// withdrawn pages from the terminal while every MCP client was refused.
test("query: a star.yaml narrowed after the build refuses with the MCP message and exit 3 — before any embedding", async () => {
  const p = prepared(SCOPE_BUILT);
  try {
    await buildIndex(join(p.home, "index.db"));
    writeFileSync(join(p.vault, "star.yaml"), SCOPE_NARROWED); // narrowed, not reindexed
    const { code, out, err } = await spawnCli("query", ["alpha kept tokens", "--json"], p);
    expect(code).toBe(3);
    expect(err).toContain("scope-hash mismatch"); // scopeRefusalReason's wording — the same string the MCP op throws
    expect(out).toBe(""); // the --json contract prints no partial result on a refusal
  } finally { p.cleanup(); }
}, 30_000);

// `funes eval` opens a manifest-named database and scores recalls through it. Both boundaries land
// here in one spawn each: the paired open admits a database that IS the named publication and then
// the guarded read refuses the narrowed scope (exit 3); a manifest naming a DIFFERENT publication
// is refused at the open (exit 1), which doctor also pins below.
test("eval: the paired open admits the named publication and the guarded recall refuses a narrowed scope; a foreign pair is refused at the open", async () => {
  const p = prepared(SCOPE_BUILT);
  try {
    await buildIndex(join(p.home, "gen-test.db"), { publicationId: "pub:real", finalize: true });
    const manifest = { version: 1 as const, generation: "v2:" + "f".repeat(64), db: "gen-test.db", publishedAt: new Date().toISOString(), publicationId: "pub:real" };
    publishGenerationManifest(p.home, manifest);
    // The fixture the eval scores; at the default path, so the spawn needs no --fixture.
    mkdirSync(join(p.vault, "out", "out_eval"), { recursive: true });
    writeFileSync(join(p.vault, "out", "out_eval", "recall-eval.json"), JSON.stringify({
      vault: "test", k: 5, thresholds: { pAtK: 0, mrr: 0, negativeRate: 1, unseenPAtK: 0 },
      cases: [{ id: "c1", query: "alpha kept tokens", relevant: ["wiki/keep"], split: "unseen" }],
    }));
    writeFileSync(join(p.vault, "star.yaml"), SCOPE_NARROWED);
    const refused = await spawnCli("eval", [], p);
    expect(refused.code).toBe(3);
    expect(refused.err).toContain("scope-hash mismatch");

    publishGenerationManifest(p.home, { ...manifest, publicationId: "pub:other" }); // the same bytes, a foreign name
    const unpaired = await spawnCli("eval", [], p);
    expect(unpaired.code).toBe(1);
    expect(unpaired.err).toContain("is not publication pub:other");
    expect(unpaired.err).toContain("it carries pub:real");
  } finally { p.cleanup(); }
}, 45_000);

// Doctor verified star identity through four layers and then opened the database without asking
// whether it was the publication the manifest named — so a foreign generation of the SAME star,
// moved under this manifest, audited as if it were the published one and exited 0.
test("doctor: a manifest naming a publication the database does not carry is refused at the open, after the identity check passes", async () => {
  const p = prepared("meta:\n  id: git://example.org/doc\n  name: doc\n");
  try {
    await buildIndex(join(p.home, "gen-test.db"), { publicationId: "pub:real", starId: "git://example.org/doc", finalize: true });
    publishGenerationManifest(p.home, {
      version: 1, generation: "v2:" + "f".repeat(64), db: "gen-test.db", publishedAt: new Date().toISOString(),
      publicationId: "pub:other", starId: "git://example.org/doc", // identity lines up; the pair does not
    });
    const { code, err } = await spawnCli("doctor", [], p);
    expect(code).toBe(1);
    expect(err).not.toContain("identity mismatch"); // layers 1-3 passed — this is the pair check refusing
    expect(err).toContain("is not publication pub:other");
    expect(err).toContain("it carries pub:real");
  } finally { p.cleanup(); }
}, 30_000);
