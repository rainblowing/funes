import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FUNES_CLI, runWatch } from "./watch.ts";
import { readMachineState, writeMachineState } from "./machine-state.ts";
import { E5Embedder } from "./embedder.ts";
import { computeTargetGeneration, readGenerationManifest } from "./publication.ts";
import { scopeHash } from "./scope.ts";

// PLAN-0.4.0 item 15 (RAI-126) — `funes watch` against a FAKE Syncthing: Bun.serve over TLS, with a
// self-signed certificate generated HERE, at test time, by openssl, into a temp dir. No PEM key is
// ever committed: the gitleaks gate in /ship fails closed on one, and a key checked in "for tests"
// is a key checked in.
//
// Time is the watcher's own injectable clock: `sleep` advances it and yields, so a 60-second
// --min-interval costs nothing to test and every poll lands on a known timestamp (poll k at 5k s).
// The fake serves ONE scripted status per poll and aborts the watcher after the last one, so each
// case reads as a timeline. The publish is a STUB script spawned through the real spawn-and-parse
// path — except in ONE case, which spawns the real `cli.ts publish` (FUNES_CLI) on an empty vault:
// that is what pins the `publish --json` line the stub imitates, and embeds nothing.

const KEY = "test-api-key-7f3a";
// Built at runtime: a literal key-shaped fixture here trips the gitleaks gate (a false positive).
const WRONG_KEY = ["wrong", "key", "9d1c"].join("-");
let root: string;
let certA: string, keyA: string, certB: string;

