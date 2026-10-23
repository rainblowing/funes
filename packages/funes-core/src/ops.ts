// Op-registry — the contract-first OpEntry[] pattern vendored from gbrain
// (wiki/synthesis/2026-06-09-gbrain-to-funes-core.md): one declarative array fanning out to
// stdio-MCP and HTTP through pure projections, all sharing one handler.
//
// S3 (H4): the registry carries MUTATING ops (remember/supersede/forget) — every mutation goes
// through FunesStore (assertOwned to out_memory/, sanitized, markdown-canonical write-through),
// and trust is SERVER-STAMPED: no operation accepts a `trust` argument; remote writes are always
// recorded untrusted; elevation is a deliberate separate act on the CLI/human surface only and
// is deliberately NOT in this registry. Recall is unrestricted (the S2 in_* hard filter retired)
// but every result carries {trust, path} so consumers weight/filter — the lone-local INGEST
// posture is "trust-tag only" (trifecta).
//
// P3.15: each op declares ONE zod schema (`args`) and `inputSchema` is DERIVED from it, so the
// advertised contract and the enforced contract cannot drift. See `op()` below.
//
// 0.6.0 (ADR-0020, RAI-304): twelve ops, one entry type, one `ceiling(tier, …)`. No twins and no
// internal ops: a cross-star call is the base op on a context with `crossStar` set.
import { z } from "zod";
import type { IndexedPage } from "./index-store.ts";
import type { RecallResult, ScalarFrontmatter } from "./types.ts";
import type { FunesIndexStore, ServingIndex } from "./index-store.ts";
import { ftsTerms } from "./ranking.ts";
import { planWhere, servedDeclaration } from "./recall-planner.ts";
import { parseFrontmatter } from "./markdown.ts";
import { vaultChangedSince, type Freshness } from "./reindex.ts";
import { crossStarExpectation, ownStarExpectation } from "./scope.ts";
import { isPagePath, zoneOfDir, type Vault } from "./vault.ts";
import { assertWriteAllowed, type WriteDesignation } from "./write-designation.ts";
import { refusal, sha256Hex, type FunesStore, type StarConfig } from "./funes-store.ts";
import { contractState } from "./contract-state.ts";
import { grantCoversStar, type Grant } from "./actor.ts";
import { MAX_CHARS as MAX_BODY_CHARS } from "./sanitize.ts";

/** RAI-160 (PLAN-0.4.0 item 23): what one served write may carry. `body` stops at the sanitizer's
 *  cap, which would otherwise CUT it silently — the canonical tail lost, the write reported as done.
 *  `title` is bounded so the text the store chunks (`${title}\n${body}`) stays inside what the
 *  chunker is guaranteed to cover (chunking.test.ts pins the sum): no remembered tail is unrecallable,
 *  and one request holds the write fence for a bounded time. */
export const MAX_TITLE_CHARS = 1_000;
export { MAX_BODY_CHARS };

/** The code a grant refusal carries (RAI-159; `not-granted` since RAI-310, the ADR-0010 reason): the
 *  wire contract every HTTP host answers 403 with. */
export const NOT_GRANTED = "not-granted";

/** The three tiers (ADR-0015, ADR-0019): each host serves one, and `ceiling` gives its ops. */
export type Tier = "home" | "org" | "edge";

export interface OperationContext {
  /** The star's pages, through the port (PLAN-0.5.0 item 12, ADR-0011): a FolderVault at a folder. */
  vault: Vault;
  /** The star's live configuration — identity and index scope — which the scope expectations, the
   *  grant check and the write designation read on every call; at a folder, `star.yaml` re-read
   *  through its stat memo (`folderStar`). */
  star: () => StarConfig;
  /** ADR-0015: the serving surface — all an edge index implements. */
  store: ServingIndex;
  /** The folder part, absent at the edge: a home-only port (RAI-313 Q5) the engine composes. */
  folder?: FolderPart;
  /** ADR-0020: the tier this host serves, set once by the host. */
  tier: Tier;
  /** RAI-308/RAI-310: false when the caller reached this host off loopback. Absent ⇒ loopback. */
  loopback?: boolean;
  /** The D7 write-through surface — mutations ONLY go through it (assertOwned + sanitize). */
  funes: FunesStore;
  /** 0.3.0 item 24: who is performing this mutation, from TRUSTED process configuration or from a
   *  capability-to-actor mapping (actor.ts) — never from the payload. */
  actor?: string;
  /** 0.3.0 item 25: the writer designation this serving context was configured with; the host
   *  resolves the locus at its entry (RAI-313). Required (RAI-315): the kernel reads no environment. */
  designation: WriteDesignation;
  /** RAI-158: the CALLER's grant — {actor, ops, stars} — resolved from a presented credential, never
   *  from the payload. Absent ⇒ the surface serves one principal. */
  grant?: Grant;
  /** A cross-star call (ADR-0020): dispatch admits only the cross-star reads, guards them with the
   *  cross-star expectation (an absent manifest and a reindex in progress refuse), and scrubs every
   *  absolute path from a refusal. Set by the host; it can only make the guard stricter. */
  crossStar?: boolean;
  /** RAI-315 Q7 (C14): the one host restriction — `--ops`, `--readonly` and a read-only store.
   *  Dispatch serves a name only when it is in the ceiling and, when this is present, in this set. */
  narrow?: ReadonlySet<string>;
}

/** The folder part of a context (RAI-313 Q5): a home-only port. The engine implements it over a
 *  folder, with `safeResolve`'s realpath containment; the edge has none. */
