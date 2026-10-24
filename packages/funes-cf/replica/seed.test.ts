// PLAN-0.5.0 item 48 (record 25 §6 steps 4 and "A map that changed after the seed"; record 29 §4b):
// `funes seed` against a fake writer. Synthetic pages and inputs only: no personal line appears here.
import { test, expect, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { drain, listOutbox, type Writer, type WriterReply } from "./outbox.ts";
import { pagesDigest } from "funes-core";
import { seed, seedCheck, stubMaps } from "./seed.ts";
import { withScopedWriteLock } from "../../funes-engine/src/write-lock.ts";
import { funesDbDir } from "../../funes-engine/src/factory.ts";

const STAR = "mcp://rainblow.ing/taste";
const TOKEN = "funes_" + "S".repeat(43);
const T0 = Date.parse("2026-10-14T09:00:00Z");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const tmp: string[] = [];
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const mk = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d; };

const page = (title: string, extra = "") => `---\ntitle: ${title}\ntype: Film\n---\n\n**${title}**${extra}\n`;
const PAGES: Record<string, string> = {
  "items/movies/alpha--ann-example.md": page("Alpha"),
  "items/movies/beta--bo-sample.md": page("Beta"),
  "items/books/gamma.md": page("Gamma"),
};

/** The converter's output home (out/ + manifest.json over two inputs in a fixture vault), the
 *  replica folder whose star.yaml names the star, a 0600 endpoint + token file and a state dir. */
function fixture(pages: Record<string, string> = PAGES) {
  const inputs = mk("funes-seed-inputs-");
  mkdirSync(join(inputs, "resources/movies"), { recursive: true });
  writeFileSync(join(inputs, "resources/movies/movies.md"), "# Movies\n\n- [x] Alpha\n");
  writeFileSync(join(inputs, "ratings.csv"), "Const,Title\n");
  writeFileSync(join(inputs, "star.yaml"), "version: 3\nmeta:\n  id: mcp://rainblow.ing/personal\n  write_locus: host-a\n");
  const outHome = mk("funes-seed-out-");
  const writeOut = (ps: Record<string, string>) => {
    rmSync(join(outHome, "out"), { recursive: true, force: true });
    for (const [p, c] of Object.entries(ps)) { mkdirSync(join(outHome, "out", p, ".."), { recursive: true }); writeFileSync(join(outHome, "out", p), c); }
    writeFileSync(join(outHome, "manifest.json"), JSON.stringify({ vault: inputs, inputs: [["resources/movies/movies.md", "movies"], ["ratings.csv"]].map(([rel, domain]) => ({ rel: rel!, sha256: sha(readFileSync(join(inputs, rel!), "utf8")), ...(domain ? { domain } : {}) })) }));
  };
  writeOut(pages);
  const vault = mk("funes-seed-replica-");
  writeFileSync(join(vault, "star.yaml"), `version: 3\nmeta:\n  id: ${STAR}\n  write_locus: funes-taste\n`);
  const home = mk("funes-seed-home-");
  const tokenFile = join(home, "taste.token");
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const endpointsPath = join(home, "endpoints.json");
  writeFileSync(endpointsPath, JSON.stringify({ [STAR]: { url: "https://taste.example", token_file: tokenFile } }), { mode: 0o600 });
  return { inputs, outHome, writeOut, vault, endpointsPath, stateDir: mk("funes-seed-state-") };
}

const HEALTHY = { proposalProtocol: 1, starId: STAR, locus: "funes-taste", applyState: "idle" };

/** A fake edge writer holding pages by path: a create-once on an absent path applies, on a
 *  byte-equal page applies as a no-op, on another page refuses stale-base; a replace applies only on
 *  its base; an id it has seen answers already-applied. `write` is what it makes of the bytes sent. */