function mkcert(dir: string, cn: string): { cert: string; key: string } {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", `/CN=${cn}`,
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
  ], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`);
  return { cert: readFileSync(join(dir, "cert.pem"), "utf8"), key: readFileSync(join(dir, "key.pem"), "utf8") };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "funes-watch-"));
  ({ cert: certA, key: keyA } = mkcert(join(root, "cert-a"), "host-a.local"));
  ({ cert: certB } = mkcert(join(root, "cert-b"), "host-b.local"));
  // Machine state defaults to ~/.twinkling/state — a test that wrote there would write the estate.
  process.env.FUNES_STATE_DIR = join(root, "state");
});
afterAll(() => {
  delete process.env.FUNES_STATE_DIR;
  rmSync(root, { recursive: true, force: true });
});

/** The publish stub: records its argv, prints ONE JSON line — the scripted reply for this call
 *  number, else a fresh successful publication — and exits as `publish --json` does. */
const STUB = `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const calls = join(import.meta.dir, "calls.jsonl");
appendFileSync(calls, JSON.stringify(process.argv.slice(2)) + "\\n");
const n = readFileSync(calls, "utf8").trim().split("\\n").length;
const replies = join(import.meta.dir, "replies.json");
const scripted = existsSync(replies) ? JSON.parse(readFileSync(replies, "utf8"))[n - 1] : undefined;
const reply = scripted ?? { ok: true, skipped: false, generation: "sha256:g" + n, publicationId: "pub-" + n };
console.log(JSON.stringify(reply));
process.exit(reply.ok ? 0 : 1);
`;

type Status = { state: string; sequence?: number; needTotalItems?: number; pullErrors?: number; receiveOnlyChangedFiles?: number; receiveOnlyChangedDeletes?: number };
const idle = (sequence: number, extra: Partial<Status> = {}): Status => ({ state: "idle", sequence, needTotalItems: 0, pullErrors: 0, receiveOnlyChangedFiles: 0, ...extra });

interface Run {
  code: number;
  lines: string[];
  sleeps: number[];
  /** argv of each stub publish, in order. */
  calls: string[][];
  /** the fake's view: every request that reached a handler, and the poll count at each localchanged read. */
  requests: number;
  localchangedAt: number[];
  /** the injected clock at each spawn — poll k is at 5k s. */
  spawnedAt: number[];
  /** the path the watcher was given (a symlink to the vault) — what it forwards and keys state by. */
  vault: string;
  home: string;
}

type LocalChange = string | { name: string; deleted: boolean };

async function watch(script: Array<Status | 503>, o: {
  folderType?: string; noFolder?: boolean; pem?: string | null; configKey?: boolean; env?: Record<string, string>;
  url?: (port: number) => string; minIntervalMs?: number; replies?: object[]; cli?: string[];
  localchanged?: (polls: number) => LocalChange[]; lcStatus?: number; hangStatus?: boolean; requestTimeoutMs?: number;
  stopAfterSleeps?: number; prepare?: (vault: string) => void;
} = {}): Promise<Run> {
  const dir = mkdtempSync(join(root, "run-"));
  const real = join(dir, "vault");
  mkdirSync(real);
  // The match is realpath on BOTH sides, and both sides are symlinks here: Syncthing names the
  // folder through one and --vault is another. The temp dir alone would exercise the vault side
  // only on macOS (/var -> /private/var); Linux CI's /tmp is no symlink.
  symlinkSync(real, join(dir, "replica-link"));
  const vault = join(dir, "vault-link");
  symlinkSync(real, vault);
  o.prepare?.(vault);
  const conf = join(dir, "syncthing");
  mkdirSync(conf);
  writeFileSync(join(conf, "config.xml"),
    `<configuration version="37">\n  <gui enabled="true" tls="true">\n    <address>127.0.0.1:8384</address>\n` +
    (o.configKey === false ? "" : `    <apikey>${KEY}</apikey>\n`) + "  </gui>\n</configuration>\n");
  if (o.pem !== null) writeFileSync(join(conf, "https-cert.pem"), o.pem ?? certA);
  writeFileSync(join(dir, "stub.ts"), STUB);
  if (o.replies) writeFileSync(join(dir, "replies.json"), JSON.stringify(o.replies));

  const ac = new AbortController();
  let polls = 0, requests = 0;
  const localchangedAt: number[] = [];
  // idleTimeout 0: Bun's own 10 s idle cut would otherwise end a hung request and mask a watcher
  // that has no timeout of its own.
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, tls: { cert: certA, key: keyA }, idleTimeout: 0,
    fetch(req) {
      requests++;
      if (req.headers.get("x-api-key") !== KEY) return new Response("Forbidden", { status: 403 });
      const u = new URL(req.url);
      if (u.pathname === "/rest/config/folders") {
        return Response.json([
          { id: "unrelated", path: conf, type: "sendreceive" },
          ...(o.noFolder ? [] : [{ id: "funes-star", path: join(dir, "replica-link"), type: o.folderType ?? "receiveonly" }]),
        ]);
      }
      if (u.pathname === "/rest/db/status" && u.searchParams.get("folder") === "funes-star") {
        if (o.hangStatus) return new Promise<Response>(() => {});
        const s = script[Math.min(polls, script.length - 1)]!;
        polls++;
        if (polls >= script.length) ac.abort();
        return s === 503 ? new Response("", { status: 503 }) : Response.json(s);
      }
      if (u.pathname === "/rest/db/localchanged" && u.searchParams.get("folder") === "funes-star") {
        localchangedAt.push(polls);
        if (o.lcStatus) return new Response("x", { status: o.lcStatus });
        const files = (o.localchanged?.(polls) ?? []).map((f) => (typeof f === "string" ? { name: f, deleted: false } : f));
        return Response.json({ files: files.map((f) => ({ ...f, type: "FILE_INFO_TYPE_FILE" })), page: 1, perpage: 65536 });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  const lines: string[] = [];
  const sleeps: number[] = [];
  const spawnedAt: number[] = [];
  let t = 0;
  const home = join(dir, "home");
  try {
    const code = await runWatch({
      vault, home,
      syncthing: o.url ? o.url(server.port!) : `https://127.0.0.1:${server.port}`,
      intervalMs: 5_000,
      minIntervalMs: o.minIntervalMs ?? 0,
      requestTimeoutMs: o.requestTimeoutMs,
      env: { STCONFDIR: conf, ...o.env },
      cli: o.cli ?? [process.execPath, join(dir, "stub.ts")],
      log: (l) => { lines.push(l); if (l.startsWith("publishing")) spawnedAt.push(t); },
      signal: ac.signal,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
        if (o.stopAfterSleeps && sleeps.length >= o.stopAfterSleeps) ac.abort();
        await Bun.sleep(0);
      },
    });
    const callsFile = join(dir, "calls.jsonl");
    const calls = existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : [];
    return { code, lines, sleeps, calls, requests, localchangedAt, spawnedAt, vault, home };
  } finally {
    server.stop(true);
  }
}

