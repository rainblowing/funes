import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";
import { FunesStore } from "./funes-store.ts";
import type { FunesIndexStore } from "./store.ts";

// P3.15 step 8. FunesStore wrote the canonical markdown and THEN let the index take its own,
// narrower lock. Two concurrent mutations could therefore interleave as
// [A writes md] [B writes md] [B indexes] [A indexes] — leaving markdown from B and index rows from
// A. MCP is spawned one server process per session, so concurrent writers are the normal case, not
// an exotic one. `withCoordination` does not help: it is pass-through unless FUNES_COORDINATION_DIR
// is set, which it is not in the alpha.

class FakeEmbedder implements Embedder {
  readonly dim = 8;
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

/** Wrap a real store so the FIRST `remember` parks inside the index write — precisely the window
 *  the old code left open between the markdown write and the index update. */
function gated(inner: FunesIndexStore): { store: FunesIndexStore; open: () => void; parked: Promise<void> } {
  let release!: () => void;
  let signalParked!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const parked = new Promise<void>((r) => { signalParked = r; });
  let first = true;
  const store = new Proxy(inner, {
    get(t, p, r) {
      if (p !== "remember") return Reflect.get(t, p, r);
      return async (items: Parameters<FunesIndexStore["remember"]>[0]) => {
        if (first) { first = false; signalParked(); await gate; }
        return inner.remember(items);
      };
    },
  }) as FunesIndexStore;
  return { store, open: release, parked };
}

test("concurrent remember() calls cannot interleave markdown and index writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "funes-conc-"));
  const vault = join(dir, "vault");
  mkdirSync(join(vault, "out_memory"), { recursive: true });
  const inner = await LibsqlStore.create(new FakeEmbedder(), join(dir, "index.db"));
  const g = gated(inner);
  const funes = new FunesStore(g.store, { root: vault, now: () => "2026-01-01T00:00:00Z" });
  const id = "out_memory/contested";

  try {
    // A parks inside the index write, holding the lock.
    const a = funes.remember([{ id, title: "Contested", body: "AAA from writer A" }]);
    await g.parked;
    // B must not be able to touch the canonical file while A is mid-operation.
    let bDone = false;
    const b = funes.remember([{ id, title: "Contested", body: "BBB from writer B" }]).then((r) => { bDone = true; return r; });
    await Bun.sleep(120);
    expect(bDone).toBe(false); // serialized, not interleaved
    expect(readFileSync(join(vault, `${id}.md`), "utf8")).toContain("AAA from writer A");

    g.open();
    await a; await b;

    // Whoever finished last must own BOTH halves — the markdown and the indexed body agree.
    const md = readFileSync(join(vault, `${id}.md`), "utf8");
    const indexed = await inner.indexedPage({ id });
    expect(indexed).not.toBeNull();
    const winner = md.includes("BBB from writer B") ? "BBB from writer B" : "AAA from writer A";
    expect(md).toContain(winner);
    expect(indexed!.body).toContain(winner);
  } finally {
    await inner.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("a nested mutation (supersede -> remember) is reentrant, not a deadlock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "funes-reentrant-"));
  const vault = join(dir, "vault");
  mkdirSync(join(vault, "out_memory"), { recursive: true });
  const store = await LibsqlStore.create(new FakeEmbedder(), join(dir, "index.db"));
  const funes = new FunesStore(store, { root: vault, now: () => "2026-01-01T00:00:00Z" });
  try {
    const { ids } = await funes.remember([{ title: "Original", body: "v1" }]);
    // supersede acquires the scoped lock, then calls remember() which must recognise the resource
    // as already owned BY THIS ASYNC CONTEXT and pass straight through.
    const { id } = await funes.supersede(ids[0]!, { title: "Successor", body: "v2" });
    expect(id).toContain("out_memory/");
    expect(readFileSync(join(vault, `${ids[0]}.md`), "utf8")).toContain("superseded_by");
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
