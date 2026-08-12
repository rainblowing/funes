import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { coordinationDir, withCoordination } from "./coordination.ts";
import { FunesStore } from "./funes-store.ts";
import { indexDir } from "./reindex.ts";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";

class FakeEmbedder implements Embedder {
  readonly dim = 16;
  private vec(t: string): Float32Array {
    const v = new Float32Array(this.dim);
    for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? [])
      v[[...w].reduce((a, c) => a + c.charCodeAt(0), 0) % this.dim]! += 1;
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i]! /= n;
    return v;
  }
  async embedQuery(t: string) { return this.vec(t); }
  async embedPassage(t: string) { return this.vec(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.vec(t)); }
}

test("coordination: FUNES_COORDINATION_DIR unset -> pass-through, NO lock.db anywhere (Mac single-process behaviour)", async () => {
  const prev = process.env.FUNES_COORDINATION_DIR;
  delete process.env.FUNES_COORDINATION_DIR;
  try {
    expect(coordinationDir()).toBeNull();
    const vault = mkdtempSync(join(tmpdir(), "funes-coord-off-"));
    const store = await LibsqlStore.create(new FakeEmbedder());
    const funes = new FunesStore(store, { root: vault });
    const { ids } = await funes.remember([{ title: "T", body: "remembered without a lock" }]);
    expect(ids.length).toBe(1);
    expect(existsSync(join(vault, ".twinkling-sync", "lock.db"))).toBe(false);
    await store.close();
  } finally {
    if (prev != null) process.env.FUNES_COORDINATION_DIR = prev;
  }
});

test("coordination: env set -> remember/supersede/reindex acquire the shared lock.db (reentrant nesting included)", async () => {
  const prev = process.env.FUNES_COORDINATION_DIR;
  const coord = mkdtempSync(join(tmpdir(), "funes-coord-on-"));
  process.env.FUNES_COORDINATION_DIR = coord;
  try {
    expect(coordinationDir()).toBe(coord);
    const vault = mkdtempSync(join(tmpdir(), "funes-coord-vault-"));
    mkdirSync(join(vault, "wiki"), { recursive: true });
    writeFileSync(join(vault, "wiki", "a.md"), "---\ntitle: A\n---\nbody a\n");
    const store = await LibsqlStore.create(new FakeEmbedder());
    const funes = new FunesStore(store, { root: vault });

    // remember (a vault write) runs under the lock — lock.db materializes in the coordination dir
    const { ids } = await funes.remember([{ title: "First", body: "locked write" }]);
    expect(existsSync(join(coord, "lock.db"))).toBe(true);

    // supersede NESTS remember inside its own lock frame — reentrancy, not a deadlock
    const { id } = await funes.supersede(ids[0]!, { title: "Second", body: "superseding write" });
    expect(id).not.toBe(ids[0]);

    // reindex (the other funes write path) also runs under the lock
    await indexDir(store, vault, vault, {});
    expect((await store.stats()).generation).toMatch(/^v1:/);

    // and the lock is RELEASED after each path: an immediate re-acquire succeeds
    await withCoordination(async () => 1);
    await store.close();
  } finally {
    if (prev != null) process.env.FUNES_COORDINATION_DIR = prev;
    else delete process.env.FUNES_COORDINATION_DIR;
  }
});
