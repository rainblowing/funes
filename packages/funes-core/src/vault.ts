// The Vault port (PLAN-0.5.0 item 11, ADR-0011 §The decision; signatures from
// docs/research/0.5.0/21-vault-seam.md answer 1). Pages live in a folder (FolderVault, funes-engine)
// or in R2 (R2Vault, funes-cf); both sit behind read, list and one swap frame. Pure TS, relative
// imports only (H7, lint-core-imports).

/** Vault-relative, "/"-separated; no leading "/", no empty, "." or ".." segment. */
export type VaultPath = string;
/** The store's own token (the lstat triple on a folder, the etag on R2): opaque above its adapter,
 *  compared by equality only. Never the proposal base — that is the sha256 of the bytes (ADR-0010),
 *  computed above the port, and it is the only version that crosses loci. */
export type Version = string;
/** Exact bytes: no newline or BOM change, because the ADR-0010 base is the sha256 of these. */
export interface VaultFile { bytes: Uint8Array; version: Version }
export interface VaultEntry { path: VaultPath; version: Version }
export type SwapResult = { ok: true; version: Version | null } | { ok: false };

export interface Vault {
  /** One file's exact bytes and the version they are; null = absent. Never follows a symlink. */
  read(path: VaultPath): Promise<VaultFile | null>;
  /** Every PAGE (`isPagePath`, not excluded) with its version; `star.yaml` and `.history/` are never
   *  listed. `exclude` is called with each ancestor `"<dir>/"` and then the file (the walkMd
   *  contract), identically in every adapter. Order unspecified. There is no watch op: change
   *  detection is these versions compared with the recorded ones. */
  list(opts?: { exclude?: (rel: string) => boolean }): AsyncIterable<VaultEntry>;
  /** One change. `tx.swap` is the only write, and a frame swaps each path at most once. A history
   *  object is never removed. At a folder, a throw from `fn` undoes the frame (created paths removed
   *  first, then each replaced path put back once; undo carries on past a failure and names every
   *  path it could not put back). At the edge the frame stages, so a throw writes nothing, and once
   *  its journal is durable it rolls forward. One frame per Vault at a time: the caller's serializer
   *  guarantees it. */
  atomically<T>(fn: (tx: VaultTx) => Promise<T>): Promise<T>;
}

export interface VaultTx {
  /** Compare-and-swap one file. `expect`: the version read, or null = must be absent (create-once).
   *  `next`: new bytes, or null = remove. `{ok: false}` when `expect` does not hold. */
  swap(path: VaultPath, expect: Version | null, next: Uint8Array | null): Promise<SwapResult>;
}

/** Syncthing's exact conflict suffix (its `conflictName`): timestamp, then the 7-char base32 short
 *  device id — empty when the file carries no `ModifiedBy` — then the original extension, if any.
 *  Anchored and shaped, never a bare substring: a page whose NAME merely carries the words
 *  (`how.sync-conflict-resolution.md`, `notes.sync-conflict-20260909.md`) is a page, and dropping it
 *  would silently remove canonical content (PLAN-0.4.0-REVIEW-LOG round 1, #20). */
const SYNC_CONFLICT = /\.sync-conflict-\d{8}-\d{6}-(?:[A-Z2-7]{7})?(?:\.[^.]*)?$/;

/** Is this file NAME (a basename, not a path) a Syncthing conflict copy? The one predicate every
 *  walker, `grandfather`, `doctor` and the watcher share (0.4.0 item 7). */
export function isSyncConflict(name: string): boolean {
  return SYNC_CONFLICT.test(name);
}

/** What a page is, for both adapters: `.md`, no dot segment, not `index.md` or `log.md` (OKF §3.1
 *  reserves both), not `*.summary.md`, not a sync-conflict copy. */
export function isPagePath(rel: VaultPath): boolean {
  const segs = rel.split("/");
  const name = segs[segs.length - 1]!;
  return segs.every((s) => s !== "" && !s.startsWith("."))
    && name.endsWith(".md") && name !== "index.md" && name !== "log.md"
    && !name.endsWith(".summary.md") && !isSyncConflict(name);
}

const HISTORY = ".history/";

/** Where a replace keeps the bytes it overwrote: `.history/<page path>/<sha256 of those bytes>`, with
 *  no `.md` suffix, so it is outside the index scope and OKF §11 by construction. Written create-once
 *  in the same frame as, and before, the page swap; a create-once that finds it there is success,
 *  since the name certifies the content. */
export function historyPath(path: VaultPath, sha256: string): VaultPath {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`funes: historyPath needs a lowercase hex sha256, got "${sha256}"`);
  return `${HISTORY}${path}/${sha256}`;
}

/** The standing rules at the only write op, on every page swap. It sits BESIDE `assertOwned` (H3),
 *  not instead of it, and checks the path only, never content. It refuses a path that is not a vault
 *  path (so no `..` or empty segment can walk into `raw/`), refuses the incoming zone (first segment
 *  `raw`, any `in_*` segment) — for a history object, the zone of the page it keeps — and under
 *  `.history/` admits only create-once (`expect` null, `next` bytes). */
export function assertWritable(path: VaultPath, expect: Version | null, next: Uint8Array | null): void {
  if (path.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw new Error(`funes: refusing to write "${path}" — not a vault path.`);
  }
  const history = path.startsWith(HISTORY);
  const page = history ? path.slice(HISTORY.length, path.lastIndexOf("/")) : path;
  if (zoneOfFile(page) === "incoming") {
    throw new Error(`funes: refusing to write "${path}" — the incoming zone (raw/, in_*) is never written.`);
  }
  if (history && (expect !== null || next === null)) {
    throw new Error(`funes: refusing to write "${path}" — a history object is create-once only.`);
  }
}

// Vault-v2 zone resolution (personal-vault-v2 brief, 2026-06-12; moved from funes-shared/zones.ts,
// which re-exports it). Zones are decided by DIRECTORY segments at any depth — `raw/` and `out/` are
// pure containers:
//   any `in_*` segment, or first segment `raw`  → incoming (untrusted ingest)
//   any `out_*` segment, or first segment `out` → output (generated artifacts)
// Filenames never count (a page named `in_progress.md` is wiki — only its directories
// decide the zone). Backward compatible with top-level in_*/out_* layouts; INCOMING wins
// when both match (a stray out_* under raw/ stays untrusted — deny-biased).
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