function fakeWriter(write: (content: string) => string = (c) => c) {
  const pages = new Map<string, string>();
  const seen = new Set<string>();
  const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  const answer = (args: Record<string, unknown>): WriterReply => {
    const id = args.proposalId as string;
    const path = args.path as string;
    const content = args.content as string;
    if (seen.has(id)) return { answer: { proposalId: id, status: "already-applied", writtenHash: sha(pages.get(path)!) } };
    const cur = pages.get(path);
    const base = args.base as string | undefined;
    if (base === undefined ? cur !== undefined && cur !== content : cur === undefined || sha(cur) !== base) {
      return { answer: { proposalId: id, status: "refused", reason: cur === undefined ? "not-found" : "stale-base", ...(cur ? { currentHash: sha(cur) } : {}) } };
    }
    seen.add(id);
    pages.set(path, write(content));
    return { answer: { proposalId: id, status: "applied", writtenHash: sha(pages.get(path)!) } };
  };
  const factory = (): Writer => ({
    async call(op, args) {
      calls.push({ op, args });
      return op === "health" ? { answer: { ...HEALTHY, nodes: pages.size } } : answer(args);
    },
    async close() {},
  });
  return { factory, pages, calls, answer };
}

/** One seed run on a fake clock its sleeps advance. */
const run = (f: ReturnType<typeof fixture>, w: { factory: () => Writer }, digest: string, extra: Partial<Parameters<typeof seed>[0]> = {}) => {
  let t = T0;
  return seed({ star: STAR, digest, vault: f.vault, outHome: f.outHome, stateDir: f.stateDir, endpointsPath: f.endpointsPath, now: () => t, sleep: async (ms) => { t += ms; }, writer: w.factory, ...extra });
};
const digestOf = (ps: Record<string, string>) => pagesDigest(new Map(Object.entries(ps)));

test("every page reaches the writer as a create-once put_page and answers applied; the outbox ends empty", async () => {
  const f = fixture();
  const w = fakeWriter();
  const r = await run(f, w, pagesDigest(new Map(Object.entries(PAGES))));
  expect([...w.pages.entries()].sort()).toEqual(Object.entries(PAGES).sort());
  const puts = w.calls.filter((c) => c.op === "put_page");
  expect(puts).toHaveLength(3);
  for (const c of puts) expect(c.args).not.toHaveProperty("base");
  expect(r).toMatchObject({ created: 3, replaced: 0, applied: 3, refused: [], removed: [] });
  expect(listOutbox(join(f.stateDir, "outbox")).records).toEqual([]);
});

test("a second drainer meeting the same id gets already-applied, and the seed counts it applied", async () => {
  const f = fixture();
  const w = fakeWriter();
  // the writer applies every first delivery but the reply is lost, so the next delivery of the same
  // id is a second one — as when the resident process, or a seed run again, already sent it
  let lost = 0;
  const lossy = (): Writer => ({
    async call(op, args) {
      if (op === "health") return { answer: HEALTHY };
      const a = w.answer(args);
      return "answer" in a && a.answer.status === "applied" ? (lost++, { error: "socket hang up" }) : a;
    },
    async close() {},
  });
  const r = await run(f, { factory: lossy }, digestOf(PAGES));
  expect(lost).toBe(3);
  expect(r).toMatchObject({ created: 3, applied: 3, refused: [] });
  expect(w.pages.size).toBe(3);

  // two drainers over one outbox at once: whichever meets an id second answers already-applied, and
  // neither fails on the other's removal of the record
  const g = fixture();
  const v = fakeWriter();
  const slow = (): Writer => ({
    async call(op, args) { await Bun.sleep(1); return op === "health" ? { answer: HEALTHY } : v.answer(args); },
    async close() {},
  });
  const [s, d] = await Promise.all([
    run(g, { factory: slow }, digestOf(PAGES)),
    (async () => { await Bun.sleep(0); return drain({ vault: g.vault, dir: join(g.stateDir, "outbox"), endpointsPath: g.endpointsPath, now: () => T0, writer: slow }); })(),
  ]);
  expect(d.applied.length).toBeGreaterThan(0);
  expect(s.refused).toEqual([]);
  expect(s.applied).toBe(3);
  expect(v.pages.size).toBe(3);
  expect(listOutbox(join(g.stateDir, "outbox")).records).toEqual([]);
});

