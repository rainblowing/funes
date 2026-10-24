// PLAN-0.5.0 item 32 (ADR-0010 §Revision (the replica bullet); record 29): `funes replica` against
// an S3 stub and the clock seam — record 35's R-rows R1–R17 (R12 is Vlad's Obsidian check; the
// `render()` quoting it tests is item 47's), "approve with the LaunchAgent stopped sends nothing" (R8)
// and "a stray `.md` in the mirror blocks publish" (R16).
//
// The edge is one double: the S3 stub lists and GETs the same objects its fake writer swaps, with
// put_page's compare-and-swap, receipts, protected fields and history objects, so a proposal the
// writer applied reaches the mirror only through the next pull, as on the proposer machine.
import { test, expect, afterAll, beforeAll } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { refuseS3Env, replicaTick, s3Bucket, type Bucket, type ReplicaOptions } from "./replica.ts";
import { approve, dismiss, listOutbox, outboxDirFor, resend, type Writer, type WriterReply } from "./outbox.ts";
import { parseFrontmatter } from "funes-core";
import { stateDirFor } from "../../funes-engine/src/funes-home.ts";
import { assertWriteAllowed } from "funes-core/internal";
import { resolveWriteDesignation } from "../../funes-engine/src/process-locus.ts";

const STAR = "mcp://rainblow.ing/taste";
/** The star's objects in the deployment's one bucket (ADR-0024). */
const PREFIX = "rainblow.ing/taste/_/";
const TOKEN = "funes_" + "R".repeat(43);
const T0 = Date.parse("2026-10-14T09:00:00Z");
const S = 1000, DAY = 86_400_000;
const tmp: string[] = [];
const mk = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d; };
let savedState: string | undefined;
beforeAll(() => { savedState = process.env.FUNES_HOME; process.env.FUNES_HOME = mk("funes-replica-state-"); });
afterAll(() => {
  if (savedState === undefined) delete process.env.FUNES_HOME; else process.env.FUNES_HOME = savedState;
  for (const d of tmp) { lift(d); rmSync(d, { recursive: true, force: true }); }
});
/** The mirror is 0555/0444 by design; give the cleanup and the tamper tests their bits back. */
function lift(d: string) {
  if (!existsSync(d)) return;
  chmodSync(d, 0o755);
  for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) lift(join(d, e.name)); else chmodSync(join(d, e.name), 0o644);
}

const enc = new TextEncoder();
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const md5 = (b: Uint8Array) => createHash("md5").update(b).digest("hex");
const STAR_YAML = `version: 3\nmeta:\n  id: ${STAR}\n  name: taste\n  write_locus: funes-taste\n`;
const page = (title: string, extra = "") => `---\ntitle: ${title}\ntype: Movie\ndomain: movies\n${extra}---\n\n**${title}**\n`;

/** The edge: R2's objects behind an S3 stub, and the writer that swaps them. */
class Edge {
  objects = new Map<string, { bytes: Uint8Array; etag: string; lastModified: string }>();
  receipts = new Map<string, { payload: string; writtenHash?: string }>();
  applyState = "idle";
  healthOverride: Record<string, unknown> | null = null;
  reachable = true;
  http: number | null = null;
  loseNextReply = false;
  calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  gets: string[] = [];
  lists = 0;
  clock = () => T0;

  put(key: string, body: string | Uint8Array, at = this.clock()) {
    const bytes = typeof body === "string" ? enc.encode(body) : body;
    this.objects.set(key, { bytes, etag: `"${md5(bytes)}"`, lastModified: new Date(at).toISOString() });
  }
  text(key: string) { return new TextDecoder().decode(this.objects.get(key)!.bytes); }

  /** Other stars' objects in the same bucket (ADR-0024), by their full key. */
  foreign = new Map<string, { bytes: Uint8Array; etag: string; lastModified: string }>();
  /** The full R2 key of a vault path: the star's `<key>/_/` prefix plus the path. */
  private full = (path: string) => `${PREFIX}${path}`;
  private byKey = (key: string) => (key.startsWith(PREFIX) ? this.objects.get(key.slice(PREFIX.length)) : undefined) ?? this.foreign.get(key);