const published = (r: Run) => r.lines.filter((l) => l.startsWith("publishing"));
const statusLines = (r: Run) => r.lines.filter((l) => l.startsWith("status:"));
const count = (r: Run, prefix: string) => r.lines.filter((l) => l.startsWith(prefix)).length;
const SCOPED = 'memory:\n  index_scope:\n    exclude:\n      - "private/**"\n';

test("item 15: a delivered change becomes a new publication — once, on a settled idle sequence, and never again for it", async () => {
  const r = await watch([
    idle(1), idle(1), idle(1),                                        // settles, publishes 1, then holds
    { state: "syncing", sequence: 2, needTotalItems: 1, pullErrors: 0 }, // a delivery in flight
    idle(3), idle(3), idle(3),                                        // lands: settles, publishes 3, holds
  ], {
    prepare: (vault) => {
      writeFileSync(join(vault, "star.yaml"), SCOPED);
      // A reindex on this machine already bound the LIVE index. The watcher's write must not erase it.
      writeMachineState(vault, { boundTo: "instance-live", authoredHere: true, desiredScopeHash: null });
    },
  });
  expect(r.code).toBe(0);
  expect(r.calls).toEqual([
    ["publish", "--vault", r.vault, "--home", r.home, "--json"],
    ["publish", "--vault", r.vault, "--home", r.home, "--json"],
  ]);
  expect(published(r)).toEqual(["publishing sequence 1", "publishing sequence 3"]);
  expect(r.spawnedAt).toEqual([5_000, 25_000]); // poll 1 and poll 5
  expect(r.localchangedAt).toEqual([]); // nothing changed locally: the expensive call is never made
  expect(r.lines.some((l) => l.startsWith("published sequence 3") && l.includes("pub-2"))).toBe(true);
  // Machine state is written for the publication this machine just built, so doctor on the replica
  // reads "authored here" instead of UNKNOWN (the gap RAI-126's review named: publish never wrote it),
  // with the scope in force when it was built…
  const ms = readMachineState(r.vault, "pub-2");
  expect(ms.kind).toBe("known");
  if (ms.kind === "known") {
    expect(ms.state.authoredHere).toBe(true);
    expect(ms.state.desiredScopeHash).toBe(scopeHash(["private/**"]));
  }
  // …and in its own slot: the live index's binding survives, so `doctor --live` stays "authored here".
  expect(readMachineState(r.vault, "instance-live").kind).toBe("known");
}, 30_000);

// The one case with the REAL publish: the default argv (FUNES_CLI), the real `publish --json` line,
// and the `publicationId` field item 15 added to it. An empty vault walks, builds and publishes with
// nothing to embed; the model cache is an empty dir and every fetch goes to a dead proxy, so a
// regression that loads the model fails in seconds instead of downloading it. Env reaches the child
// through `env`, because the watcher's spawn inherits this process's and nothing else.
test("item 15: through the real `funes publish` — the manifest it publishes is the one the watcher names and binds", async () => {
  const scratch = mkdtempSync(join(root, "real-"));
  const models = join(scratch, "models");
  mkdirSync(models);
  const r = await watch([idle(1), idle(1), idle(1)], {
    cli: ["/usr/bin/env", `FUNES_MODEL_DIR=${models}`, `FUNES_LOCK_DIR=${join(scratch, "locks")}`,
      "HTTPS_PROXY=http://127.0.0.1:1", "HTTP_PROXY=http://127.0.0.1:1", "NO_PROXY=", ...FUNES_CLI],
  });
  expect(r.code).toBe(0);
  const m = readGenerationManifest(r.home);
  expect(m).not.toBeNull();
  expect(m!.publicationId).toMatch(/^pub:[0-9a-f]{32}$/);
  // The research pass's proof: the published generation is the content-hash target of this vault.
  expect(m!.generation).toBe(computeTargetGeneration(r.vault, { embedder: new E5Embedder(), scopeSignature: null }));
  expect(r.lines).toContain(`published sequence 1: publication ${m!.publicationId} · generation ${m!.generation}`);
  const ms = readMachineState(r.vault, m!.publicationId!);
  expect(ms.kind).toBe("known");
  if (ms.kind === "known") expect(ms.state.desiredScopeHash).toBeNull(); // no star.yaml, no declared scope
  expect(readdirSync(models)).toEqual([]);
}, 60_000);

