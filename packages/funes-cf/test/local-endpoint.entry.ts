// A local endpoint for record 35 N9 (test/n9.node.ts): funes-taste's own entry and StarDO under
// `wrangler dev` with the TEST config, plus what that config cannot carry. env.AI is a fake (the
// test config has no `ai` binding; Workers AI has no local mode), and `/__provision/<key>?sha=` writes
// a test outbox row in that star's object, as the deploy login runs `funes token mint --edge`'s
// statements (revoke, then insert). The star's config is seeded first (test/seed-local.ts). Never
// deployed, never in wrangler.jsonc: the deploy config's main is src/index.ts.
import worker, { StarDO as Real } from "../src/index.ts";
import type { StarEnv } from "../src/star-do.ts";
import { fakeAiRun } from "./fake-ai.ts";

/** The same fake as vitest.config.ts's env.AI. */
const FAKE_AI = { run: async (model: string, inputs: { text: string | string[] }) => fakeAiRun(model, inputs) } as unknown as Ai;

export class StarDO extends Real {
  constructor(ctx: DurableObjectState, env: StarEnv) {
    super(ctx, { ...env, AI: FAKE_AI });
  }

  /** The outbox row for a token's sha256, in this star's object once its config is proven. */
  async provisionOutbox(tokenSha256: string, label: string): Promise<boolean> {
    if ("status" in (await this.load())) return false;
    const sql = this.ctx.storage.sql;
    const at = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      sql.exec("update grants set revoked_at = ? where role = 'outbox' and revoked_at is null", at);
      sql.exec("insert into grants(token_sha256, actor, role, stars, created_at, expires_at, revoked_at, label) values (?, ?, 'outbox', ?, ?, null, null, ?)",
        tokenSha256, `outbox@${label}`, JSON.stringify([this.ctx.id.name]), at, label);
    });
    return true;
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__provision/")) {
      const ns = env.STAR as unknown as DurableObjectNamespace<StarDO>;
      const ok = await ns.getByName(url.pathname.slice("/__provision/".length)).provisionOutbox(url.searchParams.get("sha") ?? "", "replica");
      return new Response(ok ? "provisioned\n" : "unknown star\n", { status: ok ? 200 : 404 });
    }
    return worker.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
