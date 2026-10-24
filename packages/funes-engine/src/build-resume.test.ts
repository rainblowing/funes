// RAI-314 build gates 2 and 5: a kill -9 mid-build resumes at its cursor to the same content
// generation with no extra embeds, and `neighbors` finds similar pages after a module build (the
// module never writes nodes.embedding; neighbors reads chunk 0).
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibsqlStore } from "./libsql/store.ts";
import { indexDir } from "./reindex.ts";
import { FakeEmbedder } from "./__fixtures__/publish-child.ts";

function vaultOf(n: number): string {
  const v = mkdtempSync(join(tmpdir(), "funes-resume-"));
  mkdirSync(join(v, "wiki"));
  for (let i = 0; i < n; i++) {
    writeFileSync(join(v, "wiki", `p${i}.md`), `---\ntitle: Page ${i}\nedges:\n  - { type: cites, target: p${(i + 1) % n} }\n---\nalpha beta gamma ${i}\n`);
  }
  return v;
}

test("gate 2: kill -9 after a committed batch, then resume: one generation, no extra embeds", async () => {
  const vault = vaultOf(10);
  const dir = mkdtempSync(join(tmpdir(), "funes-resume-db-"));
  try {
    const counter = join(dir, "embeds");
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "__fixtures__", "build-child.ts"), vault, join(dir, "a.db"), "2", counter]);
    expect(child.signalCode).toBe("SIGKILL");
    const before = Number(readFileSync(counter, "utf8"));
    expect(before).toBe(4); // two batches of two pages, one chunk each

    let after = 0;
    const base = new FakeEmbedder();
    const counting = Object.assign(Object.create(base) as FakeEmbedder, { embedPassages: async (ts: string[]) => { after += ts.length; return base.embedPassages(ts); } });
    const resumed = await LibsqlStore.create(counting, join(dir, "a.db"), { allowDirty: true });
    expect((await resumed.stats()).reindexDirty).toBe(true);
    await indexDir(resumed, vault, { batch: 2 });
    const got = await resumed.stats();
    await resumed.close();
    expect(before + after).toBe(10);

    const clean = await LibsqlStore.create(new FakeEmbedder(), join(dir, "b.db"));
    await indexDir(clean, vault, { batch: 2 });
    const want = await clean.stats();
    await clean.close();
    expect(got.reindexDirty).toBe(false);
    expect(got.contentGeneration).not.toBeNull();
    expect(got.contentGeneration).toBe(want.contentGeneration);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gate 5: neighbors(id).similar is non-empty after a module build", async () => {
  const vault = vaultOf(4);
  try {
    const store = await LibsqlStore.create(new FakeEmbedder(), ":memory:");
    await indexDir(store, vault);
    const n = await store.neighbors("wiki/p0");
    expect(n.similar.length).toBeGreaterThan(0);
    expect(n.edgesOut).toEqual([{ type: "cites", id: "wiki/p1", title: "Page 1", trust: "trusted" }]);
    expect((await store.graph({ simCutoff: 0 })).stats.simEdges).toBeGreaterThan(0);
    await store.close();
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