test("a re-run is idempotent: nothing applied is sent again, and an interrupted run finishes without a duplicate", async () => {
  const f = fixture();
  const w = fakeWriter();
  await run(f, w, digestOf(PAGES));
  const sends = w.calls.length;
  const again = await run(f, w, digestOf(PAGES));
  expect(again).toMatchObject({ created: 0, replaced: 0, unchanged: 3, applied: 0, refused: [], removed: [] });
  expect(w.calls.length).toBe(sends);

  // the writer was unreachable and the process died: the re-run sends what is in the outbox, once
  const g = fixture();
  const v = fakeWriter();
  const offline = (): Writer => ({ async call() { return { error: "fetch failed" }; }, async close() {} });
  let passes = 0;
  await expect(run(g, { factory: offline }, digestOf(PAGES), { sleep: async () => { if (++passes === 2) throw new Error("killed"); } })).rejects.toThrow(/killed/);
  expect(listOutbox(join(g.stateDir, "outbox")).records).toHaveLength(3);
  const resumed = await run(g, v, digestOf(PAGES));
  expect(resumed).toMatchObject({ created: 0, applied: 3 });
  expect(v.calls.filter((c) => c.op === "put_page")).toHaveLength(3);
  expect(v.pages.size).toBe(3);
});

test("the seed refuses a digest that is not the approved one, an input whose sha256 changed and another star, before any enqueue", async () => {
  const f = fixture();
  const w = fakeWriter();
  await expect(run(f, w, "0".repeat(64))).rejects.toThrow(/hash to [0-9a-f]{64}, not the approved 0{64}/);
  writeFileSync(join(f.inputs, "resources/movies/movies.md"), "# Movies\n\n- [x] Alpha\n- [x] Delta\n");
  await expect(run(f, w, digestOf(PAGES))).rejects.toThrow(/resources\/movies\/movies\.md changed/);
  rmSync(join(f.inputs, "ratings.csv"));
  await expect(run(f, w, digestOf(PAGES))).rejects.toThrow(/changed/);
  await expect(run(f, w, digestOf(PAGES), { star: "mcp://rainblow.ing/personal" })).rejects.toThrow(/names "mcp:\/\/rainblow.ing\/taste", not/);
  expect(w.calls).toEqual([]);
  expect(listOutbox(join(f.stateDir, "outbox")).records).toEqual([]);
});

test("an out/ inside a git repo, a star, a .stfolder tree or a cloud-synced folder refuses", async () => {
  for (const marker of [".git", "star.yaml", ".stfolder"]) {
    const f = fixture();
    writeFileSync(join(f.outHome, marker), "");
    await expect(run(f, fakeWriter(), digestOf(PAGES)), marker).rejects.toThrow(/fail-closed/);
    // and from further up the tree
    const g = fixture();
    const nested = join(g.outHome, "deeper");
    mkdirSync(join(nested, "out"), { recursive: true });
    writeFileSync(join(g.outHome, marker), "");
    await expect(run(g, fakeWriter(), digestOf(PAGES), { outHome: nested }), marker).rejects.toThrow(/fail-closed/);
  }
  const f = fixture();
  const cloud = join(f.outHome, "Library", "CloudStorage", "Dropbox", "taste-out");
  mkdirSync(join(cloud, "out"), { recursive: true });
  await expect(run(f, fakeWriter(), digestOf(PAGES), { outHome: cloud })).rejects.toThrow(/CloudStorage/);
});

test("after a changed map: a changed page is a replace with the applied page's sha256 as base, a new page a create-once, a removed item listed", async () => {
  const f = fixture();
  const w = fakeWriter();
  await run(f, w, digestOf(PAGES));

  // Vlad ticked a line: the converter re-ran over the new map, and he approves the new digest
  writeFileSync(join(f.inputs, "resources/movies/movies.md"), "# Movies\n\n- [x] Alpha /9\n- [x] Delta\n");
  const next: Record<string, string> = { ...PAGES, "items/movies/alpha--ann-example.md": page("Alpha", " · my score 9"), "items/movies/delta.md": page("Delta") };
  delete next["items/books/gamma.md"];
  f.writeOut(next);
  const before = w.calls.length;
  const r = await run(f, w, digestOf(next));
  const puts = w.calls.slice(before).filter((c) => c.op === "put_page").map((c) => c.args);
  expect(puts.map((a) => [a.path, a.base]).sort()).toEqual([
    ["items/movies/alpha--ann-example.md", sha(PAGES["items/movies/alpha--ann-example.md"]!)],
    ["items/movies/delta.md", undefined],
  ]);
  expect(r).toMatchObject({ created: 1, replaced: 1, unchanged: 1, applied: 2, refused: [], removed: ["items/books/gamma.md"] });
  expect(w.pages.get("items/movies/alpha--ann-example.md")).toBe(next["items/movies/alpha--ann-example.md"]!);
  expect(w.pages.has("items/books/gamma.md")).toBe(true); // put_page cannot delete: Vlad decides

  // a page edited at the edge since is never overwritten: the replace refuses stale-base
  w.pages.set("items/movies/delta.md", page("Delta", " · edited by the bot"));
  const third = { ...next, "items/movies/delta.md": page("Delta", " · from the map") };
  f.writeOut(third);
  const s = await run(f, w, digestOf(third));
  expect(s.refused).toEqual([{ path: "items/movies/delta.md", reason: "stale-base" }]);
  expect(w.pages.get("items/movies/delta.md")).toBe(page("Delta", " · edited by the bot"));
});

