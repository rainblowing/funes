// The funes-taste entry. Its default export is a plain {fetch} handler with no WorkerEntrypoint
// methods, so a service binding to it can call nothing but fetch (record 34). /mint is item 44,
// /mcp item 43 (mcp.ts). Any other path is 404.
import { logError } from "./log.ts";
import { bearerOf, refuse, serveMcp } from "./mcp.ts";

export { TasteDO } from "./taste-do.ts";

/** The taste DO's instance name: the scheme-free canonical key of the bundled star (record 24). */
const TASTE_KEY = "rainblow.ing/taste";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      // The checks both paths share (ADR-0014): the Host the Worker serves, and https: only.
      const url = new URL(request.url);
      if (url.host !== env.FUNES_HOST) return new Response(null, { status: 421 });
      const taste = () => env.TASTE.getByName(TASTE_KEY);
      if (url.protocol !== "https:") {
        // A token sent in cleartext is dead: revoked on the spot, and answered 401 (ADR-0014).
        const token = bearerOf(request);
        if (!token) return new Response("https only\n", { status: 403 });
        await taste().revoke(token);
        return refuse(401, "a bearer sent over http: is revoked");
      }
      if (url.pathname === "/mint") return await taste().mint(request);
      if (url.pathname === "/mcp") return await serveMcp(request, taste, ctx);
      return new Response(null, { status: 404 });
    } catch (e) {
      logError("entry-error", e);
      return refuse(500, "internal error");
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>;