  /** ListObjectsV2 two keys a page, so the pull has to follow the continuation token; the S3 `prefix`
   *  filters the whole bucket, this star's objects and the others'. */
  bucket = (): Bucket => ({
    list: async (input) => {
      if (!this.reachable) throw new Error("fetch failed: ECONNREFUSED");
      this.lists++;
      const keys = [...[...this.objects.keys()].map(this.full), ...this.foreign.keys()].filter((k) => k.startsWith(input.prefix)).sort();
      const from = input.continuationToken ? Number(input.continuationToken) : 0;
      const contents = keys.slice(from, from + 2).map((key) => ({ key, eTag: this.byKey(key)!.etag, lastModified: this.byKey(key)!.lastModified }));
      const more = from + 2 < keys.length;
      return { contents, isTruncated: more, ...(more ? { nextContinuationToken: String(from + 2) } : {}) };
    },
    file: (key) => ({ bytes: async () => { this.gets.push(key.startsWith(PREFIX) ? key.slice(PREFIX.length) : key); return new Uint8Array(this.byKey(key)!.bytes); } }),
  });

  writer = (): Writer => ({
    call: async (op, args): Promise<WriterReply> => {
      this.calls.push({ op, args });
      if (!this.reachable) return { error: "fetch failed: ECONNREFUSED" };
      if (this.http) return { http: this.http };
      if (op === "health") return { answer: this.healthOverride ?? { proposalProtocol: 1, starId: STAR, locus: "funes-taste", applyState: this.applyState } };
      const answer = this.apply(args as { path: string; content: string; base?: string; proposalId: string });
      if (this.loseNextReply) { this.loseNextReply = false; return { error: "the reply was lost" }; }
      return { answer };
    },
    close: async () => {},
  });

  private apply(a: { path: string; content: string; base?: string; proposalId: string }): Record<string, unknown> {
    const payload = sha(JSON.stringify([a.path, a.content, a.base ?? null]));
    const known = this.receipts.get(a.proposalId);
    if (known) return known.payload === payload ? { proposalId: a.proposalId, status: "already-applied", writtenHash: known.writtenHash } : { proposalId: a.proposalId, status: "refused", reason: "invalid" };
    const refuse = (reason: string, currentHash?: string) => ({ proposalId: a.proposalId, status: "refused", reason, ...(currentHash ? { currentHash } : {}) });
    const cur = this.objects.get(a.path);
    const curHash = cur && sha(cur.bytes);
    if (a.base === undefined && cur) return refuse("stale-base", curHash);
    if (a.base !== undefined && !cur) return refuse("not-found");
    if (a.base !== undefined && a.base !== curHash) return refuse("stale-base", curHash);
    const fm = parseFrontmatter(a.content);
    if (fm.malformed !== undefined || a.content.includes("WRITER-SAYS-INVALID")) return refuse("invalid");
    if (a.base === undefined && "created" in fm.data) return refuse("protected-field");
    const text = a.content.replace(/\r\n/g, "\n"); // the writer's sanitize: the next pull brings the normalized bytes
    if (cur) this.put(`.history/${a.path}/${curHash}`, cur.bytes);
    this.put(a.path, text);
    const writtenHash = sha(enc.encode(text));
    this.receipts.set(a.proposalId, { payload, writtenHash });
    return { proposalId: a.proposalId, status: "applied", writtenHash };
  }

  proposals() { return this.calls.filter((c) => c.op !== "health"); }
}

/** The proposer machine's shape: `~/taste`, a funes home with the 0600 endpoint file, outbox token and Object Read
 *  credential, and the edge holding the taste star.yaml and two pages. */
