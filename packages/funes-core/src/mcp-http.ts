// B5 (RAI-337; RAI-310 D4, D8a; ADR-0014 and ADR-0021 as amended): the one HTTP MCP handler. A web
// Request in, a Response out, so `funes serve`, the surface's loopback `/mcp` and the edge Worker run
// the same checks in the same order, each before the next costs anything:
//   1 exact Host                                      421 host
//   2 an Origin or a Sec-Fetch-Site header            403 browser-origin
//   3 Bearer → host.grant (absent, malformed, unknown) 401 unauthorized, WWW-Authenticate: Bearer
//   4 the grant does not name this star               403 not-granted
//   5 method is not POST                              405 method
//   6 body over the cap, before parse                 413 too-large
//   7 JSON parse                                      400 invalid
//   8 dispatch, through host.call
// A refusal is `{error, message}`, JSON, never cached, and no response carries a CORS header. It
// imports web standards, the MCP SDK and the registry only, never `node:fs`. The kernel's subpath
// `funes-core/mcp-http` (RAI-313 Q7): the one module that imports the MCP SDK.
import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import { presentedToken } from "./presented-token.ts";
import { buildToolDefs, operations, type Tier } from "./ops.ts";
import type { Grant } from "./actor.ts";
import type { Refusal } from "./authorize.ts";
import { FUNES_VERSION } from "./version.ts";

export interface McpHost {
  tier: Tier;
  /** The exact Host this host serves (`name` or `name:port`). */
  host: string;
  /** The byte cap on a request body. Default 1 MiB. */
  maxBodyBytes?: number;
  /** The presented Bearer (or null) → a Grant cut to the ceiling, or a refusal. `authorize` does it. */
  grant(token: string | null, peer: { loopback: boolean }): Promise<Grant | Refusal>;
  /** Run one op. A throw is a tool error: its `status` (else 403 for `not-granted`, else 400) and `code`. */
  call(name: string, args: Record<string, unknown>, auth: { token: string | null; grant: Grant }, peer: { loopback: boolean }): Promise<unknown>;
  /** The MCP transport's own errors. */
  onerror?(e: Error): void;
}

const MAX_MCP_BODY_BYTES = 1024 * 1024;

function refuse(status: number, error: string, message: string, headers: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify({ error, message })}\n`, {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...(status === 401 ? { "www-authenticate": "Bearer" } : {}), ...headers },
  });
}

/** The body, or null when it is over `max`: a declared length is refused unread, a stream stops at the cap. */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  if (Number(request.headers.get("content-length") ?? 0) > max) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

export function mcpHandler(host: McpHost): (request: Request, peer: { loopback: boolean }) => Promise<Response> {
  const max = host.maxBodyBytes ?? MAX_MCP_BODY_BYTES;
  return async (request, peer) => {
    if ((request.headers.get("host") ?? new URL(request.url).host) !== host.host) return refuse(421, "host", `this host serves ${host.host} exactly`);
    if (request.headers.has("origin") || request.headers.has("sec-fetch-site")) return refuse(403, "browser-origin", "browser-origin requests are refused on /mcp");
    const p = presentedToken((n) => request.headers.get(n));
    if ("refused" in p) return refuse(401, "unauthorized", "malformed Authorization: send Authorization: Bearer <token>");
    const grant = await host.grant(p.token, peer);
    if ("status" in grant) return refuse(grant.status, grant.error, grant.message);
    if (request.method !== "POST") return refuse(405, "method", "POST only", { allow: "POST" });
    const raw = await readCapped(request, max);
    if (raw === null) return refuse(413, "too-large", `request body over ${max} bytes`, { connection: "close" });
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(new TextDecoder().decode(raw)); // a leading BOM is dropped, as the SDK decodes
    } catch {
      return refuse(400, "invalid", "the body is not JSON");
    }
    const tools = buildToolDefs(operations.filter((o) => grant.ops.has(o.name)));
    const auth = { token: p.token, grant };
    const handler = createMcpHandler(() => {
      const server = new Server({ name: "funes", version: FUNES_VERSION }, { capabilities: { tools: {} } });
      server.setRequestHandler("tools/list", async () => ({ tools }));
      server.setRequestHandler("tools/call", async (req) => {
        const { name, arguments: args = {} } = req.params;
        try {
          const result = await host.call(name, args as Record<string, unknown>, auth, peer);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        } catch (e) {
          const { status, code } = e as { status?: unknown; code?: unknown };
          const s = typeof status === "number" ? status : code === "not-granted" ? 403 : 400;
          return { content: [{ type: "text" as const, text: JSON.stringify({ status: s, ...(typeof code === "string" ? { code } : {}), error: (e as Error).message }) }], isError: true };
        }
      });
      return server;
      // responseMode stays the default: funes emits no mid-call notification, and "json" makes the SDK
      // console.warn on every construction (one per request).
    }, { legacy: "stateless", onerror: (e) => host.onerror?.(e) });
    return handler.fetch(request, { parsedBody });
  };
}
