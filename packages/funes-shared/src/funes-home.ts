// The funes home (ADR-0016, PLAN-0.5.0 item 7): the ONE per-machine directory every machine-local
// path derives from — index (`libsql/`), `locks/`, machine state (`state/`), `models/`, the
// capability file and the writer-endpoint file. Not the publication home (`--home`).
//
// Chosen by what it holds, never by what exists: a home holds state when any of `libsql/`, `locks/`
// or `state/` is a DIRECTORY (a plain file there is a tombstone `funes home move` leaves). Exactly
// one holding home is used; neither → `~/.funes`; both → refuse and name both (a move interrupted
// after its first rename). While the legacy home holds state, an entry `funes home move` renames
// before `locks/` (`models/`, `funes-cap`, `endpoints.json`) in `~/.funes` also counts: served on
// the legacy home, a process would re-create it there and the rerun would refuse to merge. `locks/`
// counts because the lock home is independent of
// FUNES_LIBSQL_DIR: a legacy home with only `locks/` must keep 0.4.x and 0.5.0 on one lock dir.
//
// Memoized per process, at first use: a process alive across a move keeps its old home and hits the
// tombstones (fails closed) instead of keying a lock on the old index path inside the new home.
// On a home that has not moved, every path is 0.4.x's string byte for byte, so the
// `sha256(resolve(path))` lock key matches across versions. There is no FUNES_HOME; tests set HOME.
import { lstatSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const isDir = (p: string): boolean => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};
const holdsState = (home: string): boolean => ["libsql", "locks", "state"].some((d) => isDir(join(home, d)));
const exists = (p: string): boolean => {
  try { lstatSync(p); return true; } catch { return false; }
};
/** What `funes home move` renames before the first tombstoned entry: in `~/.funes` beside a legacy
 *  home that still holds state, they are a move cut short. */
const movedFirst = (home: string): boolean => ["models", "funes-cap", "endpoints.json"].some((e) => exists(join(home, e)));

let memo: string | undefined;

/** The two candidate homes. Only the resolver and `funes home move` look at both. */
export const homeCandidates = (): { legacy: string; fresh: string } =>
  ({ legacy: join(homedir(), ".twinkling"), fresh: join(homedir(), ".funes") });

/** Write the plain tombstone file at `at`, naming `newPath`. A file already there is a tombstone
 *  and is kept (funes never deletes one); anything else in the way — a legacy directory — throws. */
export function writeTombstone(at: string, newPath: string): void {
  try {
    writeFileSync(at, `funes home moved: ${newPath}\nA tombstone (ADR-0016): an old-home mkdir fails here, closed. Never delete it.\n`, { flag: "wx" });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST" && lstatSync(at).isFile()) return;
    throw new Error(`funes: cannot write the tombstone ${at} (${code}) — something other than a tombstone is in the way; refusing.`);
  }
}

/** The funes home, resolved once per process. Throws when both candidate homes hold state. */
export function funesHome(): string {
  if (memo !== undefined) return memo;
  const { legacy, fresh } = homeCandidates();
  const l = holdsState(legacy), f = holdsState(fresh) || (l && movedFirst(fresh));
  if (l && f) {
    throw new Error(
      `funes: two funes homes hold state — ${legacy} and ${fresh}. Finish or undo \`funes home move\`; refusing to run.`,
    );
  }
  // PLAN-0.5.0 item 6 (record 33): the legacy home is served with one deprecation line per process —
  // the memo above makes this branch run once.
  if (l) console.warn(`funes: running on the legacy funes home ${legacy} — run \`funes home move\` (0.6.0 refuses a legacy home)`);
  return (memo = l ? legacy : fresh);
}

let tombstoned = false;

/** `<home>/<sub>` for `libsql`, `locks` or `state`. On the fresh home this is where they are first
 *  created, so the legacy paths are tombstoned first (once per process, idempotent): a later 0.4.x
 *  can then neither create `~/.twinkling/locks` nor build an index under `~/.twinkling/libsql`. */
function stateDir(sub: string): string {
  const home = funesHome();
  const { legacy, fresh } = homeCandidates();
  if (!tombstoned && home === fresh) {
    mkdirSync(legacy, { recursive: true });
    for (const t of ["libsql", "locks", "state"]) writeTombstone(join(legacy, t), join(fresh, t));
    tombstoned = true;
  }
  return join(home, sub);
}

/** What `doctor` reports as `home:` — "legacy" until `funes home move`. */
export const funesHomeKind = (): "legacy" | "funes" => (funesHome() === homeCandidates().legacy ? "legacy" : "funes");

/** A FUNES_* override for one resource: unset → the home-derived default; set-but-empty → refuse
 *  and name the variable (an empty value used to mean cwd-relative, "" or the default, by site). */
function overrideOr(name: string, fallback: () => string): string {
  const v = process.env[name];
  if (v === undefined) return fallback();
  if (v.trim() === "") throw new Error(`funes: ${name} is set but empty — unset it or name a path; refusing to run.`);
  return v;
}

/** Base of every star's index: `<base>/<vault basename>/index.db`. */
export const libsqlBase = (): string => overrideOr("FUNES_LIBSQL_DIR", () => stateDir("libsql"));
/** Where cross-process write locks live (index and vault locks). */
export const locksHome = (): string => overrideOr("FUNES_LOCK_DIR", () => stateDir("locks"));
/** Machine-state root (outboxes, replica.json, canon mirrors, machine-state files). */
export const stateRoot = (): string => overrideOr("FUNES_STATE_DIR", () => stateDir("state"));
/** The embedder's model-weight cache. */
export const modelsDir = (): string => overrideOr("FUNES_MODEL_DIR", () => join(funesHome(), "models"));
/** The shared capability token file (basename kept: the access file's actor is `funes-cap`). */
export const capabilityFilePath = (): string => overrideOr("FUNES_CAPABILITY_FILE", () => join(funesHome(), "funes-cap"));
/** The writer-endpoint file. No override variable. */
export const endpointsFilePath = (): string => join(funesHome(), "endpoints.json");