test("a writer that changes the bytes it writes: the next replace's base is its writtenHash, not the sent bytes' sha256", async () => {
  const f = fixture();
  const w = fakeWriter((c) => c.replace("type: Film", "type: film")); // e.g. the writer's normalization
  await run(f, w, digestOf(PAGES));
  const next = { ...PAGES, "items/movies/alpha--ann-example.md": page("Alpha", " · my score 9") };
  f.writeOut(next);
  const r = await run(f, w, digestOf(next));
  expect(r).toMatchObject({ replaced: 1, unchanged: 2, applied: 1, refused: [] });
  expect(w.pages.get("items/movies/alpha--ann-example.md")).toContain("my score 9");
});

test("a dotfile in out/ (a Finder .DS_Store) is not a page: the digest holds and the done gate does not name it", async () => {
  const f = fixture();
  const w = fakeWriter();
  writeFileSync(join(f.outHome, "out", ".DS_Store"), "\0\0\x01Bud1");
  writeFileSync(join(f.outHome, "out", "items", "movies", ".DS_Store"), "\0\0\x01Bud1");
  expect(await run(f, w, digestOf(PAGES))).toMatchObject({ created: 3, applied: 3 });
  mirrorOf(f, w.pages);
  expect(await check(f, w)).toEqual([]);
});

test("the inline drain keeps item 30's rules: an unreachable writer backs off, a halt or a probe refusal stops the seed with its records kept", async () => {
  const f = fixture();
  const w = fakeWriter();
  const slept: number[] = [];
  let down = 3;
  const flaky = (): Writer => {
    const inner = w.factory();
    return { async call(op, args) { return op === "health" && down-- > 0 ? { error: "fetch failed" } : inner.call(op, args); }, async close() {} };
  };
  let t = T0;
  const r = await run(f, { factory: flaky }, digestOf(PAGES), { now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
  expect(slept).toEqual([2000, 4000, 8000]);
  expect(r.applied).toBe(3);

  const g = fixture();
  const revoked = (): Writer => ({ async call() { return { http: 401 }; }, async close() {} });
  await expect(run(g, { factory: revoked }, digestOf(PAGES))).rejects.toThrow(/halted the endpoint \(HTTP 401\)/);
  expect(listOutbox(join(g.stateDir, "outbox")).records.map((x) => x.status)).toEqual(["pending", "pending", "pending"]);

  const h = fixture();
  const other = (): Writer => ({ async call() { return { answer: { ...HEALTHY, locus: "host-b" } }; }, async close() {} });
  await expect(run(h, { factory: other }, digestOf(PAGES))).rejects.toThrow(/write_locus/);
  expect(listOutbox(join(h.stateDir, "outbox")).records).toHaveLength(3);
});

test("`funes seed` needs TASTE_OUT, --star and a sha256 --digest, and names a refusal", async () => {
  const f = fixture();
  const cli = async (env: Record<string, string>, ...args: string[]) => {
    const p = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), "seed", ...args], { env: { ...process.env, FUNES_HOME: f.stateDir, ...env }, stdout: "pipe", stderr: "pipe" });
    const [, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, err };
  };
  expect((await cli({ TASTE_OUT: f.outHome }, "--star", STAR)).code).toBe(2);
  expect((await cli({}, "--star", STAR, "--digest", digestOf(PAGES), "--vault", f.vault)).code).toBe(2);
  const wrong = await cli({ TASTE_OUT: f.outHome }, "--star", STAR, "--digest", "0".repeat(64), "--vault", f.vault);
  expect(wrong.code).toBe(1);
  expect(wrong.err).toContain(`not the approved ${"0".repeat(64)}`);
});

