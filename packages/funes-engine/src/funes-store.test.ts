import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Embedder } from "funes-core";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";
import { FunesStore } from "./funes-store.ts";
import { indexDir } from "./reindex.ts";
import { parseFrontmatter } from "./markdown.ts";

class FakeEmbedder implements Embedder {
  readonly dim = 16;
  private vec(t: string): Float32Array {
    const v = new Float32Array(this.dim);
    for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? [])
      v[[...w].reduce((a, c) => a + c.charCodeAt(0), 0) % this.dim]! += 1;
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < v.length; i++) v[i]! /= norm;
    return v;
  }
  async embedQuery(t: string) { return this.vec(t); }
  async embedPassage(t: string) { return this.vec(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.vec(t)); }
}

/** Fresh (root dir, FunesStore over a :memory: index) with a fixed clock. */
async function fresh() {
  const root = mkdtempSync(join(tmpdir(), "funes-store-"));
  const index = await LibsqlStore.create(new FakeEmbedder());
  const store = new FunesStore(index, { root, now: () => "2026-06-08T00:00:00Z" });
  return { root, index, store, cleanup: async () => { await index.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("remember writes out_memory/<id>.md (canonical) AND indexes it", async () => {
  const { root, store, cleanup } = await fresh();
  const { ids } = await store.remember([{ title: "Fitness goals", body: "lose body fat gain muscle protein" }]);
  const id = ids[0]!;
  expect(id.startsWith("out_memory/")).toBe(true);
  const abs = join(root, `${id}.md`);
  expect(existsSync(abs)).toBe(true);
  const { data } = parseFrontmatter(readFileSync(abs, "utf8"));
  expect(data.title).toBe("Fitness goals");
  expect(data.created).toBe("2026-06-08T00:00:00Z");
  const res = await store.recall({ query: "fitness protein", k: 3 });
  expect(res.map((r) => r.id)).toContain(id);
  await cleanup();
});

test("supersede: old kept on disk with superseded_by, off recall; new is recalled", async () => {
  const { root, store, cleanup } = await fresh();
  const { ids } = await store.remember([{ title: "Weight target", body: "target is eighty kilograms" }]);
  const oldId = ids[0]!;
  const { id: newId } = await store.supersede(oldId, { title: "Weight target", body: "target is seventy eight kilograms" });

  // old markdown retained, marked
  const oldAbs = join(root, `${oldId}.md`);
  expect(existsSync(oldAbs)).toBe(true);
  expect(parseFrontmatter(readFileSync(oldAbs, "utf8")).data.superseded_by).toBe(newId);

  // recall returns the successor, not the superseded item
  const res = await store.recall({ query: "weight target kilograms", k: 5 });
  const got = res.map((r) => r.id);
  expect(got).toContain(newId);
  expect(got).not.toContain(oldId);
  await cleanup();
});

test("forget soft: file kept with forgotten:true, off recall; hard: file deleted", async () => {
  const { root, store, cleanup } = await fresh();
  const soft = (await store.remember([{ title: "Soft secret", body: "ephemeral note about pineapples" }])).ids[0]!;
  const hard = (await store.remember([{ title: "Hard secret", body: "ephemeral note about coconuts" }])).ids[0]!;

  await store.forget(soft);
  await store.forget(hard, { hard: true });

  expect(existsSync(join(root, `${soft}.md`))).toBe(true);
  expect(parseFrontmatter(readFileSync(join(root, `${soft}.md`), "utf8")).data.forgotten).toBe(true);
  expect(existsSync(join(root, `${hard}.md`))).toBe(false);

  const all = await store.recall({ query: "ephemeral note", k: 10 });
  const ids = all.map((r) => r.id);
  expect(ids).not.toContain(soft);
  expect(ids).not.toContain(hard);
  await cleanup();
});

test("link: edge written to canonical frontmatter; recall edge-walk reaches the target", async () => {
  const { root, store, cleanup } = await fresh();
  const a = (await store.remember([{ title: "Alpha subject", body: "zzzqqq unique-token-alpha" }])).ids[0]!;
  const b = (await store.remember([{ title: "Beta subject", body: "wholly unrelated wording" }])).ids[0]!;

  await store.link(a, b, "related_to");

  const fm = parseFrontmatter(readFileSync(join(root, `${a}.md`), "utf8")).data;
  expect(Array.isArray(fm.edges)).toBe(true);
  expect((fm.edges as any[])[0].target).toBe(b);

  const res = await store.recall({ query: "unique-token-alpha", k: 5 });
  expect(res.map((r) => r.id)).toContain(b); // reached only via the a->b edge
  await cleanup();
});

test("reindex skips tombstoned items (soft-forgotten survives a full rebuild deterministically)", async () => {
  const { root, store, index, cleanup } = await fresh();
  const keep = (await store.remember([{ title: "Keeper", body: "rebuildable keeper content marker" }])).ids[0]!;
  const gone = (await store.remember([{ title: "Goner", body: "rebuildable goner content marker" }])).ids[0]!;
  await store.forget(gone); // soft tombstone in markdown

  // rebuild a brand-new index purely from the canonical markdown on disk
  const fresh2 = await LibsqlStore.create(new FakeEmbedder());
  const r = await indexDir(fresh2, root, root);
  expect(r.tombstoned).toBe(1);
  const res = await fresh2.recall({ query: "rebuildable content marker", k: 10 });
  const ids = res.map((x) => x.id);
  expect(ids).toContain(keep);
  expect(ids).not.toContain(gone);
  await fresh2.close();
  await cleanup();
});

// ── S3 (H4): sanitizer + trust defaults + elevation ──

test("H4: remember sanitizes input (control chars/ANSI stripped) and stamps trust: untrusted", async () => {
  const { root, store, cleanup } = await fresh();
  try {
    const ESC = String.fromCharCode(27), NUL = String.fromCharCode(0);
    const { ids } = await store.remember([{
      title: "Dirty" + NUL + " input",
      body: "payload " + ESC + "[31minjected" + ESC + "[0m text" + NUL,
    }]);
    const raw = readFileSync(join(root, ids[0]! + ".md"), "utf8");
    expect(raw.includes(NUL)).toBe(false);
    expect(raw.includes(ESC)).toBe(false);
    expect(raw).toContain("trust: untrusted"); // server-side default, recorded canonically
    expect(raw).toContain("injected text");    // content survives, control bytes don't
  } finally { await cleanup(); }
});

test("H4: elevate flips a funes-written item to trusted (frontmatter + recall); foreign ids refused", async () => {
  const { root, store, cleanup } = await fresh();
  try {
    const { ids } = await store.remember([{ title: "Promotable", body: "useful agent memory zebra" }]);
    const id = ids[0]!;
    let res = await store.recall({ query: "useful agent memory zebra", k: 3 });
    expect(res.find((r) => r.id === id)?.trust).toBe("untrusted");

    await store.elevate(id);
    expect(readFileSync(join(root, id + ".md"), "utf8")).toContain("trust: trusted");
    res = await store.recall({ query: "useful agent memory zebra", k: 3 });
    expect(res.find((r) => r.id === id)?.trust).toBe("trusted");

    await expect(store.elevate("wiki/some-page")).rejects.toThrow(/refusing to mutate/);
  } finally { await cleanup(); }
});

test("S4: harness-injected compact hook distills the body before sanitize; absent = passthrough", async () => {
  const root = mkdtempSync(join(tmpdir(), "funes-compact-"));
  const index = await LibsqlStore.create(new FakeEmbedder());
  try {
    const ESC = String.fromCharCode(27);
    const compact = async (t: string) => "DISTILLED: " + t.split(" ").slice(0, 3).join(" ") + " " + ESC + "[31m";
    const store = new FunesStore(index, { root, now: () => "2026-06-11T00:00:00Z", compact });
    const { ids } = await store.remember([{ title: "Long note", body: "alpha beta gamma delta epsilon zeta" }]);
    const raw = readFileSync(join(root, ids[0]! + ".md"), "utf8");
    expect(raw).toContain("DISTILLED: alpha beta gamma"); // compacted
    expect(raw.includes(ESC)).toBe(false);                // ...then sanitized
    expect(raw).not.toContain("epsilon");
  } finally { await index.close(); rmSync(root, { recursive: true, force: true }); }
});
