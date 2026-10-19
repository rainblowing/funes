import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { assertReplicaLocation } from "./sync-root.ts";

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
function proposerMachine(): { home: string; taste: string; endpoints: string; idx: string } {
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
  const idx = mkdtempSync(join(tmpdir(), "funes-r9-idx-"));
  return { home, taste, endpoints, idx };
}

/** The four R9 cases: the environment each process runs with, and what is done to the endpoint file. */
const CASES: Array<{ name: string; env: Record<string, string>; unreadable?: boolean }> = [
  { name: "no FUNES_LOCUS", env: {} },
  { name: "FUNES_WRITE_DESIGNATION=off", env: { FUNES_WRITE_DESIGNATION: "off" } },
  { name: "FUNES_LOCUS=funes-taste", env: { FUNES_LOCUS: "funes-taste" } },
  { name: "an unreadable endpoint file", env: {}, unreadable: true },
];

function envFor(f: ReturnType<typeof proposerMachine>, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const k of ["FUNES_LOCUS", "FUNES_WRITE_DESIGNATION", "FUNES_ACTOR", "FUNES_STATE_DIR", "FUNES_LOCK_DIR"]) delete env[k];
  return { ...env, HOME: f.home, FUNES_BACKEND: "libsql", FUNES_LIBSQL_DIR: f.idx, FUNES_DAEMON_PORT: "1", ...extra };
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
      expect(err).toContain('the star\'s writer is "funes-taste"');
      if (c.unreadable) expect(err).toContain("endpoint file cannot be read");
      else expect(err).toContain("https://taste.example");
      expect(walk(f.home).some((p) => p.split("/").includes("outbox"))).toBe(false);
      expect(walk(f.taste).sort()).toEqual(["items", "items/film", "items/film/stalker.md", "star.yaml"]);
    } finally {
      chmodSync(f.endpoints, 0o600);
      rmSync(f.home, { recursive: true, force: true });
      rmSync(f.idx, { recursive: true, force: true });
    }
  }, 30_000);
}

// The daemon and twinkl.ing's host build a folder context with no designation; dispatchToolCall
// resolves one on the first call, and that resolution reads the endpoint file too.
test("R9 (a host's own context): dispatchToolCall over folderContext with no designation refuses at ~/taste", async () => {
  const f = proposerMachine();
  try {
    const script = `
      const { folderContext } = await import(${JSON.stringify(join(import.meta.dir, "funes-store.ts"))});
      const { dispatchToolCall, folderOperations } = await import(${JSON.stringify(join(import.meta.dir, "ops.ts"))});
      const ctx = folderContext({ vault: ${JSON.stringify(f.taste)}, store: {}, trust: "untrusted", remote: true });
      try { await dispatchToolCall(folderOperations, "forget", { id: "items/film/stalker" }, ctx); console.log("WROTE"); }
      catch (e) { console.log(JSON.stringify({ code: e.code, writeLocus: e.writeLocus, endpoint: e.endpoint })); }`;
    const proc = Bun.spawn(["bun", "-e", script], { cwd: REPO, env: envFor(f, {}), stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    expect(JSON.parse(out)).toEqual({ code: "not-write-locus", writeLocus: "funes-taste", endpoint: "https://taste.example" });
  } finally {
    rmSync(f.home, { recursive: true, force: true });
    rmSync(f.idx, { recursive: true, force: true });
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
      rmSync(f.idx, { recursive: true, force: true });
    }
  }, 30_000);
}

// PLAN-0.5.0 item 58, record 35 C6: the reader container (a reader locus such as the image's, no endpoint
// file, no token) — every mutation against the taste star refuses over stdio MCP and names the write
// locus, with no outbox record and no file write. Not a proposer: the refusal is the `mismatch` one.
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
      rmSync(f.idx, { recursive: true, force: true });
    }
  }, 30_000);
}

// Record 29 §2: the replica's paths — `~/taste`, the canon mirror, the endpoint file, every token and
// credential file, and `stateDirFor` — refuse inside a synced or versioned tree. The walk starts at the
// PARENT, so `~/taste` holding its own star.yaml is not refused by it.
test("location refusal: outside every synced, versioned or star tree it passes; inside one it refuses and names why", () => {
  const home = mkdtempSync(join(tmpdir(), "funes-loc-home-"));
  try {
    const at = (...p: string[]) => { const path = join(home, ...p); mkdirSync(path, { recursive: true }); return path; };
    const taste = at("taste");
    writeFileSync(join(taste, "star.yaml"), "meta:\n  id: mcp://rainblow.ing/taste\n");
    for (const ok of [taste, join(home, ".funes", "endpoints.json"), join(at(".funes", "state", "taste-0123456789"), "canon")]) {
      expect(() => assertReplicaLocation(ok, home), ok).not.toThrow();
    }
    const refused: Array<[string, RegExp]> = [
      [join(at("Documents"), "taste"), /Documents/],
      [join(at("Desktop"), "taste"), /Desktop/],
      [join(at("Library", "Mobile Documents"), "taste"), /Mobile Documents/],
      [join(at("Library", "CloudStorage", "Dropbox-Personal"), "taste"), /CloudStorage/],
      [join(at("code", "repo", "sub"), "taste"), /\.git/],
      [join(at("Sync"), "endpoints.json"), /\.stfolder/],
      [join(at("vault", "deep"), "taste"), /star\.yaml/],
    ];
    mkdirSync(join(home, "code", "repo", ".git"));
    writeFileSync(join(home, "Sync", ".stfolder"), "");
    writeFileSync(join(home, "vault", "star.yaml"), "meta:\n  name: personal\n");
    for (const [path, why] of refused) {
      expect(() => assertReplicaLocation(path, home), path).toThrow(why);
      expect(() => assertReplicaLocation(path, home), path).toThrow(/fail-closed/);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
