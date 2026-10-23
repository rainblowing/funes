// `funes replica` (PLAN-0.5.0 item 32; ADR-0010 §Revision (the replica bullet), ADR-0011
// §Consequences; record 29). The one resident process on the proposer machine for the taste star. Each tick, in order:
//
//   pull       R2 → the canon mirror at `stateDirFor(~/taste)/canon/` (0444 files, 0555 dirs): an
//              explicit `Bun.S3Client` under the Object Read credential, GETs only for a changed etag,
//              md5-checked, raw bytes, never a delete, `.history/` included; skipped while the
//              writer's `health.applyState` is `pending`.
//   reconcile  `~/taste` from the mirror — by local copy only, and only where the bytes are ours
//              (record 29 §7): absent (restored create-once), last written by us, a resolved payload,
//              or a held path whose new local bytes were first captured into its outbox record.
//   publish    this machine's own index of the MIRROR (never `~/taste`), refused while the mirror holds a
//              file absent from the manifest.
//   scan       `~/taste` by lstat, hashing only what moved. A file is an edit when its sha256 is none
//              of: its mirror copy, the bytes last written there (`disk`), the last payload (`sent`).
//              An edit 30 s stable that passes UTF-8 and the OKF normalizer is proposed, one per path,
//              its base per ADR-0010 §Revision. A new file is held for `funes outbox approve`.
//   drain      act on `approve` marks (the page-id rule checked), then one outbox pass.
//
// The three run in one process, one after the other, so they cannot race on `replica.json`. A
// deletion is never proposed — the next reconcile restores it. Edits are told by content, not by
// events: there is no fs.watch (ADR-0011).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { isPagePath, sameStar } from "funes-core/internal";
import { refKey } from "funes-core";
import { endpointsFilePath, stateDirFor } from "../../funes-engine/src/funes-home.ts";
import { readOwnerOnly } from "../../funes-engine/src/actor.ts";
import { endpointFor, readEndpoints, type EndpointEntry } from "./endpoints.ts";
import { readStarIdentity } from "../../funes-engine/src/factory.ts";
import { createOnce } from "../../funes-engine/src/folder-vault.ts";
import { sha256Hex as sha256 } from "funes-core/internal";
import { normalizePage, parseFrontmatter } from "funes-core";
import { dismiss, drain, enqueue, hold, listOutbox, mcpWriter, readRecords, saveRecord, type DrainResult, type OutboxRecord, type WriterFactory } from "./outbox.ts";
import { isItemPath } from "funes-core/internal";
import { itemPaths } from "funes-core";
import { assertReplicaLocation } from "./location.ts";
import { fileURLToPath } from "node:url";
import { spawnPublish, type PublishLine } from "../../funes-engine/src/watch.ts";
import { atomicWriteFile } from "../../funes-engine/src/write.ts";

/** What the pull needs of an S3 client; `Bun.S3Client` is one. */
export interface Bucket {
  list(input: { prefix: string; continuationToken?: string }): Promise<{ contents?: Array<{ key: string; eTag?: string; lastModified?: string }>; isTruncated?: boolean; nextContinuationToken?: string }>;
  file(key: string): { bytes(): Promise<Uint8Array> };
}
export interface Credentials { accessKeyId: string; secretAccessKey: string }
type Pull = NonNullable<EndpointEntry["pull"]>;

/** A boundary that held: the CLI exits 2 and says why. */
export class ReplicaRefusal extends Error {}

/** record 29 §1a: Bun's S3 client attaches `AWS_SESSION_TOKEN`/`S3_SESSION_TOKEN` from the
 *  environment even with every field explicit, so the replica refuses to start while any `S3_*` or
 *  `AWS_*` variable is set. Names only, never a value. */
export function refuseS3Env(env: NodeJS.ProcessEnv = process.env): void {
  const set = Object.keys(env).filter((k) => /^(S3|AWS)_/.test(k));
  if (set.length) throw new ReplicaRefusal(`${set.join(", ")} set — Bun's S3 client reads S3_*/AWS_* from the environment even with every field explicit; unset them and restart (fail-closed)`);
}

