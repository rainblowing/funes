import type { PgDriver } from "./driver.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Graph from "graphology";
import { circular } from "graphology-layout";
import forceAtlas2 from "graphology-layout-forceatlas2";
import louvain from "graphology-communities-louvain";
// P3.14: the index-store CONTRACT (these interfaces) moved to funes-core — types only, so the
// portable tier can hold them and funes-libsql stops importing this package. Implementations
// (PostgresStore below, the graph bake) stay here. Re-exported so existing importers are unchanged.
export type { FreshnessFields, HotlistRow, GraphNode, GraphEdge, GraphArtifact, IndexedPage, NeighborsResult, GuardedResult, FunesIndexStore } from "funes-core";
import type { FreshnessFields, HotlistRow, GraphNode, GraphEdge, GraphArtifact, IndexedPage, NeighborsResult, GuardedResult, FunesIndexStore } from "funes-core";
import type { Embedder, MemoryItem, RecallQuery, RecallResult, RememberResult, ScopeSignature, Store, Trust } from "funes-core";
import { rrf, rrfScores, resolveGraphArm, embeddingSignature, normalizeRelationType, buildGraphArm, GRAPH_ARM_CAP_OUT, GRAPH_ARM_CAP_IN, GRAPH_ARM_HUB_MAX } from "funes-core";
import type { GraphNeighborRow } from "funes-core";
import { acquireWriteLock, withWriteLock } from "funes-shared";
import type { WriteLock } from "funes-shared";
import { guardRefusal } from "./scope.ts";
import { hashItem } from "funes-shared";
import { CHUNK_SIG, chunkText } from "./embedder.ts";
import type { Reranker } from "./rerank.ts";
import { zoneOfFile, type Zone } from "funes-shared";

/** pgvector literal for a Float32Array — `"[0.1,0.2,…]"`, used with `$n::vector`. Pure (dialect,
 *  not driver): relocated here when the PGLite WASM driver was removed — node-postgres needs it
 *  identically on the write/recall path. */
export const vecLiteral = (a: Float32Array): string => `[${Array.from(a).join(",")}]`;

const WORD = /[a-zA-Z0-9]+/g;

/** Postgres tsvector input is hard-capped at 1,048,575 BYTES; multi-MB vault files (export
 *  dumps) abort `to_tsvector` with "string is too long for tsvector". Cap at 250k chars —
 *  4-byte worst-case UTF-8 stays under the limit. (The embedding path has its own, much
 *  smaller truncation — H1 chunking debt.) */
const FTS_MAX_CHARS = 250_000;

/** Free-text -> A1-style OR-query of quoted terms (kept exported for parity with the Python A1
 *  backend and for the profile-C FTS5 substrate; the PGLite recall path uses websearch_to_tsquery). */
export function ftsQuery(q: string): string {
  const terms = (q.match(WORD) ?? []).filter((t) => t.length >= 2);
  return terms.map((t) => `"${t}"`).join(" OR ") || '""';
}

// Content hash for incremental reindex: hashItem now lives in generation.ts (THE one encoding
// module — generation-v1 records must use the exact store change-detection hash, so the
// definition moved there; imported above).


const isVolatile = (it: MemoryItem) => (it as MemoryItem & FreshnessFields).volatile === true;

/** Frontmatter freshness value -> ISO timestamp or null. Lenient: an unparsable date is a null
 *  freshness (sorts last in a volatile tie), never an aborted batch. */
