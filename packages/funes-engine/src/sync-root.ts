// The sync-root guard (0.3.0 item 23): an INDEX may not live inside a folder some other process
// replicates behind funes' back.
//
// The index is a live SQLite database with WAL and -shm sidecars whose bytes are only meaningful
// together, on one machine, at one instant. A file-syncing provider copies them independently and
// out of order, so a "replicated" index is a torn one — and per ADR-0003 the index is DERIVED and
// disposable, so there is never a reason to sync it: every machine rebuilds its own.
//
// What it guards, and what it deliberately does not:
//   - THE INDEX PATH ONLY. A VAULT under a sync root is the expected arrangement — vaults are
//     canonical markdown and Syncthing/Dropbox is exactly how they travel between loci. Guarding
//     the vault would refuse the estate's normal shape. This one confusion is why the check is a
//     named function taking an index path rather than a general "is this synced" helper.
//   - The NEAREST EXISTING ancestor is canonicalized first. A lexical resolve() misses a symlinked
//     root entirely (~/Dropbox -> /Volumes/... is one symlink away from invisible), and realpath on
//     the index path itself throws for a path that does not exist yet — which is every first run.
//   - `.stfolder` is a marker INSIDE a Syncthing root, not the name of one. Looking for an ancestor
//     NAMED `.stfolder` finds nothing, ever; the ancestor that CONTAINS a `.stfolder` is the root.
//
// The override is EXACT-PATH, never a boolean: a global "yes I know" would disable the guard for
// every star on the machine, including the ones the operator was not thinking about. And every
// active override is a red `doctor` finding, because an override that no one can see is a
// permanent silent exception.
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";

/** A file/dir a provider places INSIDE the root it replicates: the directory holding one IS a
 *  sync root. */
const ROOT_MARKERS: Array<{ entry: string; provider: string }> = [
  { entry: ".stfolder", provider: "Syncthing" },
  { entry: ".stversions", provider: "Syncthing" },
  { entry: ".dropbox", provider: "Dropbox" },
  { entry: ".dropbox.cache", provider: "Dropbox" },
  { entry: ".sync", provider: "Resilio Sync" },
];

/** Directory NAMES that are a provider mount by construction — the macOS FileProvider tree and the
 *  conventional home-directory mounts. Matched on the ancestor's own name, case-sensitively,
 *  because that is how the providers spell them. */
const ROOT_DIR_NAMES = new Map<string, string>([
  ["CloudStorage", "macOS FileProvider (iCloud/Dropbox/OneDrive/Google Drive)"],
  ["com~apple~CloudDocs", "iCloud Drive"],
  ["Dropbox", "Dropbox"],
  ["OneDrive", "OneDrive"],
  ["Google Drive", "Google Drive"],
]);

export interface SyncRootFinding {
  /** The ancestor directory that IS the sync root. */
  root: string;
  provider: string;
  /** What proved it: a marker entry inside `root`, or `root`'s own name. */
  evidence: string;
}

/** Canonicalize as much of `p` as exists, keeping the not-yet-existing tail. realpath() on the
 *  whole path throws on a first run (the index file is what we are about to create), and a lexical
 *  resolve() alone walks the SYMLINK path rather than the real one — which is where a synced root
 *  hides. */
export function canonicalizeExisting(p: string): string {
  const abs = resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    if (existsSync(cur)) {
      const real = realpathSync(cur);
      return tail.length ? [real, ...tail.reverse()].join(sep) : real;
    }
    const parent = dirname(cur);
    if (parent === cur) return abs; // reached the filesystem root without finding anything that exists
    tail.push(cur.slice(parent.length + sep.length));
    cur = parent;
  }
}

/** The markers a provider puts in $HOME as its own CONFIG directory rather than as evidence of a
 *  replicated root: `~/.dropbox` (+ `~/.dropbox.cache`) is Dropbox's client state, present on every
 *  machine that has ever run it, and `~/.sync` is Resilio's. They collide with the marker names by
 *  accident, and only at $HOME. */
