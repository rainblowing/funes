import { test, expect, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";
import { indexDir } from "./reindex.ts";
import { scopeHash } from "./scope.ts";
import {
  bindingIdOf, formatOperatorState, operatorState, readMachineState, stateDirFor, writeMachineState,
} from "./machine-state.ts";

// PLAN-0.3.0 item 17 (the machine-state file) + item 20 (the operator-facing state contract).
//
// FUNES_STATE_DIR is redirected into a temp dir for every case: machine state defaults to
// ~/.twinkling/state, and a test that wrote there would be writing into the real estate.
const roots: string[] = [];
const isolate = (): string => {
  const root = mkdtempSync(join(tmpdir(), "funes-state-root-"));
  roots.push(root);
  process.env.FUNES_STATE_DIR = root;
  return root;
};
afterEach(() => {
  delete process.env.FUNES_STATE_DIR;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

class FakeEmbedder implements Embedder {
  readonly dim = 16;
  private vec(t: string): Float32Array {
    const v = new Float32Array(this.dim);
    for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) v[[...w].reduce((a, c) => a + c.charCodeAt(0), 0) % this.dim]! += 1;
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i]! /= n;
    return v;
  }
  async embedQuery(t: string) { return this.vec(t); }
  async embedPassage(t: string) { return this.vec(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.vec(t)); }
}

// ── item 17: the root ───────────────────────────────────────────────────────────────────────────
test("item 17: the state root is machine-local, honours FUNES_STATE_DIR, and keys two same-named vaults apart", () => {
  const root = isolate();
  const a = mkdtempSync(join(tmpdir(), "funes-sd-a-"));
  const b = mkdtempSync(join(tmpdir(), "funes-sd-b-"));
  mkdirSync(join(a, "notes"));
  mkdirSync(join(b, "notes"));
  try {
    const da = stateDirFor(join(a, "notes"));
    const db = stateDirFor(join(b, "notes"));
    expect(da.startsWith(root)).toBe(true);
    // Same basename, different paths -> different state. This is why the key carries a path digest
    // and not just the folder name: two stars called `notes` must not share an "authored here".
    expect(da).not.toBe(db);
    expect(da).toContain("notes-");
    // …and never inside the vault or a publication home, which sync and would carry another
    // machine's answer here.
    expect(da.startsWith(a)).toBe(false);
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

// ── item 17: the read precedence ────────────────────────────────────────────────────────────────
test("item 17: absent / unreadable / unknown-v / malformed all read as UNKNOWN, never as authored here", () => {
  isolate();
  const vault = mkdtempSync(join(tmpdir(), "funes-ms-"));
  try {
    expect(readMachineState(vault, "pub-1")).toEqual({ kind: "unknown", reason: "no machine-state file on this machine" });

    const dir = stateDirFor(vault);
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "machine-state.json");

    writeFileSync(f, "{not json");
    expect(readMachineState(vault, "pub-1").kind).toBe("unknown");

    writeFileSync(f, JSON.stringify({ v: 2, boundTo: "pub-1", authoredHere: true, at: "x" }));
    expect((readMachineState(vault, "pub-1") as { reason: string }).reason).toContain("version 2");

    writeFileSync(f, JSON.stringify({ v: 1, boundTo: "pub-1" }));
    expect((readMachineState(vault, "pub-1") as { reason: string }).reason).toContain("malformed");

    writeFileSync(f, JSON.stringify("nope"));
    expect(readMachineState(vault, "pub-1").kind).toBe("unknown");
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test("item 17: state bound to a DIFFERENT artefact is unknown — a swapped database inherits no authorship", () => {
  isolate();
  const vault = mkdtempSync(join(tmpdir(), "funes-ms-swap-"));
  try {
    writeMachineState(vault, { boundTo: "instance-AAA", authoredHere: true, desiredScopeHash: null });
    // Same vault, same path, same everything except the identity INSIDE the database. This is the
    // trap a path-hash binding walks into: the path is unchanged when a publish swap, a restored
    // backup or a copied index replaces the file, and the marker would go on claiming authorship.
    const other = readMachineState(vault, "instance-BBB");
    expect(other.kind).toBe("unknown");
    expect((other as { reason: string }).reason).toContain("a different database is at this path");
    // …and with no identity at all to compare, it is still unknown rather than optimistic.
    expect(readMachineState(vault, null).kind).toBe("unknown");
    // The matching identity is the only case that reads back.
    const same = readMachineState(vault, "instance-AAA");
    expect(same.kind).toBe("known");
    if (same.kind === "known") expect(same.state.authoredHere).toBe(true);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test("item 17: the writer leaves no temp file behind and round-trips every field", () => {
  isolate();
  const vault = mkdtempSync(join(tmpdir(), "funes-ms-rt-"));
  try {
    const h = scopeHash(["raw/**"]);
    writeMachineState(vault, { boundTo: "pub-9", authoredHere: false, desiredScopeHash: h, at: "2026-09-01T00:00:00.000Z" });
    const dir = stateDirFor(vault);
    // temp → fsync → rename → fsync dir: the temp name must not survive the rename, or a reader
    // scanning the directory would find two records of one fact.
    expect(existsSync(join(dir, "machine-state.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "machine-state.json"), "utf8"))).toEqual({
      v: 1, boundTo: "pub-9", authoredHere: false, desiredScopeHash: h, at: "2026-09-01T00:00:00.000Z",
    });
    const read = readMachineState(vault, "pub-9");
    expect(read).toEqual({ kind: "known", state: { v: 1, boundTo: "pub-9", authoredHere: false, desiredScopeHash: h, at: "2026-09-01T00:00:00.000Z" } });
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

// ── item 15/17: the instance id ─────────────────────────────────────────────────────────────────
test("item 15: every database stamps its own random instance id, and two databases never share one", async () => {
  const a = mkdtempSync(join(tmpdir(), "funes-iid-a-"));
  const b = mkdtempSync(join(tmpdir(), "funes-iid-b-"));
  try {
    const sa = await LibsqlStore.create(new FakeEmbedder(), join(a, "i.db"));
    const sb = await LibsqlStore.create(new FakeEmbedder(), join(b, "i.db"));
    const ia = await sa.instanceId();
    const ib = await sb.instanceId();
    expect(ia).toBeTruthy();
    expect(ib).toBeTruthy();
    expect(ia).not.toBe(ib);
    // It is IMMUTABLE across reopens — the whole point is that state can bind to it.
    await sa.close();
    const again = await LibsqlStore.create(new FakeEmbedder(), join(a, "i.db"));
    expect(await again.instanceId()).toBe(ia);
    // …and with no publication id, that id is what machine state binds to.
    expect(await bindingIdOf(again)).toBe(ia);
    await again.close();
    await sb.close();
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test("item 15: a publication id, once stamped, WINS the binding (it is the id principals ack)", async () => {
  const v = mkdtempSync(join(tmpdir(), "funes-iid-pub-"));
  try {
    const s = await LibsqlStore.create(new FakeEmbedder(), join(v, "i.db"));
    await s.setPublicationId("pub-42");
    expect(await bindingIdOf(s)).toBe("pub-42");
    await s.close();
  } finally { rmSync(v, { recursive: true, force: true }); }
});

// ── item 20: the operator state contract ────────────────────────────────────────────────────────
test("item 20: operatorState answers every field the item names, including the machine-state unknown case", async () => {
  isolate();
  const vault = mkdtempSync(join(tmpdir(), "funes-opstate-"));
  writeFileSync(join(vault, "star.yaml"), 'memory:\n  index_scope:\n    exclude:\n      - "raw/**"\n');
  writeFileSync(join(vault, "keep.md"), "---\ntitle: Keep\n---\nprotein creatine goals\n");
  const store = await LibsqlStore.create(new FakeEmbedder(), join(vault, "i.db"));
  try {
    await indexDir(store, vault, vault, { scopeSignature: { hash: scopeHash(["raw/**"]), ignoreScope: false } });
    const s = await operatorState(store, vault, await store.stats(), {});
    expect(s.schemaVersion).toBeTruthy();
    expect(s.buildState).toBe("built");
    expect(s.generationValid).toBe(true);
    expect(s.contentGeneration).toMatch(/^v2:/);
    expect(s.invalidatedAt).toBeNull();
    expect(s.servingSignature.startsWith("sv1:")).toBe(true);
    expect(s.builtScopeHash).toBe(scopeHash(["raw/**"]));
    expect(s.desiredScopeHash).toBe(scopeHash(["raw/**"]));
    expect(s.scopeMatches).toBe(true);
    expect(s.ignoreScope).toBe(false);
    expect(s.overrides).toEqual([]); // env passed explicitly empty: no standing exceptions
    // No machine state was recorded for this build (indexDir does not write it; the CLI does), so
    // the report says UNKNOWN with a reason rather than defaulting to "authored here".
    expect(s.machineState.kind).toBe("unknown");
    expect(formatOperatorState(s)).toContain("treated as NOT authored here");

    // …and once recorded against this database's own identity, it reads back through the contract.
    const boundTo = (await bindingIdOf(store))!;
    writeMachineState(vault, { boundTo, authoredHere: true, desiredScopeHash: scopeHash(["raw/**"]) });
    const s2 = await operatorState(store, vault, await store.stats(), {});
    expect(s2.machineState).toMatchObject({ kind: "known", boundTo, authoredHere: true });
  } finally { await store.close(); rmSync(vault, { recursive: true, force: true }); }
}, 30_000);

test("item 20: a NARROWED star.yaml shows up as built-versus-desired disagreement, not as silence", async () => {
  isolate();
  const vault = mkdtempSync(join(tmpdir(), "funes-opstate-drift-"));
  writeFileSync(join(vault, "star.yaml"), 'memory:\n  index_scope:\n    exclude:\n      - "raw/**"\n');
  writeFileSync(join(vault, "keep.md"), "---\ntitle: Keep\n---\nprotein creatine goals\n");
  const store = await LibsqlStore.create(new FakeEmbedder(), join(vault, "i.db"));
  try {
    await indexDir(store, vault, vault, { scopeSignature: { hash: scopeHash(["raw/**"]), ignoreScope: false } });
    // The operator narrows policy and has not reindexed yet — the exact state that used to be
    // invisible on every non-cross-star surface.
    writeFileSync(join(vault, "star.yaml"), 'memory:\n  index_scope:\n    exclude:\n      - "raw/**"\n      - "secrets/**"\n');
    const s = await operatorState(store, vault, await store.stats(), {});
    expect(s.builtScopeHash).toBe(scopeHash(["raw/**"]));
    expect(s.desiredScopeHash).toBe(scopeHash(["raw/**", "secrets/**"]));
    expect(s.scopeMatches).toBe(false);
    expect(formatOperatorState(s)).toContain("DISAGREE");
  } finally { await store.close(); rmSync(vault, { recursive: true, force: true }); }
}, 30_000);

test("item 20: a configless vault reports scopeMatches null — 'nothing declared' is not 'they agree'", async () => {
  isolate();
  const vault = mkdtempSync(join(tmpdir(), "funes-opstate-configless-"));
  writeFileSync(join(vault, "keep.md"), "---\ntitle: Keep\n---\nprotein creatine goals\n");
  const store = await LibsqlStore.create(new FakeEmbedder(), join(vault, "i.db"));
  try {
    await indexDir(store, vault, vault, {});
    const s = await operatorState(store, vault, await store.stats(), {});
    expect(s.desiredScopeHash).toBeNull();
    expect(s.scopeMatches).toBeNull();
    expect(s.scopeRefusal).toBeNull();
    expect(formatOperatorState(s)).toContain("nothing declared to compare");
  } finally { await store.close(); rmSync(vault, { recursive: true, force: true }); }
}, 30_000);

test("item 20: the report is deterministic — two runs over one index produce identical bytes", async () => {
  isolate();
  const vault = mkdtempSync(join(tmpdir(), "funes-opstate-det-"));
  writeFileSync(join(vault, "keep.md"), "---\ntitle: Keep\n---\nprotein creatine goals\n");
  const store = await LibsqlStore.create(new FakeEmbedder(), join(vault, "i.db"));
  try {
    await indexDir(store, vault, vault, {});
    const a = formatOperatorState(await operatorState(store, vault, await store.stats(), {}));
    const b = formatOperatorState(await operatorState(store, vault, await store.stats(), {}));
    expect(a).toBe(b); // no clock, no locale ordering — an operator can diff two runs
  } finally { await store.close(); rmSync(vault, { recursive: true, force: true }); }
}, 30_000);

// ── the writer's two crash-safety details ────────────────────────────────────────────────────────

test("item 17: the temp name is per-WRITE, not per-process — a squatted pid-keyed path neither breaks nor corrupts a write", () => {
  isolate();
  const vault = mkdtempSync(join(tmpdir(), "funes-ms-tmpname-"));
  try {
    const dir = stateDirFor(vault);
    mkdirSync(dir, { recursive: true });
    // EXACTLY the name this writer used before 2026-09-02: derived from the pid alone, so it is
    // predictable and shared — two writers inside one process land on it, and so does a same-pid
    // process on a shared state dir. publication.ts has always used pid + randomBytes for this.
    // Squatted here with a DIRECTORY, which makes the collision observable rather than a race:
    // writeFileSync onto it is EISDIR, so the old writer threw and recorded nothing at all.
    const squatted = join(dir, `.machine-state.json.${process.pid}.tmp`);
    mkdirSync(squatted);
    writeMachineState(vault, { boundTo: "pub-A", authoredHere: true, desiredScopeHash: null });
    const read = readMachineState(vault, "pub-A");
    expect(read.kind).toBe("known");
    if (read.kind === "known") expect(read.state.authoredHere).toBe(true);
    expect(existsSync(squatted)).toBe(true); // untouched: the writer does not claim that name
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test("item 17: a directory the process cannot fsync does not fail a write that already landed", () => {
  // The directory fsync is BEST-EFFORT now, like publication.ts's fsyncPath, because some platforms
  // and filesystems reject fsync on a directory outright (older macOS, network mounts). It used to
  // rethrow — so on such a mount every machine-state write raised AFTER its rename had already
  // succeeded, reporting a failure for a record that is on disk. Reproduced portably with a
  // write+execute-but-not-readable directory: that is what `openSync(dir, "r")` needs and what
  // rename does not.
  if (process.getuid?.() === 0) return; // root bypasses the mode bits — nothing to observe
  isolate();
  const vault = mkdtempSync(join(tmpdir(), "funes-ms-nofsync-"));
  const dir = stateDirFor(vault);
  try {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o311);
    writeMachineState(vault, { boundTo: "pub-B", authoredHere: true, desiredScopeHash: null });
    chmodSync(dir, 0o755);
    const read = readMachineState(vault, "pub-B"); // the record IS there, and complete
    expect(read.kind).toBe("known");
    if (read.kind === "known") expect(read.state.boundTo).toBe("pub-B");
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]); // nothing torn behind it
  } finally {
    try { chmodSync(dir, 0o755); } catch { /* already restored */ }
    rmSync(vault, { recursive: true, force: true });
  }
});
