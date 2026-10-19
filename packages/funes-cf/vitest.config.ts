import { createHash } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { fakeAiRun } from "./test/fake-ai.ts";

// Three projects, one `vitest run` (the ci.yml funes-cf job):
//   config  — Node: the wrangler configs' invariants, read with wrangler's own parser.
//   workerd — the Worker under local workerd (miniflare), bound by the TEST config: no `ai`
//             binding (Workers AI has no local mode; it would need the account), so nothing here
//             touches Cloudflare. Never `wrangler dev --remote`.
//   probe   — the probe Worker funes-probe (item 36) the same way, by probe/wrangler.test.jsonc,
//             against miniflare's local R2 and a drifting fake AI.
// Test files are *.node.ts / *.workerd.ts, never *.test.ts: the repo's `bun test` must skip them.

/** env.AI in tests: test/fake-ai.ts's deterministic fake reached over RPC, never Workers AI. */
const FAKE_AI = `import { WorkerEntrypoint } from "cloudflare:workers";
const fakeAiRun = ${fakeAiRun.toString()};
export class FakeAi extends WorkerEntrypoint {
  async run(model, inputs) { return fakeAiRun(model, inputs); }
}
export default { fetch: () => new Response(null, { status: 404 }) };`;

/** env.AI for the probe Worker: one text per call and no options (no gateway), else it throws. A
 *  text of 128 bytes or more comes back rotated by cos θ = 0.999 on every even call of that text,
 *  and every answer reports `pooling: "cls"`, so test/probe.workerd.ts checks the report against a
 *  worked example. */
const DRIFTING_AI = `import { WorkerEntrypoint } from "cloudflare:workers";
const seen = new Map();
export class DriftingAi extends WorkerEntrypoint {
  async run(_model, inputs, options) {
    if (options !== undefined) throw new Error("the probe passes no options: no gateway");
    if (!Array.isArray(inputs.text) || inputs.text.length !== 1) throw new Error("one text per call");
    const t = inputs.text[0];
    const n = (seen.get(t) ?? 0) + 1;
    seen.set(t, n);
    const bytes = new TextEncoder().encode(t).length;
    const k = bytes % 1000;
    const v = new Array(1024).fill(0);
    if (bytes >= 128 && n % 2 === 0) { v[k] = 0.999; v[k + 1] = Math.sqrt(1 - 0.999 * 0.999); } else v[k] = 1;
    return { shape: [1, 1024], data: [v], pooling: "cls" };
  }
}
export default { fetch: () => new Response(null, { status: 404 }) };`;

/** Every outbound fetch from the Worker lands here: OpenRouter gets a stub, any other host a 599.
 *  No test reaches the network. */
const OUTBOUND = (req: Request): Response =>
  new URL(req.url).host === "openrouter.ai"
    ? Response.json({ stub: "openrouter", choices: [] })
    : new Response(`outbound refused in tests: ${new URL(req.url).host}`, { status: 599 });

export default defineConfig({
  test: {
    projects: [
      { test: { name: "config", environment: "node", include: ["test/**/*.node.ts"] } },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.test.jsonc" },
            miniflare: {
              outboundService: OUTBOUND,
              // /mint's secret and allowlist (item 44): a key derived from a fake bot token, and one
              // allowlisted Telegram id. The tests sign logins with env.TELEGRAM_LOGIN_KEY.
              bindings: { TELEGRAM_LOGIN_KEY: createHash("sha256").update("fake-bot-token").digest("hex"), TELEGRAM_ALLOWED_IDS: "4242, 77" },
              serviceBindings: { AI: { name: "fake-ai", entrypoint: "FakeAi" } },
              // R2Vault's double (item 34): miniflare's local R2, a bucket of its own, so no test
              // names the canonical binding. test/r2-vault.workerd.ts first asserts it honours both
              // conditional cases (ADR-0011).
              r2Buckets: ["R2_DOUBLE"],
              workers: [{ name: "fake-ai", modules: true, script: FAKE_AI, compatibilityDate: "2026-10-06" }],
            },
          }),
        ],
        test: { name: "workerd", include: ["test/**/*.workerd.ts"], exclude: ["test/probe.workerd.ts"] },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./probe/wrangler.test.jsonc" },
            miniflare: {
              outboundService: OUTBOUND,
              bindings: { PROBE_BEARER: "test-bearer-0123456789abcdef" },
              serviceBindings: { AI: { name: "drifting-ai", entrypoint: "DriftingAi" } },
              workers: [{ name: "drifting-ai", modules: true, script: DRIFTING_AI, compatibilityDate: "2026-10-06" }],
            },
          }),
        ],
        test: { name: "probe", include: ["test/probe.workerd.ts"] },
      },
    ],
  },
});
