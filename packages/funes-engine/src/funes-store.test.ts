import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Embedder } from "funes-core";
import { serialize } from "funes-shared";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";
import { FunesStore, okfWrite } from "./funes-store.ts";
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

// A memory id is `<slug>-<sha256(title\nbody) sliced to 6 hex>` and lives in a filename forever.
// 6 hex is 24 bits: among ~5,000 distinct bodies under one slug, the birthday probability of a
// clash passes 50%. The pair below is a REAL collision, found by brute force, not a mock — both
// bodies hash to `meeting-notes-3bf585`. Before the fix, the second write read the first as its own
// prior version and overwrote it: no error, no duplicate, the note simply gone.
test("a real id collision does not silently overwrite the other note", async () => {
  const { root, store, cleanup } = await fresh();
  const title = "Meeting notes";
  const { ids: [a] } = await store.remember([{ title, body: "body-4872" }]);
  const { ids: [b] } = await store.remember([{ title, body: "body-5441" }]);

  expect(a).toBe("out_memory/meeting-notes-3bf585"); // the colliding id both inputs derive
  expect(b).not.toBe(a);                             // the second must NOT land on it
  for (const id of [a!, b!]) expect(existsSync(join(root, `${id}.md`))).toBe(true);
  expect(parseFrontmatter(readFileSync(join(root, `${a}.md`), "utf8")).body.trim()).toBe("body-4872");
  expect(parseFrontmatter(readFileSync(join(root, `${b}.md`), "utf8")).body.trim()).toBe("body-5441");

  // ...while re-remembering identical content still updates IN PLACE on its original id, which is
  // what keeps every id already on disk valid.
  const { ids: [again] } = await store.remember([{ title, body: "body-4872" }]);
  expect(again).toBe(a);
  await cleanup();
});

// RAI-155 (PLAN-0.4.0 item 18). An id is a hash of title+body, so a verbatim re-remember lands on
// the page it already wrote. Before the fix only `created` survived: the page's supersession,
// forget state, trust and edges were rebuilt from the new call — which the served `remember` never
// fills — so the re-remember revived a tombstone, demoted an elevation and dropped every link. With
// many actors on one broker, any actor holding `remember` could undo another's supersede.
const fmOf = (root: string, id: string) => parseFrontmatter(readFileSync(join(root, `${id}.md`), "utf8")).data;
const recalled = async (store: FunesStore, query: string) => (await store.recall({ query, k: 10 })).map((r) => r.id);

test("RAI-155: a re-remember of a superseded page keeps it superseded and out of recall", async () => {
  const { root, store, cleanup } = await fresh();
  const old = { title: "Weight target", body: "target is eighty kilograms" };
  const oldId = (await store.remember([old])).ids[0]!;
  const { id: newId } = await store.supersede(oldId, { title: "Weight target", body: "target is seventy eight kilograms" });

  const { ids: [again] } = await store.remember([old]);
  expect(again).toBe(oldId);
  expect(fmOf(root, oldId).superseded_by).toBe(newId);
  expect(fmOf(root, oldId).created).toBe("2026-06-08T00:00:00Z");
  expect(await recalled(store, "weight target kilograms")).not.toContain(oldId);
  await cleanup();
});

test("RAI-155: a re-remember of a soft-forgotten page keeps it forgotten", async () => {
  const { root, store, cleanup } = await fresh();
  const note = { title: "Soft secret", body: "ephemeral note about pineapples" };
  const id = (await store.remember([note])).ids[0]!;
  await store.forget(id);

  await store.remember([note]);
  expect(fmOf(root, id).forgotten).toBe(true);
  expect(await recalled(store, "ephemeral pineapples")).not.toContain(id);
  await cleanup();
});

test("RAI-155: a re-remember keeps an elevation, even when the call states the untrusted default", async () => {
  const { root, store, cleanup } = await fresh();
  const note = { title: "Vetted fact", body: "the vetted fact about tides" };
  const id = (await store.remember([note])).ids[0]!;
  await store.elevate(id);

  await store.remember([{ ...note, meta: { trust: "untrusted" } }]); // the CLI's explicit H4 default
  expect(fmOf(root, id).trust).toBe("trusted");
  const hit = (await store.recall({ query: "vetted tides", k: 5 })).find((r) => r.id === id);
  expect(hit?.trust).toBe("trusted");
  await cleanup();
});

