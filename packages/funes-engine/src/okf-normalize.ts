// `funes okf normalize` (PLAN-0.5.0 item 21, ADR-0012 "The conversion"; record 20). The dry run is
// the lint: over the OKF scope (the index scope minus the incoming zone, plus the reserved
// index.md/log.md — what a FULL build counts as `okf_nonconformant`), each file the normalizer would
// edit, and whether that moves the embedding-content fingerprint (a re-embed) or the generation
// record, and each file it refuses, with the reason. It writes nothing.
//
// `--apply` is the operator's own act at the write locus — one of two named exceptions to H3, with no
// proposal id and no receipt. It runs only where the write rule allows (a bulk rewrite from a
// non-writer locus would fork every replica), under the star's write lock (the one FunesStore
// takes, RAI-309), directly on `FolderVault.atomically`: per file, the pre-image as a history
// object, then the page, each swap conditional on the version read and passed through
// `assertWritable`. A file that moved since the read is a conflict, skipped and reported.
import { createHash } from "node:crypto";
import { assertWritable, historyPath, isPagePath, zoneOfFile } from "funes-core/internal";
import type { Version } from "funes-core/internal";
import { generationRecord, hashItem } from "funes-core/internal";
import { withScopedWriteLock } from "./write-lock.ts";
import { anyExclude, buildScopeExclude, configlessExclude } from "funes-core/internal";
import { readIndexScopeExcludes } from "./scope.ts";
import { FolderVault, walkFolder } from "./folder-vault.ts";
import { isReservedFile } from "./reindex.ts";
import { normalizePage } from "funes-core";
import { okfFloor, textToItemWithMeta, type OkfEdit, type OkfRefusal } from "funes-core/internal";
import { assertWriteAllowed } from "funes-core/internal";
import { resolveWriteDesignation } from "./process-locus.ts";
import { funesDbDir, readStarIdentity } from "./factory.ts";

/** One nonconformant file: the edit the normalizer makes, or why it refuses. */
export type OkfFinding =
  | { path: string; edit: Exclude<OkfEdit, "none">; reembed: boolean; generation: boolean }
  | { path: string; invalid: OkfRefusal; reason: string };

type Planned = { finding: OkfFinding; bytes: Uint8Array; version: Version; next?: Uint8Array };

const encoder = new TextEncoder();
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The star must hold itself to the floor: a broken index scope, an invalid `memory.okf` or
 *  `memory.okf: false` refuses (exit 2 at the CLI); "0.1" is normalized to the pin, with a line. */
function starFloor(vault: string): (rel: string) => boolean {
  const scope = readIndexScopeExcludes(vault);
  if (scope.kind === "invalid") throw Object.assign(new Error(`okf normalize: star.yaml index_scope is invalid — ${scope.reason}`), { usage: true });
  const id = readStarIdentity(vault);
  if (id.okfInvalid != null) throw Object.assign(new Error(`okf normalize: star.yaml memory.okf ${id.okfInvalid} is not "0.1", "0.2" or false`), { usage: true });
  const floor = okfFloor(id.capabilities.okf);
  if (!floor) throw Object.assign(new Error("okf normalize: star.yaml memory.okf is false — this star opted out of the OKF floor"), { usage: true });
  if (floor.mismatch) process.stderr.write(`okf normalize: ${floor.mismatch}\n`);
  // the same predicate reindex and publish build from, so the lint and `okf_nonconformant` agree
  return anyExclude(buildScopeExclude(scope.kind === "valid" ? scope.excludes : []), scope.kind === "absent" ? configlessExclude() : undefined) ?? (() => false);
}

async function plan(vault: string): Promise<Planned[]> {
  const exclude = starFloor(vault);
  const v = new FolderVault(vault);
  const out: Planned[] = [];
  for (const { rel } of walkFolder(vault, vault, (r) => isPagePath(r) || isReservedFile(r), exclude)) {
    if (zoneOfFile(rel) === "incoming") continue;
    const f = await v.read(rel);
    if (!f) continue; // gone since the walk
    const n = normalizePage(f.bytes, { path: rel });
    if ("invalid" in n) { out.push({ finding: { path: rel, invalid: n.invalid, reason: n.reason }, ...f }); continue; }
    if (n.edit === "none") continue;
    const before = textToItemWithMeta(f.bytes, rel).item;
    const after = textToItemWithMeta(n.text, rel).item;
    out.push({
      finding: { path: rel, edit: n.edit, reembed: hashItem(before) !== hashItem(after), generation: !sameJson(generationRecord(before), generationRecord(after)) },
      ...f, next: encoder.encode(n.text),
    });
  }
  return out;
}

/** The lint: every nonconformant file in the OKF scope, in walk order. Read-only. */
export async function okfDryRun(vault: string): Promise<OkfFinding[]> {
  return (await plan(vault)).map((p) => p.finding);
}

export interface OkfApplyResult {
  /** The files converted, each with its pre-image kept at `.history/<path>/<sha256>`. */
  applied: OkfFinding[];
  /** Files that changed between the read and the swap: skipped, nothing written for them. */
  conflicts: string[];
  /** What the normalizer refuses: left as they are, for the operator. */
  refused: OkfFinding[];
}

/** `--apply`. `locus`/`env` resolve this process's locus as every mutator does; the write rule
 *  (RAI-324) decides before the vault is read — an undeclared star proceeds, as the rule says. */
export async function okfApply(vault: string, opts: { locus?: string; env?: NodeJS.ProcessEnv } = {}): Promise<OkfApplyResult> {
  assertWriteAllowed(resolveWriteDesignation(vault, opts), "okf-normalize"); // a refused name is an error, not a refusal
  return withScopedWriteLock(funesDbDir(vault), async () => {
    const v = new FolderVault(vault);
    const res: OkfApplyResult = { applied: [], conflicts: [], refused: [] };
    for (const p of await plan(vault)) {
      if (!p.next) { res.refused.push(p.finding); continue; }
      const path = p.finding.path;
      const ok = await v.atomically(async (tx) => {
        const hist = historyPath(path, createHash("sha256").update(p.bytes).digest("hex"));
        assertWritable(hist, null, p.bytes);
        await tx.swap(hist, null, p.bytes); // { ok: false } = already there, which the name certifies
        assertWritable(path, p.version, p.next!);
        return (await tx.swap(path, p.version, p.next!)).ok;
      });
      if (ok) res.applied.push(p.finding);
      else res.conflicts.push(path);
    }
    return res;
  });
}
