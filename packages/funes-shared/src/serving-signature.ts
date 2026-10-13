// serving-signature-v1 — the THIRD of the three signatures (PLAN-0.3.0 item 7; Codex R2#6, R3#13,
// R4#6). The content generation names the ROWS; this names everything OUTSIDE the rows that changes
// what a query returns:
//
//   serving signature = "sv1:" + sha256(
//       "sv1" ‖ { backend, ranking semantics version, effective RRF k, effective graph arm,
//                 effective HNSW ef_search, bm25 column weights,
//                 trust/zone/distill/entity adjustment versions, reranker identity }
//   )
//
// Two indexes holding ONE content generation legitimately answer differently when their serving
// signatures differ. Before this, that divergence was silent and read as a bug in the index.
//
// COMPUTED PER SERVING PROCESS, NEVER PUBLISHED AS AUTHORITY (R4#6). Every input is process-local:
// the environment the process was started with, the ranking code it was built from, the reranker it
// was constructed with. A publisher's value therefore need NOT equal a read face's, so it has no
// place in a publication manifest — a manifest field would assert a fact about processes the
// publisher has never met. Each serving process computes and reports its own.
//
// NORMALIZED EFFECTIVE, never configured (R3#13). `FUNES_RRF_K=banana` signs as the default the
// process actually fuses at, because the signature must describe the query this process will
// answer, not the intention someone typed. That is why the resolvers live HERE and the stores call
// them: a store that normalized its own copy could drift from the signature that claims to
// describe it, and the signature would lie in exactly the case it exists to expose.
import { createHash } from "node:crypto";
import { DEFAULT_RRF_K, resolveGraphArm } from "funes-core";

/** The encoding version — the FIRST hash input and the visible prefix, so a future encoding over a
 *  different field set can never collide with this one. Bump when the FIELD SET or its encoding
 *  changes; the version constants below cover changes to what the fields MEAN. */
export const SERVING_SEMANTICS_VERSION = "sv1";

/** Version of the ranking SHAPE — the retrieval and fusion code itself: the FTS query construction,
 *  the vector arm's per-page best-chunk pick, the graph arm's scoring (funes-core/src/graph-arm.ts),
 *  RRF fusion and its tiebreak, the recency tiebreak, and near-duplicate collapse. BUMP on any
 *  change to that code, including a change that leaves every constant below untouched — a reshaped
 *  arm reorders results without moving a single number. "1" = the P2.11 v2 graph arm + P2.10b
 *  fusion, the shape both backend mirrors implement today. */
export const RANKING_SEMANTICS_VERSION = "rank/1";

/** Versions of the four ORDERING adjustments — the thumbs applied to the fused score. Each is
 *  separate so a change to one is legible in a signature diff rather than hidden in one lump.
 *
 *  BUMP RULE, and it is a manual one: these version the constants AND the predicates in BOTH
 *  ranking mirrors — funes-libsql/src/ranking.ts and funes-engine/src/store.ts. funes-shared sits
 *  below both in the package DAG and cannot import the constants to derive these automatically, so
 *  a value tweak that skips the bump leaves two processes claiming one serving signature while
 *  ranking differently. Change TRUST_WEIGHT, ZONE_WEIGHT, DISTILL_WEIGHT, ENTITY_BOOST, `isDistill`
 *  or `entityAdjust`'s trigger, and bump the matching constant in the same commit.
 *
 *  "1" for all four = the H5-golden-pinned values: TRUST_WEIGHT {1.0/0.95/0.85},
 *  ZONE_WEIGHT {wiki 1.0/output 0.7/incoming 0.8}, DISTILL_WEIGHT 0.87, ENTITY_BOOST 1.5. */
export const TRUST_ADJUST_VERSION = "trust/1";
export const ZONE_ADJUST_VERSION = "zone/1";
export const DISTILL_ADJUST_VERSION = "distill/1";
export const ENTITY_ADJUST_VERSION = "entity/1";

