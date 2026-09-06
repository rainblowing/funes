// Op-registry — the contract-first Operation[] pattern vendored from gbrain
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
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { z } from "zod";
import type { RecallResult } from "funes-core";
import { parseFrontmatter } from "./markdown.ts";
import { vaultChangedSince } from "./reindex.ts";
import { crossStarExpectation, ownStarExpectation } from "./scope.ts";
import { zoneOfDir } from "funes-shared";
import { authorizeCanonicalWrite, reportWriteDecision, resolveWriteDesignation, type WriteDesignation } from "./write-designation.ts";
import type { FunesIndexStore } from "./store.ts";
import type { FunesStore } from "./funes-store.ts";
import { operatorState } from "./machine-state.ts";

/** The context a READ op needs, and no more (PLAN-0.2.1 step 15). It is the WHOLE context minus
 *  the write-through surface, which is what makes the hub's seam checkable by the compiler rather
 *  than by review: the hub builds one of these, and a mutating op — whose `run` demands `funes` —
 *  is simply not assignable to the read registry it dispatches through. */
export interface ReadOperationContext {
  remote: boolean;
  trust: "trusted" | "untrusted";
  vault: string;
  store: FunesIndexStore;
  /** Move 5: when the daemon was started with `--rerank`, every recall runs the cross-encoder
   *  final stage (mirroring the CLI `--rerank` semantics). Default false — the daemon stays
   *  light. A no-op unless the store was also constructed with a Reranker. NOT a per-request
   *  arg: rerank is a daemon-wide posture, set once at startup, never client-supplied. */
  rerank?: boolean;
}

export interface OperationContext extends ReadOperationContext {
  /** The D7 write-through surface — mutations ONLY go through it (assertOwned + sanitize). */
  funes: FunesStore;
  /** 0.3.0 item 24: who is performing this mutation, from TRUSTED process configuration or from a
   *  capability-to-actor mapping (actor.ts) — never from the payload. Absent ⇒ `unknown`; it is
   *  reported in the designation audit, and the STAMPED `write_actor` comes from the store's
   *  constructor, which is the seam that was already right. */
  actor?: string;
  /** 0.3.0 item 25: the writer designation this serving context was configured with. Absent ⇒
   *  resolved from the vault's star.yaml plus the environment at dispatch, so a surface that has
   *  not been taught to pass one is still audited rather than silently exempt. */
  designation?: WriteDesignation;
}

/** The MCP `inputSchema` wire shape — the JSON Schema subset `z.toJSONSchema(…, {io:"input"})`
 *  emits for our object schemas. Deliberately loose per property: a schema that grows a `default`
 *  or a `maximum` must be representable here without a type change, because THIS is what
 *  `buildToolDefs` ships to clients verbatim. */
// A TYPE ALIAS, not an interface, and that is load-bearing: TS gives an object type alias an
// implicit index signature, an interface never gets one. The MCP SDK types `tools/list`'s schema
// with `[x: string]: unknown`, so as an interface this refused to assign and every server boundary
// needed a cast.
export type OpInputSchema = {
  type: "object";
  properties: Record<string, JsonSchemaKeywords>;
  required?: string[];
};

/** One property's JSON Schema keywords. Values are JSON, spelled out rather than left as `unknown`:
 *  the MCP SDK types `tools/list` with a recursive JSON union, and `unknown` is not assignable to
 *  it, so `unknown` here forced a cast at every server boundary. Still deliberately loose about
 *  WHICH keywords appear — a schema that grows a `default` or a `maximum` must be representable
 *  without a type change, because this is what `buildToolDefs` ships to clients verbatim. */
export type JsonSchemaKeywords = Record<string, JsonValue>;
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface Operation {
  name: string;
  description: string;
  /** The enforcement schema — the single source of truth. Build ops with `op()`, never by hand,
   *  so `inputSchema` stays derived. */
  args: z.ZodType;
  /** DERIVED from `args`. Emitted verbatim to MCP clients by `buildToolDefs`. */
  inputSchema: OpInputSchema;
  readonly: boolean;
  /** H8: the data source this op serves from. `index` reads the DERIVED store only (recall /
   *  indexed_page / health / hotlist) — index_scope IS the capability boundary. `fs` reads the vault
   *  FILESYSTEM (page / tree / graph / neighbors) or writes it (the mutations), bypassing index_scope.
   *  A `--cross-star` surface admits `index`-served ops ONLY — an fs-served op on a cross-star
   *  boundary would leak files the index deliberately excludes. */
  served: "index" | "fs";
  /** PLAN-0.3.0 item 16: does the OWN-STAR index_scope guard wrap this op's dispatch?
   *
   *  True for every op that answers out of the index's ROWS — those are the rows `index_scope`
   *  withdrew, and until this release the guard ran ONLY in `--cross-star` mode, so every ordinary
   *  MCP client and HTTP face served a narrowed-then-not-reindexed vault's excluded pages happily.
   *
   *  Declared per op rather than derived from `served`, because `served` answers a different
   *  question (does this op touch the filesystem, and may a cross-star surface expose it) and two
   *  ops — `neighbors` and `graph` — read the store while being marked `"fs"` precisely to keep
   *  them OFF the cross-star surface. Deriving would have left both leaking.
   *
   *  `page`/`tree` are absent on purpose: they read the vault directly and bypass `index_scope` by
   *  design; item 22's loopback rule is their boundary, not this one. */
  scopeGuarded?: boolean;
  /** H9: an INTERNAL op the client never names directly — the mcp.ts cross-star translation maps
   *  recall/indexed_page to the guarded_* variants and the daemon proxy dispatches them. Internal
   *  ops are hidden from tool listings (buildToolDefs) and un-allowlistable (resolveExposedOps), yet
   *  stay dispatchable by name so the guarded serve path works over both the direct and proxy paths. */
  internal?: boolean;
  /** Receives the PARSED args (`z.output` of `args`) — `dispatchToolCall` is the only caller and it
   *  never passes raw input. Typed `unknown` here because `Operation` is not generic; `op()` gives
   *  each definition site its precise inferred type. */
  run(ctx: OperationContext, args: unknown): Promise<unknown>;
}

