import { test, expect } from "bun:test";
import { createApp, composeInbox, type ApiDeps } from "./app.ts";

// Unit contract for the canonical Hono spine, driven via app.request() with INJECTED fake deps (no
// store, no PGLite). Live wiring is contract-tested by funes-engine/daemon.test.ts (direct) and
// surface/api/{app,proxy,inbox}.test.ts (direct + proxy).

function fakeDeps(over: Partial<ApiDeps> = {}): ApiDeps {
  return {
    async call(op, args) {
      if (op === "recall") return [{ path: "a.md", trust: "trusted", query: args.query, k: args.k }];
      if (op === "tree") return { files: [] }; // empty zones → empty inbox sections
      throw new Error(`unknown operation: ${op}`);
    },
    rawHealth: async () => ({ vault: "/v", nodes: 2, timingsMs: {} }),
    opDefs: () => [{ name: "recall" }, { name: "page" }],
    consoleHtml: "<html><body>READ-ONLY recall console</body></html>",
    ...over,
  };
}

test("GET / serves the injected console html (else a text fallback)", async () => {
  expect(await (await createApp(fakeDeps()).request("/")).text()).toContain("READ-ONLY");
  expect(await (await createApp(fakeDeps({ consoleHtml: undefined })).request("/")).text()).toContain("READ-ONLY");
});

test("GET /api/ops returns { ok, result: toolDefs }", async () => {
  const r = (await (await createApp(fakeDeps()).request("/api/ops")).json()) as { ok: boolean; result: unknown[] };
  expect(r.ok).toBe(true);
  expect(r.result).toEqual([{ name: "recall" }, { name: "page" }]);
});

test("GET /api/health returns the RAW shape (daemonProbe keys on .vault), not {ok,result}", async () => {
  const r = (await (await createApp(fakeDeps()).request("/api/health")).json()) as Record<string, unknown>;
  expect(r.vault).toBe("/v");
  expect(r.nodes).toBe(2);
  expect(r.ok).toBeUndefined();
});

test("POST /api/:op dispatches with the JSON body; GET passes query params through as strings", async () => {
  const post = (await (await createApp(fakeDeps()).request("/api/recall", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "protein", k: 5 }),
  })).json()) as { ok: boolean; result: Array<{ query: string; k: number }> };
  expect(post.ok).toBe(true);
  expect(post.result[0]!.query).toBe("protein");
  expect(post.result[0]!.k).toBe(5);
  // P3.15: the spine knows NO argument names — it used to hardcode Number() for `k`/`n`. Numeric
  // coercion now belongs to each op's zod schema (funes-engine/src/ops-contract.test.ts pins it),
  // so the raw string is what a dispatcher receives. This fake bypasses the registry on purpose.
  const get = (await (await createApp(fakeDeps()).request("/api/recall?query=x&k=3")).json()) as { result: Array<{ k: unknown }> };
  expect(get.result[0]!.k).toBe("3");
});

test("GET /api/inbox composes from tree+page ops (empty zones → empty sections)", async () => {
  const r = (await (await createApp(fakeDeps()).request("/api/inbox")).json()) as { ok: boolean; result: { elevation: unknown[]; reflect: unknown[]; digest: unknown[]; cadence: unknown[] } };
  expect(r.ok).toBe(true);
  expect(r.result).toEqual({ elevation: [], reflect: [], digest: [], cadence: [] });
});

test("composeInbox: elevation rows carry a copyable `funes elevate` command, trusted excluded", async () => {
  const call: ApiDeps["call"] = async (op, args) => {
    if (op === "tree" && (args.dir === "out_memory" || args.dir === "out/out_memory"))
      return { files: args.dir === "out_memory" ? ["draft.md", "kept.md", "index.md"] : [] };
    if (op === "tree") return { files: [] };
    if (op === "page" && args.path === "out_memory/draft.md")
      return { path: "out_memory/draft.md", frontmatter: { title: "Draft", trust: "untrusted" }, body: "some body" };
    if (op === "page" && args.path === "out_memory/kept.md")
      return { path: "out_memory/kept.md", frontmatter: { title: "Kept", trust: "trusted" }, body: "x" };
    throw new Error(`unexpected ${op}`);
  };
  const r = await composeInbox(call);
  expect(r.elevation.map((e) => e.id)).toEqual(["out_memory/draft"]); // trusted "kept" excluded
  expect(r.elevation[0]!.command).toBe("funes elevate out_memory/draft");
});

// ── P1.5 mutation write guards (Codex R1#2/#3, R2#1) ────────────────────────────────────────────
function mutDeps(over: Partial<ApiDeps> = {}): ApiDeps {
  return fakeDeps({
    isMutation: (op) => op === "remember",
    async call(op, args) {
      if (op === "remember") return { id: "out_memory/x", trust: "untrusted", got: args };
      if (op === "recall") return [{ path: "a.md", trust: "trusted" }];
      throw new Error(`unknown operation: ${op}`);
    },
    ...over,
  });
}
const jsonHdr = { "content-type": "application/json", host: "127.0.0.1:7777" };

