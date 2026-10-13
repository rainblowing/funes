// `funes watch` — the reindex trigger on a read locus (PLAN-0.4.0 item 15, RAI-126).
//
// A receive-only Syncthing replica is a vault whose writer is somewhere else; what it lacks is a
// publication that follows the bytes as they land. This process polls Syncthing's own account of
// the folder and runs `funes publish` when that account says a delivery is complete. It never
// indexes anything itself: `publish` is the verb that is conditional on a content-hash target,
// clone-seeded, fenced, refused-and-retryable on a mid-build delivery, and the only thing the served
// faces, `eval` and `doctor` read.
//
// POLL, NOT SUBSCRIBE (the plan's "What research changed"). `/rest/db/status?folder=F` carries
// `state`, `needTotalItems` and a `sequence` Syncthing persists in its database and never moves
// backwards across a restart. `/rest/events` ids are per mask, in memory, reset to 1 on restart and
// buffered lazily (docs/research/syncthing-events.md §1) — every restart, gap and head-probe problem
// that stream has is absent from a counter that only moves when the local index does. The predicate
// is `mesh-status.sh`'s, plus the sequence:
//
//   state === "idle" && needTotalItems === 0 && sequence held across two polls && sequence !== lastPublished
//
// and `--min-interval` floors every spawn, so continuous delivery is published once per interval,
// never once per stabilisation. `lastPublished` advances only on `ok:true`; a refused publish (item
// 10's "vault moved … retry") is retried by the next poll that satisfies the predicate, with no
// retry state of its own. `pullErrors` never gates: a failed item stays needed, so need > 0 already
// holds the spawn back. There is no startup publish: `lastPublished` starts empty, so the first poll
// that satisfies the predicate publishes, and a restart mid-pull waits for need 0 like any poll.
//
// THE KEY NEVER LEAVES THIS MACHINE, and never reaches a process that is not this machine's
// Syncthing. Both estate GUIs are https on 127.0.0.1 with a self-signed `CA:FALSE` leaf whose CN/SAN
// is the machine's `.local` name: Bun's TLS will not take it through `ca:`, and no hostname matches
// at 127.0.0.1. So: loopback only, `rejectUnauthorized:false`, and a SHA-256 pin against the
// `https-cert.pem` beside `config.xml`, checked on `secureConnect` with the socket CORKED — the
// request's first byte, and so the `X-API-Key` header, cannot reach TLS until the pin has matched.
// A mismatch destroys the socket and exits 2 (a restart re-reads the certificate, which is how a
// regenerated one is picked up).
import { spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeSync } from "node:fs";
import https from "node:https";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { writeMachineState } from "./machine-state.ts";
import { readIndexScopeExcludes, scopeHash } from "./scope.ts";
import { isSyncConflict } from "./sync-conflicts.ts";