/** An operation that runs on a READ context. Assignable to `Operation` — a function accepting the
 *  WIDER `ReadOperationContext` accepts an `OperationContext` too — so these still live in the one
 *  registry, while the hub can hold them in a list a write op cannot enter. */
export interface ReadOperation extends Omit<Operation, "run"> {
  run(ctx: ReadOperationContext, args: unknown): Promise<unknown>;
}

/** Define one operation: derives `inputSchema` from `args` and types `run`'s args as `z.output`.
 *  The `$schema` key zod emits is stripped — it was never part of the advertised contract. */
function op<A extends z.ZodType>(def: {
  name: string;
  description: string;
  args: A;
  readonly: boolean;
  served: "index" | "fs";
  scopeGuarded?: boolean;
  internal?: boolean;
  run(ctx: OperationContext, args: z.output<A>): Promise<unknown>;
}): Operation {
  const { $schema: _drop, ...json } = z.toJSONSchema(def.args, { io: "input" }) as Record<string, unknown>;
  return { ...def, inputSchema: json as unknown as OpInputSchema, run: def.run as Operation["run"] };
}

/** `op()` for an op that needs no write surface. Same derivation; the only difference is the
 *  context its `run` accepts, and that difference is the whole point — see `ReadOperation`. */
function readOp<A extends z.ZodType>(def: {
  name: string;
  description: string;
  args: A;
  readonly: true;
  served: "index";
  internal?: boolean;
  run(ctx: ReadOperationContext, args: z.output<A>): Promise<unknown>;
}): ReadOperation {
  const { $schema: _drop, ...json } = z.toJSONSchema(def.args, { io: "input" }) as Record<string, unknown>;
  return { ...def, inputSchema: json as unknown as OpInputSchema, run: def.run as ReadOperation["run"] };
}

/** A bounded count argument. TOTAL by construction, and deliberately so:
 *  - `z.coerce` because the HTTP GET surface hands every query param over as a string (funes-api
 *    used to hardcode `Number(v)` for exactly the names `k` and `n`; that special-case is gone).
 *  - `.catch(undefined)` + the `> 0` fallback rather than `.positive()`, so NaN / Infinity /
 *    garbage keep resolving to the default the way the pre-zod hand-coercion did.
 *  - `Math.min` in a `.transform` rather than `.max()`, because `.max()` would BOTH advertise a
 *    `maximum` in the tool schema AND turn today's silent clamp into a 400 for `k: 100` — the most
 *    likely call an LLM ever makes. Clamping stays invisible; that is the shipped contract. */
const count = (description: string, def: number, max: number) =>
  z.coerce
    .number()
    .describe(description)
    .optional()
    .catch(undefined)
    .transform((v) => (typeof v === "number" && v > 0 ? Math.min(v, max) : def));

/** An optional ISO-8601 date. `as_of` feeds the freshness column and, once volatile ranking lands,
 *  the ordering itself — so an untrusted agent must not be able to write `banana-2999-99-99` into
 *  canonical frontmatter. Unparseable input is REFUSED rather than silently dropped: a caller that
 *  meant to date a claim should learn it failed. */
const isoDate = (description: string) =>
  z.string().describe(description).optional()
    .refine((v) => v == null || v === "" || !Number.isNaN(Date.parse(v)), { message: "as_of must be an ISO-8601 date (e.g. 2026-07-19)" })
    .transform((v) => v || undefined);

/** An optional free-text arg whose EMPTY string means "absent" (the pre-zod ternary was
 *  `args.type ? String(args.type) : undefined`, and `??` downstream does not catch `""`). */
const optionalText = (description: string) =>
  z.string().describe(description).optional().transform((v) => v || undefined);

