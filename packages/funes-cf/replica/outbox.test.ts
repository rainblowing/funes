// PLAN-0.5.0 item 30 (ADR-0010 §Revision "The outbox"; record 22 7a-7c; record 29 §4c, §6): the
// outbox against a fake writer and a fake clock — offline 1 day drains, offline 8 days expires
// (record 35 R10), and a revoked token halts the endpoint (R11).
import { test, expect, afterAll } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approve, dismiss, drain, enqueue, listOutbox, mcpWriter, outboxDirFor, resend as resendMark, showRecord, type Writer, type WriterReply } from "./outbox.ts";
import { readEndpoints } from "./endpoints.ts";
import { ulidTime } from "funes-core/internal";

const STAR = "mcp://rainblow.ing/taste";
const TOKEN = "funes_" + "T".repeat(43);
const T0 = Date.parse("2026-10-13T09:00:00Z");
const DAY = 86_400_000;
const tmp: string[] = [];
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const mk = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d; };

/** A replica folder (its star.yaml names the star and the write locus), an outbox dir, and a 0600
 *  endpoint file whose entry names a 0600 token file. */
function fixture() {
  const vault = mk("funes-outbox-vault-");
  writeFileSync(join(vault, "star.yaml"), `version: 3\nmeta:\n  id: ${STAR}\n  write_locus: funes-taste\n`);
  const home = mk("funes-outbox-home-");
  const tokenFile = join(home, "taste.token");
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const endpointsPath = join(home, "endpoints.json");
  writeFileSync(endpointsPath, JSON.stringify({ [STAR]: { url: "https://taste.example", token_file: tokenFile } }), { mode: 0o600 });
  return { vault, dir: join(home, "outbox"), endpointsPath, tokenFile };
}

const HEALTHY = { proposalProtocol: 1, starId: STAR, locus: "funes-taste", applyState: "idle" };

/** A fake writer: `health` answers `health`, every proposal goes to `answer`; it records each call
 *  and the token it was built with. */
function fakeWriter(o: { health?: () => WriterReply; answer?: (op: string, args: Record<string, unknown>) => WriterReply } = {}) {
  const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  const tokens: string[] = [];
  const factory = (entry: { url: string; token: string }): Writer => {
    tokens.push(entry.token);
    return {
      async call(op, args) {
        calls.push({ op, args });
        if (op === "health") return o.health?.() ?? { answer: HEALTHY };
        return o.answer?.(op, args) ?? { answer: { proposalId: args.proposalId, status: "applied", writtenHash: "f".repeat(64) } };
      },
      async close() {},
    };
  };
  return { factory, calls, tokens };
}

const put = (path: string, base?: string) => ({ op: "put_page", args: { path, content: `---\ntitle: ${path}\n---\nbody\n`, ...(base ? { base } : {}) } });

