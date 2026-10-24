#!/usr/bin/env bun
// The edge cluster's own entry (PLAN-0.6.0 B1, RAI-303): the taste replica, its outbox and the seed
// left the funes CLI and the npm bin. A dormant 1.0.0 edge process, run from a funes checkout:
//   bun packages/funes-cf/replica/cli.ts replica|outbox|seed …
// The branches are the 0.5.0 `funes replica`, `funes outbox` and `funes seed` verbs, unchanged.
import { existsSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse, type Command } from "../../funes-engine/src/cli-parse.ts";
import { processLocus } from "../../funes-engine/src/process-locus.ts";
import { parseDuration } from "../../funes-engine/src/publication.ts";

const USAGE = `usage: bun packages/funes-cf/replica/cli.ts <command> [options]

  replica   --vault <~/taste> [--once] [--interval 5s]
              the taste replica on its proposer machine: each tick pulls R2 into the read-only canon
              mirror (state dir canon/), reconciles the folder from it, publishes the mirror, scans
              the folder for edits and drains the outbox. Pull entry and credentials from the
              writer-endpoint file. --once is one tick (the seed's done gate). Exit 2 on a refusal
              (any S3_*/AWS_* variable set, a path in a synced or versioned tree, a mis-mapped bucket).
  outbox    [--vault <replica>] [show <id> | dismiss <id> | approve <path> | resend <id>]
              list this replica's proposals (pending, held, refused, expired) and name an endpoint
              halted by a 401/403. The verbs only mark a record: the replica acts on the mark.
              dismiss moves the record to dismissed/; resend re-sends an expired one under a new id.
  seed      --star <meta.id> --digest <sha256> [--vault <replica, default ~/taste>]   (TASTE_OUT=<dir>)
              send the converter's approved pages to the star's writer: refuses unless TASTE_OUT/out
              lies outside every synced or versioned tree, hashes to --digest, and every input has
              its manifest sha256. One create-once put_page per new page, a replace with base per
              changed one, removed items listed; drains its own enqueues until none is pending.
  seed --check [--vault <replica, default ~/taste>]   (TASTE_OUT=<dir>)
              the done gate, after replica --once: refuses unless every page is applied with
              nothing refused, the edge's node count is the page count, the canon mirror equals out/
              byte for byte, and every map still has its manifest sha256.
  seed --stub [--vault <replica, default ~/taste>]   (TASTE_OUT=<dir>)
              the stub step, where the write rule allows (exit 3 elsewhere) and only
              while the done gate passes: each map's pre-image under .history/, then a link page to
              the taste star in its place. A re-run finds the stubs and does nothing; reindex after it.`;

// A throw is a sentence, not a stack trace (the funes CLI's rule; writeSync: a piped stderr is async).
for (const ev of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(ev, (err: unknown) => {
    try { writeSync(2, `${(err as Error)?.message ?? String(err)}\n`); } catch { /* stderr already gone */ }
    process.exit(1);
  });
}

// RAI-317 Q10: the one funes parser, with this entry's own table (an internal workspace import).
const TABLE: Command[] = [
  { verb: "replica", flags: { vault: { type: "string" }, once: { type: "boolean" }, interval: { type: "string" } } },
  { verb: "outbox", positionals: 2, flags: { vault: { type: "string" } } },
  { verb: "seed", flags: { vault: { type: "string" }, star: { type: "string" }, digest: { type: "string" }, check: { type: "boolean" }, stub: { type: "boolean" } } },
];
const parsed = parse(process.argv.slice(2), TABLE);
if (parsed.kind === "help") {
  console.log(USAGE);
  process.exit(parsed.code);
}
if (parsed.kind === "error") {
  writeSync(2, `${parsed.message}\n\n${USAGE}\n`);
  process.exit(2);
}
const cmd = parsed.cmd.verb;
const flag = (name: string): string | undefined => parsed.values[name] as string | undefined;
const has = (name: string) => parsed.values[name] === true;
const positional = (n: number): string | undefined => parsed.positionals[n - 1];
/** `--vault` defaults to the current directory, and a path that is not there is a refusal. */
const vaultArg = (): string => {
  const v = resolve(flag("vault") ?? process.cwd());
  if (!existsSync(v) || !statSync(v).isDirectory()) { writeSync(2, `--vault ${v} is not a directory\n`); process.exit(2); }
  return v;
};
const tasteArg = () => resolve(flag("vault") ?? join(homedir(), "taste"));
const EXIT_REFUSED = 3;