function proposer() {
  const root = mk("funes-replica-");
  const taste = join(root, "taste");
  mkdirSync(taste);
  const home = join(root, "funes-home");
  mkdirSync(home);
  const tokenFile = join(home, "taste-outbox.token");
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const credentialsFile = join(home, "taste-r2-read.json");
  writeFileSync(credentialsFile, JSON.stringify({ access_key_id: "AKID", secret_access_key: "SECRET" }), { mode: 0o600 });
  const endpointsPath = join(home, "endpoints.json");
  writeFileSync(endpointsPath, JSON.stringify({ [STAR]: { url: "https://taste.example", token_file: tokenFile, pull: { endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "taste", credentials_file: credentialsFile } } }), { mode: 0o600 });
  const edge = new Edge();
  let t = T0;
  edge.clock = () => t;
  edge.put("star.yaml", STAR_YAML);
  edge.put("items/movies/stalker--andrei-tarkovsky.md", page("Stalker", "creator: Andrei Tarkovsky\n"));
  edge.put("items/movies/solaris--1972.md", page("Solaris", "year: 1972\n"));
  const notes: string[] = [];
  const logs: string[] = [];
  const published: string[] = [];
  const creds: unknown[] = [];
  const opts = (): ReplicaOptions => ({
    taste, starId: STAR, endpointsPath, locationHome: root, now: () => t, pullEveryMs: 0,
    bucketFor: (pull, c) => { creds.push({ pull, c }); return edge.bucket(); },
    writer: edge.writer,
    publish: async (mirror) => { published.push(mirror); return { ok: true, generation: "g" }; },
    notify: (n) => notes.push(n),
    log: (l) => logs.push(l),
  });
  const mirror = join(stateDirFor(taste), "canon");
  return {
    taste, mirror, home, edge, notes, logs, published, creds, endpointsPath,
    outbox: outboxDirFor(taste),
    tick: (o: Partial<ReplicaOptions> = {}) => replicaTick({ ...opts(), ...o }),
    advance: (ms: number) => { t += ms; },
    at: () => t,
    read: (rel: string) => readFileSync(join(taste, rel)),
    write: (rel: string, s: string | Uint8Array) => { mkdirSync(join(taste, rel, ".."), { recursive: true }); writeFileSync(join(taste, rel), s); },
  };
}
const STALKER = "items/movies/stalker--andrei-tarkovsky.md";
const SOLARIS = "items/movies/solaris--1972.md";
const records = (v: ReturnType<typeof proposer>) => listOutbox(v.outbox).records;

/** A save, then enough ticks for it to be 30 s stable, proposed and drained. */
async function settle(v: ReturnType<typeof proposer>) {
  await v.tick();
  v.advance(31 * S);
  return v.tick();
}

test("R1: the pull mirrors every key byte-exact (BOM, CRLF, non-ASCII), 0444 files in 0555 dirs, and ~/taste equals the mirror", async () => {
  const v = proposer();
  const odd = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode("---\r\ntitle: Сталкер — ü\r\ntype: Movie\r\n---\r\n\r\nbody\r\n")]);
  v.edge.put("items/movies/stalker-ru.md", odd);
  v.edge.put(`.history/${STALKER}/${"a".repeat(64)}`, "an older version", Date.parse("2026-10-01T00:00:00Z"));
  const r = await v.tick();
  expect(r.skipped).toBeUndefined();
  for (const [key, o] of v.edge.objects) {
    expect(sha(readFileSync(join(v.mirror, key)))).toBe(sha(o.bytes));
    expect(statSync(join(v.mirror, key)).mode & 0o777).toBe(0o444);
  }
  expect(statSync(join(v.mirror, "items", "movies")).mode & 0o777).toBe(0o555);
  expect(statSync(v.mirror).mode & 0o777).toBe(0o555);
  // history: mirror only, its mtime the listing's lastModified so `ls -lt` orders versions
  expect(statSync(join(v.mirror, ".history", STALKER, "a".repeat(64))).mtimeMs).toBe(Date.parse("2026-10-01T00:00:00Z"));
  expect(existsSync(join(v.taste, ".history"))).toBe(false);
  for (const key of [STALKER, SOLARIS, "items/movies/stalker-ru.md", "star.yaml"]) expect(sha(v.read(key))).toBe(sha(v.edge.objects.get(key)!.bytes));
  expect(statSync(join(v.taste, "star.yaml")).mode & 0o777).toBe(0o444);
  // the Object Read credential came from its 0600 file, with the pull entry's endpoint and bucket
  expect(v.creds[0]).toEqual({ pull: { endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "taste", credentialsFile: expect.any(String) }, c: { accessKeyId: "AKID", secretAccessKey: "SECRET" } });

  // a second pass GETs nothing: every etag equals the mirror's
  v.edge.gets = [];
  await v.tick();
  expect(v.edge.gets).toEqual([]);
  expect(v.published).toEqual([v.mirror]); // published once, for the pass that changed the mirror
});

// RAI-316 (ADR-0024): the pull lists only `<starKey>/_/` and strips it, so a star nested under this
// one's key, and the bucket root, never reach the mirror.
test("the pull lists only the star's <key>/_/ prefix: a nested star's and a root object never reach the mirror", async () => {
  const v = proposer();
  const foreign = (key: string) => v.edge.foreign.set(key, { bytes: enc.encode("not ours"), etag: `"${md5(enc.encode("not ours"))}"`, lastModified: new Date(T0).toISOString() });
  foreign("rainblow.ing/taste/sub/_/items/movies/nested.md");
  foreign("rainblow.ing/taste/sub/_/star.yaml");
  foreign("items/movies/root.md");
  await v.tick();
  expect(existsSync(join(v.mirror, STALKER))).toBe(true);
  for (const p of ["items/movies/nested.md", "items/movies/root.md", "sub", "rainblow.ing"]) expect(existsSync(join(v.mirror, p)), p).toBe(false);
  expect(v.edge.gets.every((k) => !k.includes("nested") && !k.includes("root"))).toBe(true);
});

