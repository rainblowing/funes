import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";


// PLAN-0.5.0 item 29 — the refusal path (ADR-0010 §Revision, "Only the taste star…" and the replica
// bullet; record 29 §5). Record 35 R9: a funes CLI or MCP mutation against `~/taste` from any process
// other than the replica refuses and names `funes-taste`, in four cases, and leaves no outbox record.
// Spawned under a throwaway HOME, so the writer-endpoint file is `$HOME/.funes/endpoints.json` exactly
// as on the proposer machine, and nothing the suite does can read or write the real funes home.

const REPO = resolve(import.meta.dir, "..", "..", "..");
const CLI = join(import.meta.dir, "cli.ts");
const MCP = join(import.meta.dir, "mcp.ts");
const TASTE = "mcp://rainblow.ing/taste";

/** The proposer machine's shape: `~/taste` with its 0444 copy of the taste star.yaml, and a 0600 endpoint file whose
 *  entry for the taste star names the edge writer. */
function proposerMachine(): { home: string; taste: string; endpoints: string } {
  const home = mkdtempSync(join(tmpdir(), "funes-r9-home-"));
  const taste = join(home, "taste");
  mkdirSync(join(taste, "items", "film"), { recursive: true });
  writeFileSync(join(taste, "star.yaml"), `version: 3\nmeta:\n  id: ${TASTE}\n  name: taste\n  write_locus: funes-taste\n`, { mode: 0o444 });
  writeFileSync(join(taste, "items", "film", "stalker.md"), "---\ntitle: Stalker\n---\n\nTarkovsky.\n");
  mkdirSync(join(home, ".funes"));
  const token = join(home, ".funes", "taste-outbox.token");
  writeFileSync(token, "t\n", { mode: 0o600 });
  const endpoints = join(home, ".funes", "endpoints.json");
  writeFileSync(endpoints, JSON.stringify({ [TASTE]: { url: "https://taste.example", token_file: token } }), { mode: 0o600 });
  return { home, taste, endpoints };
}

/** The R9 cases: the environment each process runs with, and what is done to the endpoint file.
 *  RAI-324: the write rule refuses through the taste star's `write_locus: funes-taste` — the hostname
 *  locus is not it — and reads no endpoint file, so an unreadable one changes nothing. */
const CASES: Array<{ name: string; env: Record<string, string>; unreadable?: boolean }> = [
  { name: "no FUNES_LOCUS (the hostname locus)", env: {} },
  { name: "an unreadable endpoint file", env: {}, unreadable: true },
];

function envFor(f: ReturnType<typeof proposerMachine>, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const k of ["FUNES_LOCUS", "FUNES_HOME"]) delete env[k];
  return { ...env, HOME: f.home, ...extra };
}

/** Every path under `dir`, so "no outbox record" is checked wherever one could have been written. */
function walk(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: false }) as string[];
}

