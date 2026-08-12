// funes-api — THE canonical Hono spine over the funes op-registry (S5 deliverable 1).
//
// One runtime-agnostic route table (imports only `hono`); every host injects HOW it reaches the
// op-registry, so the SAME contract serves three callers with zero duplication:
//   • the funes daemon            — funes-engine buildApp() wires in-process dispatch (direct)
//   • the unified Astro surface   — surface/api createApi(ctx) wires the same dispatch (direct)
//   • daemon-coexistence surface  — surface/api createProxyApi(daemon) wires daemon.call (proxy)
//
// Response shapes are CONTRACT-IDENTICAL to the S2/S3 Bun.serve daemon:
//   GET  /              -> dev console HTML (host-provided) or a text fallback
//   GET  /api/ops       -> { ok, result: McpToolDef[] }
//   GET  /api/health    -> RAW health object (NOT {ok,result}) — daemonProbe keys on .vault
//   GET  /api/inbox     -> { ok, result: InboxResult } — COMPOSED here from tree+page ops, so it
//                          works identically in direct and proxy mode (NOT a funes registry op)
//   GET  /api/events    -> SSE stub (ready + keep-alive) — the future event bus
//   ALL  /api/:op       -> { ok, result } | { ok:false, error } (400); GET maps query params
//   anything else       -> { ok:false, error:"not found" } (404)
//
// Import discipline: ECMA-429 (WinterTC Minimum Common Web API) ONLY — no bun:/node:. The fs/store
// ctx construction lives in each host's wiring, never here.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

/** How a host reaches the op-registry + its raw health + tool defs. */
export interface ApiDeps {
  /** Hosts this app is served on, e.g. ["127.0.0.1:7777","localhost:7777"]. When set, the Host
   *  header must match one of them — see crossOriginRejected. */
  allowedHosts?: readonly string[];
  /** Run an op. Direct: dispatchToolCall(...); proxy: daemon.call(...). Throws → {ok:false,error}. */
  call(op: string, args: Record<string, unknown>): Promise<unknown>;
  /** Raw daemon-contract health (NOT {ok,result}; carries .vault [+ timingsMs]). */
  rawHealth(): Promise<Record<string, unknown>>;
  /** MCP-style tool definitions for /api/ops. */
  opDefs(): unknown | Promise<unknown>;
  /** Optional dev-console HTML for GET / (the daemon passes its bundled console.html; the unified
   *  surface omits it — Astro owns "/" and only /api/* is delegated here). */
  consoleHtml?: string;
  /** P1.5 (Codex R1#2/#3, R2#1): is this op a MUTATION? The host knows the registry (readonly flag).
   *  Mutating ops get the write guards: POST + content-type + body cap + CSRF-origin check + (if
   *  wired) authorizeWrite. Absent ⇒ nothing is treated as a mutation (legacy behaviour — every op
   *  goes through the read path). Wire it to close the drive-by-mutation surface. */
  isMutation?(op: string): boolean;
  /** P1.5: authorize a MUTATION beyond the CSRF/content guards — the injected per-host write policy.
   *  The daemon wires a constant-time capability check (when a --capability token is configured);
   *  a browser-facing host (Astro) wires an operator-session check. Return false ⇒ 401. Absent ⇒ no
   *  extra auth (the CSRF-origin + content guards still apply, so a drive-by browser POST is refused
   *  but a non-browser LOCAL caller — e.g. the MCP daemon proxy — is allowed: loopback is the floor). */
  authorizeWrite?(headers: PolicyHeaders): boolean | Promise<boolean>;
  /** Max mutation request body bytes (default 1 MiB). */
  maxBodyBytes?: number;
}

/** The subset of request headers the write policy inspects (runtime-agnostic — just a getter). */
export interface PolicyHeaders {
  get(name: string): string | null | undefined;
}

const DEFAULT_MAX_BODY_BYTES = 1 << 20; // 1 MiB

/** CSRF-origin guard for mutations (Codex R1#3/R2#1). A mutation is allowed only from a caller that
 *  is NOT a cross-origin browser: Sec-Fetch-Site absent (non-browser, e.g. the MCP daemon proxy) or
 *  same-origin/none (the dev console served from this same daemon), AND any Origin header matches the
 *  request's own host. A drive-by page on evil.com POSTing to 127.0.0.1 is rejected here; the local
 *  dev console (same-origin) and the local MCP proxy (no browser headers) are not. */