/** The real bucket: every field explicit, never the global `Bun.s3`. */
export const s3Bucket = (pull: Pull, c: Credentials): Bucket =>
  new Bun.S3Client({ accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, endpoint: pull.endpoint, bucket: pull.bucket, region: "auto" });

/** The Object Read credential: a 0600 JSON file `{access_key_id, secret_access_key}`, read now. */
function readCredentials(path: string): Credentials {
  let v: unknown;
  try { v = JSON.parse(readOwnerOnly(path, "credentials_file")); } catch (e) {
    throw new ReplicaRefusal((e as Error).message.startsWith("credentials_file") ? (e as Error).message : `credentials_file ${path}: malformed JSON (fail-closed)`);
  }
  const o = v as Record<string, unknown> | null;
  if (typeof o?.access_key_id !== "string" || typeof o.secret_access_key !== "string") throw new ReplicaRefusal(`credentials_file ${path}: needs access_key_id and secret_access_key strings (fail-closed)`);
  return { accessKeyId: o.access_key_id, secretAccessKey: o.secret_access_key };
}

export interface ReplicaOptions {
  /** `~/taste`, Vlad's Obsidian folder. */
  taste: string;
  /** The taste star's `meta.id`: its endpoint entry carries the `pull`. */
  starId: string;
  endpointsPath?: string;
  /** The home the location refusal measures `~/Desktop` and `~/Documents` from. */
  locationHome?: string;
  /** The clock seam (record 35 R10). */
  now?: () => number;
  bucketFor?: (pull: Pull, c: Credentials) => Bucket;
  writer?: WriterFactory;
  publish?: (mirror: string) => Promise<PublishLine>;
  notify?: (line: string) => void;
  log?: (line: string) => void;
  pullEveryMs?: number;
  publishEveryMs?: number;
  stableMs?: number;
  staleWindowMs?: number;
}

export interface TickResult {
  /** Why the pull, or the reconcile and publish, did not run this tick. */
  skipped?: string;
  pulled: string[];
  restored: string[];
  published: boolean | "refused";
  proposed: string[];
  held: Array<{ path: string; reason: string }>;
  drain: DrainResult | null;
}

interface PathState {
  /** sha256 the reconcile last wrote here, the one before it, and when. */
  disk?: string;
  prevDisk?: string;
  diskAt?: number;
  /** sha256 of the last payload proposed from this path. */
  sent?: string;
  /** An applied proposal's `writtenHash` the pull has not brought yet: the next base. */
  applied?: string;
  /** Bytes not yet proposed: their sha and when first seen (the 30 s and 10 s clocks). */
  seen?: { sha: string; at: number };
  stat?: string;
  /** sha of bytes held invalid locally, so they are not re-checked every tick. */
  invalid?: string;
  /** a non-proposable file, listed once. */
  listed?: boolean;
}
interface Manifest {
  v: 1;
  keys: Record<string, { etag: string; sha: string }>;
  paths: Record<string, PathState>;
  lastPullAt?: number;
  lastPublishAt?: number;
  unpublished?: boolean;
  /** The mirror's supersede-consistency failure, until a later pull clears it. */
  inconsistent?: string;
}

const md5 = (b: Uint8Array) => createHash("md5").update(b).digest("hex");
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const LOOSE = new TextDecoder("utf-8", { ignoreBOM: true });
const HISTORY = ".history/";

/** A key the mirror may hold: a vault path, never one that walks out of it. */
const safeKey = (k: string) => k.length > 0 && !k.startsWith("/") && k.split("/").every((s) => s !== "" && s !== "." && s !== "..");

/** record 29 §4d: a new file's path is the writer's shape (`items/<domain>/<name>.md`, lowercase
 *  ASCII, ≤ 900 bytes) and the page-id rule's path from its frontmatter (record 25 §3: the domain, the
 *  slug of the first Latin-script title, `--<creator|year>`, `-item` on a reserved base), or that
 *  path's `--<type>` collision variant. Null when it is; else why, naming the computed path. */
export function pageIdProblem(path: string, text: string): string | null {
  if (!isItemPath(path, "items")) return `invalid: ${path} is not items/<domain>/<name>.md in lowercase ASCII within 900 bytes`;
  const { data, malformed } = parseFrontmatter(text);
  if (malformed !== undefined) return `invalid: ${malformed}`;
  const ok = itemPaths(data, typeof data.domain === "string" ? data.domain : path.split("/")[1]!);
  if (!ok.length) return "invalid: no title to name the page by";
  return ok.includes(path) ? null : `invalid: would be ${ok[0]}`;
}