const HOME_CONFIG_MARKERS = new Set([".dropbox", ".dropbox.cache", ".sync"]);

/** Is THIS marker, in THIS directory, a config-directory collision rather than evidence?
 *
 *  Narrowed after review: exempting ALL marker evidence at $HOME failed OPEN. A home directory that
 *  is itself a Syncthing folder carries `~/.stfolder` — real evidence, of the exact hazard this
 *  guard exists for — and the blanket exemption swallowed it, so `findSyncRoot` returned null for
 *  `~/.twinkling/libsql/<star>/index.db` AND for everything else under that home. One synced home
 *  disabled the whole guard. Only the three names a provider genuinely uses as config are exempt,
 *  and only at $HOME; `.stfolder`/`.stversions` are live there like anywhere else. Name evidence
 *  was never affected either way: `~/Dropbox` is a CHILD of home, not home. */
function markerExempt(dir: string, entry: string): boolean {
  if (!HOME_CONFIG_MARKERS.has(entry)) return false;
  try {
    return dir === realpathSync(homedir());
  } catch {
    return false;
  }
}

/** Walk `indexPath`'s canonical ancestors and report the first sync root found, or null.
 *  The path itself is included: an index directory that is itself a Syncthing folder is the worst
 *  case, not an exempt one. */
export function findSyncRoot(indexPath: string): SyncRootFinding | null {
  let dir = canonicalizeExisting(indexPath);
  for (;;) {
    const name = dir.slice(dir.lastIndexOf(sep) + 1);
    const byName = ROOT_DIR_NAMES.get(name);
    if (byName) return { root: dir, provider: byName, evidence: `directory named "${name}"` };
    for (const m of ROOT_MARKERS) {
      if (markerExempt(dir, m.entry)) continue;
      if (existsSync(`${dir}${sep}${m.entry}`)) return { root: dir, provider: m.provider, evidence: `${m.entry} inside it` };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The EXACT index paths an operator has overridden, in the order declared. Compared as resolved
 *  paths and, separately, as canonicalized ones, so an override survives a symlinked home without
 *  becoming a prefix match — a prefix would turn one exception into a subtree exemption. */
export function syncRootOverrides(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.FUNES_SYNC_ROOT_OK ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function overridden(indexPath: string, env: NodeJS.ProcessEnv): boolean {
  const want = new Set([resolve(indexPath), canonicalizeExisting(indexPath)]);
  return syncRootOverrides(env).some((o) => want.has(resolve(o)) || want.has(canonicalizeExisting(o)));
}

/** The guard itself. Throws unless the exact path is overridden. */
export function assertIndexNotInSyncRoot(indexPath: string, env: NodeJS.ProcessEnv = process.env): void {
  const found = findSyncRoot(indexPath);
  if (!found) return;
  if (overridden(indexPath, env)) {
    // Loud on every open, not once: an override is a standing exception to a data-integrity rule,
    // and `doctor` reports it in red for the same reason.
    process.stderr.write(
      `funes: SYNC-ROOT OVERRIDE ACTIVE — the index at ${indexPath} is inside a ${found.provider} root (${found.root}); ` +
      "FUNES_SYNC_ROOT_OK names it, so it opens. A synced index is a torn index.\n",
    );
    return;
  }
  throw new Error(
    `funes: refusing to open an index inside a ${found.provider} root — ${found.root} (${found.evidence}).\n` +
    `  The index is a live SQLite database (index.db plus -wal/-shm) and a sync provider copies those files independently, ` +
    "which produces a torn database rather than a replicated one. The index is DERIVED (ADR-0003): rebuild it locally instead of syncing it.\n" +
    `  Move it out — set FUNES_LIBSQL_DIR to a true-local path (the default is ~/.twinkling/libsql/<star>/) — or, if this really is ` +
    `intended, override this EXACT path: FUNES_SYNC_ROOT_OK=${resolve(indexPath)} (doctor reports it in red for as long as it is set).\n` +
    "  A VAULT under a sync root is fine and expected; this guards the index only.",
  );
}
