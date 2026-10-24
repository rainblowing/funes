// B10a (RAI-347; RAI-312, RAI-314 Q7/Q10, ADR-0019): `funes serve` with `memory.tier: org`. The org
// star's pages are rows in its Turso database (the RowVault); many actors write through the one
// server; a migration builds the shadow slot inside serve and refuses writes `building` until the flip.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Embedder } from "funes-core";
import { isPagePath, operations } from "funes-core/internal";
import { startServe, type RunningServe } from "./serve.ts";

class FakeEmbedder implements Embedder {
  readonly dim = 16;
  readonly id: string = "org-fake";
  protected vec(t: string): Float32Array {
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

const tmp: string[] = [];
const env: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ["FUNES_HOME", "FUNES_LOCUS"]) env[k] = process.env[k];
  process.env.FUNES_HOME = dir("funes-org-home-");
  process.env.FUNES_LOCUS = "org-host";
});
afterAll(() => {
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});
const dir = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d; };
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const ORG_OPS = ["forget", "health", "indexed_page", "page", "recall", "remember", "supersede"];

/** An org star: its star.yaml and a v2 access file with two curators. Its pages are rows, so the
 *  folder holds no page; the markdown export goes to `exportDir` (RAI-322), a fresh directory unless
 *  given (null: the key is absent). */
function orgStar(memory = "  memory_dir: out_memory\n", exportDir: string | null = join(dir("funes-org-out-"), "export")): { vault: string; access: string; exportDir: string } {
  const vault = dir("funes-org-star-");
  const exp = exportDir === null ? "" : `  export_dir: ${JSON.stringify(exportDir)}\n`;
  writeFileSync(join(vault, "star.yaml"), `# the org test star\nmeta:\n  id: rainblow.ing/org-test\n  write_locus: org-host # the server\nmemory:\n  tier: org\n  substrate: turso\n${memory}${exp}`);
  const access = join(vault, ".access.json");
  writeFileSync(access, JSON.stringify({
    version: 2,
    roles: { curator: { ops: ORG_OPS } },
    actors: Object.fromEntries(["alice", "bob"].map((a) => [a, { token_sha256: sha(`tok-${a}`), role: "curator", stars: ["*"] }])),
  }));
  chmodSync(access, 0o600);
  return { vault, access, exportDir: exportDir ?? "" };
}

