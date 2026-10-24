// The contract state (RAI-308): the six fields `health` and `doctor` compute in one place, so the two
// cannot drift. It needs only the store and the star thunk, so it runs on every tier (RAI-313: the
// kernel's; doctor's operator state builds on it in the engine).
import type { IndexStats, ServingIndex } from "./index-store.ts";
import { expectationRefusal } from "./scope-guard.ts";
import { crossStarExpectation, ownStarExpectation } from "./scope.ts";
import type { StarConfig } from "./funes-store.ts";

/** RAI-308: the six fields `health` and `doctor` compute in one place, so the two cannot drift. It
 *  needs only the store and the star thunk, so it runs on every tier. */
export interface ContractState {
  /** THIS process's serving signature — process-local, reported, never published as authority. */
  servingSignature: string;
  contentGeneration: string | null;
  /** The locus THIS process declared (FUNES_LOCUS over the short hostname, RAI-324), or null. */
  locus: string | null;
  /** True when the built rows bypassed index_scope (the marker a pre-0.6.0 `--ignore-scope` stamped). */
  ignoreScope: boolean;
  reindexDirty: boolean;
  /** The built scope equals the scope this call expects, and no bypass. Null only for an own-star
   *  call on a star that declares no policy; an invalid manifest reads false. It ignores
   *  `reindexDirty`, which is reported beside it: a cross-star recall serves iff
   *  `scopeMatches && !reindexDirty`. */
  scopeMatches: boolean | null;
}

/** What contractState reads: a slice of the dispatcher's context. */
export interface ContractSource {
  store: ServingIndex;
  star: () => StarConfig;
  crossStar?: boolean;
  designation?: { locus: string | null };
}

export function contractState(ctx: ContractSource, stats: IndexStats): ContractState {
  const scope = () => ctx.star().scope;
  const expectation = (ctx.crossStar ? crossStarExpectation(scope, "") : ownStarExpectation(scope))();
  return {
    servingSignature: ctx.store.servingSignature(),
    contentGeneration: stats.contentGeneration,
    locus: ctx.designation?.locus ?? null,
    ignoreScope: stats.ignoreScope,
    reindexDirty: stats.reindexDirty,
    scopeMatches: expectation === null ? null : expectationRefusal({ ...stats, reindexDirty: false }, expectation) === null,
  };
}