export interface FolderPart {
  /** The vault's folder: health's `vault` and a refusal's `where` name it. */
  root: string;
  /** The full index store: the UI ops and recall's freshness read it. */
  store: FunesIndexStore;
  /** One file's bytes at a vault-relative path, inside the folder; refuses `invalid` or `not-found`. */
  readPage(rel: string): Uint8Array;
  /** One folder level at a vault-relative path ("" is the root): each entry's name and whether it is a directory, sorted. */
  listDir(rel: string): Array<{ name: string; dir: boolean }>;
  /** The absolute paths a cross-star refusal never shows: the root, its real path and the funes home. */
  privatePaths(): string[];
}

/** The MCP `inputSchema` wire shape — the JSON Schema subset `z.toJSONSchema(…, {io:"input"})`
 *  emits for our object schemas. */
// A TYPE ALIAS, not an interface, and that is load-bearing: TS gives an object type alias an
// implicit index signature, an interface never gets one. The MCP SDK types `tools/list`'s schema
// with `[x: string]: unknown`, so as an interface this refused to assign.
export type OpInputSchema = {
  type: "object";
  properties: Record<string, JsonSchemaKeywords>;
  required?: string[];
};

/** One property's JSON Schema keywords. Values are JSON, spelled out rather than left as `unknown`:
 *  the MCP SDK types `tools/list` with a recursive JSON union. */
export type JsonSchemaKeywords = Record<string, JsonValue>;
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** One op of the registry (ADR-0020): four flags, the tiers that serve it, and an optional frozen
 *  `result` schema (RAI-308). */
export interface OpEntry {
  name: string;
  description: string;
  /** The enforcement schema — the single source of truth. Build ops with `op()`, never by hand,
   *  so `inputSchema` stays derived. */
  args: z.ZodType;
  /** DERIVED from `args`. Emitted verbatim to MCP clients by `buildToolDefs`. */
  inputSchema: OpInputSchema;
  readonly: boolean;
  /** Answered from the index under the scope guard: a sibling star may call it. Implies `readonly`. */
  crossStar: boolean;
  /** Dispatch runs check-retrieve-recheck against live `star.yaml` (PLAN-0.3.0 item 16). True for
   *  every op that answers out of the index's ROWS; `health` is exempt so that it can diagnose. */
  scopeGuarded: boolean;
  /** The tiers whose hosts serve it — the one ceiling source. */
  tiers: readonly Tier[];
  /** The frozen answer schema (RAI-308), written into ops-contract.json. Strict. */
  result?: z.ZodType;
  /** Receives the PARSED args (`z.output` of `args`) — `dispatchToolCall` is the only caller. */
  run(ctx: OperationContext, args: unknown): Promise<unknown>;
}

/** Define one operation: derives `inputSchema` from `args` and types `run`'s args as `z.output`.
 *  The `$schema` key zod emits is stripped — it was never part of the advertised contract. */
function op<A extends z.ZodType>(def: Omit<OpEntry, "args" | "inputSchema" | "run"> & {
  args: A;
  run(ctx: OperationContext, args: z.output<A>): Promise<unknown>;
}): OpEntry {
  if (def.crossStar && !def.readonly) throw new Error(`registry: operation "${def.name}" is cross-star, so it must be read-only`);
  const { $schema: _drop, ...json } = z.toJSONSchema(def.args, { io: "input" }) as Record<string, unknown>;
  return { ...def, inputSchema: json as unknown as OpInputSchema, run: def.run as OpEntry["run"] };
}

/** A bounded count argument. TOTAL by construction, and deliberately so:
 *  - `z.coerce` because the HTTP GET surface hands every query param over as a string.
 *  - `.catch(undefined)` + the `> 0` fallback rather than `.positive()`, so NaN / Infinity /
 *    garbage keep resolving to the default.
 *  - `Math.min` in a `.transform` rather than `.max()`, because `.max()` would turn today's silent
 *    clamp into a 400 for `k: 100` — the most likely call an LLM ever makes. */
const count = (description: string, def: number, max: number) =>
  z.coerce
    .number()
    .describe(description)
    .optional()
    .catch(undefined)
    .transform((v) => (typeof v === "number" && v > 0 ? Math.min(v, max) : def));

/** An optional ISO-8601 date. Unparseable input is REFUSED rather than silently dropped: a caller
 *  that meant to date a claim should learn it failed. */
const isoDate = (description: string) =>
  z.string().describe(description).optional()
    .refine((v) => v == null || v === "" || !Number.isNaN(Date.parse(v)), { message: "as_of must be an ISO-8601 date (e.g. 2026-07-19)" })
    .transform((v) => v || undefined);

/** An optional free-text arg whose EMPTY string means "absent". */
const optionalText = (description: string) =>
  z.string().describe(description).optional().transform((v) => v || undefined);

/** ADR-0010 "Identity": the sender's ULID naming one request. Edge only (ADR-0020): required on
 *  `put_page`, optional on `forget`, refused on any other tier. */
const ulid = () => z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, { message: "proposalId must be a ULID" })
  .describe("ULID naming this request (ADR-0010, edge only): a retry reuses it, a new request takes a new one; with it the answer is {proposalId, status, reason?, currentHash?, writtenHash?}");

/** `sources` on remember and supersede (RAI-304): the item's provenance, written to frontmatter. */
const sources = z.array(z.string()).describe("optional provenance: the pages or URIs this item comes from, e.g. [[wiki/x]]").optional();

/** `page {raw}`'s decoder: a byte that is not UTF-8 refuses, so utf8(content) always hashes to `sha256`. */
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** Plain `page` keeps today's lossy decode (a BOM kept). */
const UTF8_LOSSY = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