// ── PLAN-0.5.0 item 49: the done gate ────────────────────────────────────────────────────────────

/** The canon mirror as `funes replica --once` leaves it: the writer's pages, its star.yaml and a
 *  history object, read-only. */
function mirrorOf(f: ReturnType<typeof fixture>, pages: Map<string, string>) {
  const canon = join(f.stateDir, "canon");
  rmSync(canon, { recursive: true, force: true });
  const put = (p: string, c: string) => { mkdirSync(join(canon, p, ".."), { recursive: true }); writeFileSync(join(canon, p), c, { mode: 0o444 }); };
  for (const [p, c] of pages) put(p, c);
  put("star.yaml", readFileSync(join(f.vault, "star.yaml"), "utf8"));
  put(`.history/items/books/gamma.md/${"0".repeat(64)}`, page("Gamma, before"));
  return canon;
}
const check = (f: ReturnType<typeof fixture>, w: { factory: () => Writer }) =>
  seedCheck({ vault: f.vault, outHome: f.outHome, stateDir: f.stateDir, endpointsPath: f.endpointsPath, writer: w.factory });

test("the done gate passes when every page is applied, the edge holds one node per page, the mirror equals out/ and every map is unchanged", async () => {
  const f = fixture();
  const w = fakeWriter();
  await run(f, w, digestOf(PAGES));
  mirrorOf(f, w.pages);
  expect(await check(f, w)).toEqual([]);
});

test("the done gate refuses an applied count short of the page count, and anything refused", async () => {
  // a page the converter wrote after the seed was never applied
  const f = fixture();
  const w = fakeWriter();
  await run(f, w, digestOf(PAGES));
  const more = { ...PAGES, "items/movies/delta.md": page("Delta") };
  f.writeOut(more);
  w.pages.set("items/movies/delta.md", page("Delta")); // the edge and the mirror agree, so only the count speaks
  mirrorOf(f, w.pages);
  expect(await check(f, w)).toEqual(["applied 3 of 4 pages — not applied: items/movies/delta.md"]);

  // the writer refused one page: it is not applied, and the refusal is named
  const g = fixture();
  const v = fakeWriter();
  v.pages.set("items/books/gamma.md", page("Gamma", " · already here"));
  const s = await run(g, v, digestOf(PAGES));
  expect(s.refused).toEqual([{ path: "items/books/gamma.md", reason: "stale-base" }]);
  mirrorOf(g, new Map(Object.entries(PAGES)));
  expect(await check(g, v)).toEqual([
    "applied 2 of 3 pages — not applied: items/books/gamma.md",
    "1 proposal(s) refused — funes outbox lists them: items/books/gamma.md (stale-base)",
  ]);
});

test("the done gate refuses an edge node count that is not the page count, and an edge it cannot ask", async () => {
  const f = fixture();
  const w = fakeWriter();
  await run(f, w, digestOf(PAGES));
  mirrorOf(f, w.pages);
  const short = (): Writer => ({ async call(op, args) { return op === "health" ? { answer: { ...HEALTHY, nodes: 2 } } : w.answer(args); }, async close() {} });
  expect(await check(f, { factory: short })).toEqual(["the edge holds 2 nodes, not the 3 pages"]);
  const other = (): Writer => ({ async call() { return { answer: { ...HEALTHY, nodes: 3, starId: "mcp://rainblow.ing/personal" } }; }, async close() {} });
  expect((await check(f, { factory: other }))[0]).toMatch(/^the edge: refused: the writer serves "mcp:\/\/rainblow.ing\/personal"/);
  const down = (): Writer => ({ async call() { return { error: "fetch failed" }; }, async close() {} });
  expect(await check(f, { factory: down })).toEqual(["the edge: health unanswered (fetch failed)"]);
});

