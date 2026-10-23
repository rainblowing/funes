// index_scope's folder read (RAI-313): star.yaml from a folder, behind a stat-keyed memo. The parser,
// the expectations and the exclude matcher are the kernel's (funes-core scope.ts).
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { crossStarHashOf, scopeExcludesFromText, type ScopeExcludesResult } from "funes-core/internal";

/** The parse memo, keyed on star.yaml's `(mtimeMs, size, ino)` — NEVER on elapsed time.
 *
 *  This read is on the hot path twice per guarded op: item 16's expectation is a thunk the guard
 *  evaluates before AND after retrieval, and each evaluation was a synchronous read plus a YAML
 *  parse — measured at 2.09 ms/call against a Dropbox-hosted star.yaml, so ~4.2 ms added to every
 *  recall. The stat still happens on every call; only the parse is skipped.
 *
 *  The key is what makes the memo safe, and a TTL would not be. Item 16 exists to catch a star.yaml
 *  narrowed DURING a read: a memo that expired on a clock would serve the pre-edit scope to the
 *  post-retrieval check for the length of its window, which is precisely the window item 16 closes.
 *  A stat key cannot — an edit moves mtime (and usually size), the key misses, the second check
 *  re-reads and still sees it. Keyed per path because the hub holds many stars open at once.
 *
 *  Bounded by the number of vaults one process ever touches, which is the fleet it serves. */
const scopeMemo = new Map<string, { key: string; result: ScopeExcludesResult }>();

/** Read + VALIDATE memory.index_scope.exclude from <vault>/star.yaml, fail-closed (H2). A missing
 *  file is `absent`; a present-but-broken shape is `invalid` (with a reason), NOT a silent empty
 *  list; a well-formed manifest is `valid` with the canonicalized excludes ([] when none declared). */
export function readIndexScopeExcludes(vault: string): ScopeExcludesResult {
  const p = join(vault, "star.yaml");
  // statSync rather than the existsSync it replaces: the memo needs the stat anyway, and a throw
  // here means the same thing existsSync's `false` meant — no readable manifest at this path.
  let st: ReturnType<typeof statSync>;
  try { st = statSync(p); } catch { return { kind: "absent" }; }
  const key = `${st.mtimeMs}:${st.size}:${st.ino}`;
  const hit = scopeMemo.get(p);
  if (hit?.key === key) return hit.result;
  const result = parseIndexScopeExcludes(p);
  scopeMemo.set(p, { key, result });
  return result;
}

function parseIndexScopeExcludes(p: string): ScopeExcludesResult {
  let text: string;
  // RAI-308: the errno code only — the fs error's text names the absolute path, and this reason
  // reaches a cross-star caller in a refusal.
  try { text = readFileSync(p, "utf8"); } catch (e) { return { kind: "invalid", reason: `star.yaml is unreadable (${(e as NodeJS.ErrnoException).code ?? "error"})` }; }
  return scopeExcludesFromText(text);
}

/** H2: the cross-star expected scope hash for a vault, or a REFUSAL when the manifest is
 *  absent/invalid. A governed cross-star boundary requires a VALID, manifest-built signature — an
 *  absent (configless) or invalid manifest is legitimate for own-star use but never for a cross-star
 *  read, so we refuse rather than compute a hash the serve-time recompute could match. */
export function crossStarExpectedHash(vault: string): { refusal: string } | { hash: string } {
  return crossStarHashOf(readIndexScopeExcludes(vault), vault);
}

export { corpusOf } from "funes-core/internal";
