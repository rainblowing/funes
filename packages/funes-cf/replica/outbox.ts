// PLAN-0.5.0 item 30: the outbox (ADR-0010 §Revision "The outbox"; record 22 7a-7c; record 29 §4b,
// §4c, §6). Machine state under the funes home — `stateDirFor(<replica>)/outbox/`, never a vault, a
// replica or a synced folder. One `<proposalId>.json` per proposal, written BEFORE the first send
// (the transactional outbox), never holding a token. The writer endpoint for a star is the
// per-machine 0600 `endpoints.json` (ADR-0016), re-read on every pass, as is the token file it names.
//
// A pass: expire what is 7 days past its ULID time (the clock runs whether or not the writer is
// reachable), act on `resend` marks, then — only if something is due — read the writer's `health`
// and send nothing unless it names the proposal protocol, this star's `meta.id` and its
// `write_locus`. Proposals go oldest first, each on its own backoff (2 s → 30 s, the watcher's). A
// transport error, a timeout, a 5xx, a 429 or a reply without this proposal's id retries it; a 401 or
// 403 halts the endpoint and marks nothing refused. Applied and already-applied records are removed
// (the receipt is the writer's, the change arrives with the next pull); refused and expired ones stay
// until dismissed, and a dismissed record moves to `dismissed/`. `show`, `dismiss`, `approve` and
// `resend` only mark records: the resident process acts on the mark (record 29 §4b).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { isB64Token } from "funes-core/internal";
import { readOwnerOnly } from "../../funes-engine/src/actor.ts";
import { endpointFor } from "./endpoints.ts";
import { readStarIdentity } from "../../funes-engine/src/factory.ts";
import { CROCKFORD, ulidTime } from "funes-core/internal";
import { stateDirFor } from "../../funes-engine/src/funes-home.ts";
import { FUNES_VERSION } from "funes-core/internal";
import { atomicWriteFile } from "../../funes-engine/src/write.ts";
import { probeRefusal } from "../src/proposal-protocol.ts";

const DAY = 86_400_000;
/** ADR-0010: a sender retries for at most 7 days from the proposal's ULID time. */
export const OUTBOX_TTL_MS = 7 * DAY;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const RECORD = /^([0-7][0-9A-HJKMNP-TV-Z]{25})\.json$/;
const HALT = "halt.json";

export const outboxDirFor = (vault: string): string => join(stateDirFor(vault), "outbox");

/** A ULID minted at `nowMs`: 10 Crockford characters of time, 16 of randomness. */
export function mintUlid(nowMs: number): string {
  let t = "";
  for (let n = nowMs, i = 0; i < 10; i++, n = Math.floor(n / 32)) t = CROCKFORD[n % 32] + t;
  return t + [...randomBytes(16)].map((b) => CROCKFORD[b % 32]).join("");
}

// ── records ─────────────────────────────────────────────────────────────────────────────────────

/** ADR-0010's answer. */
export interface ProposalAnswer { proposalId: string; status: string; reason?: string; currentHash?: string; writtenHash?: string }

export type OutboxStatus = "pending" | "held" | "refused" | "expired";

export interface OutboxRecord {
  v: 1;
  proposalId: string;
  starId: string;
  op: string;
  /** The op's arguments, the base among them; never the proposal id, which is added at send. */
  args: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  /** ms since the epoch; 0 = due now. */
  nextAttemptAt: number;
  lastError: string | null;
  answer: ProposalAnswer | null;
  /** Set by `funes outbox approve` (a held record) or `resend` (an expired one); the resident process acts on it. */
  mark?: "approve" | "resend";
  /** On a resent record moved to `dismissed/`: the proposal that re-sent it. */
  resentAs?: string;
  /** record 29 §4c: every local version saved at a held path after the refusal, kept before canon is restored. */
  captured?: string[];
}

const recordPath = (dir: string, id: string) => join(dir, `${id}.json`);
/** Write a record as it stands: the replica's own marks (a capture, an approve it cannot act on). */
export const saveRecord = (dir: string, r: OutboxRecord): void => save(dir, r);
const save = (dir: string, r: OutboxRecord) => { mkdirSync(dir, { recursive: true }); atomicWriteFile(recordPath(dir, r.proposalId), `${JSON.stringify(r, null, 2)}\n`); };

/** Put one proposal in the outbox: a new ULID minted on `nowMs`, the record on disk before anything
 *  is sent. `held` (a new file, record 29 §4d) waits for `approve`. Only the replica watcher and the
 *  approved seed call this (ADR-0010 §Revision). */
export function enqueue(dir: string, p: { starId: string; op: string; args: Record<string, unknown>; held?: boolean }, nowMs: number = Date.now()): OutboxRecord {
  const r: OutboxRecord = {
    v: 1, proposalId: mintUlid(nowMs), starId: p.starId, op: p.op, args: p.args,
    status: p.held ? "held" : "pending", attempts: 0, nextAttemptAt: 0, lastError: null, answer: null,
  };
  save(dir, r);
  return r;
}