test("a proposal is recorded before any send, sent with its id under the token, and removed once applied", async () => {
  const f = fixture();
  const rec = enqueue(f.dir, { starId: STAR, ...put("items/film/a.md", "a".repeat(64)) }, T0);
  expect(rec.proposalId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  // written before the first send, never holding a token
  const onDisk = readFileSync(join(f.dir, `${rec.proposalId}.json`), "utf8");
  expect(onDisk).not.toContain(TOKEN);
  expect(JSON.parse(onDisk)).toMatchObject({ status: "pending", op: "put_page", attempts: 0 });

  const w = fakeWriter();
  const r = await drain({ vault: f.vault, dir: f.dir, endpointsPath: f.endpointsPath, now: () => T0, writer: w.factory });
  expect(w.tokens).toEqual([TOKEN]);
  expect(w.calls.map((c) => c.op)).toEqual(["health", "put_page"]);
  expect(w.calls[1]!.args).toEqual({ ...put("items/film/a.md", "a".repeat(64)).args, proposalId: rec.proposalId });
  expect(r.applied).toEqual([rec.proposalId]);
  expect(listOutbox(f.dir).records).toEqual([]);
});

test("offline 1 day: edits queue and back off, then drain to applied or stale-base; a redelivery answers already-applied", async () => {
  const f = fixture();
  const a = enqueue(f.dir, { starId: STAR, ...put("items/film/a.md", "a".repeat(64)) }, T0);
  const b = enqueue(f.dir, { starId: STAR, ...put("items/film/b.md", "b".repeat(64)) }, T0 + 1000);
  let online = false;
  let flaky = true;
  const w = fakeWriter({
    health: () => (online ? { answer: HEALTHY } : { error: "fetch failed: ECONNREFUSED" }),
    answer: (_op, args) => {
      if (flaky) return { http: 503 }; // a pending journal: transient, no status
      return args.path === "items/film/b.md"
        ? { answer: { proposalId: args.proposalId, status: "refused", reason: "stale-base", currentHash: "c".repeat(64) } }
        : { answer: { proposalId: args.proposalId, status: "applied", writtenHash: "d".repeat(64) } };
    },
  });
  const pass = (t: number) => drain({ vault: f.vault, dir: f.dir, endpointsPath: f.endpointsPath, now: () => t, writer: w.factory });

  // offline: every pass reaches only the probe, sends nothing, and nothing expires
  for (let h = 0; h < 24; h += 6) expect((await pass(T0 + h * 3_600_000)).probe).toBe("unreachable");
  expect(w.calls.filter((c) => c.op !== "health")).toEqual([]);

  // the writer answers, but a 503 is no answer: each proposal retries on its own backoff
  online = true;
  const t1 = T0 + DAY;
  expect((await pass(t1)).retried).toEqual([a.proposalId, b.proposalId]);
  const r1 = listOutbox(f.dir).records;
  expect(r1.map((r) => [r.status, r.attempts, r.nextAttemptAt, r.lastError])).toEqual([
    ["pending", 1, t1 + 2000, "HTTP 503"], ["pending", 1, t1 + 2000, "HTTP 503"],
  ]);
  expect((await pass(t1 + 1000)).probe).toBe("idle"); // not yet due: no probe, no send

  flaky = false;
  const done = await pass(t1 + 2000);
  expect(done.applied).toEqual([a.proposalId]);
  expect(done.refused).toEqual([b.proposalId]);
  const left = listOutbox(f.dir).records;
  expect(left.map((r) => r.proposalId)).toEqual([b.proposalId]);
  expect(left[0]!.answer).toEqual({ proposalId: b.proposalId, status: "refused", reason: "stale-base", currentHash: "c".repeat(64) });

  // a refused proposal is never sent again
  const sends = w.calls.length;
  await pass(t1 + DAY);
  expect(w.calls.length).toBe(sends);

  // a second drainer's redelivery of a proposal the writer already applied is removed as applied
  const c = enqueue(f.dir, { starId: STAR, ...put("items/film/c.md", "e".repeat(64)) }, t1);
  const again = fakeWriter({ answer: (_op, args) => ({ answer: { proposalId: args.proposalId, status: "already-applied", writtenHash: "d".repeat(64) } }) });
  expect((await drain({ vault: f.vault, dir: f.dir, endpointsPath: f.endpointsPath, now: () => t1, writer: again.factory })).applied).toEqual([c.proposalId]);
});

test("offline 8 days: proposals expire unsent; resend re-sends under a new ULID with the same base, the old record kept", async () => {
  const f = fixture();
  const a = enqueue(f.dir, { starId: STAR, ...put("items/film/a.md", "a".repeat(64)) }, T0);
  const w = fakeWriter({ health: () => ({ error: "fetch failed" }) });
  const pass = (t: number) => drain({ vault: f.vault, dir: f.dir, endpointsPath: f.endpointsPath, now: () => t, writer: w.factory });

  expect((await pass(T0 + 7 * DAY - 1)).expired).toEqual([]);
  const r = await pass(T0 + 8 * DAY);
  expect(r.expired).toEqual([a.proposalId]);
  expect(listOutbox(f.dir).records.map((x) => [x.proposalId, x.status])).toEqual([[a.proposalId, "expired"]]);
  expect(w.calls.filter((c) => c.op !== "health")).toEqual([]);

  // `resend` only marks; the next pass mints the new id, on the clock seam
  expect(() => resendMark(f.dir, "01" + "0".repeat(24))).toThrow(/no record/);
  resendMark(f.dir, a.proposalId);
  expect(listOutbox(f.dir).records[0]).toMatchObject({ status: "expired", mark: "resend" });
  const back = fakeWriter();
  const t8 = T0 + 8 * DAY;
  const sent = await drain({ vault: f.vault, dir: f.dir, endpointsPath: f.endpointsPath, now: () => t8, writer: back.factory });
  expect(sent.resent).toHaveLength(1);
  const fresh = sent.resent[0]!.to;
  expect(fresh).not.toBe(a.proposalId);
  expect(ulidTime(fresh)).toBe(t8);
  expect(back.calls[1]!.args).toEqual({ ...put("items/film/a.md", "a".repeat(64)).args, proposalId: fresh });
  expect(sent.applied).toEqual([fresh]);
  const { records, dismissed } = listOutbox(f.dir);
  expect(records).toEqual([]);
  expect(dismissed.map((x) => [x.proposalId, x.status, x.resentAs])).toEqual([[a.proposalId, "expired", fresh]]);
});

test("a revoked token halts the endpoint: nothing is marked refused, the halt is named, and the 7-day clock keeps running", async () => {
  const f = fixture();
  const a = enqueue(f.dir, { starId: STAR, ...put("items/film/a.md", "a".repeat(64)) }, T0);
  const b = enqueue(f.dir, { starId: STAR, ...put("items/film/b.md", "b".repeat(64)) }, T0 + 1);
  const revoked = fakeWriter({ health: () => ({ http: 401 }) });
  const r = await drain({ vault: f.vault, dir: f.dir, endpointsPath: f.endpointsPath, now: () => T0 + DAY, writer: revoked.factory });
  expect(r.probe).toBe("halted");
  expect(revoked.calls.map((c) => c.op)).toEqual(["health"]);
  const listed = listOutbox(f.dir);
  expect(listed.halt).toEqual({ status: 401, at: new Date(T0 + DAY).toISOString() });
  expect(listed.records.map((x) => [x.status, x.attempts])).toEqual([["pending", 0], ["pending", 0]]);

  // a grant that no longer covers the star (403) mid-pass ends the pass for the endpoint
  let sends = 0;
  const forbidden = fakeWriter({ answer: () => (++sends === 1 ? { http: 403 } : { answer: { status: "applied" } }) });
  const r2 = await drain({ vault: f.vault, dir: f.dir, endpointsPath: f.endpointsPath, now: () => T0 + 2 * DAY, writer: forbidden.factory });
  expect(r2.halt?.status).toBe(403);
  expect(sends).toBe(1);
  expect(listOutbox(f.dir).records.map((x) => [x.status, x.answer])).toEqual([["pending", null], ["pending", null]]);

  const halted = fakeWriter({ health: () => ({ http: 401 }) });
  const r3 = await drain({ vault: f.vault, dir: f.dir, endpointsPath: f.endpointsPath, now: () => T0 + 8 * DAY, writer: halted.factory });
  expect(r3.expired).toEqual([a.proposalId, b.proposalId]);

  // a probe the writer answers lifts the halt
  enqueue(f.dir, { starId: STAR, ...put("items/film/c.md") }, T0 + 8 * DAY);
  await drain({ vault: f.vault, dir: f.dir, endpointsPath: f.endpointsPath, now: () => T0 + 8 * DAY, writer: fakeWriter().factory });
  expect(listOutbox(f.dir).halt).toBeNull();
});

test("the health probe must name the protocol, this star and its write locus, or nothing is sent", async () => {
  for (const [h, why] of [
    [{ ...HEALTHY, proposalProtocol: 2 }, /proposal protocol/],
    [{ ...HEALTHY, starId: "mcp://rainblow.ing/personal" }, /serves/],
    [{ ...HEALTHY, locus: "host-b" }, /locus/],
    [{ starId: STAR, locus: "funes-taste" }, /proposal protocol/],
  ] as const) {
    const f = fixture();
    enqueue(f.dir, { starId: STAR, ...put("items/film/a.md") }, T0);
    const w = fakeWriter({ health: () => ({ answer: h }) });
    const r = await drain({ vault: f.vault, dir: f.dir, endpointsPath: f.endpointsPath, now: () => T0, writer: w.factory });
    expect(r.probe).toMatch(why);
    expect(w.calls.map((c) => c.op)).toEqual(["health"]);
  }
  // normalized: the same star by its bare key, the locus in another case
  const f = fixture();
  enqueue(f.dir, { starId: STAR, ...put("items/film/a.md") }, T0);
  const w = fakeWriter({ health: () => ({ answer: { ...HEALTHY, starId: "rainblow.ing/taste", locus: " Funes-Taste" } }) });
  expect((await drain({ vault: f.vault, dir: f.dir, endpointsPath: f.endpointsPath, now: () => T0, writer: w.factory })).applied).toHaveLength(1);
});

test("the endpoint file and the token file are owner-only, re-read every pass, and fail closed", async () => {
  const f = fixture();
  enqueue(f.dir, { starId: STAR, ...put("items/film/a.md") }, T0);
  const pass = () => drain({ vault: f.vault, dir: f.dir, endpointsPath: f.endpointsPath, now: () => T0, writer: fakeWriter({ health: () => ({ error: "offline" }) }).factory });
  chmodSync(f.endpointsPath, 0o644);
  await expect(pass()).rejects.toThrow(/group\/world readable/);
  chmodSync(f.endpointsPath, 0o600);
  chmodSync(f.tokenFile, 0o640);
  await expect(pass()).rejects.toThrow(/token_file .* group\/world readable/);
  chmodSync(f.tokenFile, 0o600);
  expect((await pass()).probe).toBe("unreachable");

  writeFileSync(f.endpointsPath, JSON.stringify({ [STAR]: { url: "http://taste.example", token_file: f.tokenFile } }));
  await expect(pass()).rejects.toThrow(/https only/);
  writeFileSync(f.endpointsPath, JSON.stringify({ "mcp://rainblow.ing/other": { url: "https://x.example", token_file: f.tokenFile } }));
  await expect(pass()).rejects.toThrow(/no writer endpoint for mcp:\/\/rainblow.ing\/taste/);
  writeFileSync(f.endpointsPath, "{not json");
  await expect(pass()).rejects.toThrow(/malformed JSON/);

  writeFileSync(f.endpointsPath, JSON.stringify({ [STAR]: { url: "https://x.example", token_file: f.tokenFile, pull: { endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "taste", credentials_file: "/c" } } }));
  expect(readEndpoints(f.endpointsPath).get(STAR)).toEqual({ url: "https://x.example", tokenFile: f.tokenFile, pull: { endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "taste", credentialsFile: "/c" } });
});

test("the marks: a held record is never sent until approved, dismiss moves a record to dismissed/, show never mutates", async () => {
  const f = fixture();
  const held = enqueue(f.dir, { starId: STAR, ...put("items/film/new.md"), held: true }, T0);
  const w = fakeWriter();
  expect((await drain({ vault: f.vault, dir: f.dir, endpointsPath: f.endpointsPath, now: () => T0, writer: w.factory })).probe).toBe("idle");
  expect(w.calls).toEqual([]);
  expect(() => approve(f.dir, "items/film/other.md")).toThrow(/no held record/);
  expect(approve(f.dir, "items/film/new.md")).toMatchObject({ proposalId: held.proposalId, status: "held", mark: "approve" });

  const before = readFileSync(join(f.dir, `${held.proposalId}.json`), "utf8");
  expect(showRecord(f.dir, held.proposalId).mark).toBe("approve");
  expect(readFileSync(join(f.dir, `${held.proposalId}.json`), "utf8")).toBe(before);

  dismiss(f.dir, held.proposalId);
  expect(existsSync(join(f.dir, `${held.proposalId}.json`))).toBe(false);
  expect(readdirSync(join(f.dir, "dismissed"))).toEqual([`${held.proposalId}.json`]);
  expect(listOutbox(f.dir).dismissed[0]!.proposalId).toBe(held.proposalId);
  expect(() => resendMark(f.dir, held.proposalId)).toThrow(/no record/);
  const p = enqueue(f.dir, { starId: STAR, ...put("items/film/p.md") }, T0);
  expect(() => resendMark(f.dir, p.proposalId)).toThrow(/only an expired proposal/);
});

test("over the real MCP transport, a token revoked at the writer halts the endpoint", async () => {
  // A minimal streamable-HTTP writer (RAI-303: no funes face): the Bearer rule first (401 for a token
  // it does not hold), then JSON-RPC replies; its health names no proposal protocol, so the probe
  // refuses, but only after auth.
  let tokens = [TOKEN];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (!tokens.some((t) => req.headers.get("authorization") === `Bearer ${t}`)) return new Response(null, { status: 401 });
      if (req.method === "GET") return new Response(null, { status: 405 });
      const m = (await req.json()) as { id?: number; method: string; params?: { protocolVersion?: string } };
      if (m.id === undefined) return new Response(null, { status: 202 });
      if (m.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-writer", version: "0" } } });
      }
      return Response.json({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify({ starId: STAR, locus: "funes-taste" }) }] } });
    },
  });
  try {
    const f = fixture();
    writeFileSync(f.endpointsPath, JSON.stringify({ [STAR]: { url: `http://127.0.0.1:${server.port}/mcp`, token_file: f.tokenFile } }));
    enqueue(f.dir, { starId: STAR, ...put("items/film/a.md") }, T0);
    const pass = () => drain({ vault: f.vault, dir: f.dir, endpointsPath: f.endpointsPath, now: () => T0 });
    expect((await pass()).probe).toMatch(/proposal protocol/);
    tokens = ["funes_" + "Z".repeat(43)]; // re-provisioned: the outbox's token no longer resolves
    const r = await pass();
    expect(r.probe).toBe("halted");
    expect(listOutbox(f.dir).halt?.status).toBe(401);
    expect(listOutbox(f.dir).records.map((x) => x.status)).toEqual(["pending"]);
  } finally {
    server.stop(true);
  }
});

