import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { openIndex, openMutator } from "./cli-open.ts";

// 0.3.0 item 24 on the CLI (RAI-148) — the split the two openers exist for. The mutators' open
// carries the resolved actor into the store constructor; the maintenance open carries NONE, whatever
// FUNES_ACTOR says, because a full reindex re-remembers every live file and would otherwise rewrite
// every row's attribution to whoever ran it. A spawn cannot prove either half: a `remember` embeds,
// and the model is off-limits to the suite. So the openers are exercised in-process, with the fake
// embedder the store tests use.

const fake: Embedder = {
  dim: 8,
  async embedQuery() { return new Float32Array(8); },
  async embedPassage() { return new Float32Array(8); },
  async embedPassages(texts) { return texts.map(() => new Float32Array(8)); },
};

/** Patch the live environment for one call and always put it back — both openers read it. */
async function withEnv<T>(patch: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k]]));
  Object.assign(process.env, patch);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("cli-open: the mutators' open stamps the resolved actor; the maintenance open stamps none and keeps prior attribution", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-cli-open-vault-"));
  const base = mkdtempSync(join(tmpdir(), "funes-cli-open-idx-"));
  const dbDir = join(base, "index.db");
  try {
    // FUNES_LIBSQL_DIR keeps the fence's lock dir (keyed on the vault's default home) under the temp
    // base; FUNES_DAEMON_PORT=1 makes the daemon probe a definite "nothing listening".
    const env = { FUNES_LIBSQL_DIR: base, FUNES_DAEMON_PORT: "1" };
    const id = await withEnv({ ...env, FUNES_ACTOR: "operator:ada" }, async () => {
      // No --actor flag: the resolver falls through to FUNES_ACTOR, exactly as the HTTP face's does.
      const m = await openMutator(vault, "remember", { dbDir, embedder: fake });
      expect(m.actor).toBe("operator:ada");
      const { ids } = await m.fenced(() => m.funes.remember([{ title: "Retainer", body: "9500/mo" }]));
      await m.funes.close();
      return ids[0]!;
    });
    await withEnv({ ...env, FUNES_ACTOR: "operator:bo" }, async () => {
      // The maintenance open, with a DIFFERENT actor in the environment. If openIndex read it, the
      // re-remembered row below would flip to operator:bo; the coalesce keeps ada only because the
      // maintenance opener stamps nothing.
      const idx = await openIndex(vault, { dbDir, embedder: fake });
      try {
        expect((await idx.indexedPage({ id }))!.writeActor).toBe("operator:ada"); // the mutator's stamp landed
        await idx.remember([{ id, title: "Retainer", body: "9500/mo, restated by a reindex" }]);
        expect((await idx.indexedPage({ id }))!.writeActor).toBe("operator:ada"); // ...and survives maintenance
        await idx.remember([{ id: "wiki/fresh", title: "Fresh", body: "first seen by a reindex" }]);
        expect((await idx.indexedPage({ id: "wiki/fresh" }))!.writeActor).toBe("unknown"); // a new row: no actor, no guess
      } finally {
        await idx.close();
      }
    });
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});