// ── the mirror's file modes ─────────────────────────────────────────────────────────────────────

/** Run `fn` with `dir` writable, then put its mode back (the pull lifts 0555 only around its own renames). */
function withWritable<T>(dir: string, fn: () => T): T {
  const mode = statSync(dir).mode & 0o777;
  chmodSync(dir, mode | 0o700);
  try { return fn(); } finally { chmodSync(dir, mode); }
}

function ensureMirrorDir(d: string, mirror: string): void {
  if (existsSync(d)) return;
  if (d !== mirror) ensureMirrorDir(dirname(d), mirror);
  else mkdirSync(dirname(d), { recursive: true });
  withWritable(dirname(d), () => mkdirSync(d));
  chmodSync(d, 0o555);
}

function writeMirror(mirror: string, key: string, bytes: Uint8Array, mtime?: string): void {
  const abs = join(mirror, key);
  ensureMirrorDir(dirname(abs), mirror);
  withWritable(dirname(abs), () => {
    atomicWriteFile(abs, bytes);
    chmodSync(abs, 0o444);
    if (mtime && !Number.isNaN(Date.parse(mtime))) utimesSync(abs, new Date(mtime), new Date(mtime));
  });
}

/** Every file under `dir`, dot paths included, as `/`-separated relative paths. */
function walkAll(dir: string, rel = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? walkAll(dir, r) : e.isFile() ? [r] : [];
  });
}

// ── the tick ────────────────────────────────────────────────────────────────────────────────────