/** H9: the recall op's public projection (shared by `recall` and the guarded `guarded_recall`, so
 *  the cross-star path returns a byte-identical shape). Emits the raw RRF score (parity contract).
 *  Sharing the function is NOT enough to keep that promise — `guarded_recall` shipped calling it
 *  with one argument, so `vaultChangedSinceReindex` was absent on exactly the path that cannot ask
 *  for it any other way, while this comment claimed otherwise. BOTH callers pass `stale`. */
/** PLAN-0.3.0 item 18: THE freshness call, with BOTH arguments. `vaultChangedSince` has taken an
 *  `indexedIds` thunk — the only way it can see a DELETION, since a note that is gone leaves no file
 *  behind to be newer — and all five call sites passed two arguments, so the thunk was `undefined`,
 *  `?? []` made the id set empty, and no deletion has ever been detected. The receiving logic was
 *  written and tested; it had simply never been given its argument. Funnelling every caller through
 *  one helper is what stops the sixth call site from omitting it again. */
function freshness(ctx: ReadOperationContext, stampedAt: () => Promise<string | null>): Promise<boolean | null> {
  return vaultChangedSince(ctx.vault, stampedAt, () => ctx.store.indexedIds());
}

function shapeRecall(res: RecallResult[], stale: boolean | null = null): Array<Record<string, unknown>> {
  // `volatile`/`freshness` were indexed and tiebroken on from P5.19 but never emitted, so no agent
  // could see which hits were state (replaceable) versus event (append-only) — which is precisely
  // why supersede() was unusable in practice: the caller must already know oldId, and nothing here
  // told it which hit to supersede. `rank` is the authoritative order; `score` is raw fused RRF and
  // is NOT what the list is sorted by (trust × zone × entity, then tiebreak, then optional rerank),
  // so a consumer re-sorting by it silently gets a different ranking than the one it was handed.
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
    // `health` carries the same flag, but health is a call an agent never makes on its way to an
    // answer — so a model had no way to know the hit it is about to cite came from an index older
    // than the notes. Stamped ONLY when true: the key is additive and absent on a current index, so
    // the array shape every consumer already parses is unchanged. The tri-state (false vs unknown)
    // stays on health; here, absence means "not flagged".
    ...(stale ? { vaultChangedSinceReindex: true } : {}),
  }));
}

/** Registry invariants, enforced structurally at module load:
 *  (1) op names unique; (2) NO op may accept a `trust` argument — trust is server-stamped,
 *  client values are unrepresentable (closes audit-spoofing); (3) `elevate` must never be
 *  registered — elevation stays a human/CLI act; (4) every schema must derive to an OBJECT
 *  schema, because invariant (2) is enforced by reading `inputSchema.properties` — a union /
 *  record / any schema emits no `properties` and would silently retire the trust guard. */
export function createRegistry(ops: Operation[]): Operation[] {
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

// ── path safety (page/tree) ──────────────────────────────────────────────────────────────
/** Resolve a vault-relative path; reject absolute paths, escapes, and any dot-segment. */
function safeResolve(vault: string, rel: string): string {
  if (rel.startsWith("/") || rel.includes(String.fromCharCode(0))) throw new Error(`invalid path: ${rel}`);
  const norm = normalize(rel);
  if (norm.split(sep).some((seg) => seg === ".." || seg.startsWith("."))) {
    throw new Error(`invalid path (escapes vault or dot-path): ${rel}`);
  }
  const abs = resolve(vault, norm);
  const root = resolve(vault);
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`path escapes vault: ${rel}`);
  // Lexical containment is not containment: a symlink with an ordinary name inside the vault
  // (`notes/leak.md -> /etc/passwd`) passes every check above, because none of them touch the
  // filesystem. Resolve the real path and re-check. The vault root is realpath'd too, or a vault
  // reached through a symlinked parent would fail its own containment test.
  let realAbs: string, realRoot: string;
  try { realRoot = realpathSync(root); } catch { realRoot = root; }
  try { realAbs = realpathSync(abs); } catch { return abs; } // not yet on disk — lexical check stands
  if (realAbs !== realRoot && !realAbs.startsWith(realRoot + sep)) {
    throw new Error(`path escapes vault via a symlink: ${rel}`);
  }
  return realAbs;
}

// Vault-v2: zone by full vault-relative DIR path (raw/ and out/ are containers; in_*/out_*
// segments count at any depth) — see zones.ts.

const strList = (v: string | undefined): string[] | undefined =>
  v ? v.split(",").map((x) => x.trim()).filter(Boolean) : undefined;