/** The HNSW recall floor applied per pooled connection (2026-07-13 bench: ef=40 collapses
 *  cross-language recall; ef=200 ≡ exact). THE one default — postgres-driver.ts and the engine
 *  store's init() both resolve through resolveEfSearch so neither can drift from the signature. */
export const DEFAULT_EF_SEARCH = 200;

/** Just enough of `process.env` to resolve a setting; passing an explicit object is what makes the
 *  resolvers testable without mutating the real environment. */
export type ServingEnv = Record<string, string | undefined>;

/** Effective RRF fusion constant. A non-finite value rides DEFAULT_RRF_K — and note that an EMPTY
 *  string is `Number("") === 0`, which is finite, so `FUNES_RRF_K=` fuses at k=0. That is the value
 *  the process actually uses, so it is the value that gets signed. */
export function resolveRrfK(env: ServingEnv = process.env): number {
  const k = Number(env.FUNES_RRF_K);
  return Number.isFinite(k) ? k : DEFAULT_RRF_K;
}

/** Effective HNSW ef_search. `|| DEFAULT_EF_SEARCH` deliberately catches NaN AND 0 — an ef_search
 *  of 0 is not a search. Mirrors what postgres-driver.ts has always done, now in one place. */
export function resolveEfSearch(env: ServingEnv = process.env): number {
  return Number(env.FUNES_EF_SEARCH ?? DEFAULT_EF_SEARCH) || DEFAULT_EF_SEARCH;
}

export interface ServingSignatureInputs {
  /** The substrate this process serves from: "libsql" | "postgres". A backend is not an identity,
   *  but it IS a serving difference — the two ranking mirrors are not bit-identical (ts_rank vs
   *  weighted bm25, `pgvector` vs exact cosine over chunks). */
  backend: string;
  /** The fts5/tsvector column weights this process ranks its text arm with, in column order. The
   *  VALUES, not a version: they are per-backend and a tweak must move the signature by itself. */
  bm25ColumnWeights: readonly number[];
  /** The reranker's pinned identity (e.g. `Xenova/ms-marco-MiniLM-L-6-v2:q8`), or null when the
   *  process was constructed without one. A rerank stage reorders results; an unnamed one would
   *  make two differently-ordering processes claim one signature. */
  reranker: string | null;
  /** Defaults to `process.env` — the point of the parameter is tests, and a serving process that
   *  resolved its settings from somewhere else passing the same object it resolved them from. */
  env?: ServingEnv;
  rankingSemanticsVersion?: string;
  trustAdjustVersion?: string;
  zoneAdjustVersion?: string;
  distillAdjustVersion?: string;
  entityAdjustVersion?: string;
}

/** Canonical encoding + hash: one fixed-key-order JSON object over the NORMALIZED EFFECTIVE
 *  settings, with the encoding version as the first hash input (the same shape as the content
 *  generation's tail, for the same reason). */
export function servingSignature(inputs: ServingSignatureInputs): string {
  const env = inputs.env ?? process.env;
  const body = JSON.stringify({
    backend: inputs.backend,
    ranking: inputs.rankingSemanticsVersion ?? RANKING_SEMANTICS_VERSION,
    rrfK: resolveRrfK(env),
    graphArm: resolveGraphArm(env.FUNES_GRAPH_ARM),
    efSearch: resolveEfSearch(env),
    bm25: [...inputs.bm25ColumnWeights],
    trust: inputs.trustAdjustVersion ?? TRUST_ADJUST_VERSION,
    zone: inputs.zoneAdjustVersion ?? ZONE_ADJUST_VERSION,
    distill: inputs.distillAdjustVersion ?? DISTILL_ADJUST_VERSION,
    entity: inputs.entityAdjustVersion ?? ENTITY_ADJUST_VERSION,
    reranker: inputs.reranker,
  });
  const h = createHash("sha256");
  h.update(SERVING_SEMANTICS_VERSION + "\n");
  h.update(body);
  return `${SERVING_SEMANTICS_VERSION}:${h.digest("hex")}`;
}
