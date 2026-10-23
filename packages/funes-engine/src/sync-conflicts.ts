// Sync conflicts are a finding, not an edge (0.4.0 item 7, RAI-129).
//
// When two loci edit one page before Syncthing has carried either edit across, Syncthing keeps
// BOTH: the winner under the page's own name and the loser beside it as
// `<name>.sync-conflict-<YYYYMMDD>-<HHMMSS>-<short device id><ext>`. Walked as a page, that copy is
// a second node claiming the same title, the same `aliases:` (which then collide to null in
// buildReferenceMaps, so an alias-authored edge to the REAL page stops resolving) and the same
// outbound edges — a stale fork of a page that no one wrote as one. So the walkers skip it
// structurally, at the tier of `index.md` and `*.summary.md`, and `funes doctor` names it.
//
// Structural, NOT index_scope and NOT CONFIGLESS_EXCLUDES: a scope glob would move the scope hash
// (and with it every home's generation), and CONFIGLESS_EXCLUDES is directory segments for
// configless vaults only (scope.ts). The funes star's own four `*.sync-conflict-*` globs stay as
// they are — removing them moves the scope hash on every home that serves it — and their wider net
// (a bare substring, so `how.sync-conflict-resolution.md` is excluded there too) is a documented
// over-exclusion on that one star; this predicate is the rule everywhere else.
//
// A FILENAME test, applied in each walker's file branch only: Syncthing never makes a conflict
// directory, and pruning directories on it would change walk semantics for nothing. It sees
// nothing inside a file — a page left with git conflict markers is not its business.
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { configlessExclude } from "funes-core/internal";
import { readIndexScopeExcludes } from "./scope.ts";

// The predicate itself (the anchored Syncthing shape) moved to funes-core's vault module, where
// `isPagePath` uses it (PLAN-0.5.0 item 11); re-exported here so callers and twinkl.ing do not change.
import { isSyncConflict } from "funes-core";
export { isSyncConflict };

/** `doctor`'s finding: the conflict copies on disk, which the operator resolves by hand. The
 *  indexed half (pre-0.4.0 residue rows) was deleted by RAI-327 (RAI-306). */
export interface SyncConflictFinding {
  onDisk: string[];
}

/** Every conflict copy under `vault`, of ANY extension (a conflicted `star.yaml` is a finding too),
 *  as vault-relative POSIX paths in walk order — deterministic, so two runs diff clean. star.yaml
 *  scope is deliberately NOT applied: on the funes star its glob would hide every copy, and a copy
 *  outside the index is still two versions of one file on disk. Dot-entries and symlinks are
 *  skipped as walkMd skips them.
 *
 *  The CONFIGLESS_EXCLUDES directories are pruned ONLY where reindex prunes them — no star.yaml
 *  (cli.ts reindex: `scope.kind === "absent"`). A DECLARED scope is never extended with them
 *  (scope.ts), so walkMd descends a starred vault's `build/` or `vendor/` and indexes the pages
 *  there; pruning them here too made the finding NARROWER than the index for those six names, and a
 *  copy the walker skipped in one was neither indexed nor reported — the silent loss this item
 *  exists to prevent. In a configless vault the prune is kept: walking a code repo's node_modules
 *  would make doctor slow for pages reindex never reads either.
 *
 *  Best-effort, never a throw: doctor calls this after the audit, so a throw here lost the whole
 *  report. And because scope is ignored, this walk enters trees reindex never opens — a
 *  scope-excluded directory the user cannot read (a root-owned volume, a TCC-protected folder) threw
 *  EACCES where reindex and publish succeed. Such a directory is skipped: Syncthing normally runs
 *  as that same user, so it cannot have written a copy there either. An entry that vanishes
 *  between readdir and lstat (a sync or an editor's temp file) is skipped the same way. */
export function syncConflictFinding(vault: string): SyncConflictFinding {
  const skipDir = readIndexScopeExcludes(vault).kind === "absent" ? configlessExclude() : undefined;
  const onDisk: string[] = [];
  const walk = (rel: string): void => {
    let names: string[];
    try { names = readdirSync(join(vault, rel)).sort(); } catch { return; }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const childRel = rel ? `${rel}/${name}` : name;
      let st;
      try { st = lstatSync(join(vault, childRel)); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { if (!skipDir?.(name)) walk(childRel); }
      else if (isSyncConflict(name)) onDisk.push(childRel);
    }
  };
  walk("");
  return { onDisk };
}