// ── the operations ───────────────────────────────────────────────────────────────────────
// ── H9 guarded cross-star reads (INTERNAL) — the daemon-side/atomic half of the --cross-star
//    surface, and (PLAN-0.2.1 step 15) the WHOLE surface the hub may dispatch. The client always
//    names `recall`/`indexed_page`; mcp.ts translates those to the guarded_* ops in --cross-star
//    mode (direct AND over the daemon proxy), so the scope check + the retrieval happen in ONE
//    atomic guarded store read server-side. Each resolves the CURRENT policy from ctx.vault's
//    star.yaml itself (never a client-supplied hash), refusing when the manifest is absent/invalid
//    (H2) or the persisted signature is missing/ignored/stale/mid-reindex.
//
//    They are hoisted OUT of the registry array and spread back into it so this list can be its
//    own exported value. That is what makes step 15's "read operations only" a type, not a habit:
//    every member is a `ReadOperation`, a mutating op's `run` demands the write surface, and the
//    two are not assignable — adding `remember` here is a compile error, not a review catch.
export const HUB_READ_OPS: ReadOperation[] = [
  readOp({
    name: "guarded_recall",
    description: "Cross-star GUARDED recall (internal): atomically verifies the index_scope boundary and returns recall results in the same guarded read, or refuses. The daemon-side half of --ops --cross-star.",
    args: z.object({
      query: z.string().describe("free-text question"),
      k: count("max results (default 5)", 5, 50),
    }),
    readonly: true,
    served: "index",
    internal: true,
    async run(ctx, args) {
      const res = await ctx.store.guardedRead(crossStarExpectation(ctx.vault), () =>
        ctx.store.recall({ query: args.query, k: args.k, rerank: ctx.rerank === true }));
      if ("refusal" in res) throw new Error(res.refusal);
      // The staleness flag belongs HERE most of all: a cross-star caller cannot run `health` against
      // someone else's star, so this key is the only way it learns the rows it is about to cite came
      // from an index older than the notes. Safe on this boundary — the walk is index_scope-scoped
      // (reindex.ts indexedFileExclude), so it does not bypass what `served: "index"` protects, and
      // it returns no file content: one boolean over mtimes of the very corpus this caller may
      // already recall in full. Ordered AFTER the guarded read, which is load-bearing:
      // crossStarExpectation has by then refused an absent/invalid manifest, so the scope lookup
      // cannot take its configless FALLBACK branch — the one place it would walk unscoped.
      return shapeRecall(res.ok, await freshness(ctx, async () => (await ctx.store.stats()).lastReindexAt));
    },
  }),
  readOp({
    name: "guarded_indexed_page",
    description: "Cross-star GUARDED indexed_page (internal): atomic index_scope check + indexed-snapshot read in one guarded read, or refusal. The daemon-side half of --ops --cross-star.",
    args: indexedPageArgs(),
    readonly: true,
    served: "index",
    internal: true,
    async run(ctx, args) {
      const res = await ctx.store.guardedRead(crossStarExpectation(ctx.vault), () => ctx.store.indexedPage({ id: args.id, path: args.path }));
      if ("refusal" in res) throw new Error(res.refusal);
      if (!res.ok) throw new Error(`indexed_page: "${args.id ?? args.path}" is not in the index (unindexed, index_scope-excluded, or not found)`);
      return res.ok;
    },
  }),
  readOp({
    name: "guarded_health",
    description: "Cross-star GUARDED health (internal): the same index stats as `health`, behind the atomic index_scope check, with the absolute vault path projected out. The hub's per-star health call.",
    args: z.object({}),
    readonly: true,
    served: "index",
    internal: true,
    async run(ctx) {
      // The scope guard is not decoration here. `health` is exempt because a same-star caller
      // already knows its own vault; a HUB caller does not, and stats over a mid-reindex or
      // scope-drifted index would describe a corpus the caller may not read.
      const res = await ctx.store.guardedRead(crossStarExpectation(ctx.vault), () => ctx.store.stats());
      if ("refusal" in res) throw new Error(res.refusal);
      const stats = res.ok;
      const vaultChangedSinceReindex = await freshness(ctx, async () => stats.lastReindexAt);
      // `vault` is DELIBERATELY absent: `health` returns the absolute path, and a hub answer must
      // not hand one star's filesystem layout to a caller reaching in from another. The catalogue
      // already names the star; the path is the operator's, not the caller's.
      return { ...stats, vaultChangedSinceReindex };
    },
  }),
];

/** The names the hub may dispatch, as a TYPE. A caller that asks for anything else — a write op, a
 *  filesystem-served op, a typo — does not compile. */
export type HubOpName = "guarded_recall" | "guarded_indexed_page" | "guarded_health";

/** Dispatch one hub read op: the same required-presence + schema path as `dispatchToolCall`, over
 *  the read registry and a context that HAS no write surface to reach. */
export async function dispatchReadOp(
  name: HubOpName,
  args: Record<string, unknown>,
  ctx: ReadOperationContext,
): Promise<unknown> {
  const op = HUB_READ_OPS.find((o) => o.name === name);
  if (!op) throw new Error(`unknown read operation: ${name}`); // unreachable via the type; kept for JS callers
  const parsed = parseOpArgs(op, name, args);
  return op.run(ctx, parsed);
}

