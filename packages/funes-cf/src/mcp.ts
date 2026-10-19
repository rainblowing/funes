// The edge face's /mcp entry (PLAN-0.5.0 item 43, ADR-0014, record 32): the Worker side. The checks
// run in this order, each before the next costs anything:
//   Origin or Sec-Fetch-Site     403 — API-only, and no response carries a CORS header
//   presentedToken, then shape   401 with WWW-Authenticate: Bearer, with no DO call (no legacy header)
//   the grant (the DO)           401 unknown/revoked/expired/malformed table, 403 a star not granted —
//                                both before the body is read
//   POST only, the 1 MiB cap     405, 413
// Then the MCP SDK's own web-standard handler (not `agents`' createMcpHandler, whose peers pin the
// SDK at 2.0.0) serves the request; every tool call is one DO call, which runs the same
// dispatchToolCall over {vault: R2Vault, star} (writer.ts). The Host and https: checks are the
// entry's (index.ts), shared with /mint.
import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import { presentedToken } from "funes-core";
import { FUNES_VERSION } from "funes-engine/portable";
import { EDGE_OPERATIONS } from "./grants.ts";
import { logError } from "./log.ts";
import type { Authorized, Reply } from "./writer.ts";
import type { TasteDO } from "./taste-do.ts";

/** The byte cap the 0.4.0 faces carry over (record 32). */
export const MAX_MCP_BODY_BYTES = 1024 * 1024;
const TOKEN_SHAPE = /^funes_[A-Za-z0-9_-]{43}$/;

/** A refusal: JSON, never cached, and every 401 names the scheme it wants (RFC 6750 §3). */
export function refuse(status: number, why: string, headers: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify({ error: why })}\n`, {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...(status === 401 ? { "www-authenticate": "Bearer" } : {}), ...headers },
  });
}

/** The presented bearer when it has the shape of a funes token, else null. ADR-0016's parser with no
 *  legacy header (ADR-0014); a query-string token is never read. */
export function bearerOf(request: Request): string | null {
  const p = presentedToken((n) => request.headers.get(n), null);
  return "token" in p && p.token != null && TOKEN_SHAPE.test(p.token) ? p.token : null;
}

export async function serveMcp(request: Request, taste: () => DurableObjectStub<TasteDO>, ctx: ExecutionContext): Promise<Response> {
  if (request.headers.has("origin") || request.headers.has("sec-fetch-site")) return refuse(403, "browser-origin requests are refused on /mcp");
  const token = bearerOf(request);
  if (!token) return refuse(401, "unauthorized");
  // Every DO call runs under waitUntil, so a client disconnect cannot cancel an apply (record 34).
  // (The RPC stub's types wrap each result; the values are plain Authorized and Reply.)
  const held = <T>(p: Promise<unknown>): Promise<T> => (ctx.waitUntil(p.catch(() => {})), p as Promise<T>);
  const stub = taste();
  const auth = await held<Authorized>(stub.authorize(token));
  if (auth.status !== 200) return refuse(auth.status, auth.status === 403 ? "this grant does not name the star" : "unauthorized");
  if (request.method !== "POST") return refuse(405, "POST only", { allow: "POST" });

  const tools = EDGE_OPERATIONS.filter((o) => auth.ops.includes(o.name) && !o.internal)
    .map((o) => ({ name: o.name, description: o.description, inputSchema: o.inputSchema }));
  const handler = createMcpHandler(() => {
    const server = new Server({ name: "funes-taste", version: FUNES_VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", async () => ({ tools }));
    server.setRequestHandler("tools/call", async (req) => {
      const { name, arguments: args = {} } = req.params;
      const r = await held<Reply>(stub.call(token, name, args as Record<string, unknown>));
      return r.status === 200
        ? { content: [{ type: "text" as const, text: JSON.stringify(r.body) }] }
        : { content: [{ type: "text" as const, text: JSON.stringify({ status: r.status, ...(r.body as object) }) }], isError: true };
    });
    return server;
    // responseMode stays the default: funes emits no mid-call notification, so a modern reply is one
    // JSON body anyway, and "json" makes the SDK console.warn on every construction (one per request).
  }, { legacy: "stateless", maxRequestBodySize: MAX_MCP_BODY_BYTES, onerror: (e) => logError("mcp-transport", e) });
  return handler.fetch(request);
}
