import { DurableObject } from "cloudflare:workers";
import { createProtocolTables } from "./edge-store.ts";
import { logError } from "./log.ts";
import { serveMint, type MintEnv } from "./mint.ts";
import { designationFor, sha256Hex, starConfigFromText } from "funes-engine/portable";
import STAR_YAML from "./star.yaml";
import { armAlarm, Writer, type Authorized, type Reply } from "./writer.ts";

/** What the taste DO is bound to (wrangler.jsonc). */
export interface TasteEnv extends MintEnv {
  FUNES_LOCUS?: string;
  TASTE: DurableObjectNamespace;
  TASTE_VAULT: R2Bucket;
  AI: Ai;
}

/** Record 24 §1's proof, run once in the constructor: the bundled star.yaml parses and validates,
 *  `FUNES_LOCUS` equals its `meta.write_locus` under ADR-0005's rule, and this object's id is
 *  `idFromName` of the star's canonical key. It catches configuration drift, not a second deployment
 *  of the same code (that is the deploy credential's, RAI-173 Q1). */
export function proveLocus(starText: string, funesLocus: string | undefined, idIs: (key: string) => boolean): { locus: string } | { refused: string } {
  try {
    const star = starConfigFromText(starText);
    const { identity, scope, recall } = star;
    if (!identity.key) return { refused: "the bundled star.yaml names no meta.id" };
    if (scope.kind === "invalid") return { refused: `the bundled star.yaml's index_scope is invalid (${scope.reason})` };
    if (recall?.kind === "invalid") return { refused: `the bundled star.yaml's memory.recall is invalid (${recall.reason})` };
    if (identity.okfInvalid) return { refused: `the bundled star.yaml's memory.okf is invalid (${identity.okfInvalid})` };
    const d = designationFor(identity.writeLocus, "the bundled star.yaml", { locus: funesLocus, mode: "audit", env: {} });
    if (d.locus == null || d.locus !== d.authority) return { refused: `FUNES_LOCUS ${JSON.stringify(funesLocus ?? null)} is not the star's write_locus ${JSON.stringify(d.authority)}` };
    if (!idIs(identity.key)) return { refused: `this object is not idFromName("${identity.key}")` };
    return { locus: d.locus };
  } catch (e) {
    return { refused: (e as Error).message };
  }
}

/** The taste DO: the writer, the index host and the grant store of the taste star (record 34).
 *  SQLite-backed by wrangler.jsonc's v1 migration. This module is the only one that may name the
 *  bucket binding (record 24 §2; test/config.node.ts). The entry reaches it only by
 *  `env.TASTE.getByName("rainblow.ing/taste")`; any other object of the class never serves. */
export class TasteDO extends DurableObject<TasteEnv> {
  private readonly writer: Writer | null = null;
  private readonly refused: string | null = null;

  constructor(ctx: DurableObjectState, env: TasteEnv) {
    super(ctx, env);
    const proof = proveLocus(STAR_YAML, env.FUNES_LOCUS, (key) => ctx.id.equals(env.TASTE.idFromName(key)));
    if ("refused" in proof) {
      this.refused = proof.refused;
      return;
    }
    this.writer = new Writer({
      storage: ctx.storage, bucket: env.TASTE_VAULT, ai: env.AI, starText: STAR_YAML, locus: proof.locus,
      waitUntil: (p) => ctx.waitUntil(p),
    });
    // The first hold (recovery, the canary, the star.yaml publish) runs from this alarm, or from the
    // first mutation if one comes first. Short storage-only work, the documented constructor use.
    void ctx.blockConcurrencyWhile(() => armAlarm(ctx.storage, Date.now()));
  }

  private serving(): Writer {
    if (!this.writer) throw new Error(`funes-taste: this object does not serve — ${this.refused}`);
    return this.writer;
  }

  /** /mint (item 44), after the entry's Host and https: checks. It needs no writer, so it is not
   *  gated on the locus proof. A throw logs its name and code only: never a message, which could
   *  carry the query string (record 35 L9). */
  async mint(request: Request): Promise<Response> {
    try {
      return await serveMint(request, this.ctx.storage, this.env);
    } catch (e) {
      logError("mint-error", e);
      return new Response("refused: internal error\n", { status: 500, headers: { "cache-control": "no-store" } });
    }
  }

  /** The entry's grant check before it reads an /mcp body (item 43): 401, 403, or the preset's ops. */
  async authorize(presented: string): Promise<Authorized> {
    return this.serving().authorize(presented);
  }

  /** A bearer the entry saw on an http: request is dead (ADR-0014): its live row is revoked now. The
   *  row is kept (supersede, never delete); no writer is needed, as for /mint's revoke. */
  async revoke(presented: string): Promise<void> {
    createProtocolTables(this.ctx.storage.sql);
    this.ctx.storage.sql.exec("update grants set revoked_at = ? where token_sha256 = ? and revoked_at is null",
      new Date().toISOString(), sha256Hex(presented));
  }

  /** One MCP tool call from the entry (item 43): the presented bearer, the op and its arguments. */
  async call(presented: string | null, name: string, args: Record<string, unknown>): Promise<Reply> {
    return this.serving().call(presented, name, args);
  }

  async alarm(): Promise<void> {
    if (this.writer) await this.writer.alarm();
  }
}