/** record 29 §7: a file the replica cannot place (its manifest was lost and the bytes are not canon)
 *  is held as a refusal no writer gave — `unknown-base` — so §4c's capture, restore and `dismiss`
 *  merge apply to it. Nothing is sent. */
export function hold(dir: string, p: { starId: string; path: string; content: string; reason: string }, nowMs: number = Date.now()): OutboxRecord {
  const id = mintUlid(nowMs);
  const r: OutboxRecord = {
    v: 1, proposalId: id, starId: p.starId, op: "put_page", args: { path: p.path, content: p.content },
    status: "refused", attempts: 0, nextAttemptAt: 0, lastError: null, answer: { proposalId: id, status: "refused", reason: p.reason },
  };
  save(dir, r);
  return r;
}

export function readRecords(dir: string): OutboxRecord[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => RECORD.test(n)).sort().map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")) as OutboxRecord);
}

export interface Halt { status: number; at: string }

/** What `funes outbox` lists: every record, oldest first, and the endpoint's halt if one stands. */
export function listOutbox(dir: string): { records: OutboxRecord[]; dismissed: OutboxRecord[]; halt: Halt | null } {
  const halt = existsSync(join(dir, HALT)) ? JSON.parse(readFileSync(join(dir, HALT), "utf8")) as Halt : null;
  return { records: readRecords(dir), dismissed: readRecords(join(dir, "dismissed")), halt };
}

// ── the marks (`funes outbox show|dismiss|approve|resend`) ──────────────────────────────────────

function load(dir: string, id: string): OutboxRecord {
  if (!ULID.test(id) || !existsSync(recordPath(dir, id))) throw new Error(`outbox: no record ${JSON.stringify(id)}`);
  return JSON.parse(readFileSync(recordPath(dir, id), "utf8")) as OutboxRecord;
}

export function showRecord(dir: string, id: string): OutboxRecord {
  return load(dir, id);
}

/** Give a proposal up: its record moves to `dismissed/`, kept, never deleted. */
export function dismiss(dir: string, id: string): void {
  load(dir, id);
  mkdirSync(join(dir, "dismissed"), { recursive: true });
  renameSync(recordPath(dir, id), recordPath(join(dir, "dismissed"), id));
}

/** Mark the held record at `path` approved; the resident process checks and sends it (record 29 §4d). */
export function approve(dir: string, path: string): OutboxRecord {
  const r = readRecords(dir).find((x) => x.status === "held" && x.args.path === path);
  if (!r) throw new Error(`outbox: no held record at ${JSON.stringify(path)}`);
  r.mark = "approve";
  save(dir, r);
  return r;
}

/** Mark an expired record to be sent again, under a new id with the same base (record 29 §6). */
export function resend(dir: string, id: string): OutboxRecord {
  const r = load(dir, id);
  if (r.status !== "expired") throw new Error(`outbox: ${id} is ${r.status} — only an expired proposal is resent`);
  r.mark = "resend";
  save(dir, r);
  return r;
}

// ── the writer and the drain ────────────────────────────────────────────────────────────────────

/** One reply from the writer's served MCP surface: the op's JSON answer, an HTTP refusal status, or
 *  a failure with no answer (transport error, timeout, a tool error). */
export type WriterReply = { answer: Record<string, unknown> } | { http: number } | { error: string };
export interface Writer {
  call(op: string, args: Record<string, unknown>): Promise<WriterReply>;
  close(): Promise<void>;
}
export type WriterFactory = (entry: { url: string; token: string }) => Writer;

/** The real writer: MCP over streamable HTTP, `Authorization: Bearer` on every request (ADR-0016).
 *  The HTTP status is read off the fetch, so a 401/403 at any step — the version probe included —
 *  is named as such rather than as an SDK error. */
export const mcpWriter: WriterFactory = ({ url, token }) => {
  let status = 0;
  const timeoutMs = 30_000;
  const watched = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const r = await fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
    // the SDK's unawaited background GET (the SSE stream; the edge answers 405) is no call's failure
    if (r.status >= 400 && init?.method !== "GET") status = r.status;
    return r;
  };
  let client: Client | null = null;
  return {
    async call(op, args) {
      status = 0;
      try {
        if (!client) {
          const c = new Client({ name: "funes-outbox", version: FUNES_VERSION });
          await c.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: watched, requestInit: { headers: { authorization: `Bearer ${token}` } } }));
          client = c;
        }
        const r = await client.callTool({ name: op, arguments: args });
        const text = ((r.content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
        if (r.isError) return { error: text };
        return { answer: JSON.parse(text) as Record<string, unknown> };
      } catch (e) {
        return status ? { http: status } : { error: (e as Error).message };
      }
    },
    async close() { await client?.close().catch(() => {}); },
  };
};