test("R1: a body whose md5 is not its etag is refused and never written", async () => {
  const v = proposer();
  v.edge.put("items/movies/torn.md", page("Torn"));
  v.edge.objects.get("items/movies/torn.md")!.etag = `"${"0".repeat(32)}"`;
  await v.tick();
  expect(existsSync(join(v.mirror, "items/movies/torn.md"))).toBe(false);
  expect(existsSync(join(v.taste, "items/movies/torn.md"))).toBe(false);
  expect(v.logs.some((l) => l.includes("items/movies/torn.md — the body's md5 is not its etag"))).toBe(true);
});

test("an edit 30 s stable is proposed with its base, answers applied, and the next pass leaves ~/taste at the normalized canon", async () => {
  const v = proposer();
  await v.tick();
  const before = sha(v.read(STALKER));
  v.write(STALKER, page("Stalker", "creator: Andrei Tarkovsky\nmy_score: 10\n").replace(/\n/g, "\r\n"));
  const first = await v.tick();
  expect(first.proposed).toEqual([]); // not yet 30 s stable
  v.advance(31 * S);
  const r = await v.tick();
  expect(r.proposed).toEqual([STALKER]);
  expect(r.drain!.applied).toHaveLength(1);
  expect(v.edge.proposals()[0]!.args.base).toBe(before);
  // the writer stored LF; the next pass brings it and puts it in ~/taste
  v.advance(5 * S);
  await v.tick();
  expect(v.read(STALKER).toString()).toBe(page("Stalker", "creator: Andrei Tarkovsky\nmy_score: 10\n"));
  expect(sha(v.read(STALKER))).toBe(sha(v.edge.objects.get(STALKER)!.bytes));
  v.advance(60 * S);
  await v.tick();
  expect(v.edge.proposals()).toHaveLength(1); // its own write is never an edit
});

test("R2: a save of the pre-overwrite buffer within 10 s of a reconcile write answers stale-base, not applied", async () => {
  const v = proposer();
  await v.tick();
  const buffer = v.read(STALKER).toString();
  v.advance(60 * S);
  v.edge.put(STALKER, page("Stalker", "creator: Andrei Tarkovsky\nmy_score: 9\n")); // the bot's edit
  const r1 = await v.tick();
  expect(r1.restored).toEqual([STALKER]);
  v.advance(3 * S);
  v.write(STALKER, buffer.replace("**Stalker**", "**Stalker**, from an editor buffer loaded before the pull"));
  v.advance(2 * S);
  await v.tick(); // first seen 5 s after the reconcile wrote the path
  v.advance(31 * S);
  const r = await v.tick();
  expect(r.drain!.applied).toEqual([]);
  expect(r.drain!.refused).toHaveLength(1);
  expect(v.edge.proposals()[0]!.args.base).toBe(sha(buffer));
  expect(records(v)[0]!.answer!.reason).toBe("stale-base");
  expect(v.notes).toEqual([expect.stringMatching(/^refused stale-base: items\/movies\/stalker--andrei-tarkovsky\.md — funes outbox show /)]);
});

/** A proposer edit refused stale-base: queued offline, the bot edits the page meanwhile, then the drain. */
async function refusedEdit() {
  const v = proposer();
  await v.tick();
  v.edge.reachable = false;
  v.write(STALKER, page("Stalker", "creator: Andrei Tarkovsky\nmy_score: 7\n"));
  await settle(v);
  expect(records(v)[0]!.status).toBe("pending");
  v.edge.put(STALKER, page("Stalker", "creator: Andrei Tarkovsky\nmy_score: 9\n"));
  v.edge.reachable = true;
  v.advance(5 * S);
  const r = await v.tick();
  expect(r.drain!.refused).toHaveLength(1);
  expect(v.read(STALKER).toString()).toContain("my_score: 7"); // the pull never overwrites an unanswered edit
  return v;
}