// The walk publishes through the CLI, which writes no machine state, so the watcher's first spawn on
// an unchanged vault is a skip. Recording only a BUILT publication left `doctor` on the replica
// UNKNOWN until the next delivery — the outcome plan item 15's "after each successful publish" is for.
test("item 15: a skipped publish is a success that records machine state too — bound to the publication current in the home", async () => {
  const r = await watch([idle(1), idle(1), idle(1)], {
    replies: [{ ok: true, skipped: true, generation: "sha256:g", publicationId: "pub-standing" }],
  });
  expect(r.calls.length).toBe(1);
  expect(r.lines.some((l) => l.startsWith("published sequence 1: already current"))).toBe(true);
  const ms = readMachineState(r.vault, "pub-standing");
  expect(ms.kind).toBe("known");
  if (ms.kind === "known") expect(ms.state.authoredHere).toBe(true);
}, 30_000);

test("item 15: lastPublished advances only on ok:true — a refused publish is retried on a later poll with no other state", async () => {
  const r = await watch([idle(4), idle(4), idle(4), idle(4), idle(4)], {
    replies: [{ ok: false, error: "publishReindex: the vault moved between the build and the swap — not published, retry" }],
  });
  expect(r.calls.length).toBe(2); // the failure, then the retry that succeeded; then nothing
  expect(r.lines.some((l) => l.startsWith("publish FAILED at sequence 4") && l.includes("not published, retry"))).toBe(true);
  expect(r.lines.some((l) => l.startsWith("published sequence 4"))).toBe(true);
}, 30_000);

test("item 15: a refused publish is floored by --min-interval too — its retry waits the interval, not the next poll", async () => {
  const r = await watch(Array.from({ length: 16 }, () => idle(1)), {
    minIntervalMs: 60_000,
    replies: [{ ok: false, error: "publishReindex: the vault moved between the build and the swap — not published, retry" }],
  });
  expect(r.spawnedAt).toEqual([5_000, 65_000]); // poll 1 fails; the retry is poll 13, 60 s later
  expect(r.calls.length).toBe(2);
}, 30_000);

test("item 15: two deliveries inside one --min-interval are one spawn, of the later sequence", async () => {
  // poll k lands at 5k s. 1 publishes at 5 s; 2 settles at 15 s and 3 at 25 s, both under the
  // floor; the next spawn is the first settled poll at or past 65 s — poll 13, sequence 3.
  const script = [idle(1), idle(1), idle(2), idle(2), ...Array.from({ length: 12 }, () => idle(3))];
  const r = await watch(script, { minIntervalMs: 60_000 });
  expect(published(r)).toEqual(["publishing sequence 1", "publishing sequence 3"]);
  expect(r.spawnedAt).toEqual([5_000, 65_000]); // AT the floor, not the poll after it
  expect(r.calls.length).toBe(2);
}, 30_000);

test("item 15: idle with needTotalItems > 0 never spawns, logs ONE line carrying need and pullErrors, and publication resumes at need 0", async () => {
  const r = await watch([
    idle(1), idle(1),                                                                // publishes 1
    idle(2, { needTotalItems: 3, pullErrors: 3 }), idle(2, { needTotalItems: 3, pullErrors: 3 }),
    idle(2, { needTotalItems: 3, pullErrors: 3 }), idle(2, { needTotalItems: 3, pullErrors: 3 }),
    idle(5), idle(5), idle(5),                                                       // need back to 0
  ]);
  expect(r.lines.filter((l) => l.includes("needTotalItems=3") && l.includes("pullErrors=3")).length).toBe(1);
  expect(published(r)).toEqual(["publishing sequence 1", "publishing sequence 5"]);
}, 30_000);