async function rpc(s: RunningServe, token: string, method: string, params: Record<string, unknown> = {}) {
  const r = await fetch(`${s.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": method,
      ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}), authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method,
      params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "org-test", version: "0" } } },
    }),
  });
  const text = await r.text();
  return (text.startsWith("event:") ? JSON.parse(text.split("\n").find((l) => l.startsWith("data: "))!.slice(6)) : JSON.parse(text)) as { result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean } };
}
/** One tool call's answer: the JSON text, and whether it is a tool error. */
async function call(s: RunningServe, token: string, name: string, args: Record<string, unknown>) {
  const b = await rpc(s, token, "tools/call", { name, arguments: args });
  return { error: b.result?.isError === true, json: JSON.parse(b.result?.content?.[0]?.text ?? "null") };
}

test("an org star: one funes serve over Turso serves the org ceiling, and two concurrent clients keep both writes", async () => {
  const { vault, access } = orgStar();
  const s = await startServe({ vault, bind: "127.0.0.1", port: 0, access, embedder: new FakeEmbedder() });
  try {
    expect((await rpc(s, "tok-alice", "tools/list")).result!.tools!.map((t) => t.name).sort()).toEqual(ORG_OPS);
    const writes = await Promise.all(["alice", "bob"].flatMap((a) => [1, 2, 3].map((i) =>
      call(s, `tok-${a}`, "remember", { title: `${a} note ${i}`, body: `${a} wrote sourdough note ${i}` }))));
    expect(writes.filter((w) => w.error)).toEqual([]);
    const ids = writes.map((w) => w.json.id as string);
    expect(new Set(ids).size).toBe(6);
    for (const id of ids) {
      const page = await call(s, "tok-bob", "indexed_page", { id });
      expect(page.error, id).toBe(false);
      expect(page.json.writeActor).toBe("unknown"); // R11: a multi-actor server stamps no actor
      expect((await call(s, "tok-alice", "page", { path: `${id}.md` })).json.body).toContain("sourdough note");
    }
    expect((await call(s, "tok-alice", "recall", { query: "bob sourdough note 2", k: 6 })).json.results.map((r: { id: string }) => r.id)).toContain(ids[4]);
    const health = (await call(s, "tok-alice", "health", {})).json;
    expect(health).toMatchObject({ nodes: 6, freshnessBasis: "stat", vaultChangedSinceReindex: false, reindexDirty: false });
    expect(health.servingSignature).toStartWith("turso:");
    // the org ceiling: no folder op and no put_page
    expect((await call(s, "tok-alice", "tree", {})).error).toBe(true);
  } finally {
    await s.close();
  }
}, 30_000);

test("an org star refuses to serve without memory.memory_dir, and its index refuses every local open", async () => {
  const { vault } = orgStar("");
  await expect(startServe({ vault, bind: "127.0.0.1", port: 0, embedder: new FakeEmbedder() })).rejects.toThrow(/memory_dir/);
  const { reindex } = await import("./reindex.ts");
  const ok = orgStar();
  await expect(reindex(ok.vault, { embedder: new FakeEmbedder() })).rejects.toThrow(/org.*funes serve/);
});

test("a migration at org: serve on a new embedder builds the shadow slot, and writes answer 503 building until the flip", async () => {
  const { vault, access } = orgStar();
  const first = await startServe({ vault, bind: "127.0.0.1", port: 0, access, embedder: new FakeEmbedder() });
  const before = await Promise.all([1, 2, 3].map((i) => call(first, "tok-alice", "remember", { title: `Old ${i}`, body: `old crumb ${i}` })));
  expect(before.filter((w) => w.error)).toEqual([]);
  await first.close();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  class Gated extends FakeEmbedder {
    override readonly id = "org-fake-2";
    override async embedPassages(ts: string[]) { await gate; return super.embedPassages(ts); }
  }
  const s = await startServe({ vault, bind: "127.0.0.1", port: 0, access, embedder: new Gated() });
  try {
    const refused = await call(s, "tok-bob", "remember", { title: "New", body: "new crumb" });
    expect(refused.error).toBe(true);
    expect(refused.json).toMatchObject({ status: 503, code: "building" });
    expect((await call(s, "tok-bob", "recall", { query: "old crumb" })).error).toBe(false); // the live slot still serves
    release();
    let w = refused;
    for (let i = 0; i < 100 && w.error; i++) { await Bun.sleep(50); w = await call(s, "tok-bob", "remember", { title: "New", body: "new crumb" }); }
    expect(w.error).toBe(false);
    const health = (await call(s, "tok-bob", "health", {})).json;
    expect(health.nodes).toBe(4);
    expect(health.embeddingSignature).toStartWith("org-fake-2:");
  } finally {
    await s.close();
  }
}, 30_000);

// ── B10b (RAI-348; RAI-322, ADR-0019): the org markdown export ──────────────────────────────────

/** Every page file in the export, path → text (`isPagePath` names: no dot segment, no index.md). */
function exportPages(exportDir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of readdirSync(exportDir, { recursive: true }) as string[]) {
    if (isPagePath(rel) && statSync(join(exportDir, rel)).isFile()) out.set(rel, readFileSync(join(exportDir, rel), "utf8"));
  }
  return out;
}
/** The row bytes the server answers for each path, as UTF-8 text. */
async function rowTexts(s: RunningServe, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const p of paths) out.set(p, (await call(s, "tok-alice", "page", { path: p, raw: true })).json.content);
  return out;
}
const remember = async (s: RunningServe, title: string) => {
  const w = await call(s, "tok-alice", "remember", { title, body: `${title} body text` });
  expect(w.error, JSON.stringify(w.json)).toBe(false);
  return `${w.json.id as string}.md`;
};
const exportDirty = async (s: RunningServe) => (await call(s, "tok-bob", "health", {})).json.exportDirty;

test("the export: every acknowledged org write is byte-equal in the export, mode 0444, beside a derived star.yaml and the marker", async () => {
  const { vault, access, exportDir } = orgStar();
  const s = await startServe({ vault, bind: "127.0.0.1", port: 0, access, embedder: new FakeEmbedder() });
  try {
    const paths: string[] = [];
    for (const t of ["rye", "spelt", "einkorn"]) {
      paths.push(await remember(s, t));
      expect(exportPages(exportDir)).toEqual(await rowTexts(s, paths)); // after EVERY acknowledged write
    }
    const sup = await call(s, "tok-bob", "supersede", { oldId: paths[0]!.slice(0, -3), title: "rye v2", body: "rye, revised" });
    expect(sup.error, JSON.stringify(sup.json)).toBe(false);
    expect((await call(s, "tok-bob", "forget", { id: paths[1]!.slice(0, -3) })).error).toBe(false);
    paths.push(`${sup.json.id as string}.md`);
    expect(exportPages(exportDir)).toEqual(await rowTexts(s, paths));
    for (const p of paths) expect(statSync(join(exportDir, p)).mode & 0o777).toBe(0o444);
    expect(await exportDirty(s)).toBe(false);
    // the derived star.yaml: no tier, substrate or export_dir; the write locus `<w>.export`; comments kept
    const derived = readFileSync(join(exportDir, "star.yaml"), "utf8");
    expect(derived).toBe("# the org test star\nmeta:\n  id: rainblow.ing/org-test\n  write_locus: org-host.export # the server\nmemory:\n  memory_dir: out_memory\n");
    expect(JSON.parse(readFileSync(join(exportDir, ".funes-export"), "utf8"))).toEqual({ id: "rainblow.ing/org-test" });
    // RAI-308 amended (C8): an org health answer parses against the strict schema, and its tier key
    // is disjoint from the contract keys
    const health = (await call(s, "tok-bob", "health", {})).json;
    operations.find((o) => o.name === "health")!.result!.parse(health);
    expect(Object.keys(health).filter((k) => k === "exportDirty")).toEqual(["exportDirty"]);
  } finally {
    await s.close();
  }
}, 30_000);

test("the export: an unwritable export dir answers the write with exportDirty; the next write after the fix clears it", async () => {
  const { vault, access, exportDir } = orgStar();
  const s = await startServe({ vault, bind: "127.0.0.1", port: 0, access, embedder: new FakeEmbedder() });
  try {
    chmodSync(exportDir, 0o555);
    const first = await remember(s, "barley"); // committed and answered, never exported
    expect(await exportDirty(s)).toBe(true);
    expect(existsSync(join(exportDir, first))).toBe(false);
    chmodSync(exportDir, 0o755);
    const second = await remember(s, "oats");
    expect(await exportDirty(s)).toBe(false);
    expect(exportPages(exportDir)).toEqual(await rowTexts(s, [first, second])); // the retry set ran
  } finally {
    chmodSync(exportDir, 0o755);
    await s.close();
  }
}, 30_000);

test("the export: kill -9 after the commit and before the rename loses nothing — the next start writes the file", async () => {
  const { vault, access, exportDir } = orgStar();
  const script = join(dir("funes-org-child-"), "child.ts");
  writeFileSync(script, `
import { startServe } from ${JSON.stringify(join(import.meta.dir, "serve.ts"))};
class E { dim = 16; id = "org-fake";
  vec(t) { const v = new Float32Array(16); for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) v[[...w].reduce((a, c) => a + c.charCodeAt(0), 0) % 16] += 1; let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); }
  async embedQuery(t) { return this.vec(t); } async embedPassage(t) { return this.vec(t); } async embedPassages(ts) { return ts.map((t) => this.vec(t)); } }