test("mutation guard: happy paths — non-browser caller AND same-origin console are allowed", async () => {
  // non-browser (no Origin / Sec-Fetch — the MCP daemon proxy): allowed
  const proxy = await createApp(mutDeps()).request("/api/remember", {
    method: "POST", headers: jsonHdr, body: JSON.stringify({ title: "t", body: "b" }),
  });
  expect(proxy.status).toBe(200);
  expect(((await proxy.json()) as { ok: boolean }).ok).toBe(true);
  // same-origin dev console (Sec-Fetch-Site: same-origin, Origin matches Host): allowed
  const console = await createApp(mutDeps()).request("/api/remember", {
    method: "POST",
    headers: { ...jsonHdr, origin: "http://127.0.0.1:7777", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ title: "t", body: "b" }),
  });
  expect(console.status).toBe(200);
});

test("mutation guard: the CSRF matrix — cross-origin browser POSTs are refused", async () => {
  const app = () => createApp(mutDeps());
  const body = JSON.stringify({ title: "t", body: "b" });
  // cross-site fetch metadata → 403
  const xsite = await app().request("/api/remember", { method: "POST", headers: { ...jsonHdr, "sec-fetch-site": "cross-site" }, body });
  expect(xsite.status).toBe(403);
  // mismatched Origin (older browser without Sec-Fetch) → 403
  const xorigin = await app().request("/api/remember", { method: "POST", headers: { ...jsonHdr, origin: "http://evil.example" }, body });
  expect(xorigin.status).toBe(403);
  // GET a mutation → 405
  expect((await app().request("/api/remember?title=t&body=b")).status).toBe(405);
  // wrong content-type → 415 (a cross-origin simple form POST can't set application/json)
  const ct = await app().request("/api/remember", { method: "POST", headers: { host: "127.0.0.1:7777", "content-type": "text/plain" }, body });
  expect(ct.status).toBe(415);
});

test("mutation guard: body cap (413), malformed JSON (400), non-object body (400)", async () => {
  const big = await createApp(mutDeps({ maxBodyBytes: 8 })).request("/api/remember", {
    method: "POST", headers: { ...jsonHdr, "content-length": "999" }, body: JSON.stringify({ title: "way too long" }),
  });
  expect(big.status).toBe(413);
  const malformed = await createApp(mutDeps()).request("/api/remember", { method: "POST", headers: jsonHdr, body: "{not json" });
  expect(malformed.status).toBe(400);
  expect(((await malformed.json()) as { error: string }).error).toContain("malformed JSON");
  const arr = await createApp(mutDeps()).request("/api/remember", { method: "POST", headers: jsonHdr, body: "[1,2,3]" });
  expect(arr.status).toBe(400); // a JSON array is not a valid args object
});

test("mutation guard: authorizeWrite gates the write (401 when it denies, 200 when it allows)", async () => {
  const denied = await createApp(mutDeps({ authorizeWrite: () => false })).request("/api/remember", {
    method: "POST", headers: { ...jsonHdr, "x-cap": "wrong" }, body: JSON.stringify({ title: "t", body: "b" }),
  });
  expect(denied.status).toBe(401);
  const allowed = await createApp(mutDeps({ authorizeWrite: (h) => h.get("x-cap") === "secret" })).request("/api/remember", {
    method: "POST", headers: { ...jsonHdr, "x-cap": "secret" }, body: JSON.stringify({ title: "t", body: "b" }),
  });
  expect(allowed.status).toBe(200);
});

test("mutation guard: READS are never guarded — a read op answers cross-origin (loopback console + clients)", async () => {
  // recall is not a mutation: a same-origin console GET/POST and even a cross-origin GET read fine
  // (reads over loopback are safe; the guard is only about drive-by WRITES).
  const r = await createApp(mutDeps()).request("/api/recall?query=x", { headers: { "sec-fetch-site": "cross-site" } });
  expect(r.status).toBe(200);
});

test("unknown op → 400 {ok:false,error}; unmatched path → 404; SSE announces ready", async () => {
  const bad = await createApp(fakeDeps()).request("/api/elevate", { method: "POST", body: "{}" });
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toContain("unknown operation");

  const nf = await createApp(fakeDeps()).request("/elsewhere");
  expect(nf.status).toBe(404);
  expect((await nf.json()) as { ok: boolean; error: string }).toEqual({ ok: false, error: "not found" });

  const sse = await createApp(fakeDeps()).request("/api/events");
  expect(sse.headers.get("content-type")).toContain("text/event-stream");
  const reader = sse.body!.getReader();
  try { expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready"); }
  finally { await reader.cancel(); }
});
