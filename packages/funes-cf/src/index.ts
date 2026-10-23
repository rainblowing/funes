// The edge entry, one per deployment and stateless (ADR-0024). Its default export is a plain {fetch}
// handler with no WorkerEntrypoint methods, so a service binding to it can call nothing but fetch
// (record 34). The routes are /mcp/<key> (mcp.ts) and /mint/<key> (mint-telegram.ts); the key names
// the star's object, `STAR.getByName(key)`. Any other path is 404.
import { parseCanonicalKey } from "funes-core/internal";
import { logError } from "./log.ts";
import { bearerOf, serveMcp } from "./mcp.ts";
import { MAX_STAR_KEY_BYTES } from "./star-do.ts";

export { StarDO } from "./star-do.ts";

/** The entry's own refusal: JSON, never cached; a 401 names the scheme it wants (RFC 6750 §3). */
const refuse = (status: number, error: string, message: string): Response =>
  new Response(`${JSON.stringify({ error, message })}\n`, {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...(status === 401 ? { "www-authenticate": "Bearer" } : {}) },
  });

/** The key gate: the path's key when it is exactly canonical (getByName is case-sensitive, and the
 *  parser lowercases and trims) and at most 47 bytes, else null. */
export function starKeyOf(raw: string): string | null {
  const p = parseCanonicalKey(raw);
  return p.ok && p.key === raw && new TextEncoder().encode(raw).length <= MAX_STAR_KEY_BYTES ? raw : null;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      // The checks both paths share (ADR-0014): the Host the Worker serves, the route, the key, https: only.
      const url = new URL(request.url);
      if (url.host !== env.FUNES_HOST) return refuse(421, "host", `this host serves ${env.FUNES_HOST} exactly`);
      const route = /^\/(mcp|mint)\/(.+)$/.exec(url.pathname);
      if (!route) return refuse(404, "not-found", "the routes are /mcp/<star key> and /mint/<star key>");
      const key = starKeyOf(route[2]!);
      if (!key) return refuse(404, "unknown-star", "the path names no star key: exactly canonical, at most 47 bytes");
      const star = () => env.STAR.getByName(key);
      if (url.protocol !== "https:") {
        // A token sent in cleartext is dead: revoked on the spot in its star's object, and answered 401 (ADR-0014).
        const token = bearerOf(request);
        if (!token) return refuse(403, "https-only", "https only");
        await star().revoke(token);
        return refuse(401, "unauthorized", "a bearer sent over http: is revoked: send Authorization: Bearer <token> over https only");
      }
      if (route[1] === "mint") {
        if (!env.TELEGRAM_LOGIN_KEY) return refuse(404, "not-found", "this deployment has no Telegram mint");
        return await star().mint(request);
      }
      return await serveMcp(request, env.FUNES_HOST, star, ctx);
    } catch (e) {
      logError("entry-error", e);
      return refuse(500, "internal", "internal error");
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>;
