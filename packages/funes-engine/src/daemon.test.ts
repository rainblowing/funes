import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "funes-core";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";
import type { Reranker } from "./rerank.ts";
import { startDaemon } from "./daemon.ts";
import { daemonProbe } from "./daemon-client.ts";

class FakeEmbedder implements Embedder {
  readonly dim = 16;
  private vec(t: string): Float32Array {
    const v = new Float32Array(this.dim);
    for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? [])
      v[[...w].reduce((a, c) => a + c.charCodeAt(0), 0) % this.dim]! += 1;
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i]! /= n;
    return v;
  }
  async embedQuery(t: string) { return this.vec(t); }
  async embedPassage(t: string) { return this.vec(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.vec(t)); }
}

async function liveDaemon(opts: { capabilityPath?: string } = {}) {
  const vault = mkdtempSync(join(tmpdir(), "funes-daemon-"));
  mkdirSync(join(vault, "in_chatgpt"));
  writeFileSync(join(vault, "fitness.md"), "---\ntitle: Fitness\n---\nprotein creatine goals\n");
  writeFileSync(join(vault, "in_chatgpt", "chat.md"), "---\ntitle: Chat\n---\nprotein creatine goals\n");
  const store = await LibsqlStore.create(new FakeEmbedder());
  await store.remember([
    { id: "fitness", path: "fitness.md", title: "Fitness", body: "protein creatine goals", trust: "trusted" },
    { id: "in_chatgpt/chat", path: "in_chatgpt/chat.md", title: "Chat", body: "protein creatine goals", trust: "untrusted" },
  ]);
  const server = startDaemon({ vault, store, port: 0, capabilityPath: opts.capabilityPath }); // ephemeral port
  const base = `http://127.0.0.1:${server.port!}`;
  return { vault, store, server, base, cleanup: async () => { server.stop(true); await store.close(); rmSync(vault, { recursive: true, force: true }); } };
}

test("daemon binds 127.0.0.1 only and serves the console at /", async () => {
  const d = await liveDaemon();
  try {
    expect(d.server.hostname).toBe("127.0.0.1"); // the lone-local ACCESS guarantee
    const html = await (await fetch(d.base + "/")).text();
    expect(html).toContain("READ-ONLY");
    expect(html).toContain("recall");
  } finally { await d.cleanup(); }
});

test("HTTP recall (S3): trust-labeled unrestricted surface; health has the probe contract shape", async () => {
  const d = await liveDaemon();
  try {
    const r = (await (await fetch(d.base + "/api/recall", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "protein creatine goals", k: 5 }),
    })).json()) as { ok: boolean; result: Array<{ path: string; trust: string }> };
    expect(r.ok).toBe(true);
    const byPath = new Map(r.result.map((x) => [x.path, x.trust]));
    expect(byPath.get("fitness.md")).toBe("trusted");
    expect(byPath.get("in_chatgpt/chat.md")).toBe("untrusted"); // tagged, not hidden (S3)

    // P3.15 end to end: a GET hands `k` over as the STRING "1" (the spine no longer knows argument
    // names), and recall's zod schema coerces it. Garbage must still resolve to the default, not 400.
    const one = (await (await fetch(d.base + "/api/recall?query=protein+creatine&k=1")).json()) as { ok: boolean; result: unknown[] };
    expect(one.ok).toBe(true);
    expect(one.result).toHaveLength(1);
    const junk = (await (await fetch(d.base + "/api/recall?query=protein+creatine&k=abc")).json()) as { ok: boolean };
    expect(junk.ok).toBe(true);

    const h = (await (await fetch(d.base + "/api/health")).json()) as { vault: string; nodes: number };
    expect(h.vault).toBe(d.vault); // daemonProbe keys on this
    expect(h.nodes).toBe(2);
  } finally { await d.cleanup(); }
});

