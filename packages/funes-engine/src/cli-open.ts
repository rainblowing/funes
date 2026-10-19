// The CLI's two store openers (0.3.0 items 24 + 25 on the CLI; RAI-148). Factored out of cli.ts —
// which dispatches its command at module load and so cannot be imported by a test — into the one
// seam where the two postures the plan names are told apart by TYPE rather than by call site:
//
//   openIndex    a MAINTENANCE or READ open (reindex, query). It has no actor parameter at all: a
//                full reindex re-remembers every live file, and the store's coalesce preserves a
//                stamped write_actor only because the maintenance opener stamps none
//                (provenance.test.ts pins that). Adding an actor here would make routine maintenance
//                rewrite every row's attribution to whoever ran it.
//   openMutator  the SIX canonical mutators (remember, supersede, link, forget, elevate,
//                grandfather). Resolves the writer designation and the trusted actor ONCE, reports
//                the authorization decision BEFORE the store is opened, hands the actor to the store
//                constructor — the seam that already refused to take one from anywhere else — and
//                returns the fence the canonical write must run under.
//
// The six do NOT go through dispatchToolCall, on purpose: elevation is forbidden in the registry
// (ops.ts createRegistry), link and grandfather are local-only verbs, and `remember --source`
// carries metadata the op schema lacks. So the authorization boundary ADR-0005 wants in one place
// is here for the CLI and in dispatchToolCall for every served surface — two call sites of one
// function, not two rules.
import { writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Embedder, PageStatRecord } from "funes-core";
import { funesDbDir, makeStore } from "./factory.ts";
import { FunesStore } from "./funes-store.ts";
import type { FunesIndexStore } from "./store.ts";
import type { Reranker } from "./rerank.ts";
import { daemonProbe, DEFAULT_DAEMON_PORT } from "./daemon-client.ts";
import { resolveWriteActor } from "./actor.ts";
import { assertWriteAllowed, authorizeCanonicalWrite, reportWriteDecision, resolveWriteDesignation } from "./write-designation.ts";
import { withPublicationFence } from "./publication.ts";
import { vaultChangedSince } from "./reindex.ts";
import { FolderVault } from "./folder-vault.ts";
import { readIndexScopeExcludes } from "./scope.ts";

export interface CliOpenOpts {
  /** `--db`: an explicit index path; absent ⇒ funesDbDir(vault). */
  dbDir?: string;
  allowDirty?: boolean;
  reranker?: Reranker;
  /** Tests only: a fake embedder, so an open followed by a write never loads the E5 model. */
  embedder?: Embedder;
}

// PGLite is single-connection: when the S2 daemon holds this vault's pgdata, direct opens
// must refuse (twinkling's wrappers route reads through the daemon; raw CLI ops stop here).
export async function refuseIfDaemon(vault: string): Promise<void> {
  const port = Number(process.env.FUNES_DAEMON_PORT ?? DEFAULT_DAEMON_PORT);
  // `resolve` because the probe compares the daemon's vault path to this one by string: cli.ts
  // always hands over a resolved path, but these two openers are exported and a relative one must
  // not silently miss a running daemon.
  if (await daemonProbe(port, resolve(vault))) {
    console.error(`the funes daemon is running for this vault (port ${port}) and owns its PGLite handle — stop it first.`);
    process.exit(2);
  }
}

/** The maintenance / read open. NO actor, ever — see the header. */
export async function openIndex(vault: string, opts: CliOpenOpts = {}): Promise<FunesIndexStore> {
  await refuseIfDaemon(vault);
  return makeStore({ vault, dbDir: opts.dbDir, allowDirty: opts.allowDirty, reranker: opts.reranker, embedder: opts.embedder });
}

export interface CliMutator {
  funes: FunesStore;
  /** The actor every write through `funes` stamps — reported here so a caller can say it. */
  actor: string;
  /** Item 9's fence, keyed on the vault's DEFAULT publication home — the directory `publish` resolves
   *  when no `--home` is given (cli.ts), so a CLI mutation and a default-homed publish contend on
   *  ONE lock, exactly as the broker face and the publisher do (face.ts). Reentrant with
   *  FunesStore's own coordination frame (same async owner).
   *
   *  ponytail: home-keyed, so a publish with an explicit NON-default --home takes a different fence
   *  and this mutation is serialized against it by nothing. The vault-keyed fence taken before the
   *  home fence, which closes that, is RAI-150 (0.4.0). */
  fenced<T>(fn: () => Promise<T>): Promise<T>;
}

