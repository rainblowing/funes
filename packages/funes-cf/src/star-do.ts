import { DurableObject } from "cloudflare:workers";
import { refKey } from "funes-core";
import { designationFor, sha256Hex, starConfigFromText, validLocus, type StarConfig } from "funes-core/internal";
import { logError } from "./log.ts";
import { serveMint } from "./mint-telegram.ts";
import { Writer, type Authorized, type NotServing, type Reply } from "./writer.ts";

/** What a StarDO is bound to (wrangler.jsonc): per deployment, never per star (ADR-0024). */
export interface StarEnv {
  FUNES_LOCUS?: string;
  FUNES_HOST: string;
  /** A secret: sha256 of the bot token. Absent, /mint answers 404 (index.ts). */
  TELEGRAM_LOGIN_KEY?: string;
  STAR: DurableObjectNamespace;
  VAULT: R2Bucket;
  AI: Ai;
}

/** A star key's cap in UTF-8 bytes: `<key>/_/` then fits ADR-0011's 50-byte slack, so every star keeps
 *  the full 900-byte page budget (ADR-0024). */
export const MAX_STAR_KEY_BYTES = 47;

/** The edge's proof (record 24 §1, re-sourced from R2 by ADR-0024), run on the config `<key>/_/star.yaml`
 *  holds: it parses and validates, declares `memory.memory_dir`, `memory.item_pages` and a well-formed
 *  mint allowlist, `FUNES_LOCUS` equals its `meta.write_locus` under ADR-0005's rule, its
 *  `refKey(meta.id)` is the object's key, and the key is at most 47 bytes. It catches configuration
 *  drift (a config put under the wrong prefix included), not a second deployment of the same code. */
export function proveStar(starText: string, funesLocus: string | undefined, key: string): { locus: string; star: StarConfig } | { refused: string } {
  try {
    if (new TextEncoder().encode(key).length > MAX_STAR_KEY_BYTES) return { refused: `the star key is over ${MAX_STAR_KEY_BYTES} bytes` };
    const star = starConfigFromText(starText);
    const { identity, scope, recall } = star;
    if (!identity.id) return { refused: "the star.yaml names no meta.id" };
    if (refKey(identity.id) !== key) return { refused: `the star.yaml's meta.id ${JSON.stringify(identity.id)} is not the star key ${JSON.stringify(key)}` };
    if (scope.kind === "invalid") return { refused: `the star.yaml's index_scope is invalid (${scope.reason})` };
    if (recall?.kind === "invalid") return { refused: `the star.yaml's memory.recall is invalid (${recall.reason})` };
    if (identity.okfInvalid) return { refused: `the star.yaml's memory.okf is invalid (${identity.okfInvalid})` };
    if (star.memoryDir == null) return { refused: "the star.yaml declares no memory.memory_dir (required at the edge)" };
    if (star.itemPages == null) return { refused: "the star.yaml declares no boolean memory.item_pages (required at the edge)" };
    if (star.mintIds == null) return { refused: "the star.yaml's edge.mint.telegram_ids is not a list of Telegram ids" };
    const d = designationFor(identity.writeLocus, "the star.yaml", funesLocus == null ? null : validLocus(funesLocus, "FUNES_LOCUS"));
    if (d.locus == null || d.locus !== d.authority) return { refused: `FUNES_LOCUS ${JSON.stringify(funesLocus ?? null)} is not the star's write_locus ${JSON.stringify(d.authority)}` };
    return { locus: d.locus, star };
  } catch (e) {
    return { refused: (e as Error).message };
  }
}

/** One object per star key (ADR-0024): the writer, the index host and the grant store of the star
 *  `ctx.id.name` names — the edge's one composition function. SQLite-backed by wrangler.jsonc's v1
 *  migration. This module is the only one that may name the bucket binding (test/config.node.ts).
 *
 *  The constructor does nothing. The first request loads `<key>/_/star.yaml` inside
 *  blockConcurrencyWhile and memoizes only a proven config. Until then the object refuses every path,
 *  creates no table, writes nothing and arms no alarm (the unproven-object rule). */
export class StarDO extends DurableObject<StarEnv> {
  private writer: Writer | null = null;

  /** The proven writer, or why this object does not serve. An R2 error is caught inside the block
   *  (a throw there would reset the object) and answered 503; it is never memoized. */
  protected async load(): Promise<Writer | NotServing> {
    if (this.writer) return this.writer;
    return this.ctx.blockConcurrencyWhile(async (): Promise<Writer | NotServing> => {
      if (this.writer) return this.writer;
      const key = this.ctx.id.name;
      const unknown = (why: string): NotServing => ({ status: 404, error: "unknown-star", message: `no star is served at this key: ${why}` });
      if (!key) return unknown("this object has no name");
      let text: string | null;
      try {
        text = (await (await this.env.VAULT.get(`${key}/_/star.yaml`))?.text()) ?? null;
      } catch (e) {
        logError("star-config", e);
        return { status: 503, error: "unavailable", message: "the star's config could not be read; retry" };
      }
      if (text === null) return unknown("no star.yaml");
      const proof = proveStar(text, this.env.FUNES_LOCUS, key);
      if ("refused" in proof) return unknown(proof.refused);
      const writer = new Writer({
        storage: this.ctx.storage, bucket: this.env.VAULT, ai: this.env.AI, star: proof.star, key, locus: proof.locus,
        waitUntil: (p) => this.ctx.waitUntil(p),
      });
      await writer.wake();
      return (this.writer = writer);
    });
  }

  /** /mint/<key> (item 44), after the entry's checks, on a proven object only. A throw logs its name
   *  and code only: never a message, which could carry the query string (record 35 L9). */
  async mint(request: Request): Promise<Response> {
    try {
      const w = await this.load();
      if (!(w instanceof Writer)) return new Response(`refused: ${w.error}\n`, { status: w.status, headers: { "cache-control": "no-store" } });
      return await serveMint(request, this.ctx.storage, { host: this.env.FUNES_HOST, loginKey: this.env.TELEGRAM_LOGIN_KEY, key: this.ctx.id.name!, mintIds: w.mintIds });
    } catch (e) {
      logError("mint-error", e);
      return new Response("refused: internal error\n", { status: 500, headers: { "cache-control": "no-store" } });
    }
  }

  /** The entry's grant check before it reads an /mcp body (item 43): 401, 403, 404, 503, or the
   *  preset's ops. */
  async authorize(presented: string): Promise<Authorized> {
    const w = await this.load();
    return w instanceof Writer ? w.authorize(presented) : w;
  }

  /** A bearer the entry saw on an http: request is dead (ADR-0014): its live row is revoked now, in
   *  this star's object only. The row is kept (supersede, never delete). */
  async revoke(presented: string): Promise<void> {
    if (!((await this.load()) instanceof Writer)) return;
    this.ctx.storage.sql.exec("update grants set revoked_at = ? where token_sha256 = ? and revoked_at is null",
      new Date().toISOString(), sha256Hex(presented));
  }

  /** One MCP tool call from the entry (item 43): the presented bearer, the op and its arguments. */
  async call(presented: string | null, name: string, args: Record<string, unknown>): Promise<Reply> {
    const w = await this.load();
    return w instanceof Writer ? w.call(presented, name, args) : { status: w.status, body: { error: w.message, code: w.error } };
  }

  /** An alarm that finds no name or no proven config does no work: the next named request loads. */
  async alarm(): Promise<void> {
    const w = await this.load();
    if (w instanceof Writer) await w.alarm();
  }
}