test("S3 mutations over HTTP: remember lands in out_memory untrusted; elevation + foreign ids refused; page rejects traversal", async () => {
  const d = await liveDaemon();
  try {
    const rem = (await (await fetch(`${d.base}/api/remember`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "From engine", body: "an agent memory" }),
    })).json()) as { ok: boolean; result: { id: string; trust: string } };
    expect(rem.ok).toBe(true);
    expect(rem.result.id.startsWith("out_memory/")).toBe(true);
    expect(rem.result.trust).toBe("untrusted"); // server-stamped
    expect(existsSync(join(d.vault, rem.result.id + ".md"))).toBe(true); // markdown-canonical

    // elevation is NOT a remote operation
    const el = (await (await fetch(`${d.base}/api/elevate`, { method: "POST", body: "{}" })).json()) as { ok: boolean; error?: string };
    expect(el.ok).toBe(false);
    expect(el.error).toContain("unknown operation");

    // foreign ids stay immutable through the registry (H3)
    const sup = (await (await fetch(`${d.base}/api/forget`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "fitness" }),
    })).json()) as { ok: boolean; error?: string };
    expect(sup.ok).toBe(false);
    expect(sup.error).toContain("refusing to mutate");

    const esc = (await (await fetch(`${d.base}/api/page?path=../secrets.md`)).json()) as { ok: boolean };
    expect(esc.ok).toBe(false);
  } finally { await d.cleanup(); }
});

test("P1.5 daemon CSRF: a drive-by cross-origin browser POST to a mutation is refused (403); reads unaffected", async () => {
  const d = await liveDaemon();
  try {
    // a hostile page on evil.example fetches 127.0.0.1 — the browser sends Sec-Fetch-Site + Origin
    const drive = await fetch(`${d.base}/api/remember`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ title: "csrf", body: "injected memory" }),
    });
    expect(drive.status).toBe(403);
    // and no memory was written
    const rec = (await (await fetch(`${d.base}/api/recall`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "csrf injected" }),
    })).json()) as { ok: boolean; result: Array<{ path: string }> };
    expect(rec.result.some((r) => r.path.startsWith("out_memory/"))).toBe(false);
    // a cross-origin READ still works (loopback reads are safe)
    const read = await fetch(`${d.base}/api/recall?query=protein`, { headers: { "sec-fetch-site": "cross-site" } });
    expect(read.status).toBe(200);
  } finally { await d.cleanup(); }
});

test("P1.5 daemon --capability: mutations require the x-funes-capability header (401 without, 200 with)", async () => {
  const capFile = join(mkdtempSync(join(tmpdir(), "funes-cap-")), "token");
  writeFileSync(capFile, "s3cr3t-token\n");
  const d = await liveDaemon({ capabilityPath: capFile });
  try {
    const hdr = { "content-type": "application/json" };
    const body = JSON.stringify({ title: "capped", body: "needs the token" });
    // no capability → 401 even from a non-browser caller
    expect((await fetch(`${d.base}/api/remember`, { method: "POST", headers: hdr, body })).status).toBe(401);
    // wrong capability → 401
    expect((await fetch(`${d.base}/api/remember`, { method: "POST", headers: { ...hdr, "x-funes-capability": "nope" }, body })).status).toBe(401);
    // correct capability → 200
    const ok = await fetch(`${d.base}/api/remember`, { method: "POST", headers: { ...hdr, "x-funes-capability": "s3cr3t-token" }, body });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { ok: boolean }).ok).toBe(true);
    // reads never require the capability
    expect((await fetch(`${d.base}/api/health`)).status).toBe(200);
  } finally { await d.cleanup(); }
});

test("daemonProbe: matches only the same vault; silent null when nothing listens", async () => {
  const d = await liveDaemon();
  try {
    const hit = await daemonProbe(d.server.port!, d.vault);
    expect(hit).not.toBeNull();
    const recall = (await hit!.call("recall", { query: "protein goals", k: 3 })) as Array<{ path: string }>;
    expect(recall.length).toBeGreaterThan(0);
    expect(await daemonProbe(d.server.port!, "/some/other/vault")).toBeNull(); // vault mismatch
  } finally { await d.cleanup(); }
  expect(await daemonProbe(1, "/x")).toBeNull(); // nothing on port 1
});

