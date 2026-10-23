// The serving signature — the THIRD of the three signatures (PLAN-0.3.0 item 7; RAI-307). The content
// generation names the ROWS; this names what orders them: the backend, and the ranking version that
// versions every ranking constant and all ranking code. One readable string, `<backend>:<RANKING_VERSION>`.
// No environment variable changes it: FUNES_RRF_K, FUNES_GRAPH_ARM and FUNES_EF_SEARCH are gone, and
// an eval sweep edits a constant in a branch. Health reports it and an eval baseline records it; no
// index stores it, and a publisher never publishes it.

/** Version of everything that orders results: the FTS query, the vector arm's per-page best-chunk
 *  pick, the graph arm, RRF fusion and its tiebreak, the post-arm adjustments and collapse, and every
 *  constant they use. "rank/2" (PLAN-0.5.0 item 23, ADR-0013): the planner's allowed set enters both
 *  arms, and collapse reads the declared keys from the indexed frontmatter.
 *
 *  BUMP RULE: ranking-constants.test.ts pins a snapshot of every ranking constant of every backend
 *  beside this value; a constant change fails it until the snapshot moves, and a moved snapshot fails
 *  it until this value moves. A change to ranking CODE that leaves every constant alone still needs a
 *  manual bump (the libsql recall golden catches most). One version for all backends: a Turso-only
 *  change marks libsql baselines NOT COMPARABLE too — re-take the baseline. */
export const RANKING_VERSION = "rank/2";

/** `<backend>:<RANKING_VERSION>`, e.g. `libsql:rank/2`. Compared by string equality only. */
export const servingSignature = (backend: string): string => `${backend}:${RANKING_VERSION}`;