test("item 15: startup mid-pull (needTotalItems > 0) waits like any other poll — no startup publish, then exactly one", async () => {
  const r = await watch([
    idle(7, { needTotalItems: 2 }), idle(7, { needTotalItems: 2 }), idle(7, { needTotalItems: 2 }),
    { state: "syncing", sequence: 8, needTotalItems: 1, pullErrors: 0 },
    idle(9), idle(9), idle(9), idle(9),
  ]);
  expect(published(r)).toEqual(["publishing sequence 9"]);
  expect(r.calls.length).toBe(1);
}, 30_000);

test("item 15: a state other than idle never spawns, even with need 0 and a settled sequence", async () => {
  const scanning = { state: "scanning", sequence: 5, needTotalItems: 0, pullErrors: 0 };
  const r = await watch([scanning, scanning, scanning, idle(5), idle(5)]);
  // Sequence 5 is already settled when idle arrives, so the spawn is poll 3 — and nothing before it.
  expect(published(r)).toEqual(["publishing sequence 5"]);
  expect(r.spawnedAt).toEqual([15_000]);
}, 30_000);

test("item 15: pullErrors never gates — idle, need 0 and a settled sequence publish whatever it says", async () => {
  const r = await watch([idle(1), idle(1), idle(1)].map((s) => ({ ...s, pullErrors: 2 })));
  expect(published(r)).toEqual(["publishing sequence 1"]);
  expect(r.lines.filter((l) => l.includes("pullErrors=2")).length).toBe(1);
}, 30_000);

test("item 15: Syncthing down at startup backs off 2 s -> 30 s, keeps polling, and spawns nothing", async () => {
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = closed.port!;
  closed.stop(true);
  const r = await watch([idle(1)], { url: () => `https://127.0.0.1:${port}`, stopAfterSleeps: 7 });
  expect(r.code).toBe(0);
  expect(r.sleeps).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  expect(r.calls).toEqual([]);
  expect(count(r, "Syncthing unreachable")).toBe(1); // once per outage
}, 30_000);

test("item 15: a non-2xx status is Syncthing down too — back off, recover, publish; a second outage starts again at 2 s", async () => {
  const r = await watch([503, 503, idle(1), idle(1), 503, idle(1)]);
  expect(r.sleeps).toEqual([2_000, 4_000, 5_000, 5_000, 2_000, 5_000]);
  expect(count(r, "Syncthing unreachable")).toBe(2); // once per outage START
  expect(count(r, "Syncthing answering again")).toBe(2); // once per recovery, never per healthy poll
  expect(published(r)).toEqual(["publishing sequence 1"]);
}, 30_000);

test("item 15: a status with no sequence is Syncthing down — no spawn, and lastPublished is not wiped", async () => {
  const bad = { state: "idle", needTotalItems: 0, pullErrors: 0 };
  const r = await watch([idle(1), idle(1), bad, bad, bad]);
  expect(r.calls.length).toBe(1);
  expect(published(r)).toEqual(["publishing sequence 1"]);
  expect(r.sleeps.slice(2, 4)).toEqual([2_000, 4_000]);
  const down = r.lines.filter((l) => l.startsWith("Syncthing unreachable"));
  expect(down.length).toBe(1);
  expect(down[0]).toContain("status carries no state/sequence/needTotalItems");
}, 30_000);

test("item 15: a GUI that accepts the connection and never answers is Syncthing down — the request times out into a back-off", async () => {
  const r = await watch([idle(1)], { hangStatus: true, requestTimeoutMs: 200, stopAfterSleeps: 1 });
  expect(r.code).toBe(0);
  expect(r.lines.some((l) => l.startsWith("Syncthing unreachable (no answer"))).toBe(true);
  expect(r.sleeps).toEqual([2_000]);
}, 5_000);

