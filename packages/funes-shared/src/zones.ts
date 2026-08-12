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

/** The canonical agent-memory zone for a vault: `out/out_memory` under the v2 layout
 *  (an `out/` container directory exists at the root), else legacy top-level `out_memory`.
 *  The ownership guard (H3/C1 assertOwned) accepts ONLY the active zone — it never widens
 *  to all OUTPUT zones. */
export function memoryZoneOf(vaultRoot: string): string {
  const v2 = join(vaultRoot, "out");
  return existsSync(v2) && statSync(v2).isDirectory() ? "out/out_memory" : "out_memory";
}
