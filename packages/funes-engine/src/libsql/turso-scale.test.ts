// RAI-314 gate (B8b, RAI-344): the Turso adapter is accepted only after a build of a synthetic
// 10k-page star (personal is about 8.8k pages). Turso flushes its `fts` segment per statement, so the
// module writes each batch set-wise; without that this build took about 12 s, with it about 4 s.
// Budget: one temp file of about 15 MB (refuses past 64 MB), 60 s of wall time.
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Vault } from "funes-core/internal";
import { pathOrder } from "funes-core/internal";
import { GoldenEmbedder } from "../../../funes-core/src/__fixtures__/index-golden.ts";
import { LibsqlStore } from "./store.ts";

const N = 10_000;
const WORDS = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango".split(" ");

test("gate: a 10k-page synthetic star builds on Turso inside its budget, and recall finds a rare term", async () => {
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < N; i++) {
    const body = Array.from({ length: 60 }, (_, j) => WORDS[(i * 7 + j * 13) % WORDS.length]).join(" ") + ` marker${i}`;
    files.set(`p/${String(i).padStart(5, "0")}.md`, new TextEncoder().encode(`---\ntitle: Page ${i}\n---\n${body}\n`));
  }
  const paths = [...files.keys()].sort(pathOrder);
  const vault: Vault = {
    read: async (p) => ({ bytes: files.get(p)!, version: `1:1:${files.get(p)!.length}` }),
    async *list(o = {}) { for (const path of paths) if (o.after == null || pathOrder(path, o.after) > 0) yield { path, version: "" }; },
    atomically: () => { throw new Error("read-only"); },
  };
  const dir = mkdtempSync(join(tmpdir(), "funes-turso-10k-"));
  try {
    const store = await LibsqlStore.create(new GoldenEmbedder(), join(dir, "index.db"), { engine: "turso" });
    const t0 = performance.now();
    const r = await store.build({ vault, batch: 32 });
    const ms = performance.now() - t0;
    expect(r.files).toBe(N);
    expect((await store.stats()).nodes).toBe(N);
    expect((await store.recall({ query: "marker4242", k: 3 })).map((h) => h.id)).toContain("p/04242");
    await store.close();
    const bytes = readdirSync(dir).reduce((n, f) => n + statSync(join(dir, f)).size, 0);
    expect(bytes).toBeLessThan(64e6);
    expect(ms).toBeLessThan(60_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
