import { test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { dispatchToolCall } from "funes-core";
import { statParity } from "funes-core/internal";
import { LibsqlStore } from "./libsql/store.ts";
import { folderContext } from "./funes-store.ts";
import { indexDir } from "./reindex.ts";
import { FolderVault } from "./folder-vault.ts";

// RAI-318 (plan B8, first-run): a funes write records the stat and the sha256 of every page it swaps,
// so the recall after a funes write carries no stale hint. These are the RAI-318 probes.

class FakeEmbedder implements Embedder {
  readonly dim = 8;
  private vec() { const v = new Float32Array(this.dim); v[0] = 1; return v; }
  async embedQuery() { return this.vec(); }
  async embedPassage() { return this.vec(); }
  async embedPassages(ts: string[]) { return ts.map(() => this.vec()); }
}

// the star's write lock lives under the funes home: keep it out of the real one
let home: string;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), "funes-first-run-home-")); process.env.FUNES_HOME = home; });
afterAll(() => { delete process.env.FUNES_HOME; rmSync(home, { recursive: true, force: true }); });

type Recalled = { results: Array<{ id: string }>; vaultChangedSinceReindex?: true };

/** A star with one page, an index with one full build, and the dispatcher's context over both. */
async function star() {
  const vault = mkdtempSync(join(tmpdir(), "funes-first-run-"));
  writeFileSync(join(vault, "roof.md"), "---\ntitle: Roof repair decision\n---\nMetal tiles in spring.\n");
  const store = await LibsqlStore.create(new FakeEmbedder());
  const ctx = folderContext({ vault, store });
  const call = (op: string, args: Record<string, unknown>) => dispatchToolCall(op, args, ctx) as Promise<Record<string, unknown>>;
  const build = () => indexDir(store, vault);
  const parity = async () => statParity(new FolderVault(vault), (await store.stats()).lastReindexAt, await store.pageStats());
  const done = async () => { await store.close(); rmSync(vault, { recursive: true, force: true }); };
  return { vault, store, ctx, call, build, parity, done };
}

test("RAI-318 probe: remember, then recall — no stale hint", async () => {
  const s = await star();
  try {
    await s.build();
    const { id } = await s.call("remember", { title: "Roof start date", body: "Roofers start on 12 May." });
    const r = (await s.call("recall", { query: "roofers start" })) as unknown as Recalled;
    expect(r.results.map((h) => h.id)).toContain(id as string);
    expect("vaultChangedSinceReindex" in r).toBe(false);
  } finally { await s.done(); }
});

test("RAI-318 probe: supersede (the successor and the tombstone), then recall — no stale hint", async () => {
  const s = await star();
  try {
    const { id } = await s.call("remember", { title: "Roof start date", body: "Roofers start on 12 May." });
    await s.build();
    await s.call("supersede", { oldId: id, title: "Roof start date", body: "Moved to 19 May." });
    const r = (await s.call("recall", { query: "roofers start" })) as unknown as Recalled;
    expect("vaultChangedSinceReindex" in r).toBe(false);
  } finally { await s.done(); }
});

test("RAI-318 probe: soft forget (the tombstone), then recall — no stale hint", async () => {
  const s = await star();
  try {
    const { id } = await s.call("remember", { title: "Roof start date", body: "Roofers start on 12 May." });
    await s.build();
    await s.call("forget", { id });
    const r = (await s.call("recall", { query: "roofers start" })) as unknown as Recalled;
    expect("vaultChangedSinceReindex" in r).toBe(false);
  } finally { await s.done(); }
});

test("a hard forget removes the file and its stat row: the vault still matches the record", async () => {
  const s = await star();
  try {
    const { id } = await s.call("remember", { title: "Roof start date", body: "Roofers start on 12 May." });
    await s.build();
    await s.ctx.funes.forget(id as string, { hard: true });
    expect(await s.parity()).toEqual({ changed: false, basis: "stat" });
  } finally { await s.done(); }
});

/** Move a file's ctime and nothing else, as Dropbox does when it adds its xattrs after a write. */
function touchCtime(p: string): void {
  const mode = statSync(p).mode;
  Bun.sleepSync(20);
  chmodSync(p, 0o600);
  chmodSync(p, mode);
}

test("RAI-318 probe (Dropbox-style): a ctime shift after a funes write is fresh — the bytes still equal the hash", async () => {
  const s = await star();
  try {
    const { id } = await s.call("remember", { title: "Roof start date", body: "Roofers start on 12 May." });
    await s.build();
    await s.call("supersede", { oldId: id, title: "Roof start date", body: "Moved to 19 May." });
    for (const f of new Bun.Glob("**/*.md").scanSync(s.vault)) touchCtime(join(s.vault, f));
    expect(await s.parity()).toEqual({ changed: false, basis: "stat" });
  } finally { await s.done(); }
});

test("a ctime shift after a full build is fresh too; changed bytes behind a restored mtime are a change", async () => {
  const s = await star();
  try {
    await s.build();
    const p = join(s.vault, "roof.md");
    touchCtime(p);
    expect(await s.parity()).toEqual({ changed: false, basis: "stat" });
    const st = statSync(p);
    writeFileSync(p, "---\ntitle: Roof repair decision\n---\nMetal tiles in autumn.\n"); // same size
    utimesSync(p, st.atime, st.mtime);
    expect(await s.parity()).toEqual({ changed: true, basis: "stat" });
  } finally { await s.done(); }
});