test("the done gate refuses a mirror that is not out/ byte for byte", async () => {
  const f = fixture();
  const w = fakeWriter();
  await run(f, w, digestOf(PAGES));
  // no `funes replica --once` yet
  expect(await check(f, w)).toEqual([`no canon mirror at ${join(f.stateDir, "canon")} — run funes replica --once first`]);

  const missing = new Map(w.pages);
  missing.delete("items/books/gamma.md");
  mirrorOf(f, missing);
  expect(await check(f, w)).toEqual(["the mirror differs from out/: items/books/gamma.md missing"]);

  const changed = new Map(w.pages);
  changed.set("items/books/gamma.md", PAGES["items/books/gamma.md"]!.replace(/\n/g, "\r\n")); // one byte off per line
  changed.set("items/movies/stray.md", page("Stray"));
  mirrorOf(f, changed);
  expect(await check(f, w)).toEqual(["the mirror differs from out/: items/books/gamma.md differs, items/movies/stray.md extra"]);
});

test("the done gate refuses a map whose sha256 is not the manifest's", async () => {
  const f = fixture();
  const w = fakeWriter();
  await run(f, w, digestOf(PAGES));
  mirrorOf(f, w.pages);
  writeFileSync(join(f.inputs, "resources/movies/movies.md"), "# Movies\n\n- [x] Alpha /9\n");
  expect(await check(f, w)).toEqual(["the input resources/movies/movies.md is not the manifest's sha256 — it changed since the converter ran"]);
});

test("`funes seed --check` exits 1 naming every failing condition", async () => {
  const f = fixture();
  const home = mk("funes-seed-check-home-");
  const p = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), "seed", "--check", "--vault", f.vault], {
    env: { ...process.env, TASTE_OUT: f.outHome, FUNES_HOME: home }, stdout: "pipe", stderr: "pipe",
  });
  const [, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  expect(await p.exited).toBe(1);
  expect(err).toContain("applied 0 of 3 pages");
  expect(err).toContain("no writer endpoint");
});

// ── PLAN-0.5.0 item 50: the stub step ────────────────────────────────────────────────────────────

const MAP = "# Movies\n\n- [x] Alpha\n";
const atWriter = { env: { FUNES_LOCUS: "host-a" } as NodeJS.ProcessEnv };
/** A seed that passed its done gate: every page applied, the mirror pulled. */
async function seeded() {
  const f = fixture();
  const w = fakeWriter();
  await run(f, w, digestOf(PAGES));
  mirrorOf(f, w.pages);
  return { f, w };
}
const stub = (f: ReturnType<typeof fixture>, w: { factory: () => Writer }, extra: Partial<Parameters<typeof stubMaps>[0]> = {}) =>
  stubMaps({ vault: f.vault, outHome: f.outHome, stateDir: f.stateDir, endpointsPath: f.endpointsPath, writer: w.factory, ...atWriter, ...extra });

test("the stub step keeps each map's pre-image as a history object and replaces the map with a link page; a re-run finds the stub and does nothing", async () => {
  const { f, w } = await seeded();
  const r = await stub(f, w);
  expect(r).toEqual({ stubbed: ["resources/movies/movies.md"], already: [] });
  const hist = `.history/resources/movies/movies.md/${sha(MAP)}`;
  expect(readFileSync(join(f.inputs, hist), "utf8")).toBe(MAP);
  expect(readFileSync(join(f.inputs, "resources/movies/movies.md"), "utf8")).toBe(
    "---\ntitle: movies\ntype: note\n---\n" +
    `Moved to the taste star mcp://rainblow.ing/taste: 2 pages under items/movies/. The map as it was is kept at ${hist}. Open it in Obsidian: obsidian://open?vault=taste\n`,
  );
  expect(readFileSync(join(f.inputs, "ratings.csv"), "utf8")).toBe("Const,Title\n"); // an import is never a map

  const calls = w.calls.length;
  const stubBytes = readFileSync(join(f.inputs, "resources/movies/movies.md"));
  expect(await stub(f, w)).toEqual({ stubbed: [], already: ["resources/movies/movies.md"] });
  expect(w.calls.length).toBe(calls); // no gate, no edge call
  expect(readFileSync(join(f.inputs, "resources/movies/movies.md"))).toEqual(stubBytes);
});

