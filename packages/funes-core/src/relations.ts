// Relation-type normalization — the ONE compatibility boundary for edge-type spellings
// (graph research N4, 2026-07-13; grill #4). Storage keeps the AUTHORED string (a canonical
// storage migration is deferred — rewriting extraction output changes content hashes and
// re-embeds every touched page); every CONSUMER (dedupe keys, family mapping, link()'s
// exists-check, lint vocab checks) compares through this function instead.
//
// History of the fork this heals: frontmatter `edges:` defaulted to `related_to` (underscore)
// while body-wikilink extraction emitted `related-to` (hyphen) — two spellings of the same
// relation living as distinct types, invisible to dedupe and absent from RELATION_FAMILIES.

/** Normalize a relation-type string for COMPARISON (never for storage): trim, lowercase,
 *  underscores → hyphens. `related_to`, `Related_To`, and `related-to` all compare equal. */
export function normalizeRelationType(type: string): string {
  return type.trim().toLowerCase().replace(/_/g, "-");
}
