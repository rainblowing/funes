// The replica's location refusal (PLAN-0.5.0 item 29, record 29 §2), moved from the engine's
// sync-root.ts with the edge cluster (RAI-303, RAI-311: kept, never deleted). It guards the replica's
// and the seed's token and credential files.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, sep } from "node:path";
import { canonicalizeExisting, findSyncRoot } from "../../funes-engine/src/sync-root.ts";

/** Entries whose presence in an ancestor puts a path inside a git tree, a Syncthing folder or a star. */
const REPLICA_REFUSED_MARKERS = [".git", ".stfolder", "star.yaml"];

/** PLAN-0.5.0 item 29, record 29 §2: the location refusal for the replica's own paths — `~/taste`,
 *  the canon mirror, the writer-endpoint file, every token and credential file, and the resolved
 *  `stateDirFor`. A two-way syncer or a versioned tree could write a stale copy back (which the
 *  watcher would propose against a current base) or carry a token off the machine. Refused: inside
 *  `~/Desktop`, `~/Documents`, `Library/Mobile Documents` or any sync root `findSyncRoot` knows, or
 *  under an ancestor holding `.git`, `.stfolder` or `star.yaml`. The walk starts at the PARENT:
 *  `~/taste` holds its own star.yaml and is not refused by it (record 29 §2). */
export function assertReplicaLocation(path: string, home: string = homedir()): void {
  const abs = canonicalizeExisting(path);
  const refuse = (why: string) => new Error(`funes: ${path} is ${why} — the replica's paths stay outside synced and versioned trees; refusing (fail-closed)`);
  const h = canonicalizeExisting(home);
  for (const d of ["Desktop", "Documents"]) {
    const root = `${h}${sep}${d}`;
    if (abs === root || abs.startsWith(root + sep)) throw refuse(`inside ~/${d}, which iCloud may sync`);
  }
  if (abs.includes(`${sep}Library${sep}Mobile Documents${sep}`)) throw refuse("inside Library/Mobile Documents (iCloud)");
  const synced = findSyncRoot(dirname(abs));
  if (synced) throw refuse(`inside a ${synced.provider} root, ${synced.root} (${synced.evidence})`);
  for (let dir = dirname(abs); ; dir = dirname(dir)) {
    const marker = REPLICA_REFUSED_MARKERS.find((m) => existsSync(`${dir}${sep}${m}`));
    if (marker) throw refuse(`under ${dir}, which holds ${marker}`);
    if (dirname(dir) === dir) return;
  }
}