/** Recall's freshness: folder-only, as before (RAI-308); the edge never lists R2 on a recall. */
function freshness(ctx: OperationContext): Promise<Freshness> {
  const folder = ctx.folder;
  if (!folder) return Promise.resolve({ changed: null, basis: "none" });
  return vaultChangedSince(ctx.vault, ctx.star().scope, () => folder.store.lastReindexAt(), () => folder.store.pageStats());
}

/** How a refusal names the star: its star id on a cross-star call (RAI-308), else its folder, else its id. */
const where = (ctx: OperationContext): string =>
  (ctx.crossStar ? null : ctx.folder?.root) ?? ctx.star().identity.id ?? "(an unidentified star)";

/** ADR-0015: the folder part a folder-only op needs, or a refusal — never a guess about the index. */
function folderPart(ctx: OperationContext, op: string): FolderPart {
  if (!ctx.folder) throw new Error(`${op}: a folder-only operation, and this context has no folder`);
  return ctx.folder;
}

/** ADR-0015: a page's served keys — the declared `serve` keys it carries — as the `fields` object. */
const fieldsOf = (fm: ScalarFrontmatter | null | undefined, serve: string[]): ScalarFrontmatter =>
  Object.fromEntries(serve.filter((k) => fm != null && Object.hasOwn(fm, k)).map((k) => [k, fm![k]!]));

/** The star's live recall declaration (ADR-0013) — null when it declares none; invalid refuses. */
const recallDeclaration = (ctx: OperationContext) => servedDeclaration(ctx.star().recall);

/** indexed_page's projection: the stored frontmatter never leaves as is; the served keys go as
 *  `fields` when the star declares any (ADR-0015). */
function shapePage(page: IndexedPage, serve: string[] | undefined): Record<string, unknown> {
  const { frontmatter, ...rest } = page;
  return serve?.length ? { ...rest, fields: fieldsOf(frontmatter, serve) } : rest;
}

/** One recall hit. `rank` is the authoritative order; `score` is raw fused RRF and NOT what the list
 *  is sorted by, so a consumer re-sorting by it gets a different ranking than the one it was handed. */
function shapeRecall(res: RecallResult[], serve?: string[]): Array<Record<string, unknown>> {
  return res.map((r, i) => ({
    id: r.id,
    title: r.title,
    path: r.path ?? `${r.id}.md`,
    rank: r.rank ?? i + 1,
    score: r.score,
    trust: r.trust ?? "untrusted",
    ...(r.volatile ? { volatile: true } : {}),
    ...(r.freshness ? { freshness: r.freshness } : {}),
    ...(r.duplicates ? { duplicates: r.duplicates } : {}),
    // ADR-0015: only at a star that declares served keys.
    ...(serve?.length ? { fields: fieldsOf(r.frontmatter, serve) } : {}),
  }));
}

// ── the frozen answer schemas (RAI-308) ──────────────────────────────────────────────────────
const scalar = z.union([z.string(), z.number(), z.boolean()]);
const RECALL_HIT = z.object({
  id: z.string(),
  title: z.string(),
  path: z.string(),
  rank: z.number(),
  score: z.number(),
  trust: z.enum(["trusted", "untrusted", "derived"]),
  volatile: z.literal(true).optional(),
  freshness: z.string().optional(),
  duplicates: z.number().optional(),
  fields: z.record(z.string(), scalar).optional(),
}).strict();
const RECALL_RESULT = z.object({
  contentGeneration: z.string().nullable(),
  plan: z.object({ arms: z.array(z.string()), where: z.record(z.string(), z.unknown()), collapse: z.array(z.string()) }).strict().optional(),
  vaultChangedSinceReindex: z.literal(true).optional(),
  results: z.array(RECALL_HIT),
}).strict();
const HEALTH_RESULT = z.object({
  nodes: z.number(),
  edges: z.number(),
  embeddingSignature: z.string().nullable(),
  servingSignature: z.string(),
  contentGeneration: z.string().nullable(),
  lastReindexAt: z.string().nullable(),
  reindexDirty: z.boolean(),
  ignoreScope: z.boolean(),
  scopeMatches: z.boolean().nullable(),
  vaultChangedSinceReindex: z.boolean().nullable(),
  freshnessBasis: z.enum(["stat", "none", "unreadable", "scope"]),
  locus: z.string().nullable(),
  // own-star, on loopback, at a folder only
  vault: z.string().optional(),
  // the edge tier keys, a closed list (ADR-0014, ADR-0015 as amended by RAI-308)
  proposalProtocol: z.number().optional(),
  starId: z.string().nullable().optional(),
  applyState: z.enum(["pending", "building", "idle"]).optional(),
  indexDirty: z.number().optional(),
  conflicts: z.number().optional(),
  okf: z.object({ nonconformant: z.number(), malformed: z.number() }).strict().nullable().optional(),
  // the org tier keys, a closed list (RAI-308 as amended by RAI-322, PLAN-0.6.0 C8)
  exportDirty: z.boolean().optional(),
}).strict();

/** RAI-308, RAI-315 Q13: the answer types every host returns — one recall hit, the recall envelope,
 *  and the health answer (the home keys plus the closed lists of edge-only and org-only keys, optional). */
export type RecallHit = z.output<typeof RECALL_HIT>;
export type RecallEnvelope = z.output<typeof RECALL_RESULT>;
export type Health = z.output<typeof HEALTH_RESULT>;

/** Registry invariants, enforced structurally at module load:
 *  (1) op names unique; (2) NO op may accept a `trust` argument — trust is server-stamped;
 *  (3) `elevate` must never be registered — elevation stays a human/CLI act; (4) every schema must
 *  derive to an OBJECT schema, because invariant (2) is enforced by reading `inputSchema.properties`. */