test("RAI-155: a re-remember keeps the page's edges and never adds the ones it brings", async () => {
  const { root, store, cleanup } = await fresh();
  const a = { title: "Alpha subject", body: "zzzqqq unique-token-alpha" };
  const aId = (await store.remember([a])).ids[0]!;
  const bId = (await store.remember([{ title: "Beta subject", body: "wholly unrelated wording" }])).ids[0]!;
  const cId = (await store.remember([{ title: "Gamma subject", body: "different words again" }])).ids[0]!;
  await store.link(aId, bId, "related_to");
  const linked = bytes(root, aId);

  await store.remember([a]);
  await store.remember([{ ...a, edges: [{ type: "related_to", target: cId }] }]); // link() is the verb for edges
  expect(bytes(root, aId)).toBe(linked);
  expect(await recalled(store, "unique-token-alpha")).toContain(bId); // still reached via the edge
  await cleanup();
});

// RAI-156 (PLAN-0.4.0 item 19; Turso spike hazard F4b). Every mutation writes canonical markdown
// first and the index second, so an index that refuses — a full disk, a schema fence, a dirty marker,
// an unreachable primary — used to report failure AFTER the vault had changed. Each mutation now
// puts the pages it wrote back, byte for byte, before the error reaches the caller.
function refusing(index: LibsqlStore, method: "remember" | "remove"): LibsqlStore {
  return new Proxy(index, {
    get(t, p, r) {
      if (p === method) return async () => { throw new Error(`test: index ${method} refused`); };
      const v = Reflect.get(t, p, r);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}
const bytes = (root: string, id: string) => (existsSync(join(root, `${id}.md`)) ? readFileSync(join(root, `${id}.md`), "utf8") : null);
const memFiles = (root: string) => (existsSync(join(root, "out_memory")) ? readdirSync(join(root, "out_memory")).sort() : []);

test("RAI-156: a remember whose index write fails leaves no page, and a re-remember leaves the old bytes", async () => {
  const { root, index, store, cleanup } = await fresh();
  const failing = new FunesStore(refusing(index, "remember"), { root, now: () => "2026-09-25T00:00:00Z" });
  await expect(failing.remember([{ title: "Never lands", body: "a body that must not survive" }])).rejects.toThrow(/index remember refused/);
  expect(memFiles(root)).toEqual([]);

  const note = { title: "Vetted fact", body: "the vetted fact about tides" };
  const id = (await store.remember([note])).ids[0]!;
  await store.elevate(id);
  const before = bytes(root, id);
  await expect(failing.remember([note])).rejects.toThrow(/index remember refused/);
  expect(bytes(root, id)).toBe(before);
  await cleanup();
});

test("RAI-156: a supersede whose index write fails leaves neither the successor nor the patch", async () => {
  const { root, index, store, cleanup } = await fresh();
  const oldId = (await store.remember([{ title: "Weight target", body: "target is eighty kilograms" }])).ids[0]!;
  const before = bytes(root, oldId);
  for (const method of ["remember", "remove"] as const) {
    const failing = new FunesStore(refusing(index, method), { root, now: () => "2026-09-25T00:00:00Z" });
    await expect(failing.supersede(oldId, { title: "Weight target", body: "target is seventy kilograms" })).rejects.toThrow(/refused/);
    expect(memFiles(root)).toEqual([`${oldId.slice("out_memory/".length)}.md`]);
    expect(bytes(root, oldId)).toBe(before);
    // A refused `remember` changed no row. A refused `remove` came after the successor's row was
    // written, and the compensating remove is refused too — that row is derived state a full reindex
    // prunes (ADR-0003), which is the one thing this frame does not promise to undo.
    if (method === "remember") expect(await recalled(store, "weight target kilograms")).toEqual([oldId]);
  }
  await cleanup();
});

// 0.4.0 item 11: patchFrontmatter refuses a page whose YAML does not parse. supersede used to reach
// that refusal only AFTER the successor was written and indexed, and the undo frame put the page
// back but not the row — recall kept serving a successor whose write the caller was told failed.
test("supersede of a page whose frontmatter does not parse refuses, and leaves no successor in recall", async () => {
  const { root, index, store, cleanup } = await fresh();
  const oldId = (await store.remember([{ title: "Old page", body: "the old page body" }])).ids[0]!;
  const abs = join(root, `${oldId}.md`);
  writeFileSync(abs, readFileSync(abs, "utf8").replace(/^title: .*$/m, "title: a: b"));
  const before = bytes(root, oldId);
  await expect(store.supersede(oldId, { title: "Fresh successor", body: "zebra quokka successor text" })).rejects.toThrow(/does not parse/);
  expect(bytes(root, oldId)).toBe(before);
  expect(memFiles(root)).toEqual([`${oldId.slice("out_memory/".length)}.md`]);
  expect((await recalled(store, "zebra quokka successor")).filter((id) => id !== oldId)).toEqual([]);
  // ...and refuses BEFORE the successor is written: an index that would refuse it is never reached
  const noRemember = new FunesStore(refusing(index, "remember"), { root, now: () => "2026-09-25T00:00:00Z" });
  await expect(noRemember.supersede(oldId, { title: "Fresh successor", body: "zebra quokka successor text" })).rejects.toThrow(/^supersede: the frontmatter/);
  await cleanup();
});

test("RAI-156: link, soft and hard forget, and elevate put the page back when the index refuses", async () => {
  const { root, index, store, cleanup } = await fresh();
  const a = (await store.remember([{ title: "Alpha subject", body: "zzzqqq unique-token-alpha" }])).ids[0]!;
  const b = (await store.remember([{ title: "Beta subject", body: "wholly unrelated wording" }])).ids[0]!;
  const before = bytes(root, a);
  const noRemember = new FunesStore(refusing(index, "remember"), { root, now: () => "2026-09-25T00:00:00Z" });
  const noRemove = new FunesStore(refusing(index, "remove"), { root, now: () => "2026-09-25T00:00:00Z" });

  await expect(noRemember.link(a, b)).rejects.toThrow(/refused/);
  expect(bytes(root, a)).toBe(before);
  await expect(noRemember.elevate(a)).rejects.toThrow(/refused/);
  expect(bytes(root, a)).toBe(before);
  await expect(noRemove.forget(a)).rejects.toThrow(/refused/);
  expect(bytes(root, a)).toBe(before);
  await expect(noRemove.forget(a, { hard: true })).rejects.toThrow(/refused/);
  expect(bytes(root, a)).toBe(before);
  expect(await recalled(store, "unique-token-alpha")).toContain(a);
  await cleanup();
});

test("RAI-155: a re-remember writes nothing — every field the page records survives, stated or not", async () => {
  const { root, store, cleanup } = await fresh();
  const note = { title: "Retainer", body: "the retainer is twelve thousand" };
  const id = (await store.remember([{ ...note, type: "decision", meta: { volatile: true, sources: ["https://example.org/src"], tags: ["money"] } }])).ids[0]!;
  const abs = join(root, `${id}.md`);
  writeFileSync(abs, readFileSync(abs, "utf8").replace(/\n---\n/, "\ndescription: why the retainer moved\ncustom_key: kept\n---\n"));
  const before = bytes(root, id);

  await store.remember([note]); // the served shape: no type, no sources, volatile omitted
  await store.remember([{ ...note, meta: { tags: ["fees"], as_of: "2027-01-01" } }]); // edits are a successor's job
  expect(bytes(root, id)).toBe(before);
  expect(fmOf(root, id).description).toBe("why the retainer moved");
  await cleanup();
});

test("RAI-155: supersede refuses a successor whose content is a tombstoned page, or the page itself", async () => {
  const { root, store, cleanup } = await fresh();
  const a = { title: "Plan", body: "plan A" };
  const b = { title: "Plan", body: "plan B" };
  const aId = (await store.remember([a])).ids[0]!;
  const bId = (await store.supersede(aId, b)).id;
  const before = [bytes(root, aId), bytes(root, bId)];

  await expect(store.supersede(bId, a)).rejects.toThrow(/itself superseded or forgotten/); // would close a cycle
  await expect(store.supersede(bId, b)).rejects.toThrow(/the page being superseded/);
  expect([bytes(root, aId), bytes(root, bId)]).toEqual(before);
  expect(await recalled(store, "plan")).toEqual([bId]);
  await cleanup();
});

test("RAI-156: the undo copies are dotfiles that never outlive the mutation", async () => {
  const { root, index, store, cleanup } = await fresh();
  const id = (await store.remember([{ title: "Kept", body: "kept body" }])).ids[0]!;
  await store.elevate(id);
  await expect(new FunesStore(refusing(index, "remember"), { root }).elevate(id)).rejects.toThrow(/refused/);
  expect(readdirSync(join(root, "out_memory")).filter((f) => f.startsWith("."))).toEqual([]);
  await cleanup();
});

test("RAI-163: two stores on one vault serialize their mutations even over different indexes", async () => {
  const root = mkdtempSync(join(tmpdir(), "funes-vaultlock-"));
  const [ia, ib] = [await LibsqlStore.create(new FakeEmbedder()), await LibsqlStore.create(new FakeEmbedder())];
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const order: string[] = [];
  const a = new FunesStore(ia, { root, compact: async (body) => { order.push("a-in"); await held; order.push("a-out"); return body; } });
  const b = new FunesStore(ib, { root });
  const pa = a.remember([{ title: "From A", body: "a" }]);
  await Bun.sleep(30);
  const pb = b.remember([{ title: "From B", body: "b" }]).then(() => order.push("b-done"));
  await Bun.sleep(120);
  expect(order).toEqual(["a-in"]); // B waits on the vault lock, not on anything index-shaped
  release();
  await Promise.all([pa, pb]);
  expect(order).toEqual(["a-in", "a-out", "b-done"]);
  await ia.close(); await ib.close(); rmSync(root, { recursive: true, force: true });
});

// 0.5.0 item 14 (record 24 §5): the serializer is injected. The edge writer passes its one in-memory
// mutex, and it replaces the host locks: in workerd the mkdir lock lands in an ephemeral /tmp and
// serializes nothing. Each mutation takes exactly one hold; supersede's inner remember re-enters it.
test("item 14: an injected serializer holds each mutation once, and no host lock is taken", async () => {
  const root = mkdtempSync(join(tmpdir(), "funes-serialize-"));
  const locks = mkdtempSync(join(tmpdir(), "funes-serialize-locks-"));
  rmSync(locks, { recursive: true });
  process.env.FUNES_LOCK_DIR = locks;
  const index = await LibsqlStore.create(new FakeEmbedder());
  let holds = 0;
  const store = new FunesStore(index, { root, serialize: (fn) => { holds++; return serialize("star", fn, 1_000); } });
  try {
    const id = (await store.remember([{ title: "Held", body: "held body" }])).ids[0]!;
    const next = (await store.supersede(id, { title: "Held", body: "held body, revised" })).id;
    await store.link(next, id);
    await store.forget(next);
    expect(holds).toBe(4);
    expect(existsSync(locks)).toBe(false);
  } finally {
    delete process.env.FUNES_LOCK_DIR;
    await index.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// 0.5.0 item 14 (record 24 §4): at the edge a write is only staged until the frame commits, so op code
// indexes the bytes it wrote and never reads back a path it just swapped. Proven at a folder by making
// every file written during the op unreadable (umask 0o577 → mode 0o200): a read-back throws EACCES,
// indexing the written bytes does not. (Run as root, the read succeeds and this proves less.) The
// edge's serializer stands in for the host locks, whose lock files the umask would make unwritable.
test("item 14: remember and link index the bytes they wrote, never reading the page back", async () => {
  const { root, index, cleanup } = await fresh();
  const store = new FunesStore(index, { root, serialize: (fn) => serialize("read-back", fn, 1_000) });
  const target = (await store.remember([{ title: "Target", body: "the link target" }])).ids[0]!;
  const from = (await store.remember([{ title: "Linker", body: "links to the target" }])).ids[0]!;
  const prior = process.umask(0o577);
  let written: string;
  try {
    written = (await store.remember([{ title: "Write only", body: "indexed from the staged bytes" }])).ids[0]!;
    await store.link(from, target); // link reads the page before it patches; only the patched bytes are unreadable
  } finally {
    process.umask(prior);
  }
  const hits = await store.recall({ query: "indexed from the staged bytes", k: 5 });
  expect(hits.map((h) => h.id)).toContain(written);
  await cleanup();
});

// Review finding (RAI-215): elevate patches the page too, so it indexes the patched bytes like link —
// a read-back would index the pre-patch page (trust: untrusted) or throw where the write is staged.
test("item 14: elevate indexes the bytes it wrote, never reading the page back", async () => {
  const { root, index, cleanup } = await fresh();
  const store = new FunesStore(index, { root, serialize: (fn) => serialize("elevate-read-back", fn, 1_000) });
  const id = (await store.remember([{ title: "Elevated", body: "elevated from the staged bytes" }])).ids[0]!;
  const prior = process.umask(0o577);
  try {
    await store.elevate(id);
  } finally {
    process.umask(prior);
  }
  const hit = (await store.recall({ query: "elevated from the staged bytes", k: 5 })).find((h) => h.id === id);
  expect(hit?.trust).toBe("trusted");
  await cleanup();
});

// Review finding (RAI-215): a non-canonical explicit id names the same file as its canonical form;
// indexed as given it would sit beside the canonical row after the next reindex.
test("a non-canonical explicit id is refused, never indexed beside its canonical page", async () => {
  const { root, store, cleanup } = await fresh();
  for (const id of ["out_memory//note", "out_memory/./note", "out_memory/note/"]) {
    await expect(store.remember([{ id, title: "Note", body: "one page" }])).rejects.toThrow(/refusing to mutate/);
  }
  expect(existsSync(join(root, "out_memory", "note.md"))).toBe(false);
  await cleanup();
});

// PLAN-0.5.0 item 12 (ADR-0011 Consequences): every page write is a swap on the version read, so a
// page edited outside funes between funes' read and its write is a conflict, never overwritten.
test("item 12: a supersede whose old page is edited outside funes mid-mutation conflicts and writes nothing", async () => {
  const { root, index, cleanup } = await fresh();
  const store = new FunesStore(index, { root, now: () => "2026-10-13T00:00:00Z" });
  const oldId = (await store.remember([{ title: "Weight target", body: "target is eighty kilograms" }])).ids[0]!;
  const edited = `${bytes(root, oldId)}\nan editor's line, written while funes held its read\n`;
  // the successor's index write is the gap between supersede's read of the old page and its patch
  const editing = new Proxy(index, {
    get(t, p, r) {
      if (p === "remember") return async (items: never) => { writeFileSync(join(root, `${oldId}.md`), edited); return t.remember(items); };
      const v = Reflect.get(t, p, r);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const racing = new FunesStore(editing, { root, now: () => "2026-10-13T00:00:00Z" });
  await expect(racing.supersede(oldId, { title: "Weight target", body: "target is seventy kilograms" })).rejects.toThrow(/conflict/);
  expect(bytes(root, oldId)).toBe(edited);
  expect(memFiles(root)).toEqual([`${oldId.slice("out_memory/".length)}.md`]); // the successor went back
  await cleanup();
});

// ── PLAN-0.5.0 item 20 (ADR-0012): every canonical write normalizes to the OKF floor ──────────────
test("item 20: a write is normalized before it lands, and indexed as written", async () => {
  const { root, store, index, cleanup } = await fresh();
  const id = (await store.remember([{ title: "Typeless", body: "an empty type is no type", type: "" }])).ids[0]!;
  expect(parseFrontmatter(bytes(root, id)!).data.type).toBe("note"); // filled in place, nothing else touched
  expect((await index.indexedPage({ id }))?.type).toBe("note");
  await cleanup();
});

test("item 20: a write the normalizer refuses is `invalid` with the reason, and writes nothing", async () => {
  const { root, store, cleanup } = await fresh();
  // a concept at a reserved name — the one refusal FunesStore's own renderer can reach
  const refused = await store.remember([{ id: "out_memory/log", title: "Log", body: "not a concept" }]).catch((e) => e);
  expect(refused).toMatchObject({ code: "invalid" });
  expect(refused.message).toContain("reserved name log.md");
  expect(existsSync(join(root, "out_memory", "log.md"))).toBe(false);
  await cleanup();
});

test("item 20: `memory.okf: false` writes the page as rendered", async () => {
  const { root, store, cleanup } = await fresh();
  writeFileSync(join(root, "star.yaml"), "memory:\n  okf: false\n");
  const id = (await store.remember([{ title: "Typeless", body: "left as rendered", type: "" }])).ids[0]!;
  expect(parseFrontmatter(bytes(root, id)!).data.type).toBe("");
  await cleanup();
});

// The rules a payload write (put_page, item 28) leans on, at the one function every write passes.
test("item 20: okfWrite — a payload without `type` keeps its base's; the byte-equal no-op compares the normalized payload; malformed is invalid with the YAML line", () => {
  const base = { text: "---\ntype: film\ntitle: Dune\n---\nbody\n", data: { type: "film", title: "Dune" } };
  expect(okfWrite("films/dune.md", "---\ntitle: Dune\n---\nnew body\n", base)).toBe("---\ntype: film\ntitle: Dune\n---\nnew body\n");
  expect(okfWrite("films/dune.md", "body\n", null)).toBe("---\ntype: note\n---\nbody\n");
  // normalized, this payload IS the base's bytes: nothing to write
  expect(okfWrite("films/dune.md", "---\ntitle: Dune\n---\nbody\n", base)).toBeNull();
  const bad = (() => { try { okfWrite("films/dune.md", "---\ntitle: a: b\n---\nx", base); } catch (e) { return e as Error & { code?: string }; } })();
  expect(bad?.code).toBe("invalid");
  expect(bad?.message).toContain("Nested mappings are not allowed in compact mappings");
});