function freshnessIso(it: MemoryItem): string | null {
  const v = (it as MemoryItem & FreshnessFields).freshness;
  if (v == null) return null;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Provenance-v1 declared `authored` -> ISO timestamp or null (timestamptz column). Same lenient
 *  parse as freshness; a distinct provenance field, not the recency thumb. */
function authoredIso(it: MemoryItem): string | null {
  if (it.authored == null) return null;
  const t = Date.parse(String(it.authored));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Rev 7 freshness (a): two fused RRF scores within this epsilon count as a tie (RRF produces
 *  frequent EXACT ties — same ranks across different arms sum to the same float). */
export const RRF_TIE_EPS = 1e-9;

/** Rev 7 freshness (a) — recency tiebreak, a versioned ranking change pinned by H5, applied to
 *  the RRF-ordered candidate list. Deliberately NOT a comparator handed to Array.sort: epsilon
 *  equality is non-transitive on epsilon-chains (a≈b, b≈c, a≉c), which violates the sort
 *  contract and makes chain order implementation-defined. This is a total run-grouping pass:
 *
 *  Run-cutting rule (HEAD-anchored): walk the list once; a run opens at the first unconsumed
 *  item (its HEAD) and extends over CONSECUTIVE items whose fused score is within RRF_TIE_EPS
 *  of the HEAD's score — anchored to the run head, not the previous item — so a run's total
 *  score spread is bounded by EPS and an epsilon-chain (s, s-0.6e-9, s-1.2e-9) cuts before the
 *  third item instead of gluing arbitrarily distant scores into one tie.
 *
 *  A run containing at least one volatile item is stable-sorted by freshness desc (nulls
 *  last) — that comparator is a total preorder, so the sort is well-defined and deterministic;
 *  runs with no volatile member keep RRF order. Runs concat back in place: the output is a
 *  deterministic permutation of the input, and RRF scores are never altered. */
export function recencyTiebreak<T extends { score: number }>(
  items: readonly T[],
  meta: (item: T) => { volatile?: boolean; fresh?: number | null } | undefined,
): T[] {
  const out: T[] = [];
  for (let i = 0; i < items.length; ) {
    const head = items[i]!.score;
    let j = i + 1;
    while (j < items.length && Math.abs(head - items[j]!.score) <= RRF_TIE_EPS) j++;
    const run = items.slice(i, j);
    if (run.length > 1 && run.some((r) => meta(r)?.volatile)) {
      run.sort((a, b) => {
        const fa = meta(a)?.fresh ?? null, fb = meta(b)?.fresh ?? null;
        if (fa === fb) return 0;
        if (fa === null) return 1;
        if (fb === null) return -1;
        return fb - fa;
      });
    }
    out.push(...run);
    i = j;
  }
  return out;
}

/** Move 5 (trust-aware ranking) — the per-trust multiplier applied to the fused RRF score to
 *  produce the ORDERING key. A thumb on the scale, NOT a gate (every weight is in (0,1], so no
 *  result is ever excluded — recall stays unrestricted + trust-labeled per S3). trusted is the
 *  ceiling (1.0); derived takes a small haircut; untrusted a larger but bounded one. The default
 *  spread is deliberately modest: it breaks a cross-trust RRF tie and closes a small relevance
 *  gap, but cannot bury a strongly-relevant untrusted hit under weak trusted noise (the RRF gap
 *  there exceeds 1 - untrusted weight). FROZEN-ish: changing these is a VERSIONED ranking change
 *  (regenerate the H5 golden with a reviewed diff). */
export const TRUST_WEIGHT: Record<Trust, number> = {
  trusted: 1.0,
  derived: 0.95,
  untrusted: 0.85,
};

/** Move 5: the trust-adjusted ORDERING score — `rrfScore * weight(trust)`. The emitted
 *  RecallResult.score stays the raw RRF score (parity contract: "scores stay RRF, by design");
 *  this adjusted value is used ONLY to sort and to feed the recency tiebreak's run-cutting.
 *  A missing/unknown trust is treated as untrusted (deny-biased, matches ops.ts default). */
export function trustAdjust(rrfScore: number, trust: Trust | undefined): number {
  return rrfScore * (TRUST_WEIGHT[trust ?? "untrusted"] ?? TRUST_WEIGHT.untrusted);
}

/** Zone-weight: a CURATION prior, the zone analogue of TRUST_WEIGHT. A short/ambiguous query (e.g.
 *  "ada") should surface the curated `people/ada` WIKI page over the `out_distill/telegram/*`
 *  artifacts that merely mention the name. Like trust, a modest thumb on the ORDERING score only
 *  (the emitted RecallResult.score stays raw RRF — parity contract); never zero, so it RE-RANKS and
 *  never FILTERS (a strongly-relevant ingest hit still beats weak wiki noise — the RRF gap exceeds
 *  the spread). FROZEN-ish: changing these is a VERSIONED ranking change (regenerate the H5 golden
 *  with a reviewed diff). */
export const ZONE_WEIGHT: Record<Zone, number> = {
  // Curated wiki is the ceiling. OUTPUT (machine digests / telegram distills) gets the stronger
  // haircut — it's the most disposable (a curated entity page is preferred over a distill that merely
  // mentions the name, and that noise is exactly what we want under the curated page). INCOMING (raw
  // ingest) stays GENTLER so the prior remains a THUMB not a gate: a strongly-relevant raw message
  // (multi-arm RRF lead) is often genuinely important and must stay findable (the trust-ranking
  // guardrail enforces this — incoming below ~0.8 buries it). Never zero -> never a filter.
  wiki: 1.0,
  output: 0.7,
  incoming: 0.8,
};

/** Ruling-B refinement (stack review 2026-07-02, Vlad-locked): out_distill/** is the DESIGNATED
 *  telegram recall layer — machine-curated, PII-redacted — so it ranks ABOVE raw ingest (0.8) but
 *  below hand-authored wiki (1.0). Generic OUTPUT 0.7 was demoting the very layer Ruling B promoted.
 *  Segment match at any depth (vault-v2 zone semantics). MIRRORED in funes-libsql/src/ranking.ts. */
export const DISTILL_WEIGHT = 0.87;
const isDistill = (path: string): boolean => path.split("/").some((s) => s === "out_distill");

export function zoneAdjust(score: number, path: string): number {
  const zone = zoneOfFile(path);
  if (zone === "output" && isDistill(path)) return score * DISTILL_WEIGHT;
  return score * (ZONE_WEIGHT[zone] ?? ZONE_WEIGHT.wiki);
}

/** Entity boost (stack review B-1 follow-up, 2026-07-02): an exact-NAME query must surface the
 *  page NAMED that ("ada" → `people/ada`) over distill artifacts that merely mention the name —
 *  the measured failure was a 1.44× distill RRF lead burying the curated entity page. Trigger is
 *  deliberately HIGH-PRECISION: the normalized whole query equals the node's title or its id stem
 *  (the user typed the page's name); anything else is untouched, so ordinary queries never shift.
 *  ×1.5 outweighs the observed RRF lead plus the trust haircut. Ordering-score only (emitted score
 *  stays raw RRF — parity contract). VERSIONED ranking change (H5 goldens re-pin on change).
 *  MIRRORED in funes-libsql/src/ranking.ts. */
export const ENTITY_BOOST = 1.5;
export function entityAdjust(score: number, query: string, title: string | null | undefined, id: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return score;
  const stem = (id.split("/").pop() ?? id).toLowerCase();
  const t = (title ?? "").trim().toLowerCase();
  return q === t || q === stem ? score * ENTITY_BOOST : score;
}

/** Move 5 (near-duplicate collapse) — two near-identical results collapse to the best
 *  (already-ordered-first) one, which absorbs the rest and carries a `duplicates` count of how
 *  many it stood in for. Collapse KEY = (normalized title, trust, zone): a curated page and a raw
 *  dump that happen to share a title are NEVER merged (distinct trust/zone => distinct key).
 *
 *  Why title-identity, NOT score-equality, is the signal: RRF produces FREQUENT exact ties (see
 *  recencyTiebreak) — distinct pages routinely share a fused score, so collapsing on score-within-
 *  EPS would wrongly fold genuinely-different content into one slot. The audit's motivating case
 *  ("N copies of ONE document costing N slots") is exactly same-title same-zone same-trust dupes,
 *  which this catches precisely. `scoreOf` is accepted for symmetry/possible future tuning but the
 *  default key is intentionally title-based.
 *
 *  Deterministic and cheap: one linear pass over the already-ordered list, no embeddings, no extra
 *  queries; the first member of a cluster (best slot) is the keeper, so collapsing frees its
 *  lower-ranked twins' slots and later DISTINCT candidates backfill into the top-k. */
export function collapseDuplicates<
  T extends { id: string; title: string; path?: string; trust?: Trust; duplicates?: number;
              volatile?: boolean; freshness?: string },
>(items: readonly T[], _scoreOf: (item: T) => number): T[] {
  const out: T[] = [];
  const seen = new Map<string, T>(); // collapse key -> keeper
  const norm = (s: string) => s.trim().toLowerCase();
  // Between two VOLATILE twins the later claim wins, regardless of fused score. Keeping the
  // best-scoring one meant collapse could hide the current value behind the outdated one — the
  // exact failure the state/event split exists to prevent, made invisible by the very mechanism
  // meant to tidy the results. Events (non-volatile) stay append-only: score order is the right
  // answer there and there is nothing to supersede.
  const supersedes = (a: T, b: T) =>
    a.volatile === true && b.volatile === true &&
    a.freshness != null && b.freshness != null && a.freshness > b.freshness;
  for (const it of items) {
    const zone = zoneOfFile(it.path ?? `${it.id}.md`);
    const key = `${it.trust ?? "untrusted"}\x00${zone}\x00${norm(it.title)}`;
    const keeper = seen.get(key);
    if (!keeper) { seen.set(key, it); out.push(it); continue; }
    if (supersedes(it, keeper)) {
      out[out.indexOf(keeper)] = it;          // take the keeper's rank, not a lower slot
      it.duplicates = (keeper.duplicates ?? 0) + 1;
      seen.set(key, it);
    } else {
      keeper.duplicates = (keeper.duplicates ?? 0) + 1;
    }
  }
  return out;
}


// the 5 funes relation families (funes/wiki/concepts/semantic-relation-types.md) — baked onto each
// edge so the renderer colours/filters by family without re-deriving it.
const RELATION_FAMILIES: Record<string, string[]> = {
  structural: ["contains", "part-of", "instance-of", "has-instance", "subtype-of", "supertype-of", "implements", "implemented-by", "composed-of", "component-of"],
  dependency: ["depends-on", "dependency-of", "requires", "required-by", "uses", "used-by", "extends", "extended-by", "wraps", "wrapped-by"],
  epistemic: ["supports", "supported-by", "contradicts", "contradicted-by", "refines", "refined-by", "qualifies", "qualified-by", "derived-from", "source-of", "cites", "cited-by"],
  temporal: ["precedes", "succeeds", "supersedes", "superseded-by", "co-occurs-with", "valid-from", "valid-until", "observed-at"],
  causal: ["causes", "caused-by", "enables", "enabled-by", "blocks", "blocked-by", "triggers", "triggered-by", "solves", "solved-by", "competes-with", "complements"],
};
// N4 (2026-07-13): the auto-derived edge types get EXPLICIT family entries — previously
// `related-to`/`related_to`/`mentions` were absent and fell to "structural" only via the
// fallback. Mapped to "structural" DELIBERATELY (status quo made explicit, zero render change);
// re-familying `mentions` is an E-lane call, not a behavior-neutral one. Lookups normalize
// spelling (underscore/hyphen) through normalizeRelationType — storage keeps authored strings.
const TYPE_TO_FAMILY: Record<string, string> = { "related-to": "structural", mentions: "structural" };
for (const fam in RELATION_FAMILIES) for (const t of RELATION_FAMILIES[fam]!) TYPE_TO_FAMILY[t] = fam;
const familyOf = (type: string): string => TYPE_TO_FAMILY[normalizeRelationType(type)] ?? "structural";

/** Small seeded PRNG (mulberry32) so Louvain community assignment is stable across bakes (else the
 *  palette reshuffles session-to-session). */
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** funes-core Store over a Postgres server (node-postgres) + pgvector HNSW + tsvector FTS — the
 *  deferred profile-B backend (ADR-0001). Hybrid recall = FTS + vector + edge-walk -> RRF. Construct
 *  via `PostgresStore.createWithDriver(driver, ...)` (postgres-driver.ts supplies the driver). The
 *  in-process PGLite-WASM driver + its `create()` convenience were removed 2026-07-20 (libsql is the
 *  default+only-local backend); the SQL body here is plain Postgres, unchanged. */
export class PostgresStore implements FunesIndexStore {
  // P3.15: explicit fields rather than TS parameter properties — those are non-erasable syntax, so
  // Node's type-stripping loader rejects this whole module (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  private db: PgDriver; // the driver seam (ADR-0001): node-postgres on a server
  private embedder: Embedder;
  private sig: string;
  private reranker?: Reranker;
  private trackRecalls: boolean;
  private dataDir?: string; // retained so graph() can cache its baked artifact beside the data dir
  // provenance-v1 STAMPED actor (mirror of libsql) — server fact, never from item payload.
  private writeActor: string;

  private constructor(
    db: PgDriver,
    embedder: Embedder,
    sig: string,
    reranker?: Reranker,
    trackRecalls = false,
    dataDir?: string,
    writeActor = "unknown",
  ) {
    this.db = db;
    this.embedder = embedder;
    this.sig = sig;
    this.reranker = reranker;
    this.trackRecalls = trackRecalls;
    this.dataDir = dataDir;
    this.writeActor = writeActor;
  }

  /** Construct over a PgDriver — the server tier (node-postgres via postgres-driver.ts) enters here.
   *  S4: the reranker is INJECTED (never auto-instantiated) — default undefined means
   *  `recall({ rerank: true })` is a no-op and recall stays pure RRF order. R8: `trackRecalls`
   *  (opt-in, default OFF) records which results recall RETURNS into a local `recall_stats` table —
   *  advisory telemetry for the hot cache, NEVER an input to recall ranking. */
  static async createWithDriver(
    db: PgDriver,
    embedder: Embedder,
    opts: { allowDirty?: boolean; reranker?: Reranker; trackRecalls?: boolean; dataDir?: string; writeActor?: string } = {},
  ): Promise<PostgresStore> {
    const s = new PostgresStore(db, embedder, `${embeddingSignature(embedder)}:${CHUNK_SIG}`, opts.reranker, opts.trackRecalls ?? false, opts.dataDir, opts.writeActor ?? "unknown");
    await s.init(opts.allowDirty ?? false);
    return s;
  }

  /** Whether THIS handle records recall telemetry (the daemon `--stats` flag lands here). */
  get recallTracking(): boolean {
    return this.trackRecalls;
  }

  // ── write mutex (slice 4, mirrors the libsql wiring): structural writes take the cross-process
  // per-index lock; a reindex holds it begin→end (reentrant per process); in-memory stores skip. ──
  private reindexLock?: WriteLock;
  get lockResource(): string | null {
    return this.dataDir ?? null;
  }
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const res = this.lockResource;
    return res ? withWriteLock(res, fn) : fn();
  }

  private async init(allowDirty: boolean): Promise<void> {
    const d = this.db;
    await d.exec("create extension if not exists vector;");
    // HNSW recall floor (FTS-leg bench 2026-07-13): pgvector's default ef_search=40 collapses
    // recall on hard/cross-language queries (Russian query → English pages dropped entirely;
    // ef=200 reproduced exact-scan ordering, end-to-end hit@5 0.70→1.00 with the setweight fix
    // — the offline-eval harness scores hit@5 (expected-id in top 5), not judged precision).
    // The node-postgres pool applies this per-connection in postgres-driver.ts. FUNES_EF_SEARCH
    // overrides (re-measure the latency trade at 100k+ vectors before raising further).
    await d.exec(`set hnsw.ef_search = ${Number(process.env.FUNES_EF_SEARCH ?? 200) || 200};`).catch?.(() => {});
    await d.exec(`
      create table if not exists meta(key text primary key, value text);
      create table if not exists nodes(
        id text primary key, path text, title text, type text, body text,
        content_hash text, embedding_signature text,
        search_vector tsvector, embedding vector(${this.embedder.dim}));
      create index if not exists nodes_fts on nodes using gin(search_vector);
      create index if not exists nodes_vec on nodes using hnsw (embedding vector_cosine_ops);
      create table if not exists edges(source text, type text, target text, weight real default 1.0);
      create index if not exists edges_source on edges(source);
      create index if not exists edges_target on edges(target);
      create table if not exists chunks(
        page_id text not null, ord int not null, embedding vector(${this.embedder.dim}),
        primary key(page_id, ord));
      create index if not exists chunks_vec on chunks using hnsw (embedding vector_cosine_ops);
    `);
    // H1 chunking (multi-row): `chunks` is the vector-recall surface — every page embeds as
    // 1+ overlapping windows so a needle phrase mid-file is findable. `nodes.embedding` stays
    // as the HEAD-chunk embedding: cheap page-level compat for neighbors() (head-vs-head kNN);
    // for pages under CHUNK_SIZE it is byte-identical to the old whole-text embedding.
    // R8: recall telemetry table — created ONLY when tracking is opted in. Lives in the
    // derived .funes/ store, so the sanctioned crash-recovery (delete .funes + reindex)
    // wipes the counters (documented as lossy in SCHEMA.md).
    if (this.trackRecalls) {
      await d.exec(`
        create table if not exists recall_stats(
          memory_id text primary key, hit_count int not null default 0, last_recalled timestamptz);
      `);
    }
    // H4 (S3): trust column. Existing indexes gain it with default 'untrusted'; a reindex
    // re-derives real values from canonical frontmatter/zones (remember() trust-syncs even
    // hash-skipped rows, so the backfill costs a read pass, not a re-embed).
    await d.exec("alter table nodes add column if not exists trust text not null default 'untrusted';");
    // Rev 7 freshness (a): volatile + freshness columns, derived from frontmatter (`volatile:`,
    // `as_of:` else `updated:`) at index time. Trust-sync pattern: metadata-only, populated for
    // changed AND unchanged rows on every remember() pass, no re-embed.
    await d.exec("alter table nodes add column if not exists volatile boolean not null default false;");
    await d.exec("alter table nodes add column if not exists freshness timestamptz;");
    // H1 (GBrain): embedding drift guard. A *different* stored signature is a hard stop; absent is
    // grandfathered (first write stamps it). dim changes are destructive — refuse, don't auto-rebuild.
    const r = await d.query<{ value: string }>("select value from meta where key = 'embedding_signature'");
    const stored = r.rows[0]?.value;
    if (stored && stored !== this.sig) {
      throw new Error(
        `funes: embedding drift — index built with "${stored}" but embedder is "${this.sig}". ` +
        `Delete the index (its .funes dir) and reindex.`,
      );
    }
    if (!stored) {
      await d.query(
        "insert into meta(key,value) values ('embedding_signature',$1) on conflict (key) do update set value=$1",
        [this.sig],
      );
    }
    // H2 dirty-marker epoch: an interrupted FULL reindex leaves this set; refuse normal opens
    // so a partial live index is never silently served. `funes reindex` opens with allowDirty.
    const dirty = await d.query<{ value: string }>("select value from meta where key = 'reindex_dirty'");
    if (dirty.rows[0]?.value === "1" && !allowDirty) {
      throw new Error("funes: index is dirty (an earlier full reindex was interrupted) — run `funes reindex` to rebuild before querying.");
    }
    // OKF-aligned enrichment (2026-07): description folds into search_vector (boosts recall); resource
    // points at the described asset. Metadata-only (excluded from the content hash), synced on every
    // remember() pass like trust/volatile. Runs AFTER the signature + dirty guards so a rejected or
    // dirty open never gets a schema mutation (mirrors funes-libsql's documented ordering — the
    // pre-existing trust/volatile/freshness ALTERs above predate that invariant, Codex-noted).
    await d.exec("alter table nodes add column if not exists description text;");
    await d.exec("alter table nodes add column if not exists resource text;");
    // provenance-v1 (schema-v3, 2026-07-22): DECLARED source/authored + STAMPED write_actor.
    // Idempotent adds (same posture as description/resource); existing rows null / 'unknown'.
    await d.exec("alter table nodes add column if not exists source text;");
    await d.exec("alter table nodes add column if not exists authored timestamptz;");
    await d.exec("alter table nodes add column if not exists write_actor text not null default 'unknown';");
    // N1/N3 (graph research, 2026-07-13): edges gain a target index (schema block above — inbound
    // lookups were full scans) and a UNIQUENESS invariant on (source,type,target). Existing
    // indexes may carry duplicates (extraction only deduped derived-vs-explicit, never the
    // explicit list itself) — dedup FIRST, then the unique index; both idempotent, and like the
    // enrichment ALTERs this runs after the signature + dirty guards. Uniqueness is on the RAW
    // type string (storage is authored-spelling; normalization is comparison-only — N4).
    await d.exec("delete from edges a using edges b where a.ctid < b.ctid and a.source = b.source and a.type = b.type and a.target = b.target;");
    await d.exec("create unique index if not exists edges_uniq on edges(source, type, target);");
  }

  /** H2: mark a full rebuild in progress (cleared by endReindex after the prune commits). */
  async beginReindex(): Promise<void> {
    const res = this.lockResource;
    if (res) this.reindexLock = await acquireWriteLock(res); // held until endReindex (or close-belt)
    await this.db.query("insert into meta(key,value) values ('reindex_dirty','1') on conflict (key) do update set value='1'");
  }

  async endReindex(): Promise<void> {
    // Freshness honesty (stack review B-4): stamp the completed full rebuild (see libsql mirror).
    await this.db.query("insert into meta(key,value) values ('last_reindex_at',$1) on conflict (key) do update set value=$1", [new Date().toISOString()]);
    await this.db.query("delete from meta where key = 'reindex_dirty'");
    this.reindexLock?.release();
    this.reindexLock = undefined;
  }

  async remember(items: MemoryItem[]): Promise<RememberResult> {
    if (items.length === 0) return { indexed: 0, skipped: 0 };
    return this.locked(() => this.rememberUnlocked(items));
  }
  private async rememberUnlocked(items: MemoryItem[]): Promise<RememberResult> {
    const d = this.db;

    // incremental: skip items whose content hash already matches (no re-embed)
    const existing = new Map<string, string>();
    const r = await d.query<{ id: string; content_hash: string | null }>(
      "select id, content_hash from nodes where id = any($1::text[])", [items.map((i) => i.id)]);
    for (const row of r.rows) existing.set(row.id, row.content_hash ?? "");
    const changed = items.filter((it) => existing.get(it.id) !== hashItem(it));
    const unchanged = items.filter((it) => existing.has(it.id) && existing.get(it.id) === hashItem(it));
    // H4 trust-sync (+ Rev 7 freshness-sync): content hash excludes trust/volatile/freshness,
    // so a frontmatter flip on any of them must update skipped rows too — one batched
    // statement, no re-embed.
    if (unchanged.length) {
      await d.query(
        `update nodes set trust = u.trust, volatile = u.volatile, freshness = u.freshness::timestamptz,
                description = u.description, resource = u.resource,
                source = u.source, authored = u.authored::timestamptz,
                -- see funes-libsql store.ts: 'unknown' (the reindex default) never overwrites a real actor
                write_actor = coalesce(nullif(u.write_actor::text,'unknown'), nodes.write_actor),
                search_vector = setweight(to_tsvector('simple', coalesce(nodes.title,'')), 'A')
                             || setweight(to_tsvector('simple', left(coalesce(u.description,'') || ' ' || nodes.body, ${FTS_MAX_CHARS})), 'D')
           from (select unnest($1::text[]) as id, unnest($2::text[]) as trust,
                        unnest($3::boolean[]) as volatile, unnest($4::text[]) as freshness,
                        unnest($5::text[]) as description, unnest($6::text[]) as resource,
                        unnest($7::text[]) as source, unnest($8::text[]) as authored, unnest($9::text[]) as write_actor) u
          where nodes.id = u.id and (nodes.trust is distinct from u.trust
             or nodes.volatile is distinct from u.volatile
             or nodes.freshness is distinct from u.freshness::timestamptz
             or nodes.description is distinct from u.description
             or nodes.resource is distinct from u.resource
             or nodes.source is distinct from u.source
             or nodes.authored is distinct from u.authored::timestamptz
             or nodes.write_actor is distinct from coalesce(nullif(u.write_actor::text,'unknown'), nodes.write_actor))`,
        [unchanged.map((it) => it.id), unchanged.map((it) => it.trust ?? "untrusted"),
          unchanged.map(isVolatile), unchanged.map(freshnessIso),
          unchanged.map((it) => it.description ?? null), unchanged.map((it) => it.resource ?? null),
          unchanged.map((it) => it.source ?? null), unchanged.map(authoredIso), unchanged.map(() => this.writeActor)]);
    }
    if (changed.length === 0) return { indexed: 0, skipped: items.length };

    // H1: chunk every changed page, then embed ALL chunks of the whole batch in ONE
    // embedPassages call (one onnxruntime forward — the reindex throughput path).
    const chunkLists = changed.map((it) => chunkText(`${it.title}\n${it.body}`));
    const embs = await this.embedder.embedPassages(chunkLists.flat());
    // C2: one transaction per batch — content_hash, FTS, vector, chunks, and edges commit
    // together or not at all. (Pre-S0 the hash committed before edges; a crash left missing
    // edges that the hash-skip then bypassed forever.)
    await this.db.transaction(async (tx) => {
      let off = 0; // index of this item's first chunk embedding in the flat batch
      for (let i = 0; i < changed.length; i++) {
        const it = changed[i]!;
        const nChunks = chunkLists[i]!.length;
        await tx.query(
          `insert into nodes(id,path,title,type,body,content_hash,embedding_signature,trust,volatile,freshness,description,resource,source,authored,write_actor,search_vector,embedding)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz, $11, $12, $15, $16::timestamptz, $17,
                   setweight(to_tsvector('simple',$3), 'A') || setweight(to_tsvector('simple',$13), 'D'), $14::vector)
           on conflict (id) do update set
             path=$2, title=$3, type=$4, body=$5, content_hash=$6, embedding_signature=$7, trust=$8,
             volatile=$9, freshness=$10::timestamptz, description=$11, resource=$12,
             source=$15, authored=$16::timestamptz,
             write_actor=coalesce(nullif($17::text,'unknown'), nodes.write_actor),
             search_vector=setweight(to_tsvector('simple',$3), 'A') || setweight(to_tsvector('simple',$13), 'D'), embedding=$14::vector`,
          [it.id, it.path ?? null, it.title, it.type ?? null, it.body, hashItem(it), this.sig,
            it.trust ?? "untrusted", isVolatile(it), freshnessIso(it),
            it.description ?? null, it.resource ?? null,
            // FTS D-leg = description+body only; the title rides $3 with weight A (the 2026-07-13
            // FTS-leg bench: ts_rank without title weighting buries short curated pages — p@5
            // 0.70 vs 1.00 — setweight(A-title) alone restored leg parity with FTS5-BM25).
            `${it.description ?? ""} ${it.body}`.slice(0, FTS_MAX_CHARS), vecLiteral(embs[off]!),
            it.source ?? null, authoredIso(it), this.writeActor]);
        // replace the page's chunk rows wholesale — an update can shrink the chunk count, and
        // delete-all-first guarantees no orphan ords survive
        await tx.query("delete from chunks where page_id = $1", [it.id]);
        for (let c = 0; c < nChunks; c++)
          await tx.query("insert into chunks(page_id,ord,embedding) values ($1,$2,$3::vector)",
            [it.id, c, vecLiteral(embs[off + c]!)]);
        off += nChunks;
        await tx.query("delete from edges where source = $1", [it.id]);
        for (const e of it.edges ?? [])
          // on conflict do nothing: the edges_uniq index (N3) is the last line of defense —
          // extraction dedupes, but a raw remember() caller could still pass duplicates.
          await tx.query("insert into edges(source,type,target,weight) values ($1,$2,$3,$4) on conflict do nothing",
            [it.id, e.type, e.target, e.weight ?? 1.0]);
      }
    });
    return { indexed: changed.length, skipped: items.length - changed.length };
  }

  /** Remove items from the derived index (nodes drop their FTS/vec columns with the row; + chunks + edges). */
  async remove(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return this.locked(async () => {
      const d = this.db;
      const r = await d.query("delete from nodes where id = any($1::text[])", [ids]);
      await d.query("delete from chunks where page_id = any($1::text[])", [ids]);
      await d.query("delete from edges where source = any($1::text[])", [ids]);
      return r.affectedRows ?? 0;
    });
  }

  /** H2 (GBrain): a full reindex prunes index rows whose file is gone or tombstoned — keep only
   *  `keepIds`. This is what makes deleted/forgotten/superseded items leave the index on reindex. */
  async prune(keepIds: string[]): Promise<number> {
    return this.locked(async () => {
      let removed = 0;
      await this.db.transaction(async (tx) => {
        const r = await tx.query("delete from nodes where not (id = any($1::text[]))", [keepIds]);
        await tx.query("delete from chunks where not (page_id = any($1::text[]))", [keepIds]);
        await tx.query("delete from edges where not (source = any($1::text[]))", [keepIds]);
        removed = r.affectedRows ?? 0;
      });
      return removed;
    });
  }

  /** E1 Rev 2 (spec 2026-07-14): SQL row normalization for the v2 graph arm — mirrors
   *  funes-libsql.graphArmV2 exactly (distinct pairs, nodes-join existence filter, row_number
   *  per-seed caps, hub-ineligible seeds filtered before the IN query); ALL scoring lives in
   *  funes-core buildGraphArm (grill M9 — parity by construction). */
  private async graphArmV2(seeds: string[], fts: string[], vec: string[], limit: number, inbound: boolean): Promise<string[]> {
    if (!seeds.length) return [];
    const d = this.db;
    const seedBestRank = new Map<string, number>();
    for (const [i, id] of fts.entries()) if (!seedBestRank.has(id) || i < seedBestRank.get(id)!) seedBestRank.set(id, i);
    for (const [i, id] of vec.entries()) if (!seedBestRank.has(id) || i < seedBestRank.get(id)!) seedBestRank.set(id, i);
    const rows: GraphNeighborRow[] = [];
    for (const r of (await d.query<{ seed: string; cand: string }>(
      `with pairs as (select distinct e.source as seed, e.target as cand from edges e join nodes nn on nn.id = e.target where e.source = any($1::text[])),
            ranked as (select seed, cand, row_number() over (partition by seed order by cand) rn from pairs)
       select seed, cand from ranked where rn <= ${GRAPH_ARM_CAP_OUT} order by seed, cand`, [seeds])).rows) {
      rows.push({ seed: r.seed, candidate: r.cand, dir: "out" });
    }
    const seedInDegree = new Map<string, number>();
    const contribOutDegree = new Map<string, number>();
    if (inbound) {
      for (const r of (await d.query<{ seed: string; n: number }>(
        "select target as seed, count(distinct source)::int as n from edges where target = any($1::text[]) group by target", [seeds])).rows) {
        seedInDegree.set(r.seed, Number(r.n));
      }
      const eligible = seeds.filter((s) => (seedInDegree.get(s) ?? 0) <= GRAPH_ARM_HUB_MAX && (seedInDegree.get(s) ?? 0) > 0);
      if (eligible.length) {
        const inRows = (await d.query<{ seed: string; cand: string }>(
          `with pairs as (select distinct e.target as seed, e.source as cand from edges e join nodes nn on nn.id = e.source where e.target = any($1::text[])),
                ranked as (select seed, cand, row_number() over (partition by seed order by cand) rn from pairs)
           select seed, cand from ranked where rn <= ${GRAPH_ARM_CAP_IN} order by seed, cand`, [eligible])).rows;
        const contribs = [...new Set(inRows.map((r) => r.cand))];
        if (contribs.length) {
          for (const r of (await d.query<{ source: string; n: number }>(
            "select source, count(distinct target)::int as n from edges where source = any($1::text[]) group by source", [contribs])).rows) {
            contribOutDegree.set(r.source, Number(r.n));
          }
        }
        for (const r of inRows) rows.push({ seed: r.seed, candidate: r.cand, dir: "in" });
      }
    }
    return buildGraphArm({ seeds, seedBestRank, rows, seedInDegree, contribOutDegree, inbound, graphListMax: 4 * limit });
  }

  async recall(q: RecallQuery): Promise<RecallResult[]> {
    const limit = q.k ?? 5;
    const n = Math.max(limit * 4, 20);
    const d = this.db;
    // E1 Rev 2: bounded graph arm. DEFAULT_GRAPH_ARM="v2" adopted P2.11; see funes-libsql mirror.
    const graphArm = resolveGraphArm(process.env.FUNES_GRAPH_ARM);
    const v2 = graphArm !== "legacy";

    // OR-of-terms tsquery (matches A1's lenient FTS recall; RRF + edge-walk handle precision).
    // v2: `, id` secondary key makes exact-rank ties deterministic (grill H2); legacy untouched.
    const tsq = (q.query.match(WORD) ?? []).filter((t) => t.length >= 2).join(" | ");
    const fts = tsq
      ? (await d.query<{ id: string }>(
          `select id from nodes where search_vector @@ to_tsquery('simple',$1)
           order by ts_rank(search_vector, to_tsquery('simple',$1)) desc${v2 ? ", id" : ""} limit $2`, [tsq, n])).rows.map((r) => r.id)
      : [];

    // H1: kNN over CHUNKS (limit n*3 — multi-chunk pages may occupy several slots), then map
    // to pages keeping each page's BEST (min-distance) chunk: rows arrive distance-ascending,
    // so the first occurrence of a page_id IS its best chunk. Dedupe, cut at n — this ranked
    // page list feeds RRF exactly where the old nodes-level vector list did.
    const qv = await this.embedder.embedQuery(q.query);
    const vecR = await d.query<{ page_id: string }>(
      `select page_id from chunks where embedding is not null order by embedding <=> $1::vector${v2 ? ", page_id, ord" : ""} limit $2`,
      [vecLiteral(qv), n * 3]);
    const vec: string[] = [];
    const seenPages = new Set<string>();
    for (const row of vecR.rows) {
      if (seenPages.has(row.page_id)) continue;
      seenPages.add(row.page_id);
      vec.push(row.page_id);
      if (vec.length >= n) break;
    }

    // edge-walk from the top FTS+vec seeds (A1 `_edge_hits`) — one batched query (I2),
    // regrouped per seed to preserve the per-seed visit order of the old N+1 loop (legacy);
    // v2 delegates to graphArmV2 + funes-core buildGraphArm.
    const seeds = [...new Set([...fts.slice(0, limit), ...vec.slice(0, limit)])];
    let edges: string[];
    if (v2) {
      edges = await this.graphArmV2(seeds, fts, vec, limit, graphArm === "v2in");
    } else {
      const bySource = new Map<string, string[]>();
      if (seeds.length) {
        const er = await d.query<{ source: string; target: string }>(
          "select source, target from edges where source = any($1::text[])", [seeds]);
        for (const row of er.rows) {
          if (!row.target) continue;
          const list = bySource.get(row.source) ?? [];
          list.push(row.target);
          bySource.set(row.source, list);
        }
      }
      const edgeHits: string[] = [];
      for (const s of seeds) edgeHits.push(...(bySource.get(s) ?? []));
      edges = [...new Set(edgeHits)];
    }

    // DEFAULT_RRF_K (P2.10b) — both backends fuse at the same k; undefined rides the default,
    // the slot is filled only to reach opts.
    const scores = rrfScores([fts, vec, edges]);
    const merged = rrf([fts, vec, edges], undefined, { tieBreakIds: v2 });

    // S4: rerank is an optional top stage over RRF output — it widens the candidate cut to
    // k*4, reorders, then slices back to k. Parity is asserted on the RRF path (rerank off).
    const useRerank = !!q.rerank && !!this.reranker;
    const cap = useRerank ? Math.min(merged.length, limit * 4) : limit;

    // I2: existence-filter BEFORE slicing — dangling edge targets must not starve results
    // below k. One batched row fetch for all merged ids, then keep RRF order and cut at limit.
    const rowsR = await d.query<{ id: string; title: string; path: string | null; trust: string;
      volatile: boolean; fresh: number | null; description: string | null; resource: string | null;
      source: string | null; authored: string | null; write_actor: string | null }>(
      `select id,title,path,trust,volatile, extract(epoch from freshness)::float8 as fresh, description, resource,
              source, to_char(authored, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as authored, write_actor
         from nodes where id = any($1::text[])`, [merged]);
    const byId = new Map(rowsR.rows.map((r) => [r.id, r]));
    const all: RecallResult[] = [];
    for (const id of merged) {
      const row = byId.get(id);
      if (!row) continue; // dangling (e.g. unresolved edge target) — skip, don't consume a slot
      all.push({ id: row.id, title: row.title, path: row.path ?? undefined, score: scores.get(id) ?? 0,
        trust: row.trust as RecallResult["trust"], description: row.description ?? undefined, resource: row.resource ?? undefined,
        source: row.source ?? undefined, authored: row.authored ?? undefined, writeActor: row.write_actor ?? undefined,
        volatile: row.volatile ? true : undefined,
        freshness: row.fresh != null ? new Date(row.fresh * 1000).toISOString().slice(0, 10) : undefined });
    }

    // ── Move 5 ranking composition (the full, documented order): ─────────────────────────────
    //   RRF (above) -> trust-weight -> zone-weight -> entity-boost -> dup-collapse -> recency-tiebreak -> (optional) rerank.
    // The emitted `score` stays the raw RRF score (parity contract); `adj` (= rrf * trust * zone
    // * entity weight, ONE composed multiplicative key) is the ORDERING key only — it both sorts
    // the list and feeds the recency tiebreak's run-cutting, so ties are resolved AFTER trust +
    // curation-zone + entity-match have had their say. (Comment fixed 2026-07-13 — it predated
    // the entity boost and omitted it; grill #11.)
    const adj = new Map(all.map((r) => [r.id, entityAdjust(zoneAdjust(trustAdjust(r.score, r.trust), r.path ?? `${r.id}.md`), q.query, r.title, r.id)]));

    // (1) trust-weight: stable sort by adjusted score desc. JS Array.prototype.sort is stable, so
    //     a cross-trust tie that the multiplier does NOT separate keeps its deterministic RRF
    //     (merge insertion) order — trust is a thumb, never a reshuffle of equal-trust results.
    const weighted = [...all].sort((a, b) => adj.get(b.id)! - adj.get(a.id)!);

    // (2) dup-collapse: fold near-identical (same title OR ~equal adjusted score, same trust+zone)
    //     down to their best slot; the freed slots let later DISTINCT candidates backfill into the
    //     top-k automatically (the pool is the full merged candidate list, not a pre-sliced k).
    const collapsed = collapseDuplicates(weighted, (r) => adj.get(r.id)!);

    // (3) recency-tiebreak over the trust-ADJUSTED score (HEAD-anchored run-cutting; volatile tie
    //     runs reorder by freshness desc, nulls last; non-volatile runs keep order). Applied
    //     BEFORE the cap cut so a tie run spanning the boundary still resolves the slot.
    const ordered = recencyTiebreak(
      collapsed.map((r) => ({ r, score: adj.get(r.id)! })),
      (x) => byId.get(x.r.id),
    ).map((x) => x.r);
    const out = ordered.slice(0, cap);
    if (!useRerank || out.length <= 1) return this.recordRecalls(out.slice(0, limit));

    // ONE batched body fetch for the rerank candidates; results keep their RRF score + trust
    // fields — only the ORDER changes (scores stay RRF, by design).
    const bodiesR = await d.query<{ id: string; body: string | null }>(
      "select id, body from nodes where id = any($1::text[])", [out.map((r) => r.id)]);
    const bodyById = new Map(bodiesR.rows.map((r) => [r.id, r.body ?? ""]));
    const order = await this.reranker!.rerank(
      q.query,
      out.map((r) => ({ id: r.id, text: `${r.title}\n${bodyById.get(r.id) ?? ""}` })),
    );
    const resById = new Map(out.map((r) => [r.id, r]));
    const reranked: RecallResult[] = [];
    for (const id of order) {
      const r = resById.get(id);
      if (r) { reranked.push(r); resById.delete(id); }
    }
    for (const r of out) if (resById.has(r.id)) reranked.push(r); // ids a reranker dropped keep RRF order at the tail
    return this.recordRecalls(reranked.slice(0, limit));
  }

  /** R8: record the FINAL recall results into recall_stats (+1, now()) — called strictly
   *  AFTER ranking/rerank/slicing, so the counters can never influence what recall returns.
   *  No-op (zero table reads or writes) unless the store was created with trackRecalls. */
  /** Mirrors funes-libsql: both return paths funnel here, so rank is stamped once, last. */
  private async recordRecalls(results: RecallResult[]): Promise<RecallResult[]> {
    results.forEach((r, i) => { r.rank = i + 1; });
    if (this.trackRecalls && results.length) {
      await this.db.query(
        `insert into recall_stats(memory_id, hit_count, last_recalled)
         select unnest($1::text[]), 1, now()
         on conflict (memory_id) do update
           set hit_count = recall_stats.hit_count + 1, last_recalled = now()`,
        [results.map((r) => r.id)]);
    }
    return results;
  }

  /** R8: top-N most-recalled pages joined to nodes — TRUSTED rows only (trust labels are
   *  live since H4; counters on untrusted rows are pump-able and never surface). Read-only:
   *  works whether or not THIS handle tracks (the table may have been written by a tracked
   *  daemon); returns [] when telemetry was never enabled (no recall_stats table). */
  async hotlist(n = 20): Promise<HotlistRow[]> {
    const reg = await this.db.query<{ reg: string | null }>(
      "select to_regclass('recall_stats')::text as reg");
    if (!reg.rows[0]?.reg) return [];
    const r = await this.db.query<{
      id: string; title: string; path: string | null; trust: string;
      hit_count: number; last_recalled: string | null;
    }>(
      `select n.id, n.title, n.path, n.trust, s.hit_count, s.last_recalled::text as last_recalled
         from recall_stats s join nodes n on n.id = s.memory_id
        where n.trust = 'trusted'
        order by s.hit_count desc, s.last_recalled desc nulls last, n.id asc
        limit $1`, [n]);
    return r.rows.map((row) => ({
      id: row.id, title: row.title, path: row.path ?? undefined, trust: row.trust,
      hit_count: Number(row.hit_count), last_recalled: row.last_recalled,
    }));
  }

  /** Semantic + typed neighborhood of one node — the graph-explorer data source (S5-UI).
   *  k-NN by pgvector cosine over the live index + frontmatter edges in both directions.
   *  H1 note: similarity stays HEAD-chunk vs HEAD-chunk (`nodes.embedding`) — the simplest
   *  correct page-level notion ("pages whose openings are about the same thing"); for pages
   *  under CHUNK_SIZE this is exactly the pre-chunking behavior. Needle-level discovery is
   *  recall()'s job, not the neighborhood view's. */
  async neighbors(id: string, k = 8): Promise<{
    node: { id: string; title: string; path?: string; trust?: string; type?: string } | null;
    similar: Array<{ id: string; title: string; path?: string; trust?: string; score: number }>;
    edgesOut: Array<{ type: string; id: string; title: string | null; trust?: string }>;
    edgesIn: Array<{ type: string; id: string; title: string | null; trust?: string }>;
  }> {
    const d = this.db;
    const self = (await d.query<{ id: string; title: string; path: string | null; trust: string; type: string | null }>(
      "select id,title,path,trust,type from nodes where id = $1", [id])).rows[0];
    if (!self) return { node: null, similar: [], edgesOut: [], edgesIn: [] };
    const knn = await d.query<{ id: string; title: string; path: string | null; trust: string; dist: number }>(
      `select id,title,path,trust, (embedding <=> (select embedding from nodes where id = $1)) as dist
         from nodes where id <> $1 and embedding is not null
        order by dist asc limit $2`, [id, k]);
    const eo = await d.query<{ type: string; target: string; title: string | null; trust: string | null }>(
      `select e.type, e.target, n.title, n.trust from edges e left join nodes n on n.id = e.target
        where e.source = $1`, [id]);
    const ei = await d.query<{ type: string; source: string; title: string | null; trust: string | null }>(
      `select e.type, e.source, n.title, n.trust from edges e left join nodes n on n.id = e.source
        where e.target = $1`, [id]);
    return {
      node: { id: self.id, title: self.title, path: self.path ?? undefined, trust: self.trust, type: self.type ?? undefined },
      similar: knn.rows.map((r) => ({
        id: r.id, title: r.title, path: r.path ?? undefined, trust: r.trust,
        score: Math.round((1 - r.dist) * 1000) / 1000, // cosine similarity, 3dp
      })),
      edgesOut: eo.rows.map((r) => ({ type: r.type, id: r.target, title: r.title, trust: r.trust ?? undefined })),
      edgesIn: ei.rows.map((r) => ({ type: r.type, id: r.source, title: r.title, trust: r.trust ?? undefined })),
    };
  }

  /** Cross-star (--ops) read: one page's INDEXED snapshot, from the `nodes` row ONLY — never a
   *  filesystem read (Bun.file/readFileSync are deliberately not called here), so index_scope is the
   *  capability boundary with no TOCTOU. Matches by node id OR the stored `path` (with or without
   *  the `.md` suffix). null when the id/path is not in the index. */
  async indexedPage(ref: { id?: string; path?: string }): Promise<IndexedPage | null> {
    const keys: string[] = [];
    if (ref.id) keys.push(ref.id);
    if (ref.path) { keys.push(ref.path); keys.push(ref.path.replace(/\.md$/, "")); }
    if (!keys.length) return null;
    const r = await this.db.query<{
      id: string; path: string | null; title: string; type: string | null;
      trust: string; description: string | null; resource: string | null;
      source: string | null; authored: string | null; write_actor: string | null; body: string;
    }>(
      `select id, path, title, type, trust, description, resource,
              source, to_char(authored, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as authored, write_actor, body
         from nodes where id = any($1::text[]) or path = any($1::text[]) limit 1`, [keys]);
    const row = r.rows[0];
    return row
      ? { id: row.id, path: row.path, title: row.title, type: row.type, trust: row.trust,
          description: row.description, resource: row.resource,
          source: row.source, authored: row.authored, writeActor: row.write_actor ?? "unknown", body: row.body }
      : null;
  }

  /** P1 graph-viz BAKE — the global-constellation artifact for the Sigma renderer.
   *  Reads all nodes + typed frontmatter edges, runs forceAtlas2 (x/y) + seeded Louvain
   *  (community) + degree over a simple undirected graph, and returns {nodes, edges} ready to
   *  render (the browser only draws — no force iteration in the tab). Cached beside pgdata as
   *  graph.json, keyed on a content fingerprint, so it rebuilds ONLY when the graph changes; an
   *  in-memory store (no dataDir) computes fresh every call. Similarity edges ARE baked here —
   *  a THRESHOLDED set (top-k pgvector neighbours per node above a cosine cutoff, NOT the full
   *  5.5k k-NN hairball) — so the wikilink-less islands join the constellation; they render faint
   *  dashed (family "similarity") and feed layout/communities, but NOT the god-node degree. */
  async graph(opts: { iterations?: number; simTopK?: number; simCutoff?: number } = {}): Promise<GraphArtifact> {
    const d = this.db;
    const simTopK = opts.simTopK ?? 6;       // neighbours per node before the cutoff filter
    const simCutoff = opts.simCutoff ?? 0.8; // cosine floor (E5-small: ~0.8 separates related from noise)
    // fingerprint: hashItem (content_hash) already folds title+body+edges, so an md5 over the
    // sorted content_hashes (+ count + embedding sig + sim params) flips on ANY graph-affecting change.
    const fp = (await d.query<{ fp: string | null; n: string }>(
      "select md5(coalesce(string_agg(content_hash, ',' order by id),'')) as fp, count(*)::text as n from nodes")).rows[0];
    const signature = `${this.sig}:${fp?.n ?? 0}:${fp?.fp ?? ""}:sim${simTopK}@${simCutoff}`;
    const artifactPath = this.dataDir ? join(dirname(this.dataDir), "graph.json") : undefined;
    if (artifactPath && existsSync(artifactPath)) {
      try {
        const cached = JSON.parse(readFileSync(artifactPath, "utf8")) as GraphArtifact;
        if (cached.signature === signature) return cached; // fresh — render the cached layout
      } catch { /* corrupt cache -> rebuild */ }
    }

    const nodeRows = (await d.query<{ id: string; title: string; path: string | null; type: string | null; trust: string }>(
      "select id, title, path, type, trust from nodes")).rows;
    const edgeRows = (await d.query<{ source: string; type: string; target: string; weight: number }>(
      "select source, type, target, weight from edges")).rows;
    const hits = new Map<string, number>();
    if ((await d.query<{ reg: string | null }>("select to_regclass('recall_stats')::text as reg")).rows[0]?.reg) {
      for (const r of (await d.query<{ memory_id: string; hit_count: number }>("select memory_id, hit_count from recall_stats")).rows)
        hits.set(r.memory_id, Number(r.hit_count));
    }

    // simple undirected graph for layout/community/degree (typed+parallel edges collapse here);
    // the artifact carries the FULL typed edge list separately for rendering.
    const g = new Graph({ type: "undirected" });
    for (const n of nodeRows) g.addNode(n.id);
    const typedEdges: GraphEdge[] = [];
    for (const e of edgeRows) {
      if (!g.hasNode(e.source) || !g.hasNode(e.target)) continue; // skip dangling (unresolved) targets
      if (!g.hasEdge(e.source, e.target)) g.addEdge(e.source, e.target, { weight: e.weight ?? 1 });
      typedEdges.push({ source: e.source, target: e.target, type: e.type, family: familyOf(e.type), weight: e.weight ?? 1 });
    }
    // god-node degree = TYPED simple-graph degree, captured BEFORE similarity edges join g (so
    // every node gaining ~simTopK similarity edges doesn't wash the hub signal flat).
    const typedDeg = new Map<string, number>();
    g.forEachNode((id) => typedDeg.set(id, g.degree(id)));

    // P1: thresholded similarity edges. ONE lateral query — per node, its top-simTopK pgvector
    // neighbours (HNSW index scan, the outer row's embedding is the probe), kept above simCutoff.
    // De-duped undirected; skipped where a typed edge already connects the pair (no double draw).
    // Added to g so the islands get a layout home + a community; emitted with family "similarity".
    const simEdges: GraphEdge[] = [];
    if (simTopK > 0 && g.order > 1) {
      const simRows = (await d.query<{ source: string; target: string; sim: number }>(
        `select source, target, sim from (
           select a.id as source, b.id as target, 1 - (a.embedding <=> b.embedding) as sim
             from nodes a
             join lateral (
               select n.id, n.embedding from nodes n
               where n.id <> a.id and n.embedding is not null
               order by a.embedding <=> n.embedding limit $1
             ) b on true
            where a.embedding is not null
         ) t where sim >= $2`, [simTopK, simCutoff])).rows;
      const seenSim = new Set<string>();
      for (const r of simRows) {
        if (!g.hasNode(r.source) || !g.hasNode(r.target)) continue;
        const key = r.source < r.target ? `${r.source}\x00${r.target}` : `${r.target}\x00${r.source}`;
        if (seenSim.has(key)) continue;
        seenSim.add(key);
        if (g.hasEdge(r.source, r.target)) continue; // already a typed edge between them
        g.addEdge(r.source, r.target, { weight: r.sim });
        simEdges.push({ source: r.source, target: r.target, type: "similar-to", family: "similarity", weight: Math.round(r.sim * 1000) / 1000 });
      }
    }
    if (g.order > 0) {
      circular.assign(g); // deterministic seed positions; forceAtlas2 reads them
      if (g.size > 0) {
        // Barnes-Hut keeps repulsion O(n log n) — without it forceAtlas2 is O(n²) (~2min at 3.6k
        // nodes). Fewer iterations on big graphs; the bake is cached so this runs only on change.
        forceAtlas2.assign(g, {
          iterations: opts.iterations ?? (g.order > 2000 ? 150 : 300),
          settings: { ...forceAtlas2.inferSettings(g), barnesHutOptimize: g.order > 500 },
        });
        louvain.assign(g, { rng: seededRng(42) } as Parameters<typeof louvain.assign>[1]);
      }
    }
    // community -> stable rank by size (largest = 0) so the renderer's palette never reshuffles.
    const commSize = new Map<number, number>();
    g.forEachNode((_id, a) => { const c = (a.community as number) ?? 0; commSize.set(c, (commSize.get(c) ?? 0) + 1); });
    const rank = new Map([...commSize.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([c], i) => [c, i] as const));

    const nodes: GraphNode[] = nodeRows.map((n) => {
      const a = g.getNodeAttributes(n.id);
      return {
        id: n.id, label: (n.title || n.id).slice(0, 48),
        x: typeof a.x === "number" ? a.x : 0, y: typeof a.y === "number" ? a.y : 0,
        community: rank.get((a.community as number) ?? 0) ?? 0,
        degree: typedDeg.get(n.id) ?? 0,
        zone: zoneOfFile(n.path ?? `${n.id}.md`),
        type: n.type ?? null, trust: n.trust, hit_count: hits.get(n.id) ?? 0,
      };
    });
    const artifact: GraphArtifact = {
      signature, builtAt: new Date().toISOString(),
      stats: { nodes: nodes.length, edges: typedEdges.length, simEdges: simEdges.length, communities: rank.size },
      nodes, edges: [...typedEdges, ...simEdges],
    };
    if (artifactPath) { try { writeFileSync(artifactPath, JSON.stringify(artifact)); } catch { /* read-only fs -> serve uncached */ } }
    return artifact;
  }

  /** Read-only health snapshot for the S2 daemon/console (no mutation). Carries the index_scope
   *  signature so the cross-star (--ops) serve-time guard can read it over the daemon-proxy path. */
  async stats(): Promise<{ nodes: number; edges: number; embeddingSignature: string | null; reindexDirty: boolean; lastReindexAt: string | null; scopeHash: string | null; ignoreScope: boolean; generation: string | null }> {
    const d = this.db;
    const n = await d.query<{ c: string }>("select count(*)::text as c from nodes");
    const e = await d.query<{ c: string }>("select count(*)::text as c from edges");
    const sig = await d.query<{ value: string }>("select value from meta where key = 'embedding_signature'");
    const dirty = await d.query<{ value: string }>("select value from meta where key = 'reindex_dirty'");
    const last = await d.query<{ value: string }>("select value from meta where key = 'last_reindex_at'");
    const scope = await this.getScopeSignature();
    return {
      nodes: Number(n.rows[0]?.c ?? 0),
      edges: Number(e.rows[0]?.c ?? 0),
      embeddingSignature: sig.rows[0]?.value ?? null,
      reindexDirty: dirty.rows[0]?.value === "1",
      lastReindexAt: last.rows[0]?.value ?? null,
      scopeHash: scope?.hash ?? null,
      ignoreScope: scope?.ignoreScope ?? false,
      generation: await this.getGeneration(),
    };
  }

  /** generation-v1 (R5#1): persist the content-generation stamp of the last FULL build — meta key
   *  `generation`, advanced by reindex.ts exactly where the scope signature is (full runs only). */
  async setGeneration(generation: string): Promise<void> {
    await this.db.query("insert into meta(key,value) values ('generation',$1) on conflict (key) do update set value=$1", [generation]);
  }

  async getGeneration(): Promise<string | null> {
    const r = await this.db.query<{ value: string }>("select value from meta where key = 'generation'");
    return r.rows[0]?.value ?? null;
  }

  /** Persist the index_scope signature (closure sprint 3B) — meta keys `index_scope_hash` +
   *  `index_scope_ignored`. Called by a FULL reindex only (see reindex.ts), so the hash advances
   *  exactly with the authoritative prune; a bounded --max run never reaches here. */
  async setScopeSignature(sig: ScopeSignature): Promise<void> {
    await this.db.query("insert into meta(key,value) values ('index_scope_hash',$1) on conflict (key) do update set value=$1", [sig.hash]);
    await this.db.query("insert into meta(key,value) values ('index_scope_ignored',$1) on conflict (key) do update set value=$1", [sig.ignoreScope ? "1" : "0"]);
  }

  /** H2: invalidate the persisted signature (a full rebuild from an absent/invalid manifest). Both
   *  meta keys are cleared, so getScopeSignature returns null and cross-star reads fail closed. */
  async clearScopeSignature(): Promise<void> {
    await this.db.query("delete from meta where key = 'index_scope_hash'");
    await this.db.query("delete from meta where key = 'index_scope_ignored'");
  }

  async getScopeSignature(): Promise<ScopeSignature | null> {
    const h = await this.db.query<{ value: string }>("select value from meta where key = 'index_scope_hash'");
    const hash = h.rows[0]?.value;
    if (!hash) return null;
    const ig = await this.db.query<{ value: string }>("select value from meta where key = 'index_scope_ignored'");
    return { hash, ignoreScope: ig.rows[0]?.value === "1" };
  }

  /** H9: the {scope-signature, reindex-dirty} tuple the guard checks — read together so the guard
   *  and its re-check see one coherent view of "is this index a stamped, in-scope, not-mid-rebuild
   *  boundary right now". */
  private async scopeState(): Promise<{ scopeHash: string | null; ignoreScope: boolean; reindexDirty: boolean }> {
    const sig = await this.getScopeSignature();
    const dirty = await this.db.query<{ value: string }>("select value from meta where key = 'reindex_dirty'");
    return { scopeHash: sig?.hash ?? null, ignoreScope: sig?.ignoreScope ?? false, reindexDirty: dirty.rows[0]?.value === "1" };
  }

  /** H9: cross-star serve MUST be atomic with retrieval, not check-then-use. recall/indexedPage span
   *  many queries, so instead of one SQL snapshot this is check-retrieve-RECHECK (optimistic
   *  concurrency): read {scopeHash,ignoreScope,reindexDirty}; refuse on hash-mismatch / --ignore-scope
   *  / in-progress reindex; retrieve; re-read the same state and refuse if it moved. A reindex that
   *  re-admits excluded rows always flips reindexDirty at begin and the signature (hash/ignore/clear)
   *  at end — both windows refuse — while a same-manifest reindex re-excludes the identical rows and
   *  so never serves an excluded one. Never mtime-cached (timestamps are preservable). */
  async guardedRead<T>(expectedHash: string, retrieve: () => Promise<T>): Promise<GuardedResult<T>> {
    const r1 = guardRefusal(await this.scopeState(), expectedHash);
    if (r1) return { refusal: r1 };
    const value = await retrieve();
    const r2 = guardRefusal(await this.scopeState(), expectedHash);
    if (r2) return { refusal: r2 };
    return { ok: value };
  }

  async close(): Promise<void> {
    this.reindexLock?.release(); // belt: an aborted begin→end window must not leave the star locked
    this.reindexLock = undefined;
    await this.db.close();
  }
}