// RAI-309 test 3: the stub step writes the personal star, so it waits on that star's write lock.
test("the stub step waits while another holder has the personal star's write lock, then stubs", async () => {
  const { f, w } = await seeded();
  const saved = process.env.FUNES_HOME;
  process.env.FUNES_HOME = mk("funes-seed-funes-home-");
  try {
    let release!: () => void;
    const held = withScopedWriteLock(funesDbDir(f.inputs), () => new Promise<void>((r) => { release = r; }));
    await Bun.sleep(10);
    let settled = false;
    const stubbing = stub(f, w).finally(() => { settled = true; });
    await Bun.sleep(300);
    expect(settled).toBe(false);
    expect(readFileSync(join(f.inputs, "resources/movies/movies.md"), "utf8")).toBe(MAP);
    release();
    await held;
    expect(await stubbing).toEqual({ stubbed: ["resources/movies/movies.md"], already: [] });
  } finally {
    if (saved === undefined) delete process.env.FUNES_HOME; else process.env.FUNES_HOME = saved;
  }
});

// RAI-324: the write rule decides, as at every mutation — no special case.
test("the stub step refuses where the write rule refuses (not-write-locus), and writes nothing", async () => {
  const { f, w } = await seeded();
  for (const env of [{ FUNES_LOCUS: "host-b" }, {}]) {
    await expect(stub(f, w, { env: env as NodeJS.ProcessEnv })).rejects.toMatchObject({ code: "not-write-locus", writeLocus: "host-a" });
  }
  expect(readFileSync(join(f.inputs, "resources/movies/movies.md"), "utf8")).toBe(MAP);
  expect(existsSync(join(f.inputs, ".history"))).toBe(false);
});

test("the stub step proceeds on a personal star that declares no write_locus, from any locus or none", async () => {
  const { f, w } = await seeded();
  writeFileSync(join(f.inputs, "star.yaml"), "version: 3\nmeta:\n  id: mcp://rainblow.ing/personal\n");
  expect(await stub(f, w, { env: {} as NodeJS.ProcessEnv })).toEqual({ stubbed: ["resources/movies/movies.md"], already: [] });
});

test("the stub step refuses while the done gate fails, and on a map changed since the converter ran, writing nothing", async () => {
  const { f, w } = await seeded();
  rmSync(join(f.stateDir, "canon"), { recursive: true });
  await expect(stub(f, w)).rejects.toThrow(/run funes replica --once first/);
  mirrorOf(f, w.pages);
  writeFileSync(join(f.inputs, "resources/movies/movies.md"), `${MAP}- [x] Delta\n`);
  await expect(stub(f, w)).rejects.toThrow(/resources\/movies\/movies\.md is neither the manifest's sha256 nor a stub/);
  expect(existsSync(join(f.inputs, ".history"))).toBe(false);
});

test("`funes seed --stub` on stubbed maps does nothing and says so", async () => {
  const { f, w } = await seeded();
  await stub(f, w);
  const p = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), "seed", "--stub", "--vault", f.vault], {
    env: { ...process.env, FUNES_LOCUS: "host-a", TASTE_OUT: f.outHome, FUNES_HOME: mk("funes-seed-stub-home-") }, stdout: "pipe", stderr: "pipe",
  });
  const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  expect(await p.exited).toBe(0);
  expect(out).toContain("already a stub: resources/movies/movies.md");
  expect(out).toContain("nothing to do");
});

test("`funes seed --stub` from a non-writer locus exits 3 (refused) and writes nothing", async () => {
  const { f } = await seeded();
  const p = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), "seed", "--stub", "--vault", f.vault], {
    env: { ...process.env, FUNES_LOCUS: "host-b", TASTE_OUT: f.outHome, FUNES_HOME: mk("funes-seed-stub-home-") }, stdout: "pipe", stderr: "pipe",
  });
  const [, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  expect(await p.exited).toBe(3);
  expect(err).toContain("not-write-locus: operation seed --stub");
  expect(readFileSync(join(f.inputs, "resources/movies/movies.md"), "utf8")).toBe(MAP);
});