export interface DrainResult {
  /** "ok", "idle" (nothing due, no probe), "halted", "unreachable", or the probe's refusal. */
  probe: string;
  applied: string[];
  refused: string[];
  expired: string[];
  retried: string[];
  resent: Array<{ from: string; to: string }>;
  halt: Halt | null;
  /** Each applied or refused proposal's answer with the path its args name: the replica's next base and its holds. */
  answers: Array<{ path: unknown; answer: ProposalAnswer }>;
}

/** The watcher's capped exponential backoff: 2 s, 4 s, … 30 s. */
export const backoff = (attempts: number) => Math.min(30_000, 2000 * 2 ** (attempts - 1));
const isHalt = (r: WriterReply): r is { http: number } => "http" in r && (r.http === 401 || r.http === 403);

/** One pass over one star's outbox (record 22 7b). `vault` is the replica folder whose `star.yaml`
 *  names the star and its write locus. `now` is the clock seam. */
export async function drain(o: { vault: string; dir?: string; endpointsPath?: string; now?: () => number; writer?: WriterFactory }): Promise<DrainResult> {
  const dir = o.dir ?? outboxDirFor(o.vault);
  const now = o.now ?? Date.now;
  const res: DrainResult = { probe: "idle", applied: [], refused: [], expired: [], retried: [], resent: [], halt: null, answers: [] };
  const identity = readStarIdentity(o.vault);
  if (!identity.id) throw new Error(`outbox: ${o.vault}/star.yaml names no meta.id — nothing to send to (fail-closed)`);
  const t = now();

  for (const r of readRecords(dir)) {
    if (r.status === "pending" && t - ulidTime(r.proposalId) >= OUTBOX_TTL_MS) {
      r.status = "expired";
      save(dir, r);
      res.expired.push(r.proposalId);
    } else if (r.status === "expired" && r.mark === "resend") {
      // an intentional repeat: a new id, the same op and base (ADR-0010 "Identity"); the old record is kept
      const next = enqueue(dir, { starId: r.starId, op: r.op, args: r.args }, t);
      dismiss(dir, r.proposalId);
      save(join(dir, "dismissed"), { ...r, mark: undefined, resentAs: next.proposalId });
      res.resent.push({ from: r.proposalId, to: next.proposalId });
    }
  }
  const due = readRecords(dir).filter((r) => r.status === "pending" && r.nextAttemptAt <= t);
  if (due.length === 0) return res;

  // re-read every pass: an edited or revoked entry takes effect at once
  const entry = endpointFor(identity.id, o.endpointsPath);
  if (!entry) throw new Error(`outbox: this machine has no writer endpoint for ${identity.id} (fail-closed)`);
  const token = readOwnerOnly(entry.tokenFile, "token_file").trim();
  if (!isB64Token(token)) throw new Error(`outbox: token_file ${entry.tokenFile} holds no bearer token (fail-closed)`);
  const writer = (o.writer ?? mcpWriter)({ url: entry.url, token });
  const halt = (status: number) => {
    res.halt = { status, at: new Date(t).toISOString() };
    mkdirSync(dir, { recursive: true });
    atomicWriteFile(join(dir, HALT), `${JSON.stringify(res.halt)}\n`);
    res.probe = "halted";
  };
  try {
    const h = await writer.call("health", {});
    if (isHalt(h)) return halt(h.http), res;
    if (!("answer" in h)) return (res.probe = "unreachable"), res;
    const refusal = probeRefusal(h.answer, identity.id, identity.writeLocus);
    if (refusal) return (res.probe = refusal), res;
    res.probe = "ok";
    rmSync(join(dir, HALT), { force: true }); // a probe the writer answers lifts the halt

    for (const r of due) {
      const reply = await writer.call(r.op, { ...r.args, proposalId: r.proposalId });
      if (isHalt(reply)) return halt(reply.http), res; // nothing marked refused: a refusal is about one proposal
      const a = "answer" in reply && reply.answer.proposalId === r.proposalId ? reply.answer as unknown as ProposalAnswer : null;
      if (a && (a.status === "applied" || a.status === "already-applied")) {
        rmSync(recordPath(dir, r.proposalId), { force: true }); // a second drainer may have removed it first. ADR-0010 §Revision: removed — the receipt is the writer's
        res.applied.push(r.proposalId);
        res.answers.push({ path: r.args.path, answer: a });
      } else if (a && a.status === "refused") {
        save(dir, { ...r, status: "refused", answer: a, attempts: r.attempts + 1, lastError: null });
        res.refused.push(r.proposalId);
        res.answers.push({ path: r.args.path, answer: a });
      } else {
        const why = "http" in reply ? `HTTP ${reply.http}` : "error" in reply ? reply.error : "a reply without this proposal's id is no answer";
        save(dir, { ...r, attempts: r.attempts + 1, nextAttemptAt: t + backoff(r.attempts + 1), lastError: why });
        res.retried.push(r.proposalId);
      }
    }
    return res;
  } finally {
    await writer.close();
  }
}