export function createRegistry(ops: OpEntry[]): OpEntry[] {
  const seen = new Set<string>();
  for (const op of ops) {
    if (seen.has(op.name)) throw new Error(`registry: duplicate operation "${op.name}"`);
    seen.add(op.name);
    if (!op.inputSchema.properties) {
      throw new Error(`registry: operation "${op.name}" does not derive to an object schema — the trust guard needs properties`);
    }
    if ("trust" in op.inputSchema.properties) {
      throw new Error(`registry: operation "${op.name}" exposes a trust argument — trust is server-stamped, never client-supplied`);
    }
    if (op.name === "elevate") throw new Error("registry: elevation is a human/CLI act, never a remote operation");
  }
  return ops;
}

/** RAI-304: with no folder (org, edge), `page` serves only a page path — `isPagePath` widened to the
 *  home path set (`index.md`, `log.md`, `*.summary.md`) — so star configuration in a bucket, a dot
 *  path or a sync-conflict copy is never served as a page. */
const isServedPath = (rel: string): boolean => {
  const name = rel.split("/").pop()!;
  const home = name === "index.md" || name === "log.md" || name.endsWith(".summary.md");
  return isPagePath(home ? rel.replace(/[^/]+$/, "page.md") : rel);
};

const strList = (v: string | undefined): string[] | undefined =>
  v ? v.split(",").map((x) => x.trim()).filter(Boolean) : undefined;

const writeFields = {
  type: optionalText("optional item type (default: memory)"),
  tags: z.string().describe("optional comma-separated tags").optional(),
  sources,
  // P5.19 state/event split: recorded, returned by recall, and breaks ties. Supersession is still an
  // explicit act, not automatic.
  volatile: z.boolean().describe("true if this is a STATE that goes stale and should be replaced by a later write (a rate, a plan); false/omitted for an EVENT, which is append-only. Recorded and returned by recall; supersession is still an explicit act, not automatic").optional().transform((v) => v === true),
  as_of: isoDate("when this was true (ISO date), if that differs from when it was written"),
};
const metaOf = (a: { tags?: string; sources?: string[]; volatile: boolean; as_of?: string }) =>
  ({ tags: strList(a.tags), sources: a.sources?.length ? a.sources : undefined, volatile: a.volatile, as_of: a.as_of });

const ALL: readonly Tier[] = ["home", "org", "edge"];

