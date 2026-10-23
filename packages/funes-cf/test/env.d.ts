// The bindings the workerd tests read from `cloudflare:test`'s env (wrangler.test.jsonc, and
// vitest.config.ts's miniflare additions). In src/ only the DO's module names the bucket binding
// (test/config.node.ts); a test names it only to seed a star's config (test/fixture-star.ts).
declare namespace Cloudflare {
  interface Env {
    STAR: DurableObjectNamespace<import("../src/star-do.ts").StarDO>;
    /** The deployment's one bucket: each star under `<key>/_/` (ADR-0024). */
    VAULT: R2Bucket;
    AI: Ai;
    /** The local R2 double R2Vault is tested over (vitest.config.ts): never the deployment's bucket. */
    R2_DOUBLE: R2Bucket;
    /** wrangler vars: the one Host served (421 otherwise) and the deployment's write locus. */
    FUNES_HOST: string;
    FUNES_LOCUS: string;
    /** A secret: sha256 of the bot token, 64 lowercase hex (runbook 12). Tests get a fake. */
    TELEGRAM_LOGIN_KEY: string;
  }
}

/** The operator's sanctioned SQL statements (sql/*.sql), read as the operator pastes them. */
declare module "*.sql?raw" {
  const text: string;
  export default text;
}