test("R3: after a refusal every further save is captured into the record and canon restored; nothing is sent until dismiss", async () => {
  const v = await refusedEdit();
  const canon = v.edge.text(STALKER);
  v.advance(5 * S);
  await v.tick();
  expect(v.read(STALKER).toString()).toBe(canon); // restored
  for (const score of [8, 6]) {
    v.write(STALKER, page("Stalker", `creator: Andrei Tarkovsky\nmy_score: ${score}\n`));
    v.advance(5 * S);
    await v.tick();
    expect(v.read(STALKER).toString()).toBe(canon);
    v.advance(40 * S);
    await v.tick();
  }
  const rec = records(v)[0]!;
  expect(rec.status).toBe("refused");
  expect(rec.captured).toEqual([page("Stalker", "creator: Andrei Tarkovsky\nmy_score: 8\n"), page("Stalker", "creator: Andrei Tarkovsky\nmy_score: 6\n")]);
  expect(v.edge.proposals()).toHaveLength(1);
  expect(v.notes).toHaveLength(1);
  // dismiss lifts the hold: the merge Vlad saves is an ordinary edit against the canon he merged into
  dismiss(v.outbox, rec.proposalId);
  v.write(STALKER, page("Stalker", "creator: Andrei Tarkovsky\nmy_score: 8\n"));
  const r = await settle(v);
  expect(r.drain!.applied).toHaveLength(1);
  expect(v.edge.proposals()[1]!.args.base).toBe(sha(canon));
});

test("R4: an edit refused invalid while canon is unchanged — the next pass restores canon", async () => {
  const v = proposer();
  await v.tick();
  const canon = v.read(STALKER).toString();
  v.write(STALKER, page("Stalker", "creator: Andrei Tarkovsky\n") + "WRITER-SAYS-INVALID\n");
  const r = await settle(v);
  expect(records(v)[0]!.answer!.reason).toBe("invalid");
  expect(r.drain!.refused).toHaveLength(1);
  v.advance(5 * S);
  await v.tick();
  expect(v.read(STALKER).toString()).toBe(canon);
});

test("R5: an edit that breaks the YAML is held with the parser's error line, never sent, never reverted", async () => {
  const v = proposer();
  await v.tick();
  const broken = "---\ntitle: [Stalker\ncreator: Andrei Tarkovsky\n---\n\nbody\n";
  v.write(STALKER, broken);
  const r = await settle(v);
  expect(r.held).toEqual([{ path: STALKER, reason: expect.stringMatching(/^invalid: .*line \d+/) }]);
  v.advance(60 * S);
  await v.tick();
  expect(v.read(STALKER).toString()).toBe(broken);
  expect(v.edge.proposals()).toEqual([]);
  expect(records(v)).toEqual([]);
});

test("R6: a new file waits for approve — off-rule held with the computed path; the rule path and its --type variant apply; a template `created` is refused protected-field; a held file never reaches the mirror", async () => {
  const v = proposer();
  await v.tick();
  const off = "items/movies/zz-acceptance-whatever.md";
  const rule = "items/movies/zz-acceptance-two--2026.md";
  const variant = "items/movies/zz-acceptance-three--2026--movie.md";
  const tmpl = "items/movies/zz-acceptance-four.md";
  v.write(off, page("ZZ Acceptance One"));
  v.write(rule, page("ZZ Acceptance Two", "year: 2026\n"));
  v.write(variant, page("ZZ Acceptance Three", "year: 2026\n"));
  v.write(tmpl, page("ZZ Acceptance Four", "created: 2026-10-14\n"));
  await settle(v);
  const held = records(v);
  expect(held.map((r) => r.status)).toEqual(["held", "held", "held", "held"]);
  expect(held.find((r) => r.args.path === off)!.lastError).toBe("invalid: would be items/movies/zz-acceptance-one.md");
  expect(v.edge.proposals()).toEqual([]);
  for (const p of [off, rule, variant, tmpl]) approve(v.outbox, p);
  v.advance(5 * S);
  const r = await v.tick();
  expect(r.drain!.applied).toHaveLength(2);
  expect(v.edge.proposals().map((c) => c.args.path).sort()).toEqual([tmpl, variant, rule].sort());
  expect(v.edge.proposals().every((c) => c.args.base === undefined)).toBe(true); // create-once
  expect(records(v).find((x) => x.args.path === tmpl)!.answer!.reason).toBe("protected-field");
  const stillHeld = records(v).find((x) => x.args.path === off)!;
  expect([stillHeld.status, stillHeld.mark]).toEqual(["held", undefined]);
  // the proposer indexes the mirror: the held file is not in it, and only the mirror is ever published
  v.advance(60 * S);
  await v.tick();
  expect(existsSync(join(v.mirror, rule))).toBe(true);
  expect(existsSync(join(v.mirror, off))).toBe(false);
  expect(new Set(v.published)).toEqual(new Set([v.mirror]));
});