test("`funes outbox` lists records and the halt; its verbs only mark", async () => {
  const f = fixture();
  const state = mk("funes-outbox-state-");
  const was = process.env.FUNES_HOME;
  process.env.FUNES_HOME = state;
  let dir: string;
  try { dir = outboxDirFor(f.vault); } finally { if (was === undefined) delete process.env.FUNES_HOME; else process.env.FUNES_HOME = was; }
  const cli = async (...args: string[]) => {
    const p = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), "outbox", ...args, "--vault", f.vault], { env: { ...process.env, FUNES_HOME: state }, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out, err };
  };
  const a = enqueue(dir, { starId: STAR, ...put("items/film/a.md", "a".repeat(64)) }, T0);
  for (const t of [T0 + DAY, T0 + 8 * DAY]) {
    await drain({ vault: f.vault, dir, endpointsPath: f.endpointsPath, now: () => t, writer: fakeWriter({ health: () => ({ http: 401 }) }).factory });
  }
  const listed = await cli();
  expect(listed.code).toBe(0);
  expect(listed.out).toContain("endpoint HALTED: HTTP 401");
  expect(listed.out).toContain(`${a.proposalId}  expired  put_page items/film/a.md`);
  expect(listed.out).not.toContain(TOKEN);

  expect((await cli("resend", a.proposalId)).code).toBe(0);
  expect(showRecord(dir, a.proposalId).mark).toBe("resend");
  expect(JSON.parse((await cli("show", a.proposalId)).out).proposalId).toBe(a.proposalId);
  expect((await cli("dismiss", a.proposalId)).code).toBe(0);
  expect(listOutbox(dir).dismissed.map((r) => r.proposalId)).toEqual([a.proposalId]);
  const missing = await cli("dismiss", a.proposalId);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("no record");
  expect((await cli("frob")).code).toBe(2);
});