export interface WatchOptions {
  /** The replica, as `--vault` resolved it. Spawned publishes and machine state use it verbatim. */
  vault: string;
  /** The publication home `publish` is handed with `--home`. */
  home: string;
  /** Syncthing's GUI/REST base. Default `https://127.0.0.1:8384`; refused unless loopback https. */
  syncthing?: string;
  intervalMs?: number;
  minIntervalMs?: number;
  /** Per-request ceiling, default 10 s. Tests shorten it; a GUI that completes the handshake and
   *  never answers must end in a back-off, never in one `await` that KeepAlive sees as healthy. */
  requestTimeoutMs?: number;
  /** `STGUIAPIKEY`, and `STCONFDIR`/`STHOMEDIR` for where `config.xml` and `https-cert.pem` live. */
  env?: NodeJS.ProcessEnv;
  /** argv prefix of the funes CLI the publish is spawned through. Default: this runtime + cli.ts. */
  cli?: string[];
  log?: (line: string) => void;
  /** Tests stop the loop with it; under the LaunchAgent the process simply ends on SIGTERM. */
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** A boundary that held: the process exits 2 and says why. Everything else is Syncthing down. */
class Refusal extends Error {}

/** The one line `publish --json` prints (cli.ts). Only the fields the watcher reads. */
interface PublishLine { ok?: boolean; skipped?: boolean; generation?: string; publicationId?: string; error?: string }

const REQUEST_TIMEOUT_MS = 10_000;
/** The funes CLI a publish is spawned through when `cli` is not given: this runtime + cli.ts beside
 *  this file. Exported so the end-to-end test spawns exactly this argv — a moved cli.ts fails there,
 *  not as a runtime "no JSON line" on every publish. */
export const FUNES_CLI = [process.execPath, fileURLToPath(new URL("./cli.ts", import.meta.url))];
const BACKOFF_FIRST_MS = 2_000;
const BACKOFF_CAP_MS = 30_000;

/** Syncthing's own config-dir resolution, the cases it documents (locations.go): STCONFDIR, else
 *  STHOMEDIR, else the platform default — Linux's XDG state dir unless only the legacy ~/.config one
 *  carries a config. */
function syncthingConfigDir(env: NodeJS.ProcessEnv): string {
  const given = env.STCONFDIR || env.STHOMEDIR;
  if (given) return given;
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Syncthing");
  const state = join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "syncthing");
  const legacy = join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "syncthing");
  return !existsSync(join(state, "config.xml")) && existsSync(join(legacy, "config.xml")) ? legacy : state;
}

/** An https.Agent whose every socket is pinned. `createConnection` is where node:https hands the
 *  agent the connect options, so it is the one place the check can sit in front of the request. */
class PinnedAgent extends https.Agent {
  readonly pin: string;
  constructor(pin: string) {
    super({ keepAlive: false });
    this.pin = pin;
  }
  override createConnection(options: https.RequestOptions): Duplex {
    const sock = tls.connect({ ...(options as tls.ConnectionOptions), rejectUnauthorized: false });
    // Corked from birth: whatever the request writes stays in this stream's buffer until the pin
    // has matched. Without it, whether the headers are flushed before `secureConnect` fires is the
    // runtime's scheduling detail — the key would be safe by timing, not by construction.
    sock.cork();
    sock.once("secureConnect", () => {
      const got = sock.getPeerCertificate().fingerprint256;
      if (got === this.pin) sock.uncork();
      else sock.destroy(new Refusal(`the certificate at the Syncthing address has SHA-256 fingerprint ${got}, not the pinned ${this.pin} from https-cert.pem — refusing to send the API key`));
    });
    return sock;
  }
}

/** Run the watcher until `signal` aborts (0) or a boundary refuses (2). Never throws for Syncthing
 *  being down — that is backed off 2 s → 30 s and polled through, at startup as at any other time. */