/** `allowedHosts` is the fix for a circular check: the previous version validated Origin against
 *  the Host header, and an attacker supplies BOTH — `Origin: http://evil.test` with
 *  `Host: evil.test` matched itself and passed. A host the SERVER declares breaks the circle, which
 *  is the shape face.ts already used (expectedHost, 421 on mismatch). Absent (a caller that has not
 *  been wired yet) the old self-comparison stands, so this hardens without breaking hosts. */
function crossOriginRejected(h: PolicyHeaders, allowedHosts?: readonly string[]): boolean {
  const site = h.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  const host = h.get("host");
  if (allowedHosts?.length) {
    if (!host || !allowedHosts.includes(host)) return true; // Host itself is not trusted
  }
  const origin = h.get("origin");
  if (origin) {
    if (!host || (origin !== `http://${host}` && origin !== `https://${host}`)) return true;
  }
  return false;
}

/** Op-name shape — lowercase letters + underscore (`indexed_page` is the first multi-word op; the
 *  daemon's original `/^\/api\/([a-z]+)$/` predated it). Still a tight allowlist, never a wildcard. */
const OP_NAME = /^[a-z_]+$/;
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status: status as 200, headers: { "content-type": "application/json" } });

// ── GATE-OUT inbox (composed; agent-inbox vocabulary) ────────────────────────────────────
// Three sections over out_* zones, built from existing READ ops only (tree -> page each; fine at
// lone-local scale, and the only composition that works in proxy mode too):
//   elevation — out_memory pages with trust != trusted && !forgotten && !superseded_by. `elevate`
//               is structurally NOT a remote op (human/CLI act), so each row carries the copyable
//               `funes elevate <id>` command, never a call.
//   reflect   — out_reflect drafts (body included: they are rendered checklists), newest-first.
//   digest    — out_digest pages, newest-first.
//   cadence   — out_cadence engine-backed run receipts (supervised cadence outputs: morning-briefing,
//               inbox-triage, …), newest-first. The reviewable record of every cadence run.
export interface InboxDraft {
  id: string; path: string; title: string; created: string; updated: string; trust: string;
}
export interface InboxElevation extends InboxDraft { preview: string; command: string }
export interface InboxReflect extends InboxDraft { body: string }
export interface InboxResult { elevation: InboxElevation[]; reflect: InboxReflect[]; digest: InboxDraft[]; cadence: InboxDraft[] }

type OpCall = ApiDeps["call"];
interface PageShape { path: string; frontmatter: Record<string, unknown>; body: string }

/** tree(dir) -> page() each .md (index.md is folder meta). Missing zone or unreadable page → []. */
async function pagesUnder(call: OpCall, dir: string): Promise<PageShape[]> {
  let files: string[];
  try {
    files = ((await call("tree", { dir })) as { files: string[] }).files.filter((f) => f !== "index.md");
  } catch { return []; }
  const out: PageShape[] = [];
  for (const f of files) {
    try { out.push((await call("page", { path: `${dir}/${f}` })) as PageShape); } catch { /* skip */ }
  }
  return out;
}
const fmStr = (v: unknown): string => (v == null ? "" : String(v));
function draftOf(p: PageShape): InboxDraft {
  const fm = p.frontmatter ?? {};
  const id = p.path.replace(/\.md$/, "");
  return { id, path: p.path, title: fmStr(fm.title) || id.split("/").pop()!, created: fmStr(fm.created), updated: fmStr(fm.updated), trust: fmStr(fm.trust) };
}
const newestFirst = <T extends InboxDraft>(xs: T[]): T[] =>
  xs.sort((a, b) => (b.created || b.path).localeCompare(a.created || a.path) || b.path.localeCompare(a.path));
// Vault-v2: each output zone may be top-level (legacy `out_memory`) or under `out/` — probe both.
const pagesUnderZone = async (call: OpCall, zone: string): Promise<PageShape[]> =>
  [...(await pagesUnder(call, zone)), ...(await pagesUnder(call, `out/${zone}`))];

export async function composeInbox(call: OpCall): Promise<InboxResult> {
  const elevation = (await pagesUnderZone(call, "out_memory"))
    .filter((p) => { const fm = p.frontmatter ?? {}; return fm.trust !== "trusted" && fm.forgotten !== true && fm.superseded_by == null; })
    .map((p) => ({ ...draftOf(p), preview: p.body.replace(/\s+/g, " ").trim().slice(0, 240), command: `funes elevate ${p.path.replace(/\.md$/, "")}` }));
  const reflect = (await pagesUnderZone(call, "out_reflect")).map((p) => ({ ...draftOf(p), body: p.body }));
  const digest = (await pagesUnderZone(call, "out_digest")).map(draftOf);
  const cadence = (await pagesUnderZone(call, "out_cadence")).map(draftOf);
  return { elevation: newestFirst(elevation), reflect: newestFirst(reflect), digest: newestFirst(digest), cadence: newestFirst(cadence) };
}