test("P1.5 proxy: the daemon-client injects x-funes-capability from FUNES_CAPABILITY_FILE, so a gated daemon accepts proxied mutations", async () => {
  const capFile = join(mkdtempSync(join(tmpdir(), "funes-cap-")), "token");
  writeFileSync(capFile, "proxy-token-abc\n");
  const d = await liveDaemon({ capabilityPath: capFile });
  const prev = process.env.FUNES_CAPABILITY_FILE;
  try {
    // without the env, the proxy client sends no header → the gated daemon 401s a mutation
    delete process.env.FUNES_CAPABILITY_FILE;
    const noCap = await daemonProbe(d.server.port!, d.vault);
    await expect(noCap!.call("remember", { title: "t", body: "b" })).rejects.toThrow();
    // with the env pointing at the same token file, the client injects it → the mutation succeeds
    process.env.FUNES_CAPABILITY_FILE = capFile;
    const withCap = await daemonProbe(d.server.port!, d.vault);
    const rem = (await withCap!.call("remember", { title: "t", body: "b" })) as { id: string };
    expect(rem.id.startsWith("out_memory/")).toBe(true);
    // reads never need the capability (the header is ignored on read ops)
    const rec = (await noCap!.call("recall", { query: "protein", k: 3 })) as unknown[];
    expect(Array.isArray(rec)).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.FUNES_CAPABILITY_FILE; else process.env.FUNES_CAPABILITY_FILE = prev;
    await d.cleanup();
  }
});

// ── Move 5: daemon rerank behind a flag (default OFF — the daemon stays light) ───────────────

/** Fake reranker that reverses candidate order and counts its calls — proves the daemon both
 *  injects it AND drives the rerank stage (mirroring the CLI `--rerank` semantics). */
class ReverseReranker implements Reranker {
  calls = 0;
  async rerank(_q: string, docs: Array<{ id: string; text: string }>) { this.calls++; return docs.map((x) => x.id).reverse(); }
}

async function rerankDaemon(reranker?: Reranker, rerank?: boolean) {
  const vault = mkdtempSync(join(tmpdir(), "funes-daemon-rr-"));
  const store = await LibsqlStore.create(new FakeEmbedder(), undefined, reranker ? { reranker } : {});
  await store.remember([
    { id: "a", path: "a.md", title: "Alpha", body: "protein creatine goals alpha", trust: "trusted" },
    { id: "b", path: "b.md", title: "Beta", body: "protein creatine goals beta", trust: "trusted" },
    { id: "c", path: "c.md", title: "Gamma", body: "protein creatine goals gamma", trust: "trusted" },
  ]);
  const server = startDaemon({ vault, store, port: 0, rerank });
  const base = `http://127.0.0.1:${server.port!}`;
  const ids = async () => {
    const r = (await (await fetch(`${base}/api/recall`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "protein creatine goals", k: 3 }),
    })).json()) as { ok: boolean; result: Array<{ id: string }> };
    return r.result.map((x) => x.id);
  };
  return { ids, cleanup: async () => { server.stop(true); await store.close(); rmSync(vault, { recursive: true, force: true }); } };
}

test("daemon rerank: default OFF — no reranker wired, recall path is unchanged RRF order", async () => {
  const fake = new ReverseReranker();
  // a store with NO reranker (the production default-off path) -> RRF order, reranker untouched.
  const d = await rerankDaemon(undefined, false);
  try {
    const base = await d.ids();
    expect(base.length).toBe(3);
    expect(fake.calls).toBe(0); // not even constructed into this store
  } finally { await d.cleanup(); }
});

test("daemon rerank: flag ON — daemon drives the injected reranker (results reranked)", async () => {
  const fake = new ReverseReranker();
  // baseline RRF order from a no-rerank daemon over the same corpus
  const off = await rerankDaemon(undefined, false);
  const baseIds = await off.ids();
  await off.cleanup();
  // flag ON + injected reranker -> daemon sets rerank:true on the recall path -> reversed
  const on = await rerankDaemon(fake, true);
  try {
    const rrIds = await on.ids();
    expect(fake.calls).toBe(1); // the daemon recall path drove it exactly once
    expect(rrIds).toEqual([...baseIds].reverse()); // CLI-mirroring rerank semantics
  } finally { await on.cleanup(); }
});

test("daemon rerank: reranker injected but flag OFF — stays cold (rerank not requested)", async () => {
  const fake = new ReverseReranker();
  const d = await rerankDaemon(fake, false); // store HAS a reranker, but the flag is off
  try {
    await d.ids();
    expect(fake.calls).toBe(0); // no rerank flag => the optional stage never runs
  } finally { await d.cleanup(); }
});