test("R7: a deleted file is restored on the next pass, and no proposal is ever sent", async () => {
  const v = proposer();
  await v.tick();
  const canon = v.read(SOLARIS).toString();
  unlinkSync(join(v.taste, SOLARIS));
  v.advance(5 * S);
  const r = await v.tick();
  expect(r.restored).toEqual([SOLARIS]);
  expect(v.read(SOLARIS).toString()).toBe(canon);
  v.advance(60 * S);
  await v.tick();
  expect(v.edge.proposals()).toEqual([]);
  expect(v.logs).toContain(`deleted locally: ${SOLARIS} — restored from canon`);
});

test("R8: approve with the LaunchAgent stopped sends nothing — only a mark; the next tick sends it", async () => {
  const v = proposer();
  await v.tick();
  const rule = "items/movies/zz-acceptance-two--2026.md";
  v.write(rule, page("ZZ Acceptance Two", "year: 2026\n"));
  await settle(v);
  const calls = v.edge.calls.length;
  approve(v.outbox, rule); // the agent is stopped: no tick runs
  expect(records(v)[0]).toMatchObject({ status: "held", mark: "approve" });
  expect(v.edge.calls.length).toBe(calls);
  v.advance(5 * S);
  const r = await v.tick();
  expect(r.drain!.applied).toHaveLength(1);
  expect(listOutbox(v.outbox).dismissed.map((x) => x.args.path)).toEqual([rule]);
});

test("R9: after the replica placed the 0444 star.yaml, a funes mutation against ~/taste refuses through the write rule and names funes-taste", async () => {
  const v = proposer();
  await v.tick();
  expect(statSync(join(v.taste, "star.yaml")).mode & 0o777).toBe(0o444);
  // RAI-324: the rule refuses through write_locus funes-taste; the endpoint file is not an input.
  const cases: Array<Record<string, string>> = [{}, { FUNES_LOCUS: "host-b" }];
  const refuse = (env: Record<string, string>) => {
    const d = resolveWriteDesignation(v.taste, { env });
    expect(() => assertWriteAllowed(d, "put_page")).toThrow(/"funes-taste"/);
  };
  for (const env of cases) refuse(env);
  chmodSync(v.endpointsPath, 0o000);
  try { refuse({}); } finally { chmodSync(v.endpointsPath, 0o600); }
  expect(records(v)).toEqual([]);
});

test("R10: offline a day — edits queue, then drain to applied or stale-base, and a redelivery answers already-applied", async () => {
  const v = proposer();
  await v.tick();
  v.edge.reachable = false;
  v.write(STALKER, page("Stalker", "creator: Andrei Tarkovsky\nmy_score: 10\n"));
  await settle(v); // enqueued first, so drained first (oldest ULID)
  v.write(SOLARIS, page("Solaris", "year: 1972\nmy_score: 8\n"));
  const r0 = await settle(v);
  expect(r0.drain!.probe).toBe("unreachable");
  expect(records(v).map((r) => r.status)).toEqual(["pending", "pending"]);
  v.advance(DAY);
  v.edge.put(SOLARIS, page("Solaris", "year: 1972\nmy_score: 9\n")); // the bot, that day
  v.edge.reachable = true;
  v.edge.loseNextReply = true; // the first answer never reaches the proposer
  const r = await v.tick();
  expect(r.drain!.refused).toHaveLength(1);
  expect(r.drain!.retried).toHaveLength(1);
  v.advance(5 * S);
  const again = await v.tick();
  expect(again.drain!.applied).toHaveLength(1);
  const sends = v.edge.proposals().filter((c) => c.args.path === STALKER);
  expect(sends).toHaveLength(2);
  expect(sends[0]!.args.proposalId).toBe(sends[1]!.args.proposalId);
  expect(records(v).map((x) => [x.args.path, x.answer?.reason])).toEqual([[SOLARIS, "stale-base"]]);
});