export async function runWatch(o: WatchOptions): Promise<number> {
  // writeSync, as cli.ts writes stderr: an async pipe write is dropped by the process.exit(2) that
  // follows a refusal, and the refusal is the one line an operator reading the log needs.
  const log = o.log ?? ((l: string) => { writeSync(2, `${new Date().toISOString()} funes watch: ${l}\n`); });
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const intervalMs = o.intervalMs ?? 5_000;
  const minIntervalMs = o.minIntervalMs ?? 60_000;
  const requestTimeoutMs = o.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const env = o.env ?? process.env;
  // First, before any refusal: the one line that says which flags this process is running under.
  log(`watching ${o.vault} — polling every ${intervalMs / 1000}s, at most one publish per ${minIntervalMs / 1000}s`);
  try {
    // ── startup: every refusal here lands before the first request ─────────────────────────────
    // The address first, so a wrong --syncthing is refused before this process has read a key.
    let base: URL;
    try { base = new URL(o.syncthing ?? "https://127.0.0.1:8384"); } catch { throw new Refusal(`--syncthing ${JSON.stringify(o.syncthing)} is not a URL`); }
    const host = base.hostname.replace(/^\[|\]$/g, "");
    if (!((isIP(host) === 4 && host.startsWith("127.")) || host === "::1")) {
      throw new Refusal(`--syncthing ${base.origin} is not a loopback address — the API key never leaves this machine (use https://127.0.0.1:<port>)`);
    }
    if (base.protocol !== "https:") throw new Refusal(`--syncthing ${base.origin} is not https — the watcher only talks to a GUI it can pin`);
    const confDir = syncthingConfigDir(env);
    const configXml = join(confDir, "config.xml");
    let key = env.STGUIAPIKEY?.trim() || "";
    if (!key) {
      try { key = /<apikey>([^<]*)<\/apikey>/.exec(readFileSync(configXml, "utf8"))?.[1]?.trim() ?? ""; } catch { /* reported below */ }
    }
    if (!key) throw new Refusal(`no Syncthing API key: STGUIAPIKEY is unset and ${configXml} carries no <gui><apikey>`);
    const certPath = join(confDir, "https-cert.pem");
    let pin: string;
    try { pin = new X509Certificate(readFileSync(certPath)).fingerprint256; } catch (e) {
      throw new Refusal(`cannot read Syncthing's GUI certificate ${certPath} (${(e as Error).message}) — nothing to pin, so no request is sent`);
    }
    const agent = new PinnedAgent(pin);
    const vaultReal = realpathSync(o.vault);

    const get = (path: string): Promise<unknown> => new Promise((resolve, reject) => {
      const req = https.request(
        { host, port: base.port || 443, path, agent, headers: { "X-API-Key": key }, timeout: requestTimeoutMs },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (body += c));
          res.on("error", reject);
          res.on("end", () => {
            const s = res.statusCode ?? 0;
            if (s === 401 || s === 403) reject(new Refusal(`Syncthing answered ${s} on ${path.split("?")[0]} — the API key was refused`));
            else if (s !== 200) reject(new Error(`HTTP ${s} on ${path.split("?")[0]}`));
            else try { resolve(JSON.parse(body)); } catch { reject(new Error(`unparseable JSON on ${path.split("?")[0]}`)); }
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error(`no answer in ${requestTimeoutMs / 1000}s`)));
      req.end();
    });

    /** The folder whose path is this vault, by realpath on both sides — Syncthing may name it
     *  through a symlinked ancestor, and so may --vault. Receive-only or nothing: on any other type
     *  local edits propagate, and the machine is a writer, not a replica. */
    const resolveFolder = async (): Promise<string> => {
      const folders = (await get("/rest/config/folders")) as Array<{ id: string; path: string; type: string }>;
      const hit = folders.find((f) => { try { return realpathSync(f.path) === vaultReal; } catch { return false; } });
      if (!hit) throw new Refusal(`no Syncthing folder has the path ${vaultReal}`);
      if (hit.type !== "receiveonly") {
        throw new Refusal(`Syncthing folder ${hit.id} at ${vaultReal} is ${hit.type}, not receiveonly — a watcher publishes a replica, and this is a writer`);
      }
      log(`folder ${hit.id} at ${vaultReal} (receiveonly)`);
      return hit.id;
    };

    // ── the loop ───────────────────────────────────────────────────────────────────────────────
    let folder: string | undefined;
    let prevSeq: number | undefined;
    let lastPublished: number | undefined;
    let lastSpawnAt = -Infinity;
    let prevRo = 0;
    let lastReadSeq: number | undefined;
    let divergent: string[] = [];
    let deleted: string[] = [];
    let lastLine = "";
    let backoff = 0;
    const cli = o.cli ?? FUNES_CLI;

    /** `/rest/db/localchanged`: the NAMES behind the receive-only count, split by item 7's
     *  predicate. A conflict copy is Syncthing's own local addition on a receive-only folder (created,
     *  never propagated) and the walk already skips it; anything else is a local change of a canonical
     *  page — an edit (`divergent:`) or a deletion (`deleted locally:`, the entry's `deleted` flag),
     *  on every status line until Syncthing's Revert clears it. A finding, never a refusal:
     *  publication proceeds, because the index reflects the vault it serves (ADR-0003). */
    const readLocalChanges = async (fid: string, seq: number): Promise<void> => {
      let files: Array<{ name: string; deleted?: boolean }>;
      try {
        const r = (await get(`/rest/db/localchanged?folder=${encodeURIComponent(fid)}`)) as { files?: Array<{ name: string; deleted?: boolean }> };
        files = r.files ?? [];
      } catch (e) {
        if (e instanceof Refusal) throw e;
        log(`local changes: unreadable (${(e as Error).message}) — publication proceeds`);
        return;
      }
      lastReadSeq = seq;
      const conflicts = files.filter((f) => isSyncConflict(basename(f.name))).map((f) => f.name);
      const canonical = files.filter((f) => !isSyncConflict(basename(f.name)));
      divergent = canonical.filter((f) => !f.deleted).map((f) => f.name);
      deleted = canonical.filter((f) => f.deleted).map((f) => f.name);
      if (conflicts.length) log(`conflict copies (Syncthing's own, never indexed): ${conflicts.join(", ")}`);
      if (divergent.length) log(`divergent: ${divergent.join(", ")} — local edits of canonical pages on a receive-only replica`);
      if (deleted.length) log(`deleted locally: ${deleted.join(", ")} — local deletions of canonical pages on a receive-only replica`);
    };

    while (!o.signal?.aborted) {
      let wait = intervalMs;
      try {
        folder ??= await resolveFolder();
        const st = (await get(`/rest/db/status?folder=${encodeURIComponent(folder)}`)) as Record<string, unknown>;
        const { state, sequence: seq, needTotalItems: need } = st;
        if (typeof state !== "string" || typeof seq !== "number" || typeof need !== "number") throw new Error("status carries no state/sequence/needTotalItems");
        // The receive-only count is Syncthing's `TotalItems()` — files + directories + symlinks +
        // DELETES (internal/db/counts.go), the same test `/rest/db/localchanged` itself gates on
        // (model.go). `receiveOnlyChangedFiles` alone is the plan's word but not the set: a local
        // deletion lands in `Deleted`, never `Files`, so a `git clean` on the replica, or an edit
        // later deleted, moved no count the watcher read and cleared `divergent` on a missing page.
        // Summed from the per-kind fields: `receiveOnlyTotalItems` is this sum by definition, and a
        // field some version does not report counts 0 instead of blinding the whole check.
        const n = (k: string): number => (typeof st[k] === "number" ? (st[k] as number) : 0);
        const ro = n("receiveOnlyChangedFiles") + n("receiveOnlyChangedDirectories") + n("receiveOnlyChangedSymlinks") + n("receiveOnlyChangedDeletes");
        if (backoff) { log("Syncthing answering again"); backoff = 0; }
        const settled = seq === prevSeq;
        prevSeq = seq;
        const decide = state === "idle" && need === 0 && settled && seq !== lastPublished && now() - lastSpawnAt >= minIntervalMs;
        // Local changes are read when their COUNT moves, and at every spawn decision while it is
        // above zero. The count is not the set — a conflict copy moved over its page is one removal
        // and one addition, count held — but every change to the set is a local index write that
        // moves `sequence` (Syncthing's updateLocalFiles), so a read at the spawn decision, cached
        // per sequence, sees every set change and pays this expensive call at most once per spawn.
        if (ro !== prevRo) {
          prevRo = ro;
          if (ro > 0) await readLocalChanges(folder, seq);
          else { divergent = []; deleted = []; }
        } else if (decide && ro > 0 && lastReadSeq !== seq) {
          await readLocalChanges(folder, seq);
        }
        const line = `${state} seq=${seq} needTotalItems=${need} pullErrors=${String(st.pullErrors)}` +
          ` receiveOnlyChangedFiles=${n("receiveOnlyChangedFiles")} receiveOnlyChangedDeletes=${n("receiveOnlyChangedDeletes")}` +
          `${divergent.length ? ` divergent: ${divergent.join(", ")}` : ""}${deleted.length ? ` deleted locally: ${deleted.join(", ")}` : ""}`;
        if (line !== lastLine) { log(`status: ${line}`); lastLine = line; }
        if (decide) {
          lastSpawnAt = now();
          log(`publishing sequence ${seq}`);
          const r = await spawnPublish(cli, o.vault, o.home);
          if (r.ok === true) {
            lastPublished = seq;
            log(`published sequence ${seq}: ${r.skipped ? "already current" : `publication ${r.publicationId}`} · generation ${r.generation}`);
            recordMachineState(o.vault, r.publicationId, log);
          } else {
            log(`publish FAILED at sequence ${seq}: ${r.error ?? "no reason given"} — retried by a later poll`);
          }
        }
      } catch (e) {
        if (e instanceof Refusal) throw e;
        backoff = Math.min(backoff ? backoff * 2 : BACKOFF_FIRST_MS, BACKOFF_CAP_MS);
        if (backoff === BACKOFF_FIRST_MS) log(`Syncthing unreachable (${(e as Error).message}) — backing off ${BACKOFF_FIRST_MS / 1000}s -> ${BACKOFF_CAP_MS / 1000}s`);
        wait = backoff;
      }
      await sleep(wait);
    }
    return 0;
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    log(`refused: ${e.message}`);
    return 2;
  }
}