// ── the canonical app (chained so ReturnType carries route types for hc<AppType>) ─────────
export function createApp(deps: ApiDeps) {
  const app = new Hono()
    .get("/", (c) =>
      deps.consoleHtml
        ? c.html(deps.consoleHtml)
        : c.text("funes — op-registry at /api/* (READ-ONLY surface; try /api/ops)", 200))
    .get("/api/ops", async (c) => json({ ok: true, result: await deps.opDefs() }))
    .get("/api/health", async (c) => json(await deps.rawHealth()))
    .get("/api/inbox", async (c) => {
      try { return json({ ok: true, result: await composeInbox(deps.call) }); }
      catch (e) { return json({ ok: false, error: (e as Error).message }, 400); }
    })
    .get("/api/events", (c) =>
      streamSSE(c, async (stream) => {
        // STUB event bus: announce readiness, then keep-alive. Real op-driven events land later.
        await stream.writeSSE({ event: "ready", data: JSON.stringify({ ok: true }) });
        while (!stream.aborted) { await stream.sleep(15_000); if (stream.aborted) break; await stream.writeSSE({ event: "ping", data: "{}" }); }
      }))
    .all("/api/:op", async (c) => {
      const op = c.req.param("op");
      if (!OP_NAME.test(op)) return json({ ok: false, error: "not found" }, 404);
      const h: PolicyHeaders = { get: (n) => c.req.header(n) };
      const mutation = deps.isMutation?.(op) === true;
      let args: Record<string, unknown> = {};
      if (mutation) {
        // ── mutation write guards (P1.5) ──────────────────────────────────────────────────────
        // A mutation is a POST + JSON body, from a non-cross-origin caller, within the body cap,
        // and — when the host wires one — past authorizeWrite. Each failure is its own status so a
        // caller (and the negative-test matrix) can tell them apart.
        if (c.req.method !== "POST") return json({ ok: false, error: `operation ${op} is a mutation — POST only` }, 405);
        if (crossOriginRejected(h, deps.allowedHosts)) return json({ ok: false, error: "cross-origin mutation rejected" }, 403);
        const ct = (h.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
        if (ct !== "application/json") return json({ ok: false, error: "mutation requires content-type application/json" }, 415);
        const max = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
        const clen = Number(h.get("content-length") ?? "");
        if (Number.isFinite(clen) && clen > max) return json({ ok: false, error: "request body too large" }, 413);
        if (deps.authorizeWrite && !(await deps.authorizeWrite(h))) {
          return json({ ok: false, error: "unauthorized (missing or invalid write capability)" }, 401);
        }
        // Read the body ONCE as text (so we can enforce the cap even without content-length) then
        // parse — malformed JSON is a 400, never silently coerced to {} (Codex R1#3).
        const raw = await c.req.text();
        if (raw.length > max) return json({ ok: false, error: "request body too large" }, 413);
        try { args = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>; }
        catch { return json({ ok: false, error: "malformed JSON body" }, 400); }
        if (args === null || typeof args !== "object" || Array.isArray(args)) {
          return json({ ok: false, error: "JSON body must be an object" }, 400);
        }
      } else if (c.req.method === "POST") {
        // read op via POST (the dev console posts recall/neighbors): tolerate an empty/absent body,
        // but a present body that is malformed is still a 400 rather than a silent {}.
        const raw = await c.req.text();
        try { args = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>; }
        catch { return json({ ok: false, error: "malformed JSON body" }, 400); }
        if (args === null || typeof args !== "object" || Array.isArray(args)) args = {};
      } else {
        // Every query param arrives as a string; the ops' own zod schemas coerce the numeric ones
        // (P3.15). This spine deliberately knows NO argument names — it used to hardcode `k`/`n`
        // and `Number()` never throws, so `?k=abc` became NaN and `?k=1e999` became Infinity.
        for (const [k, v] of new URL(c.req.url).searchParams) args[k] = v;
      }
      try { return json({ ok: true, result: await deps.call(op, args) }); }
      catch (e) { return json({ ok: false, error: (e as Error).message }, 400); }
    })
    .notFound((c) => json({ ok: false, error: "not found" }, 404));
  return app;
}

/** Route-typed app shape for `hc<AppType>` RPC clients (S5 surface). */
export type AppType = ReturnType<typeof createApp>;