// ── the operations ───────────────────────────────────────────────────────────────────────
export const operations: OpEntry[] = createRegistry([
  op({
    name: "recall",
    description:
      "Hybrid recall (FTS + vector + edge-walk, RRF-fused) over the star's memory. Answers " +
      "{contentGeneration, plan?, vaultChangedSinceReindex?, results}: `contentGeneration` names the rows that answered " +
      "(null when no build names them); every hit carries its vault-relative path (provenance) and a trust label " +
      "(trusted = human-authored/elevated; untrusted = unvetted ingest such as in_*/ or agent writes) — weight accordingly. " +
      "`where` narrows the pages recall may return to those whose frontmatter matches keys and named predicates " +
      "the star declares in star.yaml memory.recall; the answer then echoes `plan: {arms, where, collapse}`. " +
      "`vaultChangedSinceReindex: true` says the notes moved since the index was built.",
    args: z.object({
      query: z.string().describe("free-text question"),
      k: count("max results (default 5)", 5, 50),
      // ADR-0013: the second deliberate exception to "garbage clamps, never 400s" (after `as_of`): no
      // clamp is honest, and a silently dropped filter is a lie. Separate keys AND.
      where: z.record(z.string(), z.union([
        z.string(), z.number(), z.boolean(),
        z.object({ exists: z.boolean() }).strict(),
        z.object({ ne: z.union([z.string(), z.number(), z.boolean()]) }).strict(),
      ])).describe("filter on keys or predicates the star declares (memory.recall): a scalar (strict equality), {exists: bool} or {ne: scalar}; a predicate takes true or false").optional(),
    }),
    readonly: true,
    crossStar: true,
    scopeGuarded: true,
    tiers: ALL,
    result: RECALL_RESULT,
    async run(ctx, args) {
      // ADR-0013: `where` only narrows which pages the arms may return, checked against the live
      // declaration and compiled here — no store reads star.yaml.
      const decl = recallDeclaration(ctx);
      const planned = args.where ? planWhere(args.query, args.where, ctx.star().recall) : null;
      const res = await ctx.store.recall({ query: args.query, k: args.k, collapse: decl?.collapse, filter: planned?.filter });
      // PLAN-0.5.0 item 15: the generation is read right AFTER recall with no I/O between, so it names
      // the rows recall ranked. contentIdentity, never stats(): the counts are health's (RAI-206).
      const { contentGeneration } = ctx.folder ? await ctx.folder.store.contentIdentity() : await ctx.store.stats();
      const stale = (await freshness(ctx)).changed === true;
      return {
        contentGeneration,
        // Only when `where` was given: a caller that sent one and finds no `plan` treats the results
        // as unfiltered (RAI-176).
        ...(planned ? {
          plan: { arms: [...(ftsTerms(args.query).length ? ["fts"] : []), "vector", "graph"], where: planned.where, collapse: decl!.collapse },
        } : {}),
        // RAI-308: once per answer, only when true — one freshness call serves every hit.
        ...(stale ? { vaultChangedSinceReindex: true as const } : {}),
        results: shapeRecall(res, decl?.serve),
      };
    },
  }),
  op({
    name: "page",
    description:
      "Read one markdown page: {path, sha256, frontmatter, body}. `sha256` is over the stored bytes — the `base` a " +
      "put_page replace sends. With raw=true the answer also carries `content`, the exact bytes as UTF-8 (a BOM kept), " +
      "and refuses (invalid) a page whose bytes are not UTF-8. Vault-relative path only.",
    args: z.object({
      path: z.string().describe("vault-relative path, e.g. yachts/research.md"),
      raw: z.boolean().describe("true = also answer the exact bytes as `content`").optional().transform((v) => v === true),
    }),
    readonly: true,
    crossStar: false, // reads the vault, not the index — bypasses index_scope
    scopeGuarded: false,
    tiers: ALL,
    async run(ctx, args) {
      let bytes: Uint8Array;
      if (ctx.folder) {
        bytes = ctx.folder.readPage(args.path); // the floor: the host's realpath containment over the folder
      } else {
        if (!isServedPath(args.path)) throw refusal("invalid", `page: "${args.path}" is not a page path`);
        const f = await ctx.vault.read(args.path);
        if (!f) throw refusal("not-found", `page: no page "${args.path}"`);
        bytes = f.bytes;
      }
      let content: string;
      if (args.raw) {
        try { content = UTF8_STRICT.decode(bytes); } catch { throw refusal("invalid", `page: "${args.path}" is not UTF-8`); }
      } else {
        content = UTF8_LOSSY.decode(bytes);
      }
      const { data, body } = parseFrontmatter(content);
      return { path: args.path, sha256: sha256Hex(bytes), frontmatter: data, body, ...(args.raw ? { content } : {}) };
    },
  }),
  op({
    name: "indexed_page",
    description:
      "Read one page's INDEXED snapshot from the store (title, body, and metadata as last indexed), " +
      "by node id or vault-relative path. Serves the DATABASE, never the vault filesystem — an " +
      "index_scope-excluded or unindexed path returns not-found even if the file exists on disk. The " +
      "cross-star read surface: no filesystem access, so the index is the capability boundary (no TOCTOU).",
    // The id-OR-path rule is CROSS-FIELD, so it lives in a refine — which zod omits from the emitted
    // JSON Schema. Truthiness, not nullishness: `{id: ""}` must still be "provide an id or a path".
    args: z
      .object({
        id: z.string().describe("node id (vault-relative path without .md)").optional(),
        path: z.string().describe("vault-relative path (with or without .md)").optional(),
      })
      .refine((v) => Boolean(v.id || v.path), { message: "indexed_page: provide an `id` or a `path`" }),
    readonly: true,
    crossStar: true,
    scopeGuarded: true,
    tiers: ALL,
    async run(ctx, args) {
      const page = await ctx.store.indexedPage({ id: args.id, path: args.path });
      if (!page) throw refusal("not-found", `indexed_page: "${args.id ?? args.path}" is not in the index (unindexed, index_scope-excluded, or not found)`);
      return shapePage(page, recallDeclaration(ctx)?.serve);
    },
  }),
  op({
    name: "health",
    description:
      "Index health: counts and identity, never a page. {nodes, edges, embeddingSignature, servingSignature, " +
      "contentGeneration, lastReindexAt, reindexDirty, ignoreScope, scopeMatches, vaultChangedSinceReindex, freshnessBasis, " +
      "locus, vault?}. A cross-star recall serves now iff scopeMatches && !reindexDirty.",
    args: z.object({}),
    readonly: true,
    crossStar: true,
    // Exempt, deliberately: health reports the scope verdict as data, so refusing it on a scope
    // disagreement would withhold the diagnosis of the very condition being diagnosed.
    scopeGuarded: false,
    tiers: ALL,
    result: HEALTH_RESULT,
    async run(ctx) {
      const stats = await ctx.store.stats();
      const state = contractState(ctx, stats);
      // RAI-308: a cross-star call walks for freshness only when the scope matches — with an absent
      // or invalid manifest the walk takes the configless branch and ignores index_scope.
      const fresh: { changed: boolean | null; basis: string } = ctx.crossStar && state.scopeMatches !== true
        ? { changed: null, basis: "scope" }
        : await vaultChangedSince(ctx.vault, ctx.star().scope, async () => stats.lastReindexAt, () => ctx.store.pageStats());
      // `vault` only own-star, on loopback, at a folder: the only absolute path health ever carried.
      const vault = !ctx.crossStar && ctx.loopback !== false ? ctx.folder?.root : undefined;
      return {
        nodes: stats.nodes,
        edges: stats.edges,
        embeddingSignature: stats.embeddingSignature,
        servingSignature: state.servingSignature,
        contentGeneration: state.contentGeneration,
        lastReindexAt: stats.lastReindexAt,
        reindexDirty: state.reindexDirty,
        ignoreScope: state.ignoreScope,
        scopeMatches: state.scopeMatches,
        vaultChangedSinceReindex: fresh.changed,
        freshnessBasis: fresh.basis,
        locus: state.locus,
        ...(vault ? { vault } : {}),
      };
    },
  }),
  op({
    name: "tree",
    description: "List one folder level of the vault: subfolders (with zone: incoming/output/wiki) and markdown files.",
    args: z.object({
      // "" is load-bearing: an empty dir means the vault ROOT, not a bad path.
      dir: z.string().describe("vault-relative folder (default: vault root)").optional().transform((v) => v || ""),
    }),
    readonly: true,
    crossStar: false, // readdir over the vault filesystem — bypasses index_scope
    scopeGuarded: false,
    tiers: ["home"],
    async run(ctx, args) {
      const rel = args.dir;
      const dirs: Array<{ name: string; zone: string }> = [];
      const files: string[] = [];
      for (const { name, dir } of folderPart(ctx, "tree").listDir(rel)) {
        if (name.startsWith(".")) continue;
        if (dir) dirs.push({ name, zone: zoneOfDir(rel ? `${rel}/${name}` : name) });
        else if (name.endsWith(".md")) files.push(name);
      }
      return { dir: rel || ".", dirs, files };
    },
  }),
  op({
    name: "neighbors",
    description:
      "Graph neighborhood of one page: k nearest by embedding similarity + typed frontmatter edges " +
      "(both directions). Each neighbor carries path provenance + trust. The memory-graph explorer's data source.",
    args: z.object({
      id: z.string().describe("node id (vault-relative path without .md)"),
      k: count("nearest neighbors to return (default 8, max 25)", 8, 25),
    }),
    readonly: true,
    crossStar: false, // the graph explorer's read; kept off the cross-star surface
    scopeGuarded: true, // answers out of the store: a drifted scope would leak excluded titles and ids
    tiers: ["home"],
    async run(ctx, args) {
      return folderPart(ctx, "neighbors").store.neighbors(args.id, args.k);
    },
  }),
  op({
    name: "graph",
    description:
      "Baked global knowledge-graph artifact for the constellation view: every node with its baked " +
      "x/y layout, Louvain community, degree, zone, type, trust, and recall hit_count, plus all typed " +
      "frontmatter edges (with their relation family). Cached beside the index; the browser only renders.",
    // Non-strict on purpose: unknown keys are STRIPPED, not rejected. The constellation view sends
    // `?star=<name>` and the daemon has always ignored it; `.strict()` would 400 it.
    args: z.object({}),
    readonly: true,
    crossStar: false,
    scopeGuarded: true, // the baked artifact is every node in the index — same leak as neighbors
    tiers: ["home"],
    async run(ctx) {
      return folderPart(ctx, "graph").store.graph();
    },
  }),
  op({
    name: "hotlist",
    description:
      "Top-N most-recalled TRUSTED pages from the opt-in recall_stats telemetry (`funes serve --stats`). " +
      "Counters are advisory routing hints for humans/agents — NEVER an input to recall ranking. " +
      "items is [] when tracking is off (the `tracking` field says which).",
    args: z.object({ n: count("max rows (default 20, max 100)", 20, 100) }),
    readonly: true,
    crossStar: true, // recall_stats telemetry from the store — no filesystem read
    scopeGuarded: true, // returns titles and paths of indexed pages
    tiers: ["home"],
    async run(ctx, args) {
      const store = folderPart(ctx, "hotlist").store;
      const tracking = store.recallTracking;
      return { tracking, items: tracking ? await store.hotlist(args.n) : [] };
    },
  }),
  // ── S3 mutating ops — all through FunesStore: out_memory/ only (assertOwned), sanitized,
  //    markdown written first, trust server-stamped untrusted. No trust argument exists.
  op({
    name: "remember",
    description:
      "Write a memory item to out_memory/<id>.md (markdown-canonical) and index it. " +
      "Recorded as UNTRUSTED — a human elevates it later via the funes CLI if it deserves trust.",
    args: z.object({
      title: z.string().max(MAX_TITLE_CHARS).describe("short title"),
      body: z.string().max(MAX_BODY_CHARS).describe("the memory content (markdown); split a longer record into successive memories"),
      ...writeFields,
    }),
    readonly: false,
    crossStar: false,
    scopeGuarded: false,
    tiers: ["home", "org"],
    async run(ctx, args) {
      // no trust here — FunesStore stamps untrusted
      const { ids } = await ctx.funes.remember([{ title: args.title, body: args.body, type: args.type, meta: metaOf(args) }]);
      return { id: ids[0], trust: "untrusted" };
    },
  }),
  op({
    name: "supersede",
    description: "Replace a funes-written memory item: writes the successor, marks the old one superseded (kept on disk, off recall). out_memory/ ids only.",
    args: z.object({
      oldId: z.string().describe("id of the item to supersede (out_memory/...)"),
      title: z.string().max(MAX_TITLE_CHARS),
      body: z.string().max(MAX_BODY_CHARS),
      ...writeFields,
    }),
    readonly: false,
    crossStar: false,
    scopeGuarded: false,
    tiers: ["home", "org"],
    async run(ctx, args) {
      const { id } = await ctx.funes.supersede(args.oldId, { title: args.title, body: args.body, type: args.type, meta: metaOf(args) });
      return { id, supersedes: args.oldId, trust: "untrusted" };
    },
  }),
  op({
    name: "forget",
    description: "Forget a funes-written memory item: a soft tombstone (file kept, off recall). No op hard-deletes; `funes purge` is the operator's. out_memory/ ids only.",
    args: z.object({
      id: z.string().describe("id of the item to forget (out_memory/...)"),
      proposalId: ulid().optional(),
    }),
    readonly: false,
    crossStar: false,
    scopeGuarded: false,
    tiers: ALL,
    async run(ctx, args) {
      await ctx.funes.forget(args.id);
      return { id: args.id, forgotten: true };
    },
  }),
  op({
    name: "put_page",
    description:
      "Write one whole page (ADR-0010). With no `base` it is create-once and refuses an existing page; with `base` — the sha256 " +
      "of the file its sender saw, as page returns it — a compare-and-swap replace. The writer sanitizes and normalizes the " +
      "page, keeps its own fields (trust, superseded_by, supersedes, forgotten, created, id, generated) from the base, stamps a " +
      "created page untrusted, and keeps the overwritten bytes as a history object. Answers {proposalId, status: " +
      "applied|already-applied|refused, reason?: stale-base|not-granted|not-found|invalid|protected-field, currentHash?, " +
      "writtenHash?}; `writtenHash` is the next base. The edge writer's op: no home or org host serves it.",
    args: z.object({
      path: z.string().describe("vault-relative page path under the star's memory directory, ending .md"),
      content: z.string().max(MAX_BODY_CHARS).describe("the whole file: frontmatter and body"),
      base: z.string().regex(/^[0-9a-f]{64}$/, { message: "base must be a lowercase hex sha256" })
        .describe("sha256 of the whole file its sender saw; absent = create-once").optional(),
      proposalId: ulid(),
    }),
    readonly: false,
    crossStar: false,
    scopeGuarded: false,
    tiers: ["edge"],
    async run(ctx, args) {
      return ctx.funes.putPage(args.path, args.content, { base: args.base });
    },
  }),
]);