test("a reply that does not name this proposal is no answer: the proposal retries", async () => {
  const f = fixture();
  const a = enqueue(f.dir, { starId: STAR, ...put("items/film/a.md") }, T0);
  const w = fakeWriter({ answer: () => ({ answer: { status: "applied" } }) });
  const r = await drain({ vault: f.vault, dir: f.dir, endpointsPath: f.endpointsPath, now: () => T0, writer: w.factory });
  expect(r.retried).toEqual([a.proposalId]);
  expect(listOutbox(f.dir).records[0]!.status).toBe("pending");
});

test("mcpWriter: the SDK's background SSE GET answered 405 is not the call's failure — the real error is", async () => {
  // a minimal streamable-HTTP MCP server: JSON replies to POST, 405 to the client's background GET,
  // and a tool result that is not JSON
  let gets = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method === "GET") { gets++; return new Response(null, { status: 405 }); }
      const m = (await req.json()) as { id?: number; method: string; params?: { protocolVersion?: string } };
      if (m.id === undefined) return new Response(null, { status: 202 });
      if (m.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stub", version: "0" } } });
      }
      while (gets === 0) await Bun.sleep(5); // the tool call answers only after the GET was refused
      return Response.json({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "not json" }] } });
    },
  });
  try {
    const w = mcpWriter({ url: `http://127.0.0.1:${server.port}/mcp`, token: TOKEN });
    const r = await w.call("health", {});
    await w.close();
    expect("error" in r ? r.error : r).toMatch(/JSON/);
  } finally {
    server.stop(true);
  }
});
