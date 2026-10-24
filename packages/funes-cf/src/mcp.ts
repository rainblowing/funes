// The edge face's /mcp/<key> entry (ADR-0014 as amended, RAI-310, ADR-0024): the Worker mounts funes'
// one HTTP MCP handler (`funes-core/mcp-http`, RAI-313) with the edge as its host. The handler runs
// the checks in order (Host, browser origin, Bearer, the grant, POST, the 1 MiB cap, parse); the star
// key's object answers the grant and runs every tool call, re-reading the grant inside the RPC that
// applies it (writer.ts). The https: rule and the key gate are the entry's (index.ts).
import { presentedToken } from "funes-core";
import { mcpHandler } from "funes-core/mcp-http";
import type { Grant, Refusal } from "funes-core";
import { logError } from "./log.ts";
import type { Authorized, Reply } from "./writer.ts";
import type { StarDO } from "./star-do.ts";

/** A funes token's shape: anything else is 401 with no DO call. */
const TOKEN_SHAPE = /^funes_[A-Za-z0-9_-]{43}$/;
/** The presented bearer when it has the shape of a funes token, else null (no legacy header, ADR-0014). */
export function bearerOf(request: Request): string | null {
  const p = presentedToken((n) => request.headers.get(n));
  return "token" in p && p.token != null && TOKEN_SHAPE.test(p.token) ? p.token : null;
}
const UNAUTHORIZED: Refusal = { status: 401, error: "unauthorized", message: "no funes token: send Authorization: Bearer <token>" };

export function serveMcp(request: Request, host: string, star: () => DurableObjectStub<StarDO>, ctx: ExecutionContext): Promise<Response> {
  // Every DO call runs under waitUntil, so a client disconnect cannot cancel an apply (record 34).
  // (The RPC stub's types wrap each result; the values are plain Authorized and Reply.)
  const held = <T>(p: Promise<unknown>): Promise<T> => (ctx.waitUntil(p.catch(() => {})), p as Promise<T>);
  return mcpHandler({
    tier: "edge",
    host,
    async grant(token): Promise<Grant | Refusal> {
      if (!token || !TOKEN_SHAPE.test(token)) return UNAUTHORIZED;
      const a = await held<Authorized>(star().authorize(token));
      // The handler answers a refusal's own status: the object's 404 unknown-star and 503 included.
      return "status" in a ? (a as Refusal) : { ...a, ops: new Set(a.ops) };
    },
    async call(name, args, auth) {
      const r = await held<Reply>(star().call(auth.token, name, args));
      if (r.status === 200) return r.body;
      const body = r.body as { error?: unknown; code?: unknown };
      throw Object.assign(new Error(String(body.error)), { status: r.status, code: body.code });
    },
    onerror: (e) => logError("mcp-transport", e),
  })(request, { loopback: false });
}