test("item 15: a refused API key exits 2 with no spawn, and the key is never printed", async () => {
  const r = await watch([idle(1), idle(1)], { env: { STGUIAPIKEY: WRONG_KEY } });
  expect(r.code).toBe(2);
  expect(r.calls).toEqual([]);
  expect(r.lines.some((l) => l.includes("403"))).toBe(true);
  expect(r.lines.join("\n")).not.toContain(WRONG_KEY);
  expect(r.lines.join("\n")).not.toContain(KEY);
}, 30_000);

test("item 15: no key anywhere, and an unreadable certificate, are startup refusals before any request", async () => {
  const noKey = await watch([idle(1)], { configKey: false });
  expect(noKey.code).toBe(2);
  expect(noKey.requests).toBe(0);
  expect(noKey.lines.some((l) => l.includes("STGUIAPIKEY"))).toBe(true);
  const noCert = await watch([idle(1)], { pem: null });
  expect(noCert.code).toBe(2);
  expect(noCert.requests).toBe(0);
  expect(noCert.lines.some((l) => l.includes("https-cert.pem"))).toBe(true);
}, 30_000);

test("item 15: the fingerprint pin — matching pin publishes, a wrong pin reaches no handler and exits 2", async () => {
  const good = await watch([idle(1), idle(1)]);
  expect(good.calls.length).toBe(1);
  const bad = await watch([idle(1), idle(1)], { pem: certB });
  expect(bad.code).toBe(2);
  expect(bad.requests).toBe(0); // the socket died on secureConnect, before a header carried the key
  expect(bad.calls).toEqual([]);
  expect(bad.lines.some((l) => l.includes("fingerprint"))).toBe(true);
}, 30_000);

test("item 15: only loopback https — any other host, a DNS name that starts with 127., or plain http, is a startup refusal", async () => {
  // Each case asserts the check that refused it. The http one points at the FAKE's port: with the
  // https check gone it would talk TLS to the fake, pin-match, and poll — never an accidental pass
  // through whatever else listens on 8384.
  const cases: Array<[(port: number) => string, string]> = [
    [() => "https://host-a.example.com:8384", "not a loopback address"],
    [() => "https://192.0.2.10:8384", "not a loopback address"],
    [() => "https://127.evil.example:8384", "not a loopback address"],
    [(port) => `http://127.0.0.1:${port}`, "is not https"],
  ];
  for (const [url, reason] of cases) {
    const r = await watch([idle(1)], { url, stopAfterSleeps: 2 });
    expect(r.code).toBe(2);
    expect(r.requests).toBe(0);
    expect(r.lines.some((l) => l.startsWith("refused:") && l.includes(reason))).toBe(true);
  }
  // The address is checked BEFORE the key and the certificate are read: with neither present, a
  // wrong address is still refused as an address.
  const first = await watch([idle(1)], { configKey: false, pem: null, url: () => "https://host-a.example.com:8384" });
  expect(first.code).toBe(2);
  expect(first.lines.some((l) => l.includes("not a loopback address"))).toBe(true);
  expect(first.lines.some((l) => l.includes("STGUIAPIKEY") || l.includes("https-cert.pem"))).toBe(false);
}, 30_000);

test("item 15: a folder that is not receiveonly, or no folder at the vault, is refused", async () => {
  const sr = await watch([idle(1), idle(1)], { folderType: "sendreceive" });
  expect(sr.code).toBe(2);
  expect(sr.calls).toEqual([]);
  expect(sr.lines.some((l) => l.includes("sendreceive") && l.includes("receiveonly"))).toBe(true);
  // stopAfterSleeps: a regression that backs off instead of refusing ends the run (code 0) rather
  // than polling a folder list that will never name the vault.
  const nf = await watch([idle(1)], { noFolder: true, stopAfterSleeps: 2 });
  expect(nf.code).toBe(2);
  expect(nf.requests).toBe(1); // the folder list, and nothing after it
  expect(nf.calls).toEqual([]);
  expect(nf.lines.some((l) => l.includes("no Syncthing folder has the path"))).toBe(true);
}, 30_000);

const CONFLICT = "wiki/topic.sync-conflict-20260910-101500-ABCDEFG.md";

