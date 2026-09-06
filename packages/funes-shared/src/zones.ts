// Vault-v2 zone resolution (personal-vault-v2 brief, 2026-06-12). Zones are decided by
// DIRECTORY segments at any depth — `raw/` and `out/` are pure containers:
//   any `in_*` segment, or first segment `raw`  → incoming (untrusted ingest)
//   any `out_*` segment, or first segment `out` → output (generated artifacts)
// Filenames never count (a page named `in_progress.md` is wiki — only its directories
// decide the zone). Backward compatible with top-level in_*/out_* layouts; INCOMING wins
// when both match (a stray out_* under raw/ stays untrusted — deny-biased).
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export type Zone = "incoming" | "output" | "wiki";

/** Zone of a DIRECTORY path (every segment is a directory). */
export function zoneOfDir(relDir: string): Zone {
  const segs = relDir.split("/").filter((s) => s !== "" && s !== ".");
  if (segs[0] === "raw" || segs.some((s) => s.startsWith("in_"))) return "incoming";
  if (segs[0] === "out" || segs.some((s) => s.startsWith("out_"))) return "output";
  return "wiki";
}

/** Zone of a FILE path — the basename is excluded; only its directories count. */
export function zoneOfFile(relFile: string): Zone {
  return zoneOfDir(relFile.split("/").slice(0, -1).join("/"));
}

/** The DEFAULT trust of a file, when its frontmatter declares none (funes PLAN-0.2.1 step 5).
 *  Frontmatter always wins; this decides only the absent case.
 *
 *  Two rules, one grammar, both keyed on DIRECTORY segments and both deny-biased:
 *    any `in_*` segment or a first segment `raw`  → untrusted (ingest, unchanged since H4)
 *    any `out_*` segment                          → untrusted (generated, NEW)
 *  Everything else is trusted.
 *
 *  The rule is a GRAMMAR, not a list. An enumeration of the nine `out_*` zones regressed the day
 *  a tenth appeared — which is exactly what happened to the r5 draft of this plan, and it is why
 *  a named set is refused here.
 *
 *  The `out/` CONTAINER is deliberately not matched: `out/draft.md` is a human page in a folder
 *  named out, and demoting it would demote the operator's own drafts. Only `out_*` is generated.
 *
 *  No backfill: this changes what a build LABELS, so the next full reindex carries it and the
 *  generation hash moves with it. Existing frontmatter is never rewritten. */
export function trustDefaultOfFile(relFile: string): "trusted" | "untrusted" {
  const segs = relFile.split("/").slice(0, -1).filter((s) => s !== "" && s !== ".");
  if (zoneOfDir(segs.join("/")) === "incoming") return "untrusted";
  return segs.some((s) => s.startsWith("out_")) ? "untrusted" : "trusted";
}

/** The canonical agent-memory zone for a vault: `out/out_memory` under the v2 layout
 *  (an `out/` container directory exists at the root), else legacy top-level `out_memory`.
 *  The ownership guard (H3/C1 assertOwned) accepts ONLY the active zone — it never widens
 *  to all OUTPUT zones. */
export function memoryZoneOf(vaultRoot: string): string {
  const v2 = join(vaultRoot, "out");
  return existsSync(v2) && statSync(v2).isDirectory() ? "out/out_memory" : "out_memory";
}
