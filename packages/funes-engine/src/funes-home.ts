// The funes home (ADR-0016 as amended by RAI-311): the ONE per-machine directory every machine-local
// path derives from — index (`libsql/`), `locks/`, machine state (`state/`), `models/`, the
// capability file and the writer-endpoint file. Not the publication home (`--home`).
//
// `$FUNES_HOME` when set (set-but-empty refuses), else `~/.funes`. With FUNES_HOME unset, a
// `~/.twinkling` that holds `libsql/`, `locks/` or `state/` as a DIRECTORY is a legacy home: refuse
// and name `funes home move` (a plain file there is a tombstone). A retired per-resource name that is
// still set refuses and names FUNES_HOME: a silent ignore would send a pinned process to an empty
// index with no error.
//
// The default is memoized per process, at first use: a process alive across a move keeps its old
// home and hits the tombstones (fails closed) instead of keying a lock inside the new home.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/** Retired names that refuse while set (PLAN-0.6.0 bar #6). The list grows one slice at a time and
 *  leaves in the release after 0.6.x. */
const RETIRED = ["FUNES_LIBSQL_DIR", "FUNES_LOCK_DIR", "FUNES_STATE_DIR", "FUNES_MODEL_DIR", "FUNES_SYNC_ROOT_OK", "FUNES_WRITE_DESIGNATION"];
/** Retired claims of coordination (RAI-309 Q7): funes no longer shares a lock with anything. */
const RETIRED_CLAIMS = ["FUNES_COORDINATION_DIR"];
/** A retired claim of attribution (RAI-310 D9): no variable names who wrote a row any more. */
const RETIRED_ACTOR = "FUNES_ACTOR";
/** Retired backend selectors (RAI-312, RAI-314 Q9): a star's backend is its star.yaml's choice. */
const RETIRED_BACKEND = ["FUNES_BACKEND", "FUNES_PG_URL"];

const isDir = (p: string): boolean => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};

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

/** The funes home. Throws on a retired name, an empty FUNES_HOME, or (FUNES_HOME unset) a legacy home. */
export function funesHome(): string {
  const claims = RETIRED_CLAIMS.filter((n) => process.env[n] !== undefined);
  if (claims.length) {
    throw new Error(`funes: ${claims.join(", ")} is retired in 0.6.0 — funes shares no coordination lock with any other process; its writes serialize on one write lock per star. Unset it. Refusing to run.`);
  }
  if (process.env[RETIRED_ACTOR] !== undefined) {
    throw new Error(`funes: ${RETIRED_ACTOR} is retired in 0.6.0 — the grant names the actor: FUNES_ACTOR_MAP + FUNES_CAPABILITY_FILE on stdio, --access on funes serve (else writes stamp "unknown"). Unset it. Refusing to run.`);
  }
  const backend = RETIRED_BACKEND.filter((n) => process.env[n] !== undefined);
  if (backend.length) {
    throw new Error(`funes: ${backend.join(", ")} ${backend.length > 1 ? "are" : "is"} retired in 0.6.0 — a star's backend is its star.yaml \`memory.substrate: libsql|turso\` (absent = libsql). Unset it. Refusing to run.`);
  }
  const retired = RETIRED.filter((n) => process.env[n] !== undefined);
  if (retired.length) {
    throw new Error(`funes: ${retired.join(", ")} ${retired.length > 1 ? "are" : "is"} retired in 0.6.0 — unset it; set FUNES_HOME to relocate the funes home. Refusing to run.`);
  }
  const set = process.env.FUNES_HOME;
  if (set !== undefined) {
    if (set.trim() === "") throw new Error("funes: FUNES_HOME is set but empty — unset it or name a path; refusing to run.");
    return resolve(set);
  }
  if (memo !== undefined) return memo;
  const { legacy, fresh } = homeCandidates();
  if (["libsql", "locks", "state"].some((d) => isDir(join(legacy, d)))) {
    throw new Error(`funes: ${legacy} is a legacy funes home that still holds state — run \`funes home move\`; refusing to run.`);
  }
  return (memo = fresh);
}

let tombstoned = false;

/** `<home>/<sub>` for `libsql`, `locks` or `state`. On the default home this is where they are first
 *  created, so the legacy paths are tombstoned first (once per process, idempotent): a stray ≤0.4.x
 *  process can then neither create `~/.twinkling/locks` nor build an index under `~/.twinkling/libsql`. */
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

/** Base of every star's index: `<base>/<vault basename>/index.db`. */
export const libsqlBase = (): string => stateDir("libsql");
/** Where the cross-process write locks live (one per star). */
export const locksHome = (): string => stateDir("locks");
/** Machine-state root (outboxes, replica.json, canon mirrors). */
export const stateRoot = (): string => stateDir("state");
/** One vault's machine-local state dir under `stateRoot()`. Keyed exactly as the write lock keys
 *  its resource — basename plus a 10-hex path digest — so two stars that share a folder name get
 *  distinct state. Machine-local on purpose: never inside a vault or a publication home. */
export function stateDirFor(vault: string): string {
  const abs = resolve(vault);
  const h = createHash("sha256").update(abs).digest("hex").slice(0, 10);
  return join(stateRoot(), `${basename(abs)}-${h}`);
}
/** The embedder's model-weight cache (a container mounts it read-only here). */
export const modelsDir = (): string => join(funesHome(), "models");
/** The shared capability token file (basename kept: the access file's actor is `funes-cap`).
 *  FUNES_CAPABILITY_FILE names a session's credential, not a location, so it stays. */
export function capabilityFilePath(): string {
  const v = process.env.FUNES_CAPABILITY_FILE;
  if (v === undefined) return join(funesHome(), "funes-cap");
  if (v.trim() === "") throw new Error("funes: FUNES_CAPABILITY_FILE is set but empty — unset it or name a path; refusing to run.");
  return v;
}
/** The writer-endpoint file. No override variable. */
export const endpointsFilePath = (): string => join(funesHome(), "endpoints.json");