for (const c of CASES) {
  test(`R9 (CLI): \`funes forget\` against ~/taste refuses and names funes-taste — ${c.name}`, async () => {
    const f = proposerMachine();
    try {
      if (c.unreadable) chmodSync(f.endpoints, 0o000);
      const proc = Bun.spawn(["bun", CLI, "forget", "items/film/stalker", "--vault", f.taste], { cwd: REPO, env: envFor(f, c.env), stdout: "pipe", stderr: "pipe" });
      const [, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect(await proc.exited).not.toBe(0);
      expect(err).toContain("not-write-locus");
      expect(err).toContain('the star\'s writer is "funes-taste"');
      expect(err).not.toContain("https://taste.example"); // no endpoint: the rule reads no endpoint file
      expect(walk(f.home).some((p) => p.split("/").includes("outbox"))).toBe(false);
      expect(walk(f.taste).sort()).toEqual(["items", "items/film", "items/film/stalker.md", "star.yaml"]);
    } finally {
      chmodSync(f.endpoints, 0o600);
      rmSync(f.home, { recursive: true, force: true });
    }
  }, 30_000);
}

// twinkl.ing's host builds a folder context; the engine's folderContext resolves this process's
// locus (RAI-313: --locus over FUNES_LOCUS over the short hostname, never in the kernel). A locus that
// is not the star's write_locus refuses on a declared star.
test("R9 (a host's own context): dispatchToolCall from a locus that is not the writer refuses at ~/taste — not-write-locus, writeLocus, no endpoint", async () => {
  const f = proposerMachine();
  try {
    const script = `
      const { folderContext } = await import(${JSON.stringify(join(import.meta.dir, "funes-store.ts"))});
      const { dispatchToolCall } = await import("funes-core");
      const { operations } = await import("funes-core/internal");
      const ctx = folderContext({ vault: ${JSON.stringify(f.taste)}, store: {} });
      try { await dispatchToolCall("forget", { id: "items/film/stalker" }, ctx); console.log("WROTE"); }
      catch (e) { console.log(JSON.stringify({ code: e.code, writeLocus: e.writeLocus, hasEndpoint: "endpoint" in e })); }`;
    const proc = Bun.spawn(["bun", "-e", script], { cwd: import.meta.dir, env: envFor(f, { FUNES_LOCUS: "replica" }), stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    expect(JSON.parse(out)).toEqual({ code: "not-write-locus", writeLocus: "funes-taste", hasEndpoint: false });
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
}, 30_000);

/** One `tools/call` over a spawned stdio server: newline-delimited JSON-RPC, matched by id. */
async function mcpCall(env: Record<string, string>, vault: string, name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> {
  const proc = Bun.spawn(["bun", MCP, "--vault", vault], { cwd: REPO, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const send = (o: Record<string, unknown>) => { proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...o })}\n`); proc.stdin.flush(); };
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const reply = async (id: number): Promise<Record<string, unknown>> => {
    for (;;) {
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        try { const m = JSON.parse(line) as Record<string, unknown>; if (m.id === id) return m; } catch { /* not ours */ }
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("mcp server exited before replying");
      buf += dec.decode(value, { stream: true });
    }
  };
  try {
    send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "r9", version: "0" } } });
    await reply(1);
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/call", params: { name, arguments: args } });
    const r = (await reply(2)).result as { isError?: boolean; content?: Array<{ text: string }> };
    return { isError: r?.isError, text: r?.content?.[0]?.text ?? "" };
  } finally {
    proc.kill();
    await proc.exited;
  }
}

for (const c of CASES) {
  test(`R9 (MCP): a stdio \`remember\` against ~/taste refuses and names funes-taste — ${c.name}`, async () => {
    const f = proposerMachine();
    try {
      if (c.unreadable) chmodSync(f.endpoints, 0o000);
      const r = await mcpCall(envFor(f, c.env), f.taste, "remember", { title: "Solaris", body: "Tarkovsky, 1972." });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('the star\'s writer is "funes-taste"');
      expect(walk(f.home).some((p) => p.split("/").includes("outbox"))).toBe(false);
      expect(walk(f.taste).sort()).toEqual(["items", "items/film", "items/film/stalker.md", "star.yaml"]);
    } finally {
      chmodSync(f.endpoints, 0o600);
      rmSync(f.home, { recursive: true, force: true });
    }
  }, 30_000);
}

// PLAN-0.5.0 item 58, record 35 C6: the reader container (a reader locus such as the image's, no endpoint
// file, no token) — every mutation against the taste star refuses over stdio MCP and names the write
// locus, with no outbox record and no file write — the write rule's refusal.
for (const [name, args] of [
  ["remember", { title: "Solaris", body: "Tarkovsky, 1972." }],
  ["put_page", { path: "items/film/solaris.md", content: "---\ntitle: Solaris\n---\n\nTarkovsky.\n" }],
  ["forget", { id: "items/film/stalker" }],
] as const) {
  test(`C6 (container): a stdio \`${name}\` at a reader locus refuses and names funes-taste`, async () => {
    const f = proposerMachine();
    try {
      rmSync(join(f.home, ".funes"), { recursive: true, force: true });
      const r = await mcpCall(envFor(f, { FUNES_LOCUS: "reader-container" }), f.taste, name, args);
      expect(r.isError).toBe(true);
      expect(r.text).toContain('the star\'s writer is "funes-taste"');
      expect(r.text).toContain("reader-container");
      expect(walk(f.home).some((p) => p.split("/").includes("outbox"))).toBe(false);
      expect(walk(f.taste).sort()).toEqual(["items", "items/film", "items/film/stalker.md", "star.yaml"]);
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  }, 30_000);
}

// RAI-324 (RAI-302): on the writer machine a plain shell — no FUNES_LOCUS, no --locus — writes to a
// star whose write_locus is this machine's short hostname. `hostname -s` is the operator's own name
// for the machine, an independent source for what the CLI must resolve.
test("the writer machine: a shell with FUNES_LOCUS unset writes to a star whose write_locus is `hostname -s`", async () => {
  const short = Bun.spawnSync(["hostname", "-s"]).stdout.toString().trim();
  const vault = mkdtempSync(join(tmpdir(), "funes-host-writer-"));
  const idx = mkdtempSync(join(tmpdir(), "funes-host-writer-idx-"));
  try {
    writeFileSync(join(vault, "star.yaml"), `meta:\n  id: git://example/host-writer\n  write_locus: ${short}\n`);
    mkdirSync(join(vault, "out_memory"));
    writeFileSync(join(vault, "out_memory", "note.md"), "---\ntitle: Note\ntrust: untrusted\n---\n\nbody\n");
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    delete env.FUNES_LOCUS;
    const proc = Bun.spawn(["bun", CLI, "forget", "out_memory/note", "--vault", vault], {
      cwd: REPO, env: { ...env, FUNES_HOME: idx }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect({ code: await proc.exited, err }).toMatchObject({ code: 0 });
    expect(out).toBe("id: out_memory/note\nforgotten: true\n"); // the op answer, as YAML
    expect(err).not.toContain("locus="); // RAI-302: an allowed write is silent — no audit line
    expect(readFileSync(join(vault, "out_memory", "note.md"), "utf8")).toContain("forgotten: true");
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(idx, { recursive: true, force: true });
  }
}, 30_000);
