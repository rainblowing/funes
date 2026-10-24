// The index_scope SIGNATURE — canonicalization + hash. Every backend stamps it at reindex and every
// host compares it, so it is the kernel's (RAI-313: node:crypto's createHash is on its allowlist).
import { createHash } from "node:crypto";

/** Canonical form of an exclude list: trimmed, empties dropped, de-duplicated, sorted — so two
 *  star.yaml files that mean the same scope hash identically regardless of authoring order. */
export function canonicalizeScopeExcludes(raw: string[]): string[] {
  // NOTE: non-strings are DROPPED, never coerced — this feeds a persisted signature, so the
  // behaviour is byte-pinned to the pre-P3.14 engine implementation it moved from.
  const cleaned = raw
    .map((g) => (typeof g === "string" ? g.trim() : ""))
    .filter((g) => g.length > 0);
  return [...new Set(cleaned)].sort();
}

/** sha256 over the canonicalized exclude list — the persisted `index_scope_hash` meta value. */
export function scopeHash(excludes: string[]): string {
  return createHash("sha256").update(JSON.stringify(canonicalizeScopeExcludes(excludes))).digest("hex");
}