function osNotify(line: string): void {
  if (process.platform !== "darwin") return;
  const q = (s: string) => `"${s.replace(/[\\"]/g, "\\$&")}"`;
  try { spawn("osascript", ["-e", `display notification ${q(line)} with title "funes replica"`], { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch { /* the log line stands */ }
}

/** One tick: pull → reconcile → publish → scan → drain. Throws `ReplicaRefusal` on a boundary. */
export async function replicaTick(o: ReplicaOptions): Promise<TickResult> {
  const t = (o.now ?? Date.now)();
  const log = o.log ?? ((l: string) => { writeSync(2, `${new Date(t).toISOString()} funes replica: ${l}\n`); });
  const notify = (line: string) => { log(`notify: ${line}`); (o.notify ?? osNotify)(line); };
  const writerFor = o.writer ?? mcpWriter;
  const state = stateDirFor(o.taste);
  const mirror = join(state, "canon");
  const outbox = join(state, "outbox");
  const manifestPath = join(state, "replica.json");
  const res: TickResult = { pulled: [], restored: [], published: false, proposed: [], held: [], drain: null };

  // re-read every pass: the endpoint entry, and where every path of the replica sits
  let entry: EndpointEntry | null;
  try { entry = endpointFor(o.starId, o.endpointsPath); } catch (e) { throw new ReplicaRefusal((e as Error).message); }
  if (!entry?.pull) throw new ReplicaRefusal(`this machine's writer-endpoint file has no pull entry for ${o.starId} (fail-closed)`);
  const starKey = refKey(o.starId);
  if (!starKey) throw new ReplicaRefusal(`${o.starId} is not a star id: no <starKey>/_/ prefix to pull (fail-closed)`);
  for (const p of [o.taste, state, mirror, o.endpointsPath ?? endpointsFilePath(), entry.tokenFile, entry.pull.credentialsFile]) {
    try { assertReplicaLocation(p, o.locationHome); } catch (e) { throw new ReplicaRefusal((e as Error).message); }
  }
  mkdirSync(o.taste, { recursive: true });
  mkdirSync(state, { recursive: true });
  let m: Manifest;
  try { m = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest; } catch { m = { v: 1, keys: {}, paths: {} }; } // lost: rebuilt from content
  const ps = (rel: string) => (m.paths[rel] ??= {});
  /** The outbox's live record per path (oldest first, so the latest wins): one proposal per path. */
  const active = new Map<string, OutboxRecord>();

  try {
    // ── pull ──────────────────────────────────────────────────────────────────────────────────
    if (t - (m.lastPullAt ?? -Infinity) >= (o.pullEveryMs ?? 60_000)) {
      if (await applyPending(entry, writerFor)) {
        res.skipped = "the writer's applyState is pending — the pull waits for the apply to finish";
        log(`pull skipped: ${res.skipped}`);
      } else {
        const bucket = (o.bucketFor ?? s3Bucket)(entry.pull, readCredentials(entry.pull.credentialsFile));
        try {
          res.pulled = await pull(mirror, m, bucket, `${starKey}/_/`, log);
          m.lastPullAt = t;
        } catch (e) { // offline: the scan and the outbox keep working on the last mirror (record 29 §6)
          res.skipped = `the pull failed (${(e as Error).message}) — retried next tick`;
          log(res.skipped);
        }
        if (m.unpublished) m.inconsistent = supersedeProblem(mirror, m) ?? undefined;
      }
    }
    if (!existsSync(join(mirror, "star.yaml"))) { log("the mirror holds no star.yaml yet — nothing to reconcile"); return res; }
    const id = readStarIdentity(mirror).id;
    if (!id || !sameStar(id, o.starId)) throw new ReplicaRefusal(`the pulled star.yaml names ${JSON.stringify(id)}, not ${o.starId} — a mis-mapped bucket (fail-closed)`);

    for (const r of readRecords(outbox)) if (typeof r.args.path === "string") active.set(r.args.path, r);

    if (m.inconsistent) {
      res.skipped = m.inconsistent;
      log(`reconcile and publish skipped: ${m.inconsistent}`);
    } else {
      // ── reconcile ───────────────────────────────────────────────────────────────────────────
      for (const key of Object.keys(m.keys)) {
        if (key !== "star.yaml" && !isPagePath(key)) continue; // `.history/` stays in the mirror only
        reconcile(key);
      }
      // ── publish ─────────────────────────────────────────────────────────────────────────────
      if (m.unpublished && t - (m.lastPublishAt ?? -Infinity) >= (o.publishEveryMs ?? 60_000)) {
        const stray = walkAll(mirror).filter((k) => !(k in m.keys));
        if (stray.length) {
          res.published = "refused";
          log(`publish REFUSED: the mirror holds ${stray.join(", ")}, absent from the manifest — nothing deleted; remove it by hand`);
        } else {
          m.lastPublishAt = t;
          const r = await (o.publish ?? defaultPublish)(mirror);
          if (r.ok) { m.unpublished = false; res.published = true; log(`published the mirror: ${r.skipped ? "already current" : "built"} · generation ${r.generation}`); }
          else log(`publish FAILED: ${r.error ?? "no reason given"} — retried by a later tick`);
        }
      }
    }

    // ── scan ──────────────────────────────────────────────────────────────────────────────────
    for (const rel of walkAll(o.taste)) {
      if (rel.split("/").some((s) => s.startsWith(".")) || !rel.endsWith(".md")) continue; // .obsidian/ and the like
      const st = ps(rel);
      if (!rel.startsWith("items/") || !isPagePath(rel)) {
        if (!st.listed) { log(`not proposable: ${rel} — left in place`); st.listed = true; }
        continue;
      }
      scan(rel, st);
    }

    // ── drain ─────────────────────────────────────────────────────────────────────────────────
    for (const r of readRecords(outbox)) if (r.status === "held" && r.mark === "approve") approveHeld(r);
    const haltBefore = listOutbox(outbox).halt;
    const d = await drain({ vault: mirror, dir: outbox, endpointsPath: o.endpointsPath, now: () => t, writer: writerFor });
    res.drain = d;
    for (const { path, answer } of d.answers) {
      if (typeof path !== "string") continue;
      if (answer.status === "refused") notify(`refused ${answer.reason ?? ""}: ${path} — funes outbox show ${answer.proposalId}`);
      else if (answer.writtenHash && answer.writtenHash !== m.keys[path]?.sha) ps(path).applied = answer.writtenHash;
    }
    if (d.expired.length) notify(`expired, held until resend or dismiss: ${d.expired.join(", ")}`);
    if (d.halt && !haltBefore) notify(`the writer refused the outbox token (HTTP ${d.halt.status}) — the endpoint is halted, nothing marked refused`);
    if (!d.halt && d.probe.startsWith("refused")) log(`drain: ${d.probe}`);
    return res;
  } finally {
    atomicWriteFile(manifestPath, `${JSON.stringify(m)}\n`);
  }

  /** Put canon at `rel` in `~/taste`. Create-once (FolderVault's: fsynced temp, link(2), fsynced
   *  directory) when the file is absent, so a file that has reappeared meanwhile wins; else an atomic
   *  replace. */
  function place(rel: string, once: boolean): void {
    const abs = join(o.taste, rel);
    const bytes = readFileSync(join(mirror, rel));
    if (once) {
      if (!createOnce(abs, bytes)) return;
    } else {
      mkdirSync(dirname(abs), { recursive: true });
      atomicWriteFile(abs, bytes);
    }
    const st = ps(rel);
    st.prevDisk = st.disk;
    st.disk = m.keys[rel]!.sha;
    st.diskAt = t;
    delete st.seen;
    res.restored.push(rel);
  }

  function reconcile(key: string): void {
    const canon = m.keys[key]!.sha;
    const abs = join(o.taste, key);
    if (key === "star.yaml") { // never proposable: restored from the mirror whenever it differs, 0444
      if (!existsSync(abs) || sha256(readFileSync(abs)) !== canon) { place(key, false); chmodSync(abs, 0o444); }
      return;
    }
    const st = ps(key);
    if (st.applied === canon) delete st.applied;
    if (!existsSync(abs)) {
      if (st.disk) log(`deleted locally: ${key} — restored from canon`);
      return place(key, true);
    }
    const bytes = readFileSync(abs);
    const local = sha256(bytes);
    if (local === canon) { st.disk = canon; delete st.seen; return; }
    const rec = active.get(key);
    if (rec?.status === "refused") { // §4c: capture, then restore
      const text = LOOSE.decode(bytes);
      if (text !== rec.args.content && !rec.captured?.includes(text)) {
        rec.captured = [...(rec.captured ?? []), text];
        saveRecord(outbox, rec);
        log(`held ${key}: a new local version kept in ${rec.proposalId}, canon restored`);
      }
      return place(key, false);
    }
    if (rec) return; // pending, held or expired: an unanswered edit stays where Vlad left it
    if (st.applied) return; // our applied write has not been pulled yet
    if (local === st.disk || (st.sent !== undefined && local === st.sent)) return place(key, false);
    if (st.disk === undefined && st.sent === undefined) { // no provenance (a lost replica.json): held, never proposed
      const r = hold(outbox, { starId: o.starId, path: key, content: LOOSE.decode(bytes), reason: "unknown-base" }, t);
      active.set(key, r);
      log(`held unknown-base: ${key} — kept in ${r.proposalId}, canon restored; funes outbox show ${r.proposalId}`);
      res.held.push({ path: key, reason: "unknown-base" });
      return place(key, false);
    }
    // an edit the scan has not proposed yet: left for it
  }

  function scan(rel: string, st: PathState): void {
    const abs = join(o.taste, rel);
    const ls = lstatSync(abs);
    const stat = `${ls.mtimeMs}:${ls.size}:${ls.ino}`;
    if (st.stat !== stat) {
      st.stat = stat;
      const cur = sha256(readFileSync(abs));
      if (cur === m.keys[rel]?.sha || cur === st.disk || cur === st.sent) { delete st.seen; return; }
      if (st.seen?.sha !== cur) st.seen = { sha: cur, at: t };
    }
    const seen = st.seen;
    if (!seen || seen.sha === st.invalid || active.has(rel) || t - seen.at < (o.stableMs ?? 30_000)) return;
    const bytes = readFileSync(abs);
    if (sha256(bytes) !== seen.sha) { st.stat = undefined; return; } // moved under the lstat: next tick
    let text: string;
    try { text = UTF8.decode(bytes); } catch { return invalid(rel, st, seen.sha, "not UTF-8"); }
    const n = normalizePage(text, { path: rel });
    if ("invalid" in n) return invalid(rel, st, seen.sha, n.reason);
    delete st.seen;
    if (!m.keys[rel]) { // a new file waits for `funes outbox approve` (record 29 §4d)
      const r = enqueue(outbox, { starId: o.starId, op: "put_page", args: { path: rel, content: text }, held: true }, t);
      const problem = pageIdProblem(rel, text);
      if (problem) { r.lastError = problem; saveRecord(outbox, r); }
      active.set(rel, r);
      log(`held new file: ${rel}${problem ? ` — ${problem}` : ""} — funes outbox approve ${rel}`);
      res.held.push({ path: rel, reason: problem ?? "new file" });
      return;
    }
    // the base: an applied write not yet pulled, else the bytes before a reconcile write within the
    // stale-buffer window, else the bytes last written (ADR-0010 §Revision)
    const base = st.applied ?? (st.prevDisk && st.diskAt !== undefined && seen.at - st.diskAt <= (o.staleWindowMs ?? 10_000) ? st.prevDisk : st.disk ?? m.keys[rel]!.sha);
    const r = enqueue(outbox, { starId: o.starId, op: "put_page", args: { path: rel, content: text, base } }, t);
    active.set(rel, r);
    st.sent = seen.sha;
    res.proposed.push(rel);
    log(`proposed ${rel} as ${r.proposalId}`);
  }

  function invalid(rel: string, st: PathState, sha: string, reason: string): void {
    st.invalid = sha;
    log(`held: invalid ${rel} — ${reason} — not sent, not reverted`);
    res.held.push({ path: rel, reason: `invalid: ${reason}` });
  }

  /** A held new file Vlad approved: the page-id rule checked on the bytes now there, then a
   *  create-once proposal under a ULID minted now; the held record moves to `dismissed/`. */
  function approveHeld(r: OutboxRecord): void {
    const rel = String(r.args.path);
    const abs = join(o.taste, rel);
    let problem: string | null;
    let text = "";
    if (!existsSync(abs)) problem = "the file is gone";
    else {
      try { text = UTF8.decode(readFileSync(abs)); problem = pageIdProblem(rel, text); } catch { problem = "invalid: not UTF-8"; }
    }
    if (problem) {
      delete r.mark;
      r.lastError = problem;
      saveRecord(outbox, r);
      log(`approve of ${rel} not acted on: ${problem}`);
      return;
    }
    const next = enqueue(outbox, { starId: o.starId, op: "put_page", args: { path: rel, content: text } }, t);
    dismiss(outbox, r.proposalId);
    ps(rel).sent = sha256(new TextEncoder().encode(text));
    res.proposed.push(rel);
    log(`approved ${rel}: proposed as ${next.proposalId}`);
  }
}

/** record 29 §1e: true only when the writer's `health` says an apply is pending. Unreachable or
 *  halted pulls anyway: the mirror is canon either way, and a stuck journal is what this guards. */
async function applyPending(entry: EndpointEntry, writerFor: WriterFactory): Promise<boolean> {
  let token: string;
  try { token = readOwnerOnly(entry.tokenFile, "token_file").trim(); } catch { return false; }
  const w = writerFor({ url: entry.url, token });
  try {
    const h = await w.call("health", {});
    return "answer" in h && h.answer.applyState === "pending";
  } finally {
    await w.close();
  }
}

/** List the star's `<starKey>/_/` prefix of the deployment's one bucket (ADR-0024) and GET only what
 *  changed against the mirror. Keys are mirrored with the prefix stripped: the mirror is the vault. */
async function pull(mirror: string, m: Manifest, bucket: Bucket, prefix: string, log: (l: string) => void): Promise<string[]> {
  const listed: Array<{ key: string; eTag?: string; lastModified?: string }> = [];
  let token: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(token ? { continuationToken: token } : {}) });
    listed.push(...(page.contents ?? []));
    token = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (token);
  const pulled: string[] = [];
  for (const { key: full, eTag, lastModified } of listed) {
    if (!full.startsWith(prefix)) continue; // a store that ignores `prefix`: never another star's object
    const key = full.slice(prefix.length);
    if (!safeKey(key) || !eTag) { log(`pull: ${JSON.stringify(key)} skipped — not a vault path, or no etag`); continue; }
    const etag = eTag.replace(/"/g, "").toLowerCase();
    const abs = join(mirror, key);
    if (m.keys[key]?.etag === etag && existsSync(abs)) continue;
    if (existsSync(abs)) { // a lost manifest is rebuilt from content: a copy whose md5 is the etag is canon
      const b = readFileSync(abs);
      if (md5(b) === etag) { m.keys[key] = { etag, sha: sha256(b) }; continue; }
    }
    const bytes = await bucket.file(full).bytes();
    if (md5(bytes) !== etag) { log(`pull: ${key} — the body's md5 is not its etag; refused, not written`); continue; }
    writeMirror(mirror, key, bytes, key.startsWith(HISTORY) ? lastModified : undefined);
    m.keys[key] = { etag, sha: sha256(bytes) };
    m.unpublished = true;
    pulled.push(key);
  }
  return pulled;
}

/** record 29 §1e: a mirror note whose `supersedes` names a page that lacks `superseded_by` is a
 *  half-applied supersede (the pull can see a prefix); null when every chain is whole.
 *  ponytail: a full parse of the mirror's pages on every pass that pulled; per-key if it shows. */
function supersedeProblem(mirror: string, m: Manifest): string | null {
  for (const key of Object.keys(m.keys)) {
    if (!isPagePath(key)) continue;
    const s = parseFrontmatter(readFileSync(join(mirror, key))).data.supersedes;
    if (typeof s !== "string") continue;
    const target = s.replace(/^\[\[|\]\]$/g, "").replace(/\|.*$/, "");
    const tkey = target.endsWith(".md") ? target : `${target}.md`;
    if (!m.keys[tkey]) continue;
    if (!("superseded_by" in parseFrontmatter(readFileSync(join(mirror, tkey))).data)) return `${key} supersedes ${tkey}, which lacks superseded_by — a half-applied supersede`;
  }
  return null;
}

/** The funes CLI beside this checkout: this process's entry is replica/cli.ts, not funes'. Each publish
 *  derives the mirror's home from the mirror (RAI-317). */
const FUNES_CLI = [process.execPath, fileURLToPath(new URL("../../funes-engine/src/cli.ts", import.meta.url))];
const defaultPublish = (mirror: string): Promise<PublishLine> => spawnPublish(FUNES_CLI, mirror);

/** The taste star's id on this machine: the one endpoint entry that carries a `pull`. */
export function pullStar(endpointsPath?: string): string {
  const ids = [...readEndpoints(endpointsPath)].filter(([, e]) => e.pull).map(([id]) => id);
  if (ids.length !== 1) throw new ReplicaRefusal(`the writer-endpoint file has ${ids.length} entries with a pull — funes replica serves exactly one (fail-closed)`);
  return ids[0]!;
}

/** The resident loop (`--once`: one tick). Exit 2 on a refusal; any other failure is logged and the
 *  next tick tries again. */
export async function runReplica(o: Omit<ReplicaOptions, "starId"> & { once?: boolean; intervalMs?: number; signal?: AbortSignal }): Promise<number> {
  const log = o.log ?? ((l: string) => { writeSync(2, `${new Date().toISOString()} funes replica: ${l}\n`); });
  try {
    refuseS3Env();
    const starId = pullStar(o.endpointsPath);
    log(`replica of ${starId}: ${o.taste}${o.once ? " (once)" : `, every ${(o.intervalMs ?? 5_000) / 1000}s`}`);
    if (o.once) {
      const r = await replicaTick({ ...o, starId, log, pullEveryMs: 0, publishEveryMs: 0 });
      console.log(JSON.stringify({ ok: !r.skipped && r.published !== "refused", ...r, drain: r.drain && { probe: r.drain.probe, applied: r.drain.applied, refused: r.drain.refused } }));
      return r.skipped || r.published === "refused" ? 1 : 0;
    }
    while (!o.signal?.aborted) {
      try { await replicaTick({ ...o, starId, log }); } catch (e) {
        if (e instanceof ReplicaRefusal) throw e;
        log(`tick failed: ${(e as Error).message} — next tick retries`);
      }
      await new Promise((r) => setTimeout(r, o.intervalMs ?? 5_000));
    }
    return 0;
  } catch (e) {
    if (!(e instanceof ReplicaRefusal)) throw e;
    log(`refused: ${e.message}`);
    return 2;
  }
}
