// `funes home move` (PLAN-0.5.0 item 8, ADR-0016, record 33): move the legacy funes home
// (`~/.twinkling`) to `~/.funes`, offline. It renames and never copies, symlinks or merges, and it
// never reads a FUNES_* override: an override still pointing into the old home fails closed on the
// tombstones, which is the walk's cue to rewrite the pin.
//
// Order binds (record 33): `models/`, `funes-cap`, `endpoints.json`, `locks/`, `state/`, `libsql/`
// last. Right after each of `locks/`, `state/` and `libsql/` is renamed, a plain tombstone file takes
// its old path, so a 0.4.x process (or a 0.5.0 one that memoized the old home) fails closed —
// EEXIST/ENOTDIR on its next mkdir — between renames. A rerun skips what already moved, so a crash
// anywhere is finished by running the command again; meanwhile, from the first rename on, both homes
// count as holding state and the resolver refuses every 0.5.0 process, so none re-creates a moved
// entry in the old home for the rerun to refuse to merge.
import { accessSync, constants, lstatSync, mkdirSync, renameSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { heldLocks, homeCandidates, writeTombstone } from "funes-shared";

const ENTRIES = ["models", "funes-cap", "endpoints.json", "locks", "state", "libsql"] as const;
const TOMBSTONED = new Set<string>(["locks", "state", "libsql"]);

const exists = (p: string): boolean => { try { lstatSync(p); return true; } catch { return false; } };
const isTombstone = (p: string): boolean => { try { return lstatSync(p).isFile(); } catch { return false; } };
const refuse = (why: string): Error => new Error(`funes: home move refused — ${why}`);

/** The reader sweep of the entries about to move — the same three lists as walk-locus.sh
 *  `readers()`: engine processes running from `enginePath` (an idle session MCP holds nothing open,
 *  so only pgrep sees it), `lsof` on each entry (`+D` for a directory), and holders of an unlinked
 *  file under one (`+L1`, which `+D` cannot see). Only the moved entries: twinkl.ing's own files in
 *  the old home (`cc-sessions/`, `walks/`, …) stay where they are and may stay open.
 *  Returns the pids found other than this process; an incomplete scan throws — it is not empty. */
function readerSweep(paths: string[], enginePath: string): number[] {
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (r.error) throw refuse(`the reader sweep is incomplete: ${cmd} did not run (${r.error.message})`);
    return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
  };
  const pids = new Set<number>();
  const take = (lines: string) => { for (const l of lines.split("\n")) if (/^\d+$/.test(l.trim())) pids.add(Number(l.trim())); };

  const pg = run("pgrep", ["-f", enginePath]);
  if (pg.code > 1) throw refuse(`the reader sweep is incomplete: pgrep exited ${pg.code}`);
  take(pg.out);
  // lsof exits 1 both for "nothing open" and for an error; with warnings silenced (-w), stderr is the error.
  for (const p of paths) {
    const d = run("lsof", ["-w", "-t", ...(lstatSync(p).isDirectory() ? ["+D"] : []), p]);
    if (d.code !== 0 && d.err.trim()) throw refuse(`the reader sweep is incomplete: lsof ${p}: ${d.err.trim()}`);
    take(d.out);
  }
  const u = run("lsof", ["-w", "-nP", "-F", "pn", "+L1"]);
  if (u.code !== 0 && u.err.trim()) throw refuse(`the reader sweep is incomplete: lsof +L1: ${u.err.trim()}`);
  let pid = "";
  for (const l of u.out.split("\n")) {
    if (l.startsWith("p")) pid = l.slice(1);
    else if (l.startsWith("n") && paths.some((p) => l.slice(1) === p || l.slice(1).startsWith(p + "/"))) take(pid);
  }
  pids.delete(process.pid);
  return [...pids].sort((a, b) => a - b);
}

export interface MoveOptions {
  /** The engine path the sweep's pgrep list matches (default: this engine's own source dir). */
  enginePath?: string;
  /** Crash-point seam (record 35 N6): SIGKILL this process right after renaming this entry, before
   *  its tombstone. Tests only — the CLI never passes it, nor `enginePath`. */
  crashAfter?: string;
}

/** Move the legacy home into `~/.funes`. Returns one line per action; throws on every refusal. */
export function moveHome(opts: MoveOptions = {}): string[] {
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
  const held = [...heldLocks(join(legacy, "locks")), ...heldLocks(join(fresh, "locks"))];
  if (held.length) throw refuse(`a lock has a live owner: ${held.join(", ")} — stop it first`);
  const readers = readerSweep([...todo].map((e) => join(legacy, e)), opts.enginePath ?? import.meta.dir);
  if (readers.length) throw refuse(`the reader sweep of ${legacy}/{${[...todo].join(",")}} found pid(s) ${readers.join(", ")} — stop them first`);

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