/** ADR-0020: the ops a host of `tier` serves. Cross-star admits only the cross-star reads; at the
 *  home tier off loopback, only a read a sibling may see, and `remember` the only write. `--ops`,
 *  roles and grants only narrow it. Dispatch refuses an op outside it. */
export function ceiling(tier: Tier, at: { crossStar?: boolean; loopback?: boolean } = {}): OpEntry[] {
  return operations.filter((o) =>
    o.tiers.includes(tier)
    && (!at.crossStar || (o.readonly && o.crossStar))
    && (tier !== "home" || at.loopback !== false || (o.readonly ? o.crossStar : o.name === "remember")));
}

// ── pure projections (gbrain pattern) ────────────────────────────────────────────────────
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: OpInputSchema;
}

/** THE rendering of an op's answer: the stdio MCP tool text and the CLI's `--json` (RAI-317 Q2). */
export const toolText = (result: unknown): string => JSON.stringify(result, null, 2);

export function buildToolDefs(ops: OpEntry[]): McpToolDef[] {
  return ops.map((op) => ({ name: op.name, description: op.description, inputSchema: op.inputSchema }));
}

/** P1.8: the op-capability projection — what a consumer (twinkl.ing's connection validator) may name
 *  and how funes will treat it, sorted by name. `crossStar` replaces `served`: a consumer that finds
 *  it absent must treat the op as not cross-star (fail closed). */