/** The canonical mutators' open. `op` names the mutation for the audit line; `actor` is the
 *  `--actor` flag (FUNES_ACTOR is read by the resolver when it is absent), and `locus` the `--locus`
 *  flag (FUNES_LOCUS likewise, PLAN-0.4.0 item 10). */
export async function openMutator(vault: string, op: string, opts: CliOpenOpts & { actor?: string; locus?: string } = {}): Promise<CliMutator> {
  // item 25, resolved ONCE and BEFORE the store: a misspelled FUNES_WRITE_DESIGNATION — or a refused
  // locus or write_locus — is a startup failure here as it is on the stdio server (mcp-server.ts),
  // before stdin is read for a body and before an embedder exists, not a throw after the markdown
  // was half-prepared.
  const designation = resolveWriteDesignation(vault, { locus: opts.locus });
  // item 24: `--actor` over FUNES_ACTOR, through the SAME resolver the HTTP face uses (face.ts).
  // No mapping file: a capability-to-actor map is a face concern — a terminal has an operator, not
  // a presented credential.
  const actor = resolveWriteActor({ actor: opts.actor });
  // The audit line is written BEFORE the store call, as dispatchToolCall does for every served
  // surface, and a refused decision (a `mismatch`, a proposer machine — item 29) throws here, before
  // the daemon probe and the store.
  const decision = authorizeCanonicalWrite(designation, { op, vault, actor });
  reportWriteDecision(decision);
  assertWriteAllowed(decision, op);
  await refuseIfDaemon(vault);
  const store = await makeStore({ vault, dbDir: opts.dbDir, embedder: opts.embedder, writeActor: actor });
  const home = dirname(funesDbDir(vault, "libsql"));
  return {
    funes: new FunesStore(store, { root: vault }),
    actor,
    fenced: (fn) => withPublicationFence(home, fn),
  };
}

/** One stderr line whenever a command is about to succeed while telling the user nothing. Silence
 *  and "no results" are indistinguishable at exit 0, and the staleness case is worse than useless:
 *  it is how an agent confidently cites content the vault has already superseded. */
// 0.3.0 item 18: `store` is here for the deletion half of the freshness question. Every one of the
// five call sites passed `vaultChangedSince` two arguments, so its `indexedIds` thunk was undefined
// and `?? []` made the comparison vacuous — a note DELETED since the last reindex left no file
// behind to be newer, so the CLI cheerfully reported a fresh index that could still serve the row.
// 0.4.0 item 6 (RAI-124): the thunk is the index's per-page stat record now, which answers both.
// Moved here from cli.ts (0.4.0 item 6 review): `funes query` is its only caller, and a spawned
// query EMBEDS the question — the model the suite may not load — so the branches below could not be
// reached by any test, and `if (f)` over the Freshness OBJECT (always truthy) type-checked. `write`
// is the test's seam; the CLI takes the stderr default.
export async function noteEmptyOrStale(
  store: { pageStats(): Promise<PageStatRecord | null> }, vault: string, st: { nodes: number; lastReindexAt: string | null },
  hits: number, q?: string, write: (line: string) => void = (line) => writeSync(2, line),
): Promise<void> {
  if (st.nodes === 0) {
    write(`funes: the index is empty — run \`funes reindex --vault ${vault}\` first\n`);
    return;
  }
  if (hits === 0) write(`funes: no hits${q ? ` for ${JSON.stringify(q)}` : ""} across ${st.nodes} indexed note(s)\n`);
  // The NaN case keeps its own message: vaultChangedSince folds "never reindexed" and "could not
  // walk the vault" into one null, and only the first of those has a useful instruction.
  const at = st.lastReindexAt ? Date.parse(st.lastReindexAt) : NaN;
  if (Number.isNaN(at)) {
    write(`funes: no full reindex recorded — freshness unknown (run reindex to stamp it)\n`);
  } else {
    const f = await vaultChangedSince(new FolderVault(vault), readIndexScopeExcludes(vault), async () => st.lastReindexAt, () => store.pageStats());
    if (f.changed) {
      write(`funes: notes have changed since the last reindex (${st.lastReindexAt}) — those edits are INVISIBLE to recall; run \`funes reindex --vault ${vault}\`\n`);
    } else if (f.basis === "none") {
      // An index built before the stat record existed: stamped, yet nothing to compare against.
      // Silence here would read as "fresh", which is the one answer freshness must never invent.
      write(`funes: this index records no per-page stats — freshness unknown (a full \`funes reindex --vault ${vault}\` records them)\n`);
    }
  }
}