test("R10: offline 8 days — proposals expire, the files stay, and resend sends under a new ULID with the same base", async () => {
  const v = proposer();
  await v.tick();
  v.edge.reachable = false;
  const edit = page("Stalker", "creator: Andrei Tarkovsky\nmy_score: 10\n");
  v.write(STALKER, edit);
  await settle(v);
  const first = records(v)[0]!;
  v.advance(8 * DAY);
  const r = await v.tick();
  expect(r.drain!.expired).toEqual([first.proposalId]);
  expect(v.notes).toEqual([`expired, held until resend or dismiss: ${first.proposalId}`]);
  v.advance(5 * S);
  await v.tick();
  expect(v.read(STALKER).toString()).toBe(edit); // the writer never saw it: left in place
  resend(v.outbox, first.proposalId);
  v.edge.reachable = true;
  v.advance(5 * S);
  const back = await v.tick();
  expect(back.drain!.applied).toHaveLength(1);
  const sent = v.edge.proposals()[0]!;
  expect(sent.args.proposalId).not.toBe(first.proposalId);
  expect(sent.args.base).toBe(first.args.base);
  expect(sent.args.content).toBe(edit);
});

test("R11: a revoked outbox token halts the endpoint with a 401, marks nothing refused, and posts exactly one notification", async () => {
  const v = proposer();
  await v.tick();
  v.edge.http = 401;
  v.write(STALKER, page("Stalker", "creator: Andrei Tarkovsky\nmy_score: 10\n"));
  const r = await settle(v);
  expect(r.drain!.probe).toBe("halted");
  for (let i = 0; i < 3; i++) { v.advance(5 * S); await v.tick(); }
  expect(records(v).map((x) => x.status)).toEqual(["pending"]);
  expect(v.notes).toEqual(["the writer refused the outbox token (HTTP 401) — the endpoint is halted, nothing marked refused"]);
  expect(listOutbox(v.outbox).halt?.status).toBe(401);
});

test("R13: while applyState is pending the pull skips; a mirror with an unpatched supersede predecessor is neither reconciled nor published", async () => {
  const v = proposer();
  v.edge.applyState = "pending";
  const r0 = await v.tick();
  expect(r0.skipped).toMatch(/applyState is pending/);
  expect([v.edge.lists, v.edge.gets.length]).toEqual([0, 0]);
  v.edge.applyState = "idle";
  await v.tick();
  const published = v.published.length;
  v.edge.put("items/note-a.md", "---\ntitle: A\ntype: note\n---\n\nA.\n");
  v.edge.put("items/note-b.md", "---\ntitle: B\ntype: note\nsupersedes: items/note-a\n---\n\nB.\n");
  v.advance(60 * S);
  const r = await v.tick();
  expect(r.skipped).toMatch(/items\/note-b\.md supersedes items\/note-a\.md, which lacks superseded_by/);
  expect(existsSync(join(v.taste, "items/note-b.md"))).toBe(false);
  expect(v.published.length).toBe(published);
  v.edge.put("items/note-a.md", "---\ntitle: A\ntype: note\nsuperseded_by: items/note-b\n---\n\nA.\n"); // the apply finishes
  v.advance(60 * S);
  const done = await v.tick();
  expect(done.skipped).toBeUndefined();
  expect(existsSync(join(v.taste, "items/note-b.md"))).toBe(true);
  expect(v.published.length).toBe(published + 1);
});

test("R14: a deleted replica.json is rebuilt from content — no GET, no proposal, no notification for unchanged files", async () => {
  const v = proposer();
  await v.tick();
  v.write(SOLARIS, page("Solaris", "year: 1972\nmy_score: 8\n")); // one file Vlad changed meanwhile
  rmSync(join(stateDirFor(v.taste), "replica.json"));
  const now = new Date(v.at() + 1000);
  for (const p of [STALKER, SOLARIS]) utimesSync(join(v.taste, p), now, now); // the lstat triple moved
  v.edge.gets = [];
  v.advance(60 * S);
  const r = await v.tick();
  expect(existsSync(join(stateDirFor(v.taste), "replica.json"))).toBe(true);
  expect(v.edge.gets).toEqual([]);
  expect(r.held).toEqual([{ path: SOLARIS, reason: "unknown-base" }]); // differs from canon: held, never proposed
  v.advance(60 * S);
  await v.tick();
  expect(v.edge.proposals()).toEqual([]);
  expect(v.notes).toEqual([]);
  expect(records(v).map((x) => [x.args.path, x.status, x.answer?.reason])).toEqual([[SOLARIS, "refused", "unknown-base"]]);
  expect(v.read(SOLARIS).toString()).toBe(v.edge.text(SOLARIS)); // canon restored; Vlad's bytes kept in the record
});