test("item 15: receiveOnlyChangedFiles > 0 — localchanged read once, conflict copies and divergent pages logged apart, spawn unaffected", async () => {
  const r = await watch([
    idle(1, { receiveOnlyChangedFiles: 2 }), idle(1, { receiveOnlyChangedFiles: 2 }),
    idle(1, { receiveOnlyChangedFiles: 2 }), idle(1, { receiveOnlyChangedFiles: 2 }),
  ], { localchanged: () => [CONFLICT, "wiki/other.md"] });
  expect(r.localchangedAt.length).toBe(1); // the count change; the spawn decision at the same sequence reuses it
  const conflictLine = r.lines.find((l) => l.startsWith("conflict copies"))!;
  const divergentLine = r.lines.find((l) => l.startsWith("divergent:"))!;
  expect(conflictLine).toContain(CONFLICT);
  expect(conflictLine).not.toContain("wiki/other.md");
  expect(divergentLine).toContain("wiki/other.md");
  expect(divergentLine).not.toContain(CONFLICT);
  expect(published(r)).toEqual(["publishing sequence 1"]);
  // …and every status line carries the divergent page until Syncthing's Revert clears it.
  expect(statusLines(r).every((l) => l.includes("divergent: wiki/other.md"))).toBe(true);
}, 30_000);

test("item 15: a conflict copy replaced by an edit of its page under an unchanged count — no read while count and sequence hold, divergent logged at the next spawn decision, before the spawn", async () => {
  const ro = { receiveOnlyChangedFiles: 1 };
  const r = await watch([
    idle(10, ro), idle(10, ro), idle(10, ro), // read at the count change; publish 10; hold
    idle(11, ro),                             // the copy moved over its page: count held, sequence moved
    idle(11, ro), idle(11, ro),               // settled: the spawn decision reads, logs, then publishes
  ], { localchanged: (polls) => (polls < 4 ? [CONFLICT] : ["wiki/topic.md"]) });
  expect(r.localchangedAt).toEqual([1, 5]); // after poll 0 (count change) and poll 4 (spawn decision) only
  const divergent = r.lines.findIndex((l) => l.startsWith("divergent:") && l.includes("wiki/topic.md"));
  const spawn = r.lines.indexOf("publishing sequence 11");
  expect(divergent).toBeGreaterThan(-1);
  expect(divergent).toBeLessThan(spawn);
  expect(published(r)).toEqual(["publishing sequence 10", "publishing sequence 11"]);
}, 30_000);

test("item 15: Revert — the count back at 0 clears divergent, with no read at 0 and none at a clean spawn decision", async () => {
  const r = await watch([
    idle(1, { receiveOnlyChangedFiles: 1 }), idle(1, { receiveOnlyChangedFiles: 1 }), // read, publish 1
    idle(2), idle(2), idle(2),                                                       // reverted: publish 2
  ], { localchanged: () => ["wiki/other.md"] });
  expect(r.localchangedAt).toEqual([1]);
  expect(statusLines(r).at(-1)).not.toContain("divergent:");
  expect(published(r)).toEqual(["publishing sequence 1", "publishing sequence 2"]);
}, 30_000);

test("item 15: a local DELETION of a canonical page is counted and named — receiveOnlyChangedFiles stays 0", async () => {
  // A deleted row is `Deleted` in Syncthing's counts, never `Files`: a `git clean` on the replica.
  const r = await watch([
    idle(1, { receiveOnlyChangedDeletes: 1 }), idle(1, { receiveOnlyChangedDeletes: 1 }), idle(1, { receiveOnlyChangedDeletes: 1 }),
  ], { localchanged: () => [{ name: "wiki/gone.md", deleted: true }] });
  expect(r.localchangedAt).toEqual([1]);
  expect(r.lines.some((l) => l.startsWith("deleted locally: wiki/gone.md"))).toBe(true);
  expect(r.lines.some((l) => l.startsWith("divergent:"))).toBe(false); // a deletion is not an edit
  expect(statusLines(r).every((l) => l.includes("deleted locally: wiki/gone.md"))).toBe(true);
  expect(published(r)).toEqual(["publishing sequence 1"]);
}, 30_000);

