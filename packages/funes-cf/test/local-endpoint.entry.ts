// A local endpoint for record 35 N9 (test/n9.node.ts): funes-taste's own entry and DO under
// `wrangler dev` with the TEST config, plus what that config cannot carry. env.AI is a fake (the
// test config has no `ai` binding; Workers AI has no local mode), and `/__provision?sha=` runs the
// named outbox provisioning statement, which in production only Vlad's deploy login runs. Never
// deployed, never in wrangler.jsonc: the deploy config's main is src/index.ts.
import worker, { TasteDO as Real } from "../src/index.ts";
import type { TasteEnv } from "../src/taste-do.ts";
import { createProtocolTables } from "../src/edge-store.ts";
import { PROVISION_OUTBOX_SQL } from "../src/mint.ts";
import { fakeAiRun } from "./fake-ai.ts";

/** The same fake as vitest.config.ts's env.AI. */
const FAKE_AI = { run: async (model: string, inputs: { text: string | string[] }) => fakeAiRun(model, inputs) } as unknown as Ai;

export class TasteDO extends Real {
  constructor(ctx: DurableObjectState, env: TasteEnv) {
    super(ctx, { ...env, AI: FAKE_AI });
  }

  provisionOutbox(tokenSha256: string, label: string): void {
    const sql = this.ctx.storage.sql;
    createProtocolTables(sql);
    this.ctx.storage.transactionSync(() => {
      for (const s of PROVISION_OUTBOX_SQL) sql.exec(s, tokenSha256, label, new Date().toISOString());
    });
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__provision") {
      const ns = env.TASTE as unknown as DurableObjectNamespace<TasteDO>;
      await ns.getByName("rainblow.ing/taste").provisionOutbox(url.searchParams.get("sha") ?? "", "replica");
      return new Response("provisioned\n");
    }
    return worker.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