export const operations: Operation[] = createRegistry([
  op({
    name: "recall",
    description:
      "Hybrid recall (FTS + vector + edge-walk, RRF-fused) over the star's memory. " +
      "Every result carries its vault-relative path (provenance) and a trust label " +
      "(trusted = human-authored/elevated; untrusted = unvetted ingest such as in_*/ or agent writes) — weight accordingly.",
    args: z.object({
      query: z.string().describe("free-text question"),
      k: count("max results (default 5)", 5, 50),
    }),
    readonly: true,
    served: "index", // recall reads the derived store — index_scope IS the boundary
    scopeGuarded: true, // item 16: the rows recall returns ARE the rows index_scope withdraws
    async run(ctx, args) {
      // Move 5: rerank is a daemon-wide posture (ctx.rerank, set from `--rerank` at startup),
      // never a client argument — so the input schema exposes no `rerank` key. It is a no-op
      // unless the store also carries a Reranker (mirrors the CLI: --rerank => reranker + flag).
      const res = await ctx.store.recall({ query: args.query, k: args.k, rerank: ctx.rerank === true });
      return shapeRecall(res, await freshness(ctx, async () => (await ctx.store.stats()).lastReindexAt));
    },
  }),
  op({
    name: "recall_v2",
    description:
      "Hybrid recall (as `recall`) returning a VERSIONED ENVELOPE: { publicationId, contentGeneration, " +
      "generationValid, servingSignature, results }. `results` is byte-identical to what `recall` returns; " +
      "the envelope names WHICH rows answered and WHAT semantics answered over them, so a consumer can " +
      "tell two honestly-different answers apart instead of reading the difference as a bug.",
    args: z.object({
      query: z.string().describe("free-text question"),
      k: count("max results (default 5)", 5, 50),
    }),
    readonly: true,
    served: "index",
    scopeGuarded: true,
    async run(ctx, args) {
      // PLAN-0.3.0 item 19. `recall` is NOT replaced and NOT deprecated in this release: retiring it
      // needs a twinkl.ing release, which the plan names as an EXTERNAL release gate — so the two
      // ops ship side by side and share the projection below, exactly as `guarded_recall` does. The
      // shape promise is that `results` is the same array `recall` returns, so a consumer migrates
      // by reading one key deeper, not by reparsing hits.
      const stats = await ctx.store.stats();
      const res = await ctx.store.recall({ query: args.query, k: args.k, rerank: ctx.rerank === true });
      return {
        publicationId: stats.publicationId,
        contentGeneration: stats.contentGeneration,
        // Explicit rather than inferred from `contentGeneration !== null`: the four honest causes of
        // a null stamp (never stamped, a legacy v1 stamp, invalidated by a mutation, a build in
        // flight) all mean "do not treat these rows as a named build", and a consumer should not
        // have to rediscover that rule. `health` carries invalidatedAt/Reason for the WHY.
        generationValid: stats.contentGeneration !== null,
        // This process's, not the publisher's (item 7): every input is process-local, so a manifest
        // could never assert it and a caller comparing two loci needs each locus's own answer.
        servingSignature: ctx.store.servingSignature(),
        results: shapeRecall(res, await freshness(ctx, async () => stats.lastReindexAt)),
      };
    },
  }),
  op({
    name: "page",
    description: "Read one markdown page from the vault (frontmatter + body). Vault-relative path only.",
    args: z.object({ path: z.string().describe("vault-relative path, e.g. yachts/research.md") }),
    readonly: true,
    served: "fs", // reads the vault filesystem — bypasses index_scope, banned on a cross-star surface
    async run(ctx, args) {
      const abs = safeResolve(ctx.vault, args.path);
      const { data, body } = parseFrontmatter(readFileSync(abs, "utf8"));
      return { path: args.path, frontmatter: data, body };
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
    served: "fs", // readdir over the vault filesystem — bypasses index_scope
    async run(ctx, args) {
      const rel = args.dir;
      const abs = rel ? safeResolve(ctx.vault, rel) : resolve(ctx.vault);
      const dirs: Array<{ name: string; zone: string }> = [];
      const files: string[] = [];
      for (const name of readdirSync(abs).sort()) {
        if (name.startsWith(".")) continue;
        if (statSync(join(abs, name)).isDirectory()) dirs.push({ name, zone: zoneOfDir(rel ? `${rel}/${name}` : name) });
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
    served: "fs", // NOT part of the index-served cross-star surface (graph-explorer read; banned cross-star)
    // item 16: `served: "fs"` here means "keep it off the cross-star surface", NOT "reads files" —
    // neighbors answers entirely out of the store, so a drifted scope leaks excluded pages' titles
    // and ids through it exactly as it would through recall. Guarded.
    scopeGuarded: true,
    async run(ctx, args) {
      return ctx.store.neighbors(args.id, args.k);
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
    served: "fs", // constellation bake (writes a cache file beside pgdata); not the cross-star surface
    scopeGuarded: true, // item 16: the baked artifact is every node in the index — same leak as neighbors
    async run(ctx) {
      return ctx.store.graph();
    },
  }),
  op({
    name: "health",
    description: "Index health: node/edge counts, embedding signature, dirty-reindex flag, and whether the vault has changed since the last reindex.",
    args: z.object({}),
    readonly: true,
    served: "index", // store stats only — servable on a cross-star surface (exempt from the scope guard)
    // item 16 exemption, deliberate: `health` returns COUNTS and IDENTITY, never a page. It is also
    // the op that REPORTS the built-versus-desired scope disagreement (item 20), so refusing it on
    // that disagreement would withhold the diagnosis of the very condition being diagnosed — the
    // same reason `--ops` mode keeps `health` while refusing `recall`. Cross-star callers get the
    // guarded_health variant, which DOES check, because a hub caller cannot read this star's
    // star.yaml for itself.
    scopeGuarded: false,
    async run(ctx) {
      const stats = await ctx.store.stats();
      // One definition of "has the vault moved" for health, recall and the CLI — and it walks the
      // INDEXED corpus. This used to walk every .md under the vault, so a touched `node_modules/*.md`
      // in a configless vault reported the index permanently stale; and on a `--cross-star` surface,
      // which admits this op precisely because served:"index" promises no filesystem read, it stat'd
      // the very paths index_scope exists to withhold.
      const vaultChangedSinceReindex = await freshness(ctx, async () => stats.lastReindexAt);
      // `generation` is a DEPRECATED ALIAS of `contentGeneration`, and the two faces must carry the
      // same key names for the same value: `stats()` renamed its field in 0.3.0 item 8, and because
      // this op spreads stats while the HTTP face `/health` names its keys, one rename silently gave
      // one logical value two names on two faces — with twinkl.ing's memory block (MEMORY_SAFE_KEYS,
      // gateway-proxy.ts) reading `generation` off exactly one of them. REMOVE both aliases in the
      // release that also drops `recall` for `recall_v2` — the twinkl.ing cutover the plan names as
      // an external release gate (item 19) — never before, and never on one face alone.
      // 0.3.0 item 20: the operator-facing state contract, shared VERBATIM with `doctor` (one
      // assembly in machine-state.ts, so the two faces cannot drift into two accounts of one
      // machine). It is spread LAST but adds no key that `stats` already owns except by intent —
      // `schemaVersion`, `publicationId`, `contentGeneration`, `invalidatedAt`, `invalidatedReason`
      // and `ignoreScope` are the same values from the same snapshot, and the new keys are the ones
      // that were previously unanswerable here: `generationValid`, `servingSignature`,
      // `desiredScopeHash`/`scopeMatches`, `buildState`, `machineState`, `overrides`.
      const state = await operatorState(ctx.store, ctx.vault, stats);
      return { vault: ctx.vault, ...stats, generation: stats.contentGeneration, vaultChangedSinceReindex, ...state };
    },
  }),
  op({
    name: "hotlist",
    description:
      "Top-N most-recalled TRUSTED pages from the opt-in recall_stats telemetry (daemon --stats). " +
      "Counters are advisory routing hints for humans/agents — NEVER an input to recall ranking. " +
      "items is [] when tracking is off (the `tracking` field says which).",
    args: z.object({ n: count("max rows (default 20, max 100)", 20, 100) }),
    readonly: true,
    served: "index", // recall_stats telemetry from the store — no filesystem read
    scopeGuarded: true, // item 16: hotlist returns titles and paths of indexed pages
    async run(ctx, args) {
      const tracking = ctx.store.recallTracking;
      return { tracking, items: tracking ? await ctx.store.hotlist(args.n) : [] };
    },
  }),
  op({
    name: "indexed_page",
    description:
      "Read one page's INDEXED snapshot from the store (title, body, and metadata as last indexed), " +
      "by node id or vault-relative path. Serves the DATABASE, never the vault filesystem — an " +
      "index_scope-excluded or unindexed path returns not-found even if the file exists on disk. The " +
      "cross-star read surface: no filesystem access, so the index is the capability boundary (no TOCTOU).",
    // The id-OR-path rule is CROSS-FIELD, so it lives in a refine — which zod omits from the
    // emitted JSON Schema, leaving the advertised contract unchanged. Truthiness, not nullishness:
    // `{id: ""}` must still be "provide an id or a path", as it was pre-zod.
    args: indexedPageArgs(),
    readonly: true,
    served: "index", // reads the DB snapshot only (no fs) — the cross-star read surface, no TOCTOU
    scopeGuarded: true, // item 16: serves a whole page BODY out of the index
    async run(ctx, args) {
      const page = await ctx.store.indexedPage({ id: args.id, path: args.path });
      if (!page) throw new Error(`indexed_page: "${args.id ?? args.path}" is not in the index (unindexed, index_scope-excluded, or not found)`);
      return page;
    },
  }),
  ...HUB_READ_OPS,
  // ── S3 mutating ops — all through FunesStore: out_memory/ only (assertOwned), sanitized,
  //    markdown written first, trust server-stamped untrusted. No trust argument exists.
  op({
    name: "remember",
    description:
      "Write a memory item to out_memory/<id>.md (markdown-canonical) and index it. " +
      "Recorded as UNTRUSTED — a human elevates it later via the funes CLI if it deserves trust.",
    args: z.object({
      title: z.string().describe("short title"),
      body: z.string().describe("the memory content (markdown)"),
      type: optionalText("optional item type (default: memory)"),
      tags: z.string().describe("optional comma-separated tags").optional(),
      // P5.19 state/event split. funes never decides which this is — the harness does, on the S4
      // compact-at-ingest seam — but until now it could not TELL us, so every agent write was
      // implicitly an append-only event and nothing could ever be marked stale.
      // Was "…that later writes should replace". Nothing replaces anything yet: there is no claim
      // key to supersede BY, and supersede() needs a caller that already knows oldId. Promising
      // automatic replacement writes a permanent lie into every memory's provenance, so the
      // description states what is true today — it is recorded, surfaced by recall, and breaks
      // ties. It becomes a promise when claim keys ship.
      volatile: z.boolean().describe("true if this is a STATE that goes stale and should be replaced by a later write (a rate, a plan); false/omitted for an EVENT, which is append-only. Recorded and returned by recall; supersession is still an explicit act, not automatic").optional().transform((v) => v === true),
      as_of: isoDate("when this was true (ISO date), if that differs from when it was written"),
    }),
    readonly: false,
    served: "fs", // writes canonical markdown to the vault (never in a read-only/cross-star allowlist)
    async run(ctx, args) {
      const { ids } = await ctx.funes.remember([{
        title: args.title,
        body: args.body,
        type: args.type,
        // no trust here — FunesStore stamps untrusted
        meta: { tags: strList(args.tags), volatile: args.volatile, as_of: args.as_of },
      }]);
      return { id: ids[0], trust: "untrusted" };
    },
  }),
  op({
    name: "supersede",
    description: "Replace a funes-written memory item: writes the successor, marks the old one superseded (kept on disk, off recall). out_memory/ ids only.",
    args: z.object({
      oldId: z.string().describe("id of the item to supersede (out_memory/...)"),
      title: z.string(),
      body: z.string(),
      type: optionalText("optional item type"),
      // P5.19: a successor that cannot restate its own volatility silently DEMOTES a state claim to
      // an event — the exact failure supersession exists to prevent.
      // cf8e976 retired the "later writes should replace" promise from `remember` and missed this
      // twin, so the same unkeepable claim survived on the op whose whole purpose is replacement —
      // where a caller is most likely to read it as a guarantee. There is still no claim key to
      // supersede BY; replacement is an act someone performs, not something funes does.
      volatile: z.boolean().describe("true if the successor is still a STATE that goes stale and should be replaced by a later write; false/omitted records it as an append-only EVENT. Recorded and returned by recall; supersession is still an explicit act, not automatic").optional().transform((v) => v === true),
      as_of: isoDate("when the successor's claim became true (ISO date)"),
      tags: z.string().describe("optional comma-separated tags").optional(),
    }),
    readonly: false,
    served: "fs", // writes canonical markdown to the vault
    async run(ctx, args) {
      const { id } = await ctx.funes.supersede(args.oldId, {
        title: args.title, body: args.body, type: args.type,
        meta: { tags: strList(args.tags), volatile: args.volatile, as_of: args.as_of },
      });
      return { id, supersedes: args.oldId, trust: "untrusted" };
    },
  }),
  op({
    name: "forget",
    description: "Forget a funes-written memory item: soft tombstone by default (file kept, off recall); hard=true deletes the file. out_memory/ ids only.",
    args: z.object({
      id: z.string().describe("id of the item to forget (out_memory/...)"),
      hard: z.boolean().describe("true = delete the markdown file (default false)").optional().transform((v) => v === true),
    }),
    readonly: false,
    served: "fs", // deletes/tombstones canonical markdown in the vault
    async run(ctx, args) {
      await ctx.funes.forget(args.id, { hard: args.hard });
      return { id: args.id, forgotten: true, hard: args.hard };
    },
  }),
]);

/** Shared by `indexed_page` and its guarded twin so the two can never drift — the guarded op is
 *  internal, so nothing a client can see would catch a divergence. */
function indexedPageArgs() {
  return z
    .object({
      id: z.string().describe("node id (vault-relative path without .md)").optional(),
      path: z.string().describe("vault-relative path (with or without .md)").optional(),
    })
    .refine((v) => Boolean(v.id || v.path), { message: "indexed_page: provide an `id` or a `path`" });
}

// ── pure projections (gbrain pattern) ────────────────────────────────────────────────────
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: OpInputSchema;
}

export function buildToolDefs(ops: Operation[]): McpToolDef[] {
  // H9: internal ops (guarded_recall/guarded_indexed_page) are never advertised — clients name the
  // public recall/indexed_page and mcp.ts translates. Filtered here so tools/list AND /api/ops hide them.
  return ops.filter((op) => !op.internal).map((op) => ({ name: op.name, description: op.description, inputSchema: op.inputSchema }));
}

/** P1.8: the op-capability projection — the SINGLE source of truth for what a consumer (twinkling's
 *  cross-star connection validator) may name and how funes will treat it. name + readonly + served +
 *  internal, sorted by name (deterministic). twinkling derives its known / mutating / fs-served /
 *  internal sets from this instead of a hand-maintained list that drifts from the registry (the
 *  stale MUTATING_OPS bug). Since twinkling imports funes source directly today, importing this
 *  function IS the metadata export — no drift is possible, it is computed from the registry. When
 *  funes ships as a published package (P3), a committed JSON snapshot + CI no-diff replaces the live
 *  import; until then the in-process projection is deterministic by construction. */
export interface OpCapability {
  name: string;
  readonly: boolean;
  served: "index" | "fs";
  internal: boolean;
}
export function opCapabilities(ops: Operation[] = operations): OpCapability[] {
  return ops
    .map((o) => ({ name: o.name, readonly: o.readonly, served: o.served, internal: o.internal ?? false }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** `ZodError.message` is a multi-line JSON dump of the issue objects, and three surfaces render
 *  `(e as Error).message` verbatim — MCP tool errors (mcp.ts, face.ts) and `{ok:false,error}`
 *  (funes-api). Flatten to one line so a client gets a sentence, not a blob. */
function argError(name: string, err: z.ZodError): Error {
  const parts = err.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message));
  return new Error(`operation ${name}: ${parts.join("; ")}`);
}

export async function dispatchToolCall(
  ops: Operation[],
  name: string,
  args: Record<string, unknown>,
  ctx: OperationContext,
): Promise<unknown> {
  const op = ops.find((o) => o.name === name);
  if (!op) throw new Error(`unknown operation: ${name}`);
  // 0.3.0 item 25 (ADR-0005) — THE canonical-vault mutation boundary. Every mutating op in this
  // registry writes canonical markdown (`served: "fs"`), and every served surface — the broker
  // face, stdio MCP, the daemon proxy — dispatches through here, so this is ONE place rather than a
  // convention repeated in three. It does NOT gate a machine rebuilding its own derived index:
  // reindex never comes through this dispatcher, which is exactly the narrowing ADR-0005 demands.
  // It runs AFTER the argument gate on purpose — a request that fails its schema never became a
  // write, and auditing it would fill an operator's log with rejected garbage. 0.3.0 ships `audit`,
  // so the decision is reported and the write proceeds; the `enforce` branch, when the estate
  // declares write_authority everywhere, refuses HERE on `!decision.allowed`.
  const parsed = parseOpArgs(op, name, args);
  if (!op.readonly) {
    const designation = ctx.designation ?? resolveWriteDesignation(ctx.vault);
    reportWriteDecision(authorizeCanonicalWrite(designation, { op: name, vault: ctx.vault, actor: ctx.actor }));
  }
  // 0.3.0 item 16 — THE own-star index_scope guard, here because every served surface (the broker
  // and read faces, stdio MCP, the daemon proxy, the funes-api HTTP surface) dispatches through
  // this one function. Until now the guard ran ONLY inside the three `guarded_*` ops, which only
  // `--cross-star` mode reaches — so an operator who narrowed `star.yaml` and had not yet
  // reindexed went on serving the withdrawn pages to every LOCAL client, indefinitely, with no
  // signal anywhere. The check-retrieve-RECHECK shape is the store's `guardedRead`: the desired
  // scope is recomputed from live `star.yaml` on BOTH ends, so a manifest that narrows during the
  // read refuses on the way out.
  //
  // The `guarded_*` ops are `internal` and guard themselves against the stricter cross-star
  // expectation; wrapping them again here would only ask a weaker question after a stronger one.
  if (op.scopeGuarded && !op.internal) {
    const res = await ctx.store.guardedRead(ownStarExpectation(ctx.vault), () => op.run(ctx, parsed));
    if ("refusal" in res) throw new Error(res.refusal);
    return res.ok;
  }
  return op.run(ctx, parsed);
}

/** The ONE argument gate, shared by both dispatchers — the hub must refuse exactly what the MCP
 *  surface refuses, in exactly the same words. */
function parseOpArgs(op: { inputSchema: OpInputSchema; args: z.ZodType }, name: string, args: Record<string, unknown>): unknown {
  // Required-presence runs BEFORE the schema so the long-standing wording survives: zod would say
  // "expected string, received undefined", which reads like a type error rather than a missing arg.
  for (const req of op.inputSchema.required ?? []) {
    if (!(req in args)) throw new Error(`operation ${name}: missing required argument "${req}"`);
  }
  const parsed = op.args.safeParse(args);
  if (!parsed.success) throw argError(name, parsed.error);
  return parsed.data;
}