test("item 15: an edited page later deleted — the count holds at 1, and the spawn decision renames it deleted, never clears it", async () => {
  const r = await watch([
    idle(1, { receiveOnlyChangedFiles: 1 }), idle(1, { receiveOnlyChangedFiles: 1 }),   // edit read; publish 1
    idle(2, { receiveOnlyChangedDeletes: 1 }),                                          // deleted: total held at 1
    idle(2, { receiveOnlyChangedDeletes: 1 }), idle(2, { receiveOnlyChangedDeletes: 1 }), // settled: read, publish 2
  ], { localchanged: (polls) => (polls < 3 ? ["wiki/x.md"] : [{ name: "wiki/x.md", deleted: true }]) });
  expect(r.localchangedAt).toEqual([1, 4]);
  const renamed = r.lines.findIndex((l) => l.startsWith("deleted locally: wiki/x.md"));
  expect(renamed).toBeGreaterThan(-1);
  expect(renamed).toBeLessThan(r.lines.indexOf("publishing sequence 2"));
  expect(statusLines(r).at(-1)).toContain("deleted locally: wiki/x.md");
  expect(statusLines(r).at(-1)).not.toContain("divergent:");
  expect(published(r)).toEqual(["publishing sequence 1", "publishing sequence 2"]);
}, 30_000);

test("item 15: an unreadable localchanged is a finding — publication proceeds, no back-off; a refused key there still exits 2", async () => {
  const r = await watch(Array.from({ length: 6 }, () => idle(1, { receiveOnlyChangedFiles: 1 })), { lcStatus: 500 });
  expect(published(r)).toEqual(["publishing sequence 1"]);
  expect(r.lines.some((l) => l.startsWith("local changes: unreadable"))).toBe(true);
  expect(count(r, "Syncthing unreachable")).toBe(0);
  const refused = await watch([idle(1, { receiveOnlyChangedFiles: 1 }), idle(1, { receiveOnlyChangedFiles: 1 })], { lcStatus: 403 });
  expect(refused.code).toBe(2);
  expect(refused.calls).toEqual([]);
}, 30_000);

// The verb itself. `bun --define` sets the published bin's flag at RUNTIME, so the release gate's
// usage assertion (release.yml: the word `publish` never appears in the published bin's usage) is
// testable here without a build.
const CLI = join(import.meta.dir, "cli.ts");
const REPO = resolve(import.meta.dir, "..", "..", "..");
const cli = (args: string[], define = false) => spawnSync("bun", [...(define ? ["--define", "__FUNES_LIBSQL_ONLY__=true"] : []), CLI, ...args], { cwd: REPO, encoding: "utf8" });

test("item 15: `funes watch` is a from-source verb — listed in source usage, absent from the published bin's, refused there", () => {
  expect(cli([]).stdout).toContain("watch     --vault");
  const bin = cli([], true);
  expect(`${bin.stdout}${bin.stderr}`).not.toContain("publish");
  expect(`${bin.stdout}${bin.stderr}`).not.toContain("watch");
  const refused = cli(["watch", "--vault", root], true);
  expect(refused.status).toBe(2);
  expect(refused.stderr).toContain("not part of this build");
});

test("item 15: `funes watch` runs under the --interval and --min-interval it was given, refuses a non-loopback --syncthing before any request, and a zero interval", () => {
  const r = cli(["watch", "--vault", root, "--syncthing", "https://host-a.example.com:8384", "--interval", "7s", "--min-interval", "90s"]);
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("polling every 7s, at most one publish per 90s");
  expect(r.stderr).toContain("not a loopback address");
  const zero = cli(["watch", "--vault", root, "--interval", "0"]);
  expect(zero.status).toBe(2);
  expect(zero.stderr).toContain("--interval must be positive");
  // publication.ts's one duration grammar, refusing in the name of the flag that carried the value
  const bad = cli(["watch", "--vault", root, "--syncthing", "https://host-a.example.com:8384", "--min-interval", "2x"]);
  expect(bad.status).not.toBe(0);
  expect(bad.stderr).toContain('watch: --min-interval "2x" is not a duration');
});