export interface OpCapability {
  name: string;
  readonly: boolean;
  crossStar: boolean;
  tiers: Tier[];
}
export function opCapabilities(): OpCapability[] {
  return operations
    .map((o) => ({ name: o.name, readonly: o.readonly, crossStar: o.crossStar, tiers: [...o.tiers] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** One op's entry in the frozen ops-contract.json (ADR-0020): its flags, its advertised input
 *  schema and, where it has one, its frozen answer schema (RAI-308). */
export function contractEntry(o: OpEntry): Record<string, unknown> {
  const jsonOf = (t: z.ZodType) => { const { $schema: _drop, ...json } = z.toJSONSchema(t, { io: "output" }) as Record<string, unknown>; return json; };
  return {
    name: o.name, readonly: o.readonly, crossStar: o.crossStar, scopeGuarded: o.scopeGuarded, tiers: [...o.tiers],
    inputSchema: o.inputSchema,
    ...(o.result ? { result: jsonOf(o.result) } : {}),
  };
}

/** `ZodError.message` is a multi-line JSON dump; surfaces render `(e as Error).message` verbatim.
 *  Flatten to one line so a client gets a sentence, not a blob. */
function argError(name: string, err: z.ZodError): Error {
  const parts = err.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message));
  return refusal("invalid", `operation ${name}: ${parts.join("; ")}`); // ADR-0010: an argument failure is `invalid`
}

/** THE dispatcher: every surface, own-star and cross-star, reaches an op through here, by NAME
 *  (RAI-315 Q7). It runs only its own registry's entry and reads no caller's flags: it serves a name
 *  only when it is in `ceiling(ctx.tier, ctx)`, in `ctx.grant.ops` when a grant is present, and in
 *  `ctx.narrow` when that is present. */
export async function dispatchToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: OperationContext,
): Promise<unknown> {
  if (!ctx.crossStar) return dispatch(name, args, ctx);
  try {
    return await dispatch(name, args, ctx);
  } catch (e) {
    throw scrub(e, ctx);
  }
}

/** RAI-308: the one cross-star exit. No absolute path crosses it: the folder root and the funes
 *  home in any refusal become `<star:id>`. */
function scrub(e: unknown, ctx: OperationContext): unknown {
  if (!(e instanceof Error)) return e;
  let id = "unidentified";
  try { id = ctx.star().identity.id ?? id; } catch { /* the star thunk itself failed: name no star */ }
  const roots = ctx.folder?.privatePaths() ?? [];
  for (const r of roots.filter(Boolean).sort((a, b) => b.length - a.length)) e.message = e.message.split(r).join(`<star:${id}>`);
  return e;
}

async function dispatch(name: string, args: Record<string, unknown>, ctx: OperationContext): Promise<unknown> {
  const tier = ctx.tier;
  const op = (!ctx.narrow || ctx.narrow.has(name)) ? ceiling(tier, { crossStar: ctx.crossStar, loopback: ctx.loopback }).find((o) => o.name === name) : undefined;
  if (!op) {
    // A mutation this host does not serve still refuses naming the write locus first (record 35 C6):
    // no argument gate, no grant check (record 35 A13: the ceiling answers before the grant), no
    // proposal-shaped answer. A locus that may write learns only "unknown".
    if (operations.some((o) => o.name === name && !o.readonly)) assertWriteAllowed(ctx.designation, name);
    throw new Error(`unknown operation: ${name}`);
  }
  // ADR-0010, edge only: a mutation that carries a proposal id answers as a proposal; a refusal is
  // then a result naming its reason, not a tool error.
  const pid = tier === "edge" && !op.readonly && typeof args.proposalId === "string" ? args.proposalId : undefined;
  if (pid !== undefined) return answered(pid, () => dispatchOne(op, name, args, ctx, pid));
  return dispatchOne(op, name, args, ctx);
}

/** The reasons a refusal error carries as its `code`: funes-store's `refusal`, and the grant check's NOT_GRANTED. */
const REASONS: ReadonlySet<unknown> = new Set(["stale-base", "not-found", "invalid", "protected-field", NOT_GRANTED]);

/** ADR-0010's answer: `{proposalId, status, reason?, currentHash?, writtenHash?}`, plus the op's own
 *  fields when applied. An error that names no reason (a conflict, a transient failure) is no answer:
 *  it stays a tool error, so the sender retries. */
async function answered(proposalId: string, run: () => Promise<unknown>): Promise<unknown> {
  try {
    return { proposalId, status: "applied", ...(await run() as object) };
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    const reason = REASONS.has(code) ? code : null;
    if (reason === null) throw e;
    const currentHash = (e as { currentHash?: string }).currentHash;
    return { proposalId, status: "refused", reason, ...(currentHash ? { currentHash } : {}) };
  }
}

async function dispatchOne(op: OpEntry, name: string, args: Record<string, unknown>, ctx: OperationContext, proposalId?: string): Promise<unknown> {
  // RAI-158 — the per-caller check, BEFORE the argument gate, so an actor that may not run this op
  // learns nothing about its arguments. A grant can only narrow the host's list.
  if (ctx.grant) assertGrantedStar(ctx.grant, op, ctx.star().identity.id);
  // ADR-0005 — THE canonical-vault mutation boundary, after the argument gate on purpose: a request
  // that fails its schema never became a write. A write the rule refuses refuses HERE (RAI-302).
  const parsed = parseOpArgs(op, name, args);
  if (!op.readonly) assertWriteAllowed(ctx.designation, name);
  // ADR-0020: the proposal protocol stays at the edge.
  if (!op.readonly && args.proposalId !== undefined && ctx.tier !== "edge") {
    throw refusal("invalid", `operation ${name}: proposalId is accepted only at the edge`);
  }
  if (proposalId !== undefined) {
    // ADR-0010 "Identity": the writer hashes the payload it received; the receipt binds the id to it.
    const { proposalId: _, ...payload } = parsed as Record<string, unknown>;
    return ctx.funes.propose(proposalId, sha256Hex(JSON.stringify([name, payload])), () => op.run(ctx, parsed) as Promise<{ writtenHash?: string }>);
  }
  // PLAN-0.3.0 item 16 — THE index_scope guard, here because every served surface dispatches through
  // this one function. Check-retrieve-RECHECK: the desired scope is recomputed from live `star.yaml`
  // on BOTH ends. A cross-star call takes the stricter expectation (an absent manifest and a reindex
  // in progress refuse).
  if (op.scopeGuarded) {
    const scope = () => ctx.star().scope;
    const expectation = ctx.crossStar ? crossStarExpectation(scope, where(ctx)) : ownStarExpectation(scope);
    const res = await ctx.store.guardedRead(expectation, () => op.run(ctx, parsed));
    if ("refusal" in res) throw refusal("out-of-scope", res.refusal);
    return res.ok;
  }
  return op.run(ctx, parsed);
}

/** RAI-158: refuse an op the caller's grant does not name, or a star it does not reach, over a star
 *  id already read (the dispatcher's star thunk, PLAN-0.5.0 item 12). The error carries the
 *  NOT_GRANTED code, so an HTTP host answers 403 rather than 400 (RAI-159). */
export function assertGrantedStar(grant: Grant, op: { name: string }, star: string | null): void {
  const refuse = (message: string) => Object.assign(new Error(message), { code: NOT_GRANTED });
  if (!grant.ops.has(op.name)) throw refuse(`operation ${op.name}: not granted to actor "${grant.actor}"`);
  if (!grantCoversStar(grant, star)) {
    throw refuse(`operation ${op.name}: actor "${grant.actor}" holds no grant for star "${star ?? "(no id)"}"`);
  }
}

/** The registry's operation names — what a v2 access file's roles may name. */
export const publicOpNames = (): ReadonlySet<string> => new Set(operations.map((o) => o.name));

/** The ONE argument gate. */
function parseOpArgs(op: { inputSchema: OpInputSchema; args: z.ZodType }, name: string, args: Record<string, unknown>): unknown {
  // Required-presence runs BEFORE the schema so the long-standing wording survives: zod would say
  // "expected string, received undefined", which reads like a type error rather than a missing arg.
  for (const req of op.inputSchema.required ?? []) {
    if (!(req in args)) throw refusal("invalid", `operation ${name}: missing required argument "${req}"`);
  }
  // zod drops an own `__proto__` key without an issue. In `recall`'s `where` (ADR-0013) that would
  // silently WIDEN a filter, so a key no declaration may hold refuses here instead.
  const protoKey = (v: unknown): boolean =>
    v != null && typeof v === "object" && (Object.hasOwn(v, "__proto__") || Object.values(v).some(protoKey));
  if (protoKey(args)) throw refusal("invalid", `operation ${name}: an argument may not name "__proto__"`);
  const parsed = op.args.safeParse(args);
  if (!parsed.success) throw argError(name, parsed.error);
  return parsed.data;
}