if (cmd === "replica") {
  // PLAN-0.5.0 item 32 (record 29): the S3_*/AWS_* refusal comes before anything is read.
  const { refuseS3Env, runReplica, ReplicaRefusal } = await import("./replica.ts");
  try { refuseS3Env(); } catch (e) {
    if (!(e instanceof ReplicaRefusal)) throw e;
    writeSync(2, `replica: refused: ${e.message}\n`);
    process.exit(2);
  }
  const taste = vaultArg();
  const intervalMs = parseDuration("--interval", flag("interval")) ?? 5_000;
  if (intervalMs <= 0) { writeSync(2, "replica --interval must be positive\n"); process.exit(2); }
  process.exit(await runReplica({ taste, once: has("once"), intervalMs }));
} else if (cmd === "outbox") {
  // PLAN-0.5.0 item 30 (ADR-0010 §Revision, record 29 §4c): the listing and the marks. None of them
  // sends: the replica acts on a mark (record 29 §4b), so it and the seed stay the only enqueuers.
  const vault = vaultArg();
  const ob = await import("./outbox.ts");
  const dir = ob.outboxDirFor(vault);
  const sub = positional(1);
  const arg = positional(2);
  const line = (r: import("./outbox.ts").OutboxRecord) =>
    `  ${r.proposalId}  ${r.status}${r.mark ? ` (${r.mark} marked)` : ""}  ${r.op} ${String(r.args.path ?? "")}` +
    `${r.answer?.reason ? `  ${r.answer.reason}${r.answer.currentHash ? ` current ${r.answer.currentHash}` : ""}` : ""}` +
    `${r.lastError ? `  last error: ${r.lastError} (attempt ${r.attempts})` : ""}`;
  try {
    if (sub === undefined) {
      const { records, dismissed, halt } = ob.listOutbox(dir);
      if (halt) console.log(`endpoint HALTED: HTTP ${halt.status} at ${halt.at} — the outbox token is refused; nothing is marked refused`);
      for (const r of records) console.log(line(r));
      console.log(`outbox ${dir}: ${records.length} record(s), ${dismissed.length} dismissed`);
    } else if (sub === "show" && arg) {
      console.log(JSON.stringify(ob.showRecord(dir, arg), null, 2));
    } else if (sub === "dismiss" && arg) {
      ob.dismiss(dir, arg);
      console.log(`dismissed ${arg} (kept under ${join(dir, "dismissed")})`);
    } else if (sub === "approve" && arg) {
      console.log(`marked approved: ${ob.approve(dir, arg).proposalId} — the replica sends it`);
    } else if (sub === "resend" && arg) {
      ob.resend(dir, arg);
      console.log(`marked to resend: ${arg} — the replica sends it under a new id`);
    } else {
      console.error("usage: outbox [--vault <replica>] [show <id> | dismiss <id> | approve <path> | resend <id>]");
      process.exit(2);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
} else if (cmd === "seed" && has("check")) {
  // PLAN-0.5.0 item 49: the done gate, after `replica --once` (runbook R16).
  const out = process.env.TASTE_OUT;
  if (!out) {
    console.error("usage: TASTE_OUT=<dir> … seed --check [--vault <replica, default ~/taste>]");
    process.exit(2);
  }
  const { seedCheck } = await import("./seed.ts");
  try {
    const fail = await seedCheck({ vault: tasteArg(), outHome: resolve(out) });
    if (fail.length) {
      console.error(`seed --check REFUSED:\n${fail.map((f) => `  ${f}`).join("\n")}`);
      process.exit(1);
    }
    console.log("seed --check: every page applied, nothing refused, the edge holds one node per page, the mirror equals out/, every map is the manifest's");
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
} else if (cmd === "seed" && has("stub")) {
  // PLAN-0.5.0 item 50: the stub step, after the done gate (runbook R17). Opens no index: reindex follows.
  const out = process.env.TASTE_OUT;
  if (!out) {
    console.error("usage: TASTE_OUT=<dir> … seed --stub [--vault <replica, default ~/taste>]");
    process.exit(2);
  }
  let locus: string | null;
  try { locus = processLocus(); } catch (e) { writeSync(2, `${(e as Error).message}\n`); process.exit(2); }
  const { stubMaps } = await import("./seed.ts");
  try {
    const r = await stubMaps({ vault: tasteArg(), outHome: resolve(out), locus: locus ?? undefined });
    for (const p of r.stubbed) console.log(`  stubbed: ${p} (pre-image under .history/)`);
    for (const p of r.already) console.log(`  already a stub: ${p}`);
    console.log(r.stubbed.length
      ? `seed --stub: ${r.stubbed.length} map(s) now link pages — reindex the personal star next (incremental: the stubs re-embed)`
      : "seed --stub: every map is already a stub — nothing to do");
  } catch (e) {
    console.error((e as Error).message);
    const err = e as { refused?: boolean; code?: string };
    process.exit(err.refused || err.code === "not-write-locus" ? EXIT_REFUSED : 1);
  }
} else if (cmd === "seed") {
  // PLAN-0.5.0 item 48: the approved seed, the one enqueuer beside the replica (record 29 §4b).
  const star = flag("star");
  const digest = flag("digest");
  const out = process.env.TASTE_OUT;
  if (!star || !digest || !/^[0-9a-f]{64}$/.test(digest) || !out) {
    console.error("usage: TASTE_OUT=<dir> … seed --star <meta.id> --digest <sha256> [--vault <replica, default ~/taste>]");
    process.exit(2);
  }
  const { seed } = await import("./seed.ts");
  try {
    const r = await seed({ star, digest, vault: tasteArg(), outHome: resolve(out) });
    console.log(`seed ${star}: ${r.created} create-once, ${r.replaced} replace, ${r.unchanged} unchanged; ${r.applied} applied, ${r.refused.length} refused, ${r.expired.length} expired`);
    for (const x of r.refused) console.log(`  refused ${x.reason}: ${x.path} — outbox lists it`);
    for (const p of r.removed) console.log(`  removed from the converter's output, still at the writer (put_page cannot delete; Vlad decides): ${p}`);
    if (r.refused.length || r.expired.length) process.exit(1);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
