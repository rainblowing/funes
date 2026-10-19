// The bindings the workerd tests read from `cloudflare:test`'s env. The bucket binding is not
// named here: only the DO's module may name it (test/config.node.ts).
declare namespace Cloudflare {
  interface Env {
    TASTE: DurableObjectNamespace<import("../src/taste-do.ts").TasteDO>;
    AI: Ai;
    /** The local R2 double R2Vault is tested over (vitest.config.ts): never the canonical bucket. */
    R2_DOUBLE: R2Bucket;
    /** wrangler vars: the one Host served (421 otherwise) and the Telegram ids /mint admits. */
    FUNES_HOST: string;
    TELEGRAM_ALLOWED_IDS: string;
    /** A secret: sha256 of the bot token, 64 lowercase hex (runbook 12). Tests get a fake. */
    TELEGRAM_LOGIN_KEY: string;
  }
}

/** Vite's raw import: a test reads the bundled taste star.yaml as text, as the DO's Text module will. */
declare module "*.yaml?raw" {
  const text: string;
  export default text;
}

/** The operator's sanctioned SQL statements (sql/*.sql), read as the operator pastes them. */
declare module "*.sql?raw" {
  const text: string;
  export default text;
}