/** Spawn `funes publish --vault V --home H --json` and parse its one line. Its stderr is the
 *  watcher's (the LaunchAgent log); a child that prints no JSON is a failed publish, not a crash. */
function spawnPublish(cli: string[], vault: string, home: string): Promise<PublishLine> {
  return new Promise((resolve) => {
    const child = spawn(cli[0]!, [...cli.slice(1), "publish", "--vault", vault, "--home", home, "--json"], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout!.setEncoding("utf8").on("data", (c: string) => (out += c));
    child.on("error", (e) => resolve({ ok: false, error: e.message }));
    child.on("close", (code) => {
      try { resolve(JSON.parse(out.trim().split("\n").pop() ?? "") as PublishLine); } catch { resolve({ ok: false, error: `exit ${code}, no JSON line on stdout` }); }
    });
  });
}

/** `publish` never writes machine state (only a full `reindex` does), so without this `doctor` on a
 *  watch-fed replica would print UNKNOWN for an index this machine built. Written after EACH
 *  successful publish, a skip included (plan item 15): the walk's own `publish` runs through the CLI
 *  and writes nothing, so the watcher's first spawn on an unchanged vault is a skip — and a
 *  built-only rule left `doctor` UNKNOWN until the next delivery, indefinitely on a quiet vault. A
 *  skip is still a record, not an inference: the home is machine-local (item 23 refuses one in a
 *  sync root), and the skip is this machine's publisher finding, under the fence, that the
 *  publication current in it is the content-hash target of this machine's vault. Bound to the
 *  publication id `publish --json` names, built or current, as reindex binds to its database's.
 *  Best-effort, as there. */
function recordMachineState(vault: string, publicationId: string | undefined, log: (l: string) => void): void {
  if (!publicationId) { log("machine state: not recorded (publish named no publicationId)"); return; }
  try {
    const scope = readIndexScopeExcludes(vault);
    // The `published` slot: reindex keeps the live index's binding in its own, so neither erases
    // the other and `doctor` / `doctor --live` both read "authored here" (machine-state.ts).
    writeMachineState(vault, { boundTo: publicationId, authoredHere: true, desiredScopeHash: scope.kind === "valid" ? scopeHash(scope.excludes) : null }, "published");
  } catch (e) {
    log(`machine state: not recorded (${(e as Error).message}) — the publish itself succeeded`);
  }
}
