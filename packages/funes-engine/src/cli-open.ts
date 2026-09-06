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
import { dirname, resolve } from "node:path";
import type { Embedder } from "funes-core";
import { funesDbDir, makeStore } from "./factory.ts";
import { FunesStore } from "./funes-store.ts";
import type { FunesIndexStore } from "./store.ts";
import type { Reranker } from "./rerank.ts";
import { daemonProbe, DEFAULT_DAEMON_PORT } from "./daemon-client.ts";
import { resolveWriteActor } from "./actor.ts";
import { authorizeCanonicalWrite, reportWriteDecision, resolveWriteDesignation } from "./write-designation.ts";
import { withPublicationFence } from "./publication.ts";

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
 *  `--actor` flag (FUNES_ACTOR is read by the resolver when it is absent). */
export async function openMutator(vault: string, op: string, opts: CliOpenOpts & { actor?: string } = {}): Promise<CliMutator> {
  // item 25, resolved ONCE and BEFORE the store: a misspelled FUNES_WRITE_DESIGNATION is a startup
  // failure here as it is on the stdio server (mcp-server.ts) — before stdin is read for a body
  // and before an embedder exists — not a throw after the markdown was half-prepared.
  const designation = resolveWriteDesignation(vault);
  // item 24: `--actor` over FUNES_ACTOR, through the SAME resolver the HTTP face uses (face.ts).
  // No mapping file: a capability-to-actor map is a face concern — a terminal has an operator, not
  // a presented credential.
  const actor = resolveWriteActor({ actor: opts.actor });
  // The audit line is written BEFORE the store call, as dispatchToolCall does for every served
  // surface. 0.3.0 ships `audit`, so the decision is reported and the write proceeds; the `enforce`
  // refusal, when the estate declares write_authority everywhere, lands here and in dispatchToolCall.
  reportWriteDecision(authorizeCanonicalWrite(designation, { op, vault, actor }));
  await refuseIfDaemon(vault);
  const store = await makeStore({ vault, dbDir: opts.dbDir, embedder: opts.embedder, writeActor: actor });
  const home = dirname(funesDbDir(vault, "libsql"));
  return {
    funes: new FunesStore(store, { root: vault }),
    actor,
    fenced: (fn) => withPublicationFence(home, fn),
  };
}
