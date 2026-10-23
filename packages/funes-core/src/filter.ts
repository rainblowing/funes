// ADR-0013: the recall filter and the ONE function that decides membership. funes-engine compiles a
// `where` against the star's live `memory.recall` declaration into a RecallFilter; every store (libSQL
// here, DO SQLite at the edge) applies it to the `nodes.frontmatter` it holds through this, so the two
// loci cannot disagree about which pages a `where` admits. Names no key: keys come from the star.
import type { ScalarFrontmatter } from "./types.ts";

export type FilterScalar = string | number | boolean;
/** Strict equality (no coercion), presence, or inequality (absent counts as unequal). */
export type FilterCondition = FilterScalar | { exists: boolean } | { ne: FilterScalar };
/** One clause: every key's condition holds (AND). */
export type FilterClause = Record<string, FilterCondition>;
/** A compiled `where`: every term holds (AND). A term holds when any clause holds (OR), inverted by
 *  `not` — a declared key is a one-clause term, a predicate keeps its OR of ANDs, `{p: false}` negates. */
export interface RecallFilter {
  all: Array<{ any: FilterClause[]; not?: boolean }>;
}

function holds(row: ScalarFrontmatter, key: string, cond: FilterCondition): boolean {
  const has = Object.hasOwn(row, key); // never `in`: a prototype name is not a frontmatter key
  if (typeof cond !== "object") return has && row[key] === cond;
  if (Object.hasOwn(cond, "exists")) return has === (cond as { exists: boolean }).exists;
  return !has || row[key] !== (cond as { ne: FilterScalar }).ne;
}

/** Does a page's stored frontmatter pass the filter? A null row (written before the column existed)
 *  matches no filter, negated terms included: fail-closed. */
export function matchesFilter(row: ScalarFrontmatter | null | undefined, filter: RecallFilter): boolean {
  if (row == null) return false;
  return filter.all.every((t) => t.any.some((c) => Object.entries(c).every(([k, v]) => holds(row, k, v))) !== (t.not === true));
}
