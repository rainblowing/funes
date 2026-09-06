// The MACHINE-STATE file (PLAN-0.3.0 item 17) and the OPERATOR-FACING STATE CONTRACT (item 20).
//
// Machine state is the small set of facts that are true of THIS MACHINE about an index, and of no
// other machine — chiefly "did this machine author these rows, or did they arrive from somewhere
// else". It cannot live in the database (the database is the thing that travels) and it cannot live
// in the vault or the publication home (both are synced or shared, and a replica would inherit
// another machine's answer as its own). So it lives beside the write lock, in machine-local state,
// keyed the way the write lock keys its resource.
//
// The two traps this file exists to avoid, both named by adversarial review:
//   1. An "authored here" marker that OUTLIVES the database it describes. Binding to a PATH is what
//      does it: the path is unchanged when a different database replaces the file at it (a publish
//      swap, a restored backup, a copied index), so the marker survives a substitution it should
//      have failed. `boundTo` is therefore an IMMUTABLE identity from INSIDE the database — its
//      publication id, or, where none exists, the random instance id stamped at init.
//   2. A read that DEGRADES to optimism. Absent, unreadable, wrong version, or bound to something
//      else all mean UNKNOWN, and unknown is never "authored here". A crash mid-write lands in
//      exactly one of those cases, which is why the writer is temp → fsync → rename → fsync dir:
//      the same ordering publication already uses, so a torn write is an absent file, never a
//      half-parsed one.
//
// Scope: libsql only, per the item. Postgres is a server tier with no machine-local home to bind
// to; the reader simply reports unknown there, which is the truthful answer rather than a fiction.
import { closeSync, existsSync, mkdirSync, openSync, fsyncSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { FunesIndexStore, IndexStats } from "funes-core";
import { ownStarExpectation } from "./scope.ts";
import { activeOverrides, type OverrideFinding } from "./doctor.ts";

/** The persisted shape. `v` is its OWN version, independent of the index schema and of the
 *  generation encoding (review R2 #8: three things that change for three different reasons must not
 *  share one version number). An unknown `v` is unknown, never best-effort parsed. */
export interface MachineState {
  v: 1;
  /** The IMMUTABLE database identity this state describes: `publicationId ?? instanceId`. */
  boundTo: string;
  /** Did THIS machine build these rows? Never inferred, only recorded by the build that did it. */
  authoredHere: boolean;
  /** The desired scope in force when it was recorded — so a scope change since is legible. */
  desiredScopeHash: string | null;
  at: string;
}

/** The read result. `unknown` carries WHY, because "no machine state" and "machine state for a
 *  database that is no longer here" are different operator situations with different remedies. */
export type MachineStateRead =
  | { kind: "unknown"; reason: string }
  | { kind: "known"; state: MachineState };

const STATE_FILE = "machine-state.json";

/** Machine-local state root. `$FUNES_STATE_DIR` overrides; the default sits beside the lock home
 *  (`~/.twinkling/locks`) rather than inside the vault or a publication home, because both of those
 *  are synced or shared and this is the one fact that must NOT travel. Keyed exactly as the write
 *  lock keys its resource — basename plus a 10-hex path digest — so two stars that happen to share
 *  a folder name get distinct state. */
export function stateDirFor(vault: string): string {
  const abs = resolve(vault);
  const h = createHash("sha256").update(abs).digest("hex").slice(0, 10);
  const root = process.env.FUNES_STATE_DIR || join(homedir(), ".twinkling", "state");
  return join(root, `${basename(abs)}-${h}`);
}

/** The immutable identity machine state binds to: the publication id when the database has one,
 *  else its random instance id. NEVER a path — see the header. `null` when the database can offer
 *  neither, in which case there is nothing honest to bind to and no state is written. */
export async function bindingIdOf(store: FunesIndexStore): Promise<string | null> {
  const identity = await store.contentIdentity();
  if (identity.publicationId) return identity.publicationId;
  return await store.instanceId();
}

/** Read this machine's state for `vault`, valid ONLY for the database identified by `boundTo`.
 *
 *  Every failure is the same answer — unknown — and unknown is treated conservatively everywhere:
 *  absent, unreadable, unparseable, an unknown `v`, a malformed record, or a `boundTo` naming a
 *  different artefact. The last case is the load-bearing one: it is how a swapped-in database is
 *  recognized as a stranger rather than inheriting the predecessor's "authored here". */
export function readMachineState(vault: string, boundTo: string | null): MachineStateRead {
  const path = join(stateDirFor(vault), STATE_FILE);
  if (!existsSync(path)) return { kind: "unknown", reason: "no machine-state file on this machine" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { kind: "unknown", reason: `machine-state file is unreadable (${(e as Error).message})` };
  }
  const o = parsed as Partial<MachineState> | null;
  if (!o || typeof o !== "object") return { kind: "unknown", reason: "machine-state file is not an object" };
  if (o.v !== 1) return { kind: "unknown", reason: `machine-state version ${JSON.stringify(o.v)} is not readable by this build` };
  if (typeof o.boundTo !== "string" || typeof o.authoredHere !== "boolean" || typeof o.at !== "string") {
    return { kind: "unknown", reason: "machine-state file is malformed (missing boundTo/authoredHere/at)" };
  }
  if (boundTo == null) return { kind: "unknown", reason: "this index offers no publication id and no instance id to bind to" };
  if (o.boundTo !== boundTo) {
    return { kind: "unknown", reason: `machine state is bound to ${o.boundTo}, but this index is ${boundTo} — a different database is at this path` };
  }
  return {
    kind: "known",
    state: {
      v: 1,
      boundTo: o.boundTo,
      authoredHere: o.authoredHere,
      desiredScopeHash: typeof o.desiredScopeHash === "string" ? o.desiredScopeHash : null,
      at: o.at,
    },
  };
}

/** Write it: temp → fsync the temp → rename → fsync the DIRECTORY. Publication's existing ordering,
 *  and all four steps matter — a rename is atomic but only durable once the directory entry is
 *  flushed, so skipping the last fsync can lose the whole file to a power cut while leaving the
 *  data blocks behind it intact. A crash at any point leaves the OLD file or NO file; never half a
 *  record, which the reader would have to guess about. */
export function writeMachineState(vault: string, state: Omit<MachineState, "v" | "at"> & { at?: string }): void {
  const dir = stateDirFor(vault);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, STATE_FILE);
  // pid AND randomBytes, matching publication.ts's temp names. The pid alone is not unique WITHIN a
  // process: two writers in one process (a face and an embedded publisher, or two vaults sharing a
  // state dir) collide on the same temp path, and the loser's partial bytes get renamed over the
  // winner's — a torn record the reader would have to guess about, which is trap 2 above.
  const tmp = join(dir, `.${STATE_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const body: MachineState = {
    v: 1,
    boundTo: state.boundTo,
    authoredHere: state.authoredHere,
    desiredScopeHash: state.desiredScopeHash ?? null,
    at: state.at ?? new Date().toISOString(),
  };
  try {
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
    const fd = openSync(tmp, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
    // BEST-EFFORT, like publication.ts's fsyncPath and for the same reason: some platforms and
    // filesystems (directory fsync on older macOS, network mounts) reject an fsync on a directory
    // outright. Rethrowing turned a durability IMPROVEMENT into the failure of a write that had
    // already succeeded — the rename is atomic and visible whether or not the entry is flushed —
    // and the catch below would then have deleted nothing while the caller saw an error for a file
    // that is on disk. The file fsync above is NOT best-effort: it guards the bytes themselves.
    let dfd: number | undefined;
    try { dfd = openSync(dir, "r"); fsyncSync(dfd); } catch { /* fs does not support it */ }
    finally { if (dfd !== undefined) closeSync(dfd); }
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

// ── item 20: the operator-facing state contract ────────────────────────────────────────────────

/** Everything an operator needs to answer "what is this process serving, and is it what I asked
 *  for" — in ONE shape, computed ONCE, so `health` (JSON) and `doctor` (text) cannot drift into two
 *  different accounts of one machine. Before this, `health` carried three of these fields and
 *  `doctor` none, so the two questions that actually strand an operator — has my scope drifted, and
 *  did this machine build this index — were answerable from neither. */
export interface OperatorState {
  /** The schema stamped IN the database, or null where the backend persists none. */
  schemaVersion: string | null;
  publicationId: string | null;
  contentGeneration: string | null;
  /** False whenever there is no content generation to trust — never stamped, a legacy v1 stamp,
   *  invalidated by a mutation, or a build in flight. `invalidatedAt`/`Reason` say which. */
  generationValid: boolean;
  invalidatedAt: string | null;
  invalidatedReason: string | null;
  /** THIS process's serving signature — process-local, reported, never published as authority. */
  servingSignature: string;
  /** The scope the ROWS were built under (replicated: it describes them, so it travels). */
  builtScopeHash: string | null;
  /** The scope THIS machine's live star.yaml asks for now (local). Null when no policy is declared
   *  (configless vault) or the manifest cannot be read — `scopeRefusal` then says which. */
  desiredScopeHash: string | null;
  /** Null when there is no declared policy to compare against; never conflated with false. */
  scopeMatches: boolean | null;
  /** Set when the desired scope cannot be established at all (an invalid manifest). */
  scopeRefusal: string | null;
  /** True when the built rows bypassed index_scope (`reindex --ignore-scope`). */
  ignoreScope: boolean;
  /** "building" while a full reindex holds the dirty marker; "built" otherwise. */
  buildState: "building" | "built";
  /** The machine-state binding, INCLUDING its unknown case with the reason. */
  machineState:
    | { kind: "unknown"; reason: string }
    | { kind: "known"; boundTo: string; authoredHere: boolean; desiredScopeHash: string | null; at: string };
  /** Every standing exception to a safety rule on this machine (item 23). */
  overrides: OverrideFinding[];
}

/** Assemble it. `stats` is passed in rather than re-fetched: both callers already hold one, and a
 *  second `stats()` round-trip could describe a different moment than the numbers beside it. */
export async function operatorState(
  store: FunesIndexStore,
  vault: string,
  stats: IndexStats,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OperatorState> {
  const expectation = ownStarExpectation(vault)();
  const desiredScopeHash = expectation && "hash" in expectation ? expectation.hash : null;
  const scopeRefusal = expectation && "refusal" in expectation ? expectation.refusal : null;
  const boundTo = await bindingIdOf(store);
  const read = readMachineState(vault, boundTo);
  return {
    schemaVersion: stats.schemaVersion,
    publicationId: stats.publicationId,
    contentGeneration: stats.contentGeneration,
    generationValid: stats.contentGeneration !== null,
    invalidatedAt: stats.invalidatedAt,
    invalidatedReason: stats.invalidatedReason,
    servingSignature: store.servingSignature(),
    builtScopeHash: stats.scopeHash,
    desiredScopeHash,
    // Tri-state on purpose: `null` is "there is no declared policy to compare against", which is a
    // different operator situation from "they disagree" and must not read as a passing check.
    scopeMatches: desiredScopeHash === null ? null : stats.scopeHash === desiredScopeHash && !stats.ignoreScope,
    scopeRefusal,
    ignoreScope: stats.ignoreScope,
    buildState: stats.reindexDirty ? "building" : "built",
    machineState: read.kind === "known"
      ? { kind: "known", boundTo: read.state.boundTo, authoredHere: read.state.authoredHere, desiredScopeHash: read.state.desiredScopeHash, at: read.state.at }
      : read,
    overrides: activeOverrides(env),
  };
}

/** The text rendering `doctor` prints. Deterministic — two runs over one index produce identical
 *  bytes, the property the audit report beside it already promises. */
export function formatOperatorState(s: OperatorState): string {
  const out: string[] = ["  state:"];
  out.push(`    schema ${s.schemaVersion ?? "unknown"}   build ${s.buildState}   serving-signature ${s.servingSignature}`);
  out.push(`    publication ${s.publicationId ?? "none"}`);
  out.push(`    content generation ${s.contentGeneration ?? "NONE"}${s.generationValid ? "" : " (INVALID)"}`);
  if (!s.generationValid && s.invalidatedAt) out.push(`      invalidated ${s.invalidatedAt}: ${s.invalidatedReason ?? "no reason recorded"}`);
  else if (!s.generationValid && s.invalidatedReason) out.push(`      ${s.invalidatedReason}`);
  out.push(`    built scope ${s.builtScopeHash ?? "none"}   desired ${s.desiredScopeHash ?? (s.scopeRefusal ? "UNREADABLE" : "undeclared")}` +
    `   ${s.scopeMatches === null ? "(nothing declared to compare)" : s.scopeMatches ? "agree" : "DISAGREE"}`);
  if (s.scopeRefusal) out.push(`      ${s.scopeRefusal}`);
  if (s.ignoreScope) out.push("      built with --ignore-scope: index_scope was NOT applied to these rows");
  out.push(s.machineState.kind === "known"
    ? `    machine state: bound to ${s.machineState.boundTo}, authored here: ${s.machineState.authoredHere}, recorded ${s.machineState.at}`
    : `    machine state: UNKNOWN — ${s.machineState.reason} (treated as NOT authored here)`);
  return out.join("\n");
}