test("R15: funes replica refuses to start with AWS_SESSION_TOKEN or any S3_*/AWS_* variable set", async () => {
  expect(() => refuseS3Env({ AWS_SESSION_TOKEN: "x" })).toThrow(/AWS_SESSION_TOKEN set/);
  expect(() => refuseS3Env({ S3_ENDPOINT: "x", HOME: "/h" })).toThrow(/S3_ENDPOINT/);
  expect(() => refuseS3Env({ HOME: "/h" })).not.toThrow();
  const v = proposer();
  const env = { PATH: process.env.PATH ?? "", HOME: v.home, FUNES_HOME: process.env.FUNES_HOME!, AWS_SESSION_TOKEN: "x" };
  const proc = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), "replica", "--once", "--vault", v.taste], { env, stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  expect(code).toBe(2);
  expect(err).toContain("AWS_SESSION_TOKEN set");
  expect(err).not.toContain("=x");
  expect(v.edge.calls).toEqual([]);
});

test("R15: the client is built with explicit fields — under a clean environment presign carries no X-Amz-Security-Token", async () => {
  const src = `import { s3Bucket } from ${JSON.stringify(join(import.meta.dir, "replica.ts"))};
    const b = s3Bucket({ endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "taste", credentialsFile: "/c" }, { accessKeyId: "AKID", secretAccessKey: "SECRET" });
    console.log((b as unknown as { presign(k: string): string }).presign("items/x.md"));`;
  const proc = Bun.spawn(["bun", "-e", src], { env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
  const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  expect(code).toBe(0);
  expect(out).toContain("https://acct.r2.cloudflarestorage.com/taste/items/x.md");
  expect(out).not.toContain("X-Amz-Security-Token");
});

test("R16: a stray `.md` in the mirror, absent from the manifest, blocks publish — logged, never deleted", async () => {
  const v = proposer();
  await v.tick();
  expect(v.published).toHaveLength(1);
  const dir = join(v.mirror, "items", "movies");
  chmodSync(dir, 0o755);
  writeFileSync(join(dir, "stray.md"), page("Stray"));
  chmodSync(dir, 0o555);
  v.edge.put(SOLARIS, page("Solaris", "year: 1972\nmy_score: 9\n"));
  v.advance(60 * S);
  const r = await v.tick();
  expect(r.published).toBe("refused");
  expect(v.published).toHaveLength(1);
  expect(v.logs.some((l) => l.startsWith("publish REFUSED") && l.includes("items/movies/stray.md"))).toBe(true);
  expect(existsSync(join(dir, "stray.md"))).toBe(true);
});

test("R17: an endpoint whose health names another star or locus is refused, and nothing is sent", async () => {
  for (const wrong of [{ starId: "mcp://rainblow.ing/personal" }, { locus: "another-locus" }]) {
    const v = proposer();
    await v.tick();
    v.edge.healthOverride = { proposalProtocol: 1, starId: STAR, locus: "funes-taste", applyState: "idle", ...wrong };
    v.write(STALKER, page("Stalker", "creator: Andrei Tarkovsky\nmy_score: 10\n"));
    const r = await settle(v);
    expect(r.drain!.probe).toMatch(/^refused: /);
    expect(v.edge.proposals()).toEqual([]);
    expect(records(v).map((x) => x.status)).toEqual(["pending"]);
  }
});

test("a pulled star.yaml naming another star refuses (a mis-mapped bucket), and so does a replica under a versioned tree", async () => {
  const v = proposer();
  v.edge.put("star.yaml", STAR_YAML.replace("rainblow.ing/taste", "rainblow.ing/personal"));
  await expect(v.tick()).rejects.toThrow(/mis-mapped bucket/);
  const w = proposer();
  mkdirSync(join(w.taste, "..", ".git"));
  await expect(w.tick()).rejects.toThrow(/holds \.git/);
});

// The template is private (replica/launchd/ is projection NEVER), so the public tree skips this.
const REPLICA_PLIST = join(import.meta.dir, "launchd", "tech.funes.replica.plist");
test.skipIf(!existsSync(REPLICA_PLIST))("the LaunchAgent template is a valid plist whose environment holds no S3_*/AWS_* variable", () => {
  const plist = REPLICA_PLIST;
  const text = readFileSync(plist, "utf8");
  expect(text).toContain("<string>tech.funes.replica</string>");
  expect(text).not.toMatch(/<key>(S3|AWS)_/);
  // RAI-303: the replica left the funes CLI; the template runs this folder's own entry
  expect(text).toContain("<string>@CHECKOUT@/packages/funes-cf/replica/cli.ts</string>");
  expect(text).not.toContain("funes-engine/src/cli.ts");
  if (process.platform === "darwin") expect(Bun.spawnSync(["plutil", "-lint", plist]).exitCode).toBe(0);
});
