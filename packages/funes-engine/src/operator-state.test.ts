import { test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { LibsqlStore } from "./libsql/store.ts";
import { indexDir } from "./reindex.ts";
import { scopeHash } from "funes-core";
import { stateDirFor } from "./funes-home.ts";
import { formatOperatorState, operatorState } from "./doctor.ts";
import { folderStar } from "./funes-store.ts";

// PLAN-0.3.0 item 20 (the operator-facing state contract) and the machine-local state dir. The
// machine-state FILE is gone (RAI-327, RAI-306); `stateDirFor` stays for outboxes, replica.json and
// canon mirrors. FUNES_HOME is redirected into a temp dir for every case.
const roots: string[] = [];
const isolate = (): string => {
  const root = mkdtempSync(join(tmpdir(), "funes-state-root-"));
  roots.push(root);
  process.env.FUNES_HOME = root;
  return root;
};
afterEach(() => {
  delete process.env.FUNES_HOME;
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

// ── the state dir ───────────────────────────────────────────────────────────────────────────
test("the state dir is machine-local, derives from $FUNES_HOME/state, and keys two same-named vaults apart", () => {
  const root = isolate();
  const a = mkdtempSync(join(tmpdir(), "funes-sd-a-"));
  const b = mkdtempSync(join(tmpdir(), "funes-sd-b-"));
  mkdirSync(join(a, "notes"));
  mkdirSync(join(b, "notes"));
  try {
    const da = stateDirFor(join(a, "notes"));
    const db = stateDirFor(join(b, "notes"));
    expect(da.startsWith(join(root, "state") + "/")).toBe(true);
    // Same basename, different paths -> different state. This is why the key carries a path digest
    // and not just the folder name: two stars called `notes` must not share an outbox.
    expect(da).not.toBe(db);
    expect(da).toContain("notes-");
    // …and never inside the vault or a publication home, which sync and would carry another
    // machine's answer here.
    expect(da.startsWith(a)).toBe(false);
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

// ── item 20: the operator state contract ────────────────────────────────────────────────────────
test("item 20: operatorState answers every field the item names, and carries no machineState", async () => {
  isolate();
  const vault = mkdtempSync(join(tmpdir(), "funes-opstate-"));
  writeFileSync(join(vault, "star.yaml"), 'memory:\n  index_scope:\n    exclude:\n      - "raw/**"\n');
  writeFileSync(join(vault, "keep.md"), "---\ntitle: Keep\n---\nprotein creatine goals\n");
  const store = await LibsqlStore.create(new FakeEmbedder(), join(vault, "i.db"));
  try {
    await indexDir(store, vault, { scopeSignature: { hash: scopeHash(["raw/**"]), ignoreScope: false } });
    const s = operatorState({ store, star: folderStar(vault) }, await store.stats());
    expect(s.schemaVersion).toBeTruthy();
    expect(s.buildState).toBe("built");
    expect(s.contentGeneration).toMatch(/^v3:/);
    for (const gone of ["generationValid", "invalidatedAt", "invalidatedReason"]) expect(gone in s).toBe(false); // RAI-307/RAI-308
    expect(s.servingSignature).toBe("libsql:rank/2");
    expect(s.builtScopeHash).toBe(scopeHash(["raw/**"]));
    expect(s.desiredScopeHash).toBe(scopeHash(["raw/**"]));
    expect(s.scopeMatches).toBe(true);
    expect(s.ignoreScope).toBe(false);
    expect("machineState" in s).toBe(false);
    // RAI-306 Q9: the per-build identity is the last full build's stamp, not a publication id
    expect("publicationId" in s).toBe(false);
    expect(s.lastReindexAt).toBe((await store.stats()).lastReindexAt);
    expect(s.lastReindexAt).toBeTruthy();
    expect(formatOperatorState(s)).toContain(`    last reindex ${s.lastReindexAt}\n`);
    expect(formatOperatorState(s)).not.toContain("publication");
    expect(formatOperatorState(s)).not.toContain("machine state");
    // PLAN-0.4.0 item 10: no locus passed is no locus declared — said, never defaulted to a hostname
    expect(s.locus).toBeNull();
    expect(formatOperatorState(s)).toContain("    locus UNDECLARED (no FUNES_LOCUS and no hostname)");

    const s2 = operatorState({ store, star: folderStar(vault), designation: { locus: "host-a" } }, await store.stats());
    expect(s2.locus).toBe("host-a"); // the value the caller resolved, carried verbatim
    expect(formatOperatorState(s2)).toContain("    locus host-a\n");
  } finally { await store.close(); rmSync(vault, { recursive: true, force: true }); }
}, 30_000);

test("item 20: a NARROWED star.yaml shows up as built-versus-desired disagreement, not as silence", async () => {
  isolate();
  const vault = mkdtempSync(join(tmpdir(), "funes-opstate-drift-"));
  writeFileSync(join(vault, "star.yaml"), 'memory:\n  index_scope:\n    exclude:\n      - "raw/**"\n');
  writeFileSync(join(vault, "keep.md"), "---\ntitle: Keep\n---\nprotein creatine goals\n");
  const store = await LibsqlStore.create(new FakeEmbedder(), join(vault, "i.db"));
  try {
    await indexDir(store, vault, { scopeSignature: { hash: scopeHash(["raw/**"]), ignoreScope: false } });
    // The operator narrows policy and has not reindexed yet — the exact state that used to be
    // invisible on every non-cross-star surface.
    writeFileSync(join(vault, "star.yaml"), 'memory:\n  index_scope:\n    exclude:\n      - "raw/**"\n      - "secrets/**"\n');
    const s = operatorState({ store, star: folderStar(vault) }, await store.stats());
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
    await indexDir(store, vault, {});
    const s = operatorState({ store, star: folderStar(vault) }, await store.stats());
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
    await indexDir(store, vault, {});
    const a = formatOperatorState(operatorState({ store, star: folderStar(vault), designation: { locus: "host-a" } }, await store.stats()));
    const b = formatOperatorState(operatorState({ store, star: folderStar(vault), designation: { locus: "host-a" } }, await store.stats()));
    expect(a).toBe(b); // no clock, no locale ordering — an operator can diff two runs
  } finally { await store.close(); rmSync(vault, { recursive: true, force: true }); }
}, 30_000);
