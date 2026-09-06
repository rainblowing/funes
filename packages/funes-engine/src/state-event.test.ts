import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";
import { FunesStore } from "./funes-store.ts";
import { fileToItem } from "./markdown.ts";

// P5.19 step (a). `volatile:`/`as_of:` have been read at index time since Rev 7, but frontmatterFor
// emitted a fixed key allowlist that contained neither — so the state/event distinction was
// reachable only by a human hand-editing markdown, and every agent write was implicitly an
// append-only EVENT. An agent could not mark its own memory as a claim that later writes replace.

class Fake implements Embedder {
  readonly dim = 8;
  private v(t: string) { const a = new Float32Array(this.dim); for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) a[[...w].reduce((x, c) => x + c.charCodeAt(0), 0) % this.dim]! += 1; let n = 0; for (const x of a) n += x * x; n = Math.sqrt(n) || 1; for (let i = 0; i < a.length; i++) a[i]! /= n; return a; }
  async embedQuery(t: string) { return this.v(t); }
  async embedPassage(t: string) { return this.v(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.v(t)); }
}

async function vault() {
  const dir = mkdtempSync(join(tmpdir(), "funes-state-"));
  mkdirSync(join(dir, "out_memory"), { recursive: true });
  const store = await LibsqlStore.create(new Fake(), join(dir, "i.db"));
  return { dir, store, funes: new FunesStore(store, { root: dir, now: () => "2026-01-01T00:00:00Z" }) };
}

test("an agent can mark its own write as STATE, and it reaches the canonical file", async () => {
  const { dir, store, funes } = await vault();
  try {
    const { ids } = await funes.remember([{
      title: "Northwind rate", body: "9,500 per month",
      meta: { volatile: true, as_of: "2026-07-19" },
    }]);
    const md = readFileSync(join(dir, `${ids[0]}.md`), "utf8");
    expect(md).toContain("volatile: true");
    expect(md).toContain("as_of: 2026-07-19");
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("an EVENT stays clean — absent, not `volatile: false`", async () => {
  const { dir, store, funes } = await vault();
  try {
    const { ids } = await funes.remember([{ title: "Shipped the contract", body: "delivered friday" }]);
    const md = readFileSync(join(dir, `${ids[0]}.md`), "utf8");
    expect(md).not.toContain("volatile");
    expect(md).not.toContain("as_of");
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("the bit round-trips: written by the store, read back by the indexer", async () => {
  const { dir, store, funes } = await vault();
  try {
    const { ids } = await funes.remember([{
      title: "Roadmap", body: "ship the alpha", meta: { volatile: true, as_of: "2026-08-01" },
    }]);
    // fileToItem is what reindex uses; `freshness` = as_of else updated (markdown.ts).
    const item = fileToItem(join(dir, `${ids[0]}.md`), dir) as unknown as Record<string, unknown>;
    expect(item!.volatile).toBe(true);
    expect(item!.freshness).toBe("2026-08-01");
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
});
