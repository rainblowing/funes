// `funes home move` (PLAN-0.5.0 item 8, ADR-0016, record 33): move the legacy funes home
// (`~/.twinkling`) to `~/.funes`, offline. It renames and never copies, symlinks or merges. It refuses
// when FUNES_HOME is set. It runs no reader sweep (RAI-311): a 0.6.0 process never opens a legacy
// home, and an older process that survives the rename fails closed on the tombstones at its next
// lock mkdir. `heldLocks` keeps the live-writer refusal.
//
// Order binds (record 33): `models/`, `funes-cap`, `endpoints.json`, `locks/`, `state/`, `libsql/`
// last. Right after each of `locks/`, `state/` and `libsql/` is renamed, a plain tombstone file takes
// its old path, so a 0.4.x process (or a 0.5.0 one that memoized the old home) fails closed —
// EEXIST/ENOTDIR on its next mkdir — between renames. A rerun skips what already moved, so a crash
// anywhere is finished by running the command again; meanwhile the legacy home still holds state, so
// the resolver refuses every 0.6.0 process and names this command.
import { accessSync, constants, lstatSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { heldLocks, lockHolder } from "./write-lock.ts";
import { homeCandidates, writeTombstone } from "./funes-home.ts";

const ENTRIES = ["models", "funes-cap", "endpoints.json", "locks", "state", "libsql"] as const;
const TOMBSTONED = new Set<string>(["locks", "state", "libsql"]);

const exists = (p: string): boolean => { try { lstatSync(p); return true; } catch { return false; } };
const isTombstone = (p: string): boolean => { try { return lstatSync(p).isFile(); } catch { return false; } };
const refuse = (why: string): Error => new Error(`funes: home move refused — ${why}`);

export interface MoveOptions {
  /** Crash-point seam (record 35 N6): SIGKILL this process right after renaming this entry, before
   *  its tombstone. Tests only — the CLI never passes it. */
  crashAfter?: string;
}

/** Move the legacy home into `~/.funes`. Returns one line per action; throws on every refusal. */
export function moveHome(opts: MoveOptions = {}): string[] {
  // The move is between the two default homes only: FUNES_HOME names some other place.
  if (process.env.FUNES_HOME !== undefined) throw refuse("FUNES_HOME is set — the move only moves ~/.twinkling to ~/.funes; unset FUNES_HOME to run it");
  const { legacy, fresh } = homeCandidates();
  if (!exists(legacy)) return [`nothing to move: ${legacy} does not exist; the funes home is ${fresh}`];

  // Plan first, so every refusal lands before the first rename. An entry has moved when its old
  // path is a tombstone, or when it is gone from the old home and present in the new one with every
  // earlier entry also moved (a crash between a rename and its tombstone). Anything else present in
  // the new home is state the move did not put there: refuse, never merge.
  const todo = new Set<string>();
  let owed = false;
  for (const e of ENTRIES) {
    const from = join(legacy, e), to = join(fresh, e);
    if (TOMBSTONED.has(e) && isTombstone(from)) continue;
    const present = exists(from);
    if (exists(to) && (present || todo.size > 0)) {
      throw refuse(`${to} already exists — the new home already holds state, and the move never merges`);
    }
    if (present) todo.add(e);
    if (TOMBSTONED.has(e)) owed = true;
  }
  if (todo.size === 0 && !owed) return [`nothing to move: ${legacy} is already tombstoned; the funes home is ${fresh}`];

  const target = exists(fresh) ? fresh : dirname(fresh);
  if (statSync(legacy).dev !== statSync(target).dev) {
    throw refuse(`${legacy} and ${fresh} are on different devices (EXDEV) — the move renames and never copies`);
  }
  try { accessSync(legacy, constants.W_OK); } catch {
    throw refuse(`${legacy} is not writable, so its tombstones cannot be written`);
  }
  // RAI-309: the publish lock lives in each publication home, `libsql/<star>/.publish.lock`.
  const publishLocks = (base: string): string[] => { try { return readdirSync(join(base, "libsql")).map((n) => join(base, "libsql", n, ".publish.lock")); } catch { return []; } };
  const held = [
    ...heldLocks(join(legacy, "locks")), ...heldLocks(join(fresh, "locks")),
    ...[legacy, fresh].flatMap(publishLocks).map((p) => lockHolder(p)).filter((h): h is string => h !== null),
  ];
  if (held.length) throw refuse(`a lock has a live owner: ${held.join(", ")} — stop it first`);

  const log: string[] = [];
  mkdirSync(fresh, { recursive: true });
  for (const e of ENTRIES) {
    const from = join(legacy, e), to = join(fresh, e);
    if (todo.has(e)) {
      try { renameSync(from, to); } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        throw refuse(`renaming ${from} → ${to} failed (${code}); nothing was copied — fix it and rerun`);
      }
      log.push(`moved ${from} → ${to}`);
      if (opts.crashAfter === e) process.kill(process.pid, "SIGKILL");
    }
    if (TOMBSTONED.has(e) && !isTombstone(from)) {
      writeTombstone(from, to);
      log.push(`tombstoned ${from}`);
    }
  }
  log.push(`the funes home is ${fresh}`);
  return log;
}