const s = await startServe({ vault: ${JSON.stringify(vault)}, bind: "127.0.0.1", port: 0, access: ${JSON.stringify(access)}, embedder: new E() });
console.log(s.url);
`);
  const child = Bun.spawn(["bun", script], { env: process.env, stdout: "pipe", stderr: "inherit" });
  let s: RunningServe | null = null;
  try {
    const reader = child.stdout.getReader();
    const url = new TextDecoder().decode((await reader.read()).value).trim();
    const remote = { url } as RunningServe;
    const kept = await remember(remote, "millet");
    chmodSync(join(exportDir, "out_memory"), 0o555); // the next export stops after its commit, as a crash before the rename does
    const lost = await remember(remote, "sorghum");
    child.kill("SIGKILL");
    await child.exited;
    chmodSync(join(exportDir, "out_memory"), 0o755);
    writeFileSync(join(exportDir, "out_memory", `.${lost.split("/").pop()}.4242.0.tmp`), "half"); // a temp the crash left
    expect(existsSync(join(exportDir, lost))).toBe(false);
    s = await startServe({ vault, bind: "127.0.0.1", port: 0, access, embedder: new FakeEmbedder() });
    expect(exportPages(exportDir)).toEqual(await rowTexts(s, [kept, lost]));
    expect(await exportDirty(s)).toBe(false); // a temp is not a page, so not a stray
  } finally {
    child.kill("SIGKILL");
    if (existsSync(join(exportDir, "out_memory"))) chmodSync(join(exportDir, "out_memory"), 0o755);
    await s?.close();
  }
}, 30_000);

test("the export: a stray survives the reconcile and sets exportDirty; index.md, README.md and .git/ are never touched", async () => {
  const { vault, access, exportDir } = orgStar();
  const first = await startServe({ vault, bind: "127.0.0.1", port: 0, access, embedder: new FakeEmbedder() });
  const page = await remember(first, "teff");
  await first.close();
  const foreign = { "index.md": "# index\n", "README.md": "# readme\n", ".git/HEAD": "ref: refs/heads/main\n", "out_memory/stray.md": "a page with no row\n" };
  for (const [rel, text] of Object.entries(foreign)) { mkdirSync(dirname(join(exportDir, rel)), { recursive: true }); writeFileSync(join(exportDir, rel), text); }
  chmodSync(join(exportDir, page), 0o644);
  writeFileSync(join(exportDir, page), "an outside edit\n"); // an owned file: the start overwrites it
  const s = await startServe({ vault, bind: "127.0.0.1", port: 0, access, embedder: new FakeEmbedder() });
  try {
    expect(await exportDirty(s)).toBe(true);
    for (const [rel, text] of Object.entries(foreign)) expect(readFileSync(join(exportDir, rel), "utf8")).toBe(text);
    expect(readFileSync(join(exportDir, page), "utf8")).toBe((await rowTexts(s, [page])).get(page)!);
    await remember(s, "fonio");
    expect(await exportDirty(s)).toBe(true); // a write never deletes a stray; the operator does
    for (const rel of ["out_memory/stray.md", "README.md"]) rmSync(join(exportDir, rel)); // the two strays
    expect(await exportDirty(s)).toBe(false); // …and health sees the removal at once, with no restart
  } finally {
    await s.close();
  }
}, 30_000);

test("the export: serve start refuses a bad export_dir", async () => {
  const start = (vault: string) => startServe({ vault, bind: "127.0.0.1", port: 0, embedder: new FakeEmbedder() });
  await expect(start(orgStar(undefined, null).vault)).rejects.toThrow(/memory\.tier: org requires memory\.export_dir/);
  await expect(start(orgStar(undefined, "relative/export").vault)).rejects.toThrow(/export_dir.*absolute/);
  const full = join(dir("funes-org-out-"), "full");
  mkdirSync(full); writeFileSync(join(full, "notes.md"), "mine\n");
  await expect(start(orgStar(undefined, full).vault)).rejects.toThrow(/not empty.*\.funes-export/);
  const foreign = join(dir("funes-org-out-"), "foreign");
  mkdirSync(foreign); writeFileSync(join(foreign, ".funes-export"), JSON.stringify({ id: "rainblow.ing/other" }));
  await expect(start(orgStar(undefined, foreign).vault)).rejects.toThrow(/rainblow\.ing\/other/);
  const self = orgStar();
  for (const bad of [self.vault, join(self.vault, "export"), dirname(self.vault), join(process.env.FUNES_HOME!, "export")]) {
    writeFileSync(join(self.vault, "star.yaml"), readFileSync(join(self.vault, "star.yaml"), "utf8").replace(/export_dir: .*/, `export_dir: ${JSON.stringify(bad)}`));
    await expect(start(self.vault), bad).rejects.toThrow(/export_dir/);
  }
  const twin = orgStar();
  const same = join(dir("funes-org-out-"), basename(twin.vault));
  writeFileSync(join(twin.vault, "star.yaml"), readFileSync(join(twin.vault, "star.yaml"), "utf8").replace(/export_dir: .*/, `export_dir: ${JSON.stringify(same)}`));
  await expect(start(twin.vault)).rejects.toThrow(/basename/);
});

test("the export: funes remember on it refuses not-write-locus naming <server>.export, on the server host and off it; its reindex gives the org ids and zones", async () => {
  const { vault, access, exportDir } = orgStar();
  const s = await startServe({ vault, bind: "127.0.0.1", port: 0, access, embedder: new FakeEmbedder() });
  const paths = [await remember(s, "quinoa"), await remember(s, "amaranth")];
  await s.close();
  for (const locus of ["org-host", "laptop"]) {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), "remember", "--title", "t", "--body", "b", "--vault", exportDir], {
      env: { ...process.env, FUNES_LOCUS: locus }, stdout: "pipe", stderr: "pipe",
    });
    const [err, code] = [await new Response(proc.stderr).text(), await proc.exited];
    expect(code, err).toBe(3);
    expect(err).toContain('not-write-locus: operation remember: this locus is not the write locus — the star\'s writer is "org-host.export"');
  }
  const { reindex } = await import("./reindex.ts");
  const { makeStore } = await import("./factory.ts");
  const { openOrgStar } = await import("./org-store.ts");
  await reindex(exportDir, { embedder: new FakeEmbedder() });
  const copy = await makeStore({ vault: exportDir, embedder: new FakeEmbedder() });
  const org = await openOrgStar({ vault, embedder: new FakeEmbedder() });
  try {
    expect((await copy.stats()).zones).toEqual((await org.store.stats()).zones);
    expect((await copy.stats()).nodes).toBe(paths.length);
    for (const p of paths) expect((await copy.indexedPage({ path: p }))?.id).toBe((await org.store.indexedPage({ path: p }))!.id);
  } finally {
    await copy.close();
    await org.close();
  }
}, 60_000);

test("the restore drill: stop serve, copy index.db and its -wal, start serve on the copy — the rows are byte-equal", async () => {
  const { vault, access, exportDir } = orgStar();
  const s = await startServe({ vault, bind: "127.0.0.1", port: 0, access, embedder: new FakeEmbedder() });
  const paths = [await remember(s, "buckwheat"), await remember(s, "kamut")];
  const before = await rowTexts(s, paths);
  await s.close();
  const { funesDbDir } = await import("./factory.ts");
  const db = funesDbDir(vault);
  const home = process.env.FUNES_HOME;
  const restored = dir("funes-org-restore-");
  process.env.FUNES_HOME = restored;
  try {
    mkdirSync(dirname(funesDbDir(vault)), { recursive: true });
    for (const f of ["", "-wal"]) if (existsSync(db + f)) copyFileSync(db + f, funesDbDir(vault) + f);
    rmSync(exportDir, { recursive: true }); // the export is rebuilt from the rows at the start
    const back = await startServe({ vault, bind: "127.0.0.1", port: 0, access, embedder: new FakeEmbedder() });
    try {
      expect(await rowTexts(back, paths)).toEqual(before);
      expect(exportPages(exportDir)).toEqual(before);
    } finally {
      await back.close();
    }
  } finally {
    process.env.FUNES_HOME = home;
  }
}, 30_000);
