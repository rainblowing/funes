// The hub — one funes process answering READ ops over MANY stars (RAI-39, PLAN-0.2.1 Ticket A).
//
// What it is not, first, because that is what keeps it small:
//   • It is not a router with a policy of its own. The catalogue is the whole policy, twinkling
//     derives it (intent × membership), and funes NEVER reads a constellation manifest (PRD D4
//     layering). Everything this file refuses, it refuses because the catalogue said so.
//   • It is not a writer. The only ops it can dispatch are `HUB_READ_OPS`, and a mutating op is
//     not assignable to that list — see ops.ts. There is no write path to review.
//   • It does not serve a live index. Published generations only (step 11): a live index is a
//     writer's working file, and a reader that opens one has no generation to name in an answer.
//
// The shape: one `PublishedIndex` per star (the same consumer the read face uses, so swaps, drains
// and retirement are the proven code path), one shared embedder, and a fan-out that returns
// PER-STAR GROUPS rather than one merged list. Grouping is a decision, not an omission: scores are
// RRF-fused WITHIN a store and are not comparable across stores, so a merged ranking would invent
// a precision the numbers do not carry. It is also what makes the hub-parity assertion possible —
// one star's group through the hub must equal that star's direct top-m.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Embedder, FunesIndexStore } from "funes-core";
import { refKey } from "funes-core";
import { funesDbDir, makeStore } from "./factory.ts";
import { dispatchReadOp, type HubOpName, type ReadOperationContext } from "./ops.ts";
import { PublishedIndex, startPrincipalHeartbeat, writePrincipalStatus, type PrincipalHeartbeat } from "./publication.ts";
import { assertStampedStarIdentity, verifyPublishedStarIdentity } from "./star-identity.ts";

// ── the catalogue (step 13, as amended by PRD D4) ─────────────────────────────────────────────

/** Catalogue entry v3 — the shape `twinkling star catalogue --write` emits. `access` holds the
 *  locators the star declared; there is no `env` field, ever, and no secret in any of them. */
export interface CatalogueEntry {
  id: string;
  key: string | null;
  name: string;
  constellation: string;
  locus: "local" | "remote";
  path?: string;
  access?: Record<string, Record<string, unknown>>;
  serves?: string[];
  okf?: string | false;
  backend: string;
  notes?: string;
}

/** A structurally recognizable entry that is not servable, with a STABLE reason. Retained rather
 *  than dropped: an invalid entry the operator can see is a bug report; a silently skipped one is
 *  a star that "disappeared". */
export interface CatalogueDiagnostic {
  id: string | null;
  name: string | null;
  constellation: string | null;
  reason: string;
}

export interface Catalogue {
  path: string;
  entries: CatalogueEntry[];
  diagnostics: CatalogueDiagnostic[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Read and validate the catalogue. THE top-level shape must be a JSON array; anything else fails
 *  STARTUP (step 13). Never degrades to an empty catalogue: "no stars" and "the file is broken"
 *  must not look the same to an operator, and an empty hub answers every question with silence. */
export function readCatalogue(file: string): Catalogue {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`funes hub: cannot read the catalogue at ${file} (${(e as Error).message}) — generate it with \`twinkling star catalogue --hub <star> --write\``);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`funes hub: the catalogue at ${file} is not JSON (${(e as Error).message})`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`funes hub: the catalogue at ${file} must be a JSON ARRAY (got ${parsed === null ? "null" : typeof parsed}) — refusing to serve a catalogue whose shape it does not understand`);
  }

  const entries: CatalogueEntry[] = [];
  const diagnostics: CatalogueDiagnostic[] = [];
  const seenKey = new Set<string>();
  const seenPath = new Set<string>();

  for (const row of parsed) {
    const o = (typeof row === "object" && row !== null ? row : {}) as Record<string, unknown>;
    const id = str(o.id);
    const name = str(o.name);
    const constellation = str(o.constellation);
    const reject = (reason: string) => diagnostics.push({ id, name, constellation, reason });
    if (!id) { reject("no id"); continue; }
    if (!name) { reject("no name"); continue; }
    if (!constellation) { reject("no constellation"); continue; }
    if ("env" in o) { reject("carries an `env` field — a catalogue never transports environment"); continue; }
    if (o.backend !== "libsql") { reject(`non-libsql backend (${String(o.backend)}) — the hub opens libsql generations only`); continue; }

    const key = refKey(id) ?? id;
    if (seenKey.has(key)) { reject(`duplicate id ${key}`); continue; }

    const path = str(o.path);
    if (!path) { reject("no path — remote reads arrive with Ticket C"); continue; }
    if (!isAbsolute(path)) { reject(`path is not absolute: ${path}`); continue; }
    let real: string;
    try {
      real = realpathSync(path);
      if (!statSync(real).isDirectory()) { reject(`path is not a directory: ${path}`); continue; }
    } catch {
      reject(`path does not resolve: ${path}`); continue;
    }
    if (!existsSync(join(real, "star.yaml"))) { reject(`no star.yaml at ${path}`); continue; }
    if (seenPath.has(real)) { reject(`duplicate path ${real}`); continue; }

    seenKey.add(key);
    seenPath.add(real);
    entries.push({
      ...(o as unknown as CatalogueEntry),
      id, key, name, constellation, path: real, backend: "libsql",
      locus: o.locus === "remote" ? "remote" : "local",
    });
  }
  return { path: file, entries, diagnostics };
}

// ── the hub ───────────────────────────────────────────────────────────────────────────────────

export interface StarDto {
  id: string;
  key: string | null;
  name: string;
  constellation: string;
  notes?: string;
  allowlisted: boolean;
}

export interface HubStarError { star: string; code: HubFailureCode; message: string }
export type HubFailureCode = "open-failed" | "identity-mismatch" | "timeout" | "busy" | "op-failed";

export interface HubRecallGroup {
  star: string;
  key: string | null;
  generation: string | null;
  hits: Array<Record<string, unknown>>;
  /** Set when the total output bound cut this group short — never silent. */
  truncated?: number;
}

export interface HubRecallResult {
  groups: HubRecallGroup[];
  errors: HubStarError[];
}

export interface HubOpts {
  /** The allowlist — catalogue ids or canonical keys. Absent = every catalogued star, which is
   *  only permitted while the catalogue holds ONE constellation (step 18). */
  stars?: string[];
  /** Shared across every star. Left unset in production: the E5 embedder is constructed once, on
   *  first use, and seven stars then cost one model, not seven. */
  embedder?: Embedder;
  /** Structured telemetry sink (default: stderr). Never receives query text. */
  log?: (line: string) => void;
  /** Bounds the ASYNC (embedding) portion of a per-star op — and nothing else. `LibsqlStore` is
   *  synchronous, so a slow SQL scan blocks the event loop and NO timeout can fire during it.
   *  Stated rather than implied, because "other stars keep answering" is only true of the async
   *  portion (r5). The bulkhead below is what holds when this bound is useless. */
  softTimeoutMs?: number;
  /** How many stars may be in flight at once. */
  concurrency?: number;
  /** Test seam: where a star's index home lives (default: the funes libsql home for its vault). */
  homeOf?: (entry: CatalogueEntry) => string;
  /** Test seam: how a generation db is opened (default: a read-only libsql store). */
  open?: (dbPath: string, embedder: Embedder) => Promise<FunesIndexStore>;
}

/** The principal name a hub writes into every home it serves. One name per PROCESS ROLE, matching
 *  the face's `broker`/`read` convention — a home's `.status/` is keyed by role, and a hub is one
 *  role however many stars it multiplexes. */
export const HUB_PRINCIPAL = "hub";

interface StarSlot {
  entry: CatalogueEntry;
  home: string;
  published: PublishedIndex;
  /** RAI-144: the hub is a PRINCIPAL of this home, and until now it only LOGGED its swaps — so a
   *  hub-multiplexed star's home had no acking principal at all, and the publisher's GC was free to
   *  retire an artefact the hub was still holding open the moment the grace floor passed. */
  heartbeat: PrincipalHeartbeat;
  /** The bulkhead (r6): at most ONE unresolved timed-out op per star. A soft timeout stops WAITING
   *  without cancelling the work, so without this a stalled star accumulates calls without bound. */
  busy: boolean;
}

const DEFAULTS = { softTimeoutMs: 5_000, concurrency: 4, k: 5, perStar: 5, total: 25 };

export class Hub {
  private readonly catalogue: Catalogue;
  private readonly opts: HubOpts;
  private readonly allow: Set<string> | null;
  private readonly slots = new Map<string, StarSlot>();
  private readonly log: (line: string) => void;
  private embedder: Embedder | null = null;
  private embedderInit: Promise<Embedder> | null = null;

  private constructor(catalogue: Catalogue, opts: HubOpts, allow: Set<string> | null) {
    this.catalogue = catalogue;
    this.opts = opts;
    this.allow = allow;
    this.log = opts.log ?? ((line) => process.stderr.write(line + "\n"));
  }

  static async open(catalogueFile: string, opts: HubOpts = {}): Promise<Hub> {
    const catalogue = readCatalogue(catalogueFile);
    const allow = opts.stars?.length ? new Set(opts.stars.map((s) => refKey(s) ?? s)) : null;

    // Step 18 — client isolation. A catalogue that spans constellations is the shape a client cell
    // would arrive in, so the hub refuses to serve it WHOLESALE. Naming ids is still allowed: an
    // operator who says which stars is not guessing, and that is the difference that matters.
    const constellations = new Set(catalogue.entries.map((e) => e.constellation));
    if (allow === null && constellations.size > 1) {
      throw new Error(
        `funes hub: the catalogue at ${catalogueFile} spans ${constellations.size} constellations ` +
        `(${[...constellations].sort().join(", ")}) — name the stars explicitly with --stars, or serve one constellation`,
      );
    }
    const hub = new Hub(catalogue, opts, allow);
    hub.log(JSON.stringify({
      hub: "start", catalogue: catalogueFile, entries: catalogue.entries.length,
      diagnostics: catalogue.diagnostics.length, allowlist: allow ? [...allow].sort() : "all",
      constellations: [...constellations].sort(),
    }));
    for (const d of catalogue.diagnostics) {
      // Operator stderr ALWAYS (step 16): a broken entry is the operator's problem whether or not
      // any caller is allowed to know that star exists.
      hub.log(JSON.stringify({ hub: "diagnostic", star: d.name, constellation: d.constellation, reason: d.reason }));
    }
    return hub;
  }

  /** Catalogue-only, ZERO store opens (step 16). Listing stars must never be the thing that opens
   *  seven databases. Diagnostics come back only for ids this caller may already name. */
  stars(args: { ids?: string[] } = {}): { stars: StarDto[]; diagnostics: CatalogueDiagnostic[] } {
    const asked = args.ids?.length ? new Set(args.ids.map((s) => refKey(s) ?? s)) : null;
    const visible = this.catalogue.entries.filter((e) => this.allowed(e) && (asked === null || asked.has(e.key ?? e.id)));
    const stars = visible.map((e) => ({
      id: e.id, key: e.key ?? null, name: e.name, constellation: e.constellation,
      ...(e.notes ? { notes: e.notes } : {}),
      allowlisted: this.allowed(e),
    }));
    // A diagnostic names a star. Return only those the caller's allowlist covers or explicitly
    // asked for — an invalid entry must not enumerate a star the caller may not see.
    const diagnostics = this.catalogue.diagnostics.filter((d) => {
      const key = d.id ? refKey(d.id) ?? d.id : null;
      if (!key) return false;
      if (asked?.has(key)) return true;
      return this.allow === null ? false : this.allow.has(key);
    });
    return { stars, diagnostics };
  }

  /** Fan out one recall across the allowed stars, bounded and grouped. */
  async recall(args: { query: string; k?: number; perStar?: number; total?: number; stars?: string[] }): Promise<HubRecallResult> {
    const perStar = clamp(args.perStar ?? args.k ?? DEFAULTS.perStar, 1, 50);
    const total = clamp(args.total ?? DEFAULTS.total, 1, 200);
    const targets = this.targets(args.stars);
    const errors: HubStarError[] = [];
    const groups: HubRecallGroup[] = [];

    const results = await this.fanOut(targets, async (slot) => {
      const started = Date.now();
      const out = await this.withStar(slot, "guarded_recall", { query: args.query, k: perStar });
      this.log(JSON.stringify({ hub: "op", op: "recall", star: slot.entry.name, ms: Date.now() - started, hits: (out.value as unknown[])?.length ?? 0 }));
      return out;
    });

    // Deterministic assembly: stars in CANONICAL KEY order, never completion order, so the same
    // catalogue and the same query produce byte-identical output whatever the disk did today.
    //
    // The total budget is spent ROUND-ROBIN, one rank at a time across stars — not star by star.
    // Spending it in key order starves whoever sorts last: with total=6 over five stars, the first
    // three took two hits each and `memegen` and `2cd.ai` answered with nothing, which reads as
    // "that star had no answer" when it had two. Every star gets its best hit before any star gets
    // its second, and the order within a group is untouched.
    // `slot !== null` is not redundant beside `!error`: a slot that failed to CONSTRUCT has both,
    // and the narrowing is what lets the assembly below read `slot.published` without a cast.
    const answered = results.filter((r): r is { slot: StarSlot; outcome: { value?: unknown } } => !r.outcome.error && r.slot !== null);
    for (const { outcome } of results) if (outcome.error) errors.push(outcome.error);
    const hitsOf = answered.map(({ outcome }) => (outcome.value as Array<Record<string, unknown>>) ?? []);
    const keep = hitsOf.map(() => 0);
    let budget = total;
    for (let rank = 0; budget > 0 && rank < Math.max(0, ...hitsOf.map((h) => h.length)); rank++) {
      for (let i = 0; i < hitsOf.length && budget > 0; i++) {
        if (hitsOf[i]!.length > rank) { keep[i]!++; budget--; }
      }
    }
    answered.forEach(({ slot }, i) => {
      const hits = hitsOf[i]!.slice(0, keep[i]!);
      groups.push({
        star: slot.entry.name,
        key: slot.entry.key ?? null,
        generation: slot.published.generation,
        hits,
        ...(hits.length < hitsOf[i]!.length ? { truncated: hitsOf[i]!.length - hits.length } : {}),
      });
    });
    return { groups, errors };
  }

  /** One page from ONE star — no fan-out: a page read names its star. */
  async indexedPage(args: { star: string; id?: string; path?: string }): Promise<unknown> {
    const slot = this.slotFor(args.star);
    const out = await this.withStar(slot, "guarded_indexed_page", { id: args.id, path: args.path });
    if (out.error) throw new Error(`${out.error.star}: ${out.error.message}`);
    return out.value;
  }

  /** Per-star index health, fanned out like recall (the absolute vault path is projected out by
   *  the op itself, not here — see `guarded_health`). */
  async health(args: { stars?: string[] } = {}): Promise<{ stars: Array<{ star: string; key: string | null; generation: string | null; health: unknown }>; errors: HubStarError[] }> {
    const errors: HubStarError[] = [];
    const out: Array<{ star: string; key: string | null; generation: string | null; health: unknown }> = [];
    const results = await this.fanOut(this.targets(args.stars), (slot) => this.withStar(slot, "guarded_health", {}));
    for (const { slot, outcome } of results) {
      if (outcome.error || !slot) { if (outcome.error) errors.push(outcome.error); continue; }
      out.push({ star: slot.entry.name, key: slot.entry.key ?? null, generation: slot.published.generation, health: outcome.value });
    }
    return { stars: out, errors };
  }

  async close(): Promise<void> {
    // Stop the heartbeats BEFORE closing the handles: a beat that fired mid-close would re-open a
    // store through `published.with()` on its way out.
    for (const slot of this.slots.values()) slot.heartbeat.stop();
    for (const slot of this.slots.values()) await slot.published.close().catch(() => {});
    this.slots.clear();
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────────

  private allowed(e: CatalogueEntry): boolean {
    return this.allow === null || this.allow.has(e.key ?? e.id);
  }

  private targets(named?: string[]): CatalogueEntry[] {
    const asked = named?.length ? new Set(named.map((s) => refKey(s) ?? s)) : null;
    return this.catalogue.entries
      .filter((e) => this.allowed(e) && (asked === null || asked.has(e.key ?? e.id)))
      .sort((a, b) => (a.key ?? a.id).localeCompare(b.key ?? b.id));
  }

  private slotFor(ref: string): StarSlot {
    const key = refKey(ref) ?? ref;
    const entry = this.catalogue.entries.find((e) => (e.key ?? e.id) === key || e.id === ref || e.name === ref);
    if (!entry || !this.allowed(entry)) throw new Error(`funes hub: no star "${ref}" in the served catalogue`);
    return this.slot(entry);
  }

  private slot(entry: CatalogueEntry): StarSlot {
    const key = entry.key ?? entry.id;
    const existing = this.slots.get(key);
    if (existing) return existing;
    const home = this.opts.homeOf?.(entry) ?? dirname(funesDbDir(entry.path!, "libsql"));

    // Identity layers 1-3 at slot construction (star-identity.ts, shared with `funes doctor`): the
    // catalogue against the star's OWN star.yaml, and the catalogue against the published manifest.
    // The remaining layer — the id inside the database bytes — is checked in the OPEN below,
    // because that is the only place it is re-checked on every generation swap.
    verifyPublishedStarIdentity({
      path: entry.path!, id: entry.id, name: entry.name, home,
      who: "funes hub",
      staleHint: "Regenerate the catalogue.",
      noPublicationHint: "(the hub serves published generations only)",
    });

    const open = async (dbPath: string): Promise<FunesIndexStore> => {
      const embedder = await this.sharedEmbedder();
      const store = this.opts.open
        ? await this.opts.open(dbPath, embedder)
        : await makeStore({ dbDir: dbPath, backend: "libsql", readonly: true, embedder });
      await assertStampedStarIdentity(store, { expectedId: entry.id, dbPath, who: "funes hub" });
      this.log(JSON.stringify({ hub: "open", star: entry.name, db: dbPath }));
      return store;
    };

    const published = new PublishedIndex(home, open, {
      // No fallbackDbPath: published generations ONLY (step 11). A star with nothing published
      // is an error the operator must see, not a live index quietly served instead.
      //
      // RAI-144: this used to ONLY log. A log line is not an ack — the publisher's retain-until-ack
      // GC reads `<home>/.status/`, so a hub-served home looked to it like a home with no consumers,
      // which is the case where it unlinks the prior artefact immediately. The hub now writes the
      // same status file the faces do, on the swap AND on a heartbeat.
      onServe: (publicationId, generation) => {
        this.log(JSON.stringify({ hub: "serve", star: entry.name, publicationId, generation }));
        writePrincipalStatus(home, HUB_PRINCIPAL, publicationId, generation);
      },
    });
    const slot: StarSlot = {
      entry, home, busy: false, published,
      // Live sample, not a snapshot: a broker writing into this same home invalidates the content
      // generation in the database the hub is serving, and the diagnostic half must follow it. One
      // lease for both halves (`sampleIdentity`) — pairing the id getter with an awaited read is a
      // race, and the beat that discovers a swap is the one it corrupts. See its docblock.
      heartbeat: startPrincipalHeartbeat(home, HUB_PRINCIPAL, () => published.sampleIdentity()),
    };
    this.slots.set(key, slot);
    return slot;
  }

  private async sharedEmbedder(): Promise<Embedder> {
    if (this.embedder) return this.embedder;
    if (this.opts.embedder) return (this.embedder = this.opts.embedder);
    // Single-flight: seven stars opening at once must construct ONE model, not seven.
    this.embedderInit ??= (async () => {
      const started = Date.now();
      const { E5Embedder } = await import("./embedder.ts");
      const e = new E5Embedder();
      this.log(JSON.stringify({ hub: "embedder", ms: Date.now() - started, dim: e.dim }));
      return e;
    })();
    return (this.embedder = await this.embedderInit);
  }

  /** One op against one star: bulkhead, soft timeout, and every failure turned into a CODE rather
   *  than a thrown error, so one bad star never ends the fan-out. */
  private async withStar(slot: StarSlot, op: HubOpName, args: Record<string, unknown>): Promise<{ value?: unknown; error?: HubStarError }> {
    const star = slot.entry.name;
    if (slot.busy) {
      return { error: { star, code: "busy", message: "a previous call to this star has not returned — skipped rather than queued behind it" } };
    }
    const call = (async () => {
      return slot.published.with(async (store) => {
        const ctx: ReadOperationContext = { remote: true, trust: "untrusted", vault: slot.entry.path!, store };
        return dispatchReadOp(op, args, ctx);
      });
    })();

    const timeoutMs = this.opts.softTimeoutMs ?? DEFAULTS.softTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
    try {
      const raced = await Promise.race([call.then((v) => ({ v }), (e) => ({ e })), timeout]);
      if (raced === "timeout") {
        // The work is NOT cancelled — nothing here can cancel a synchronous SQL scan. We stop
        // waiting, mark the star busy, and clear the mark when the abandoned call finally settles.
        slot.busy = true;
        void call.then(() => { slot.busy = false; }, () => { slot.busy = false; });
        this.log(JSON.stringify({ hub: "timeout", star, op, ms: timeoutMs }));
        return { error: { star, code: "timeout", message: `no answer within ${timeoutMs}ms — the star is marked busy until its call returns` } };
      }
      if ("e" in raced) {
        const message = (raced.e as Error)?.message ?? String(raced.e);
        const code: HubFailureCode = /identity mismatch|another star's name/.test(message) ? "identity-mismatch"
          : /no published generation|cannot open|ENOENT/.test(message) ? "open-failed"
          : "op-failed";
        this.log(JSON.stringify({ hub: "error", star, op, code }));
        return { error: { star, code, message } };
      }
      return { value: raced.v };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Bounded-concurrency fan-out. `allSettled` semantics by construction: `withStar` never throws,
   *  and a slot that cannot even be CONSTRUCTED (identity, no publication) becomes an error entry
   *  rather than an exception that ends everyone else's answer.
   *
   *  A failed construction yields `slot: null` — not a stand-in slot with an unusable handle. The
   *  stand-in compiled and worked, because every caller checks `outcome.error` first; it would stop
   *  working the day one of them reads `slot.published` before that check, and the failure would be
   *  a null dereference in a fan-out, at whatever hour the star happened to break. */
  private async fanOut(
    entries: CatalogueEntry[],
    fn: (slot: StarSlot) => Promise<{ value?: unknown; error?: HubStarError }>,
  ): Promise<Array<{ slot: StarSlot | null; outcome: { value?: unknown; error?: HubStarError } }>> {
    const limit = Math.max(1, this.opts.concurrency ?? DEFAULTS.concurrency);
    type Row = { slot: StarSlot | null; outcome: { value?: unknown; error?: HubStarError } };
    const out: Array<Row | null> = new Array(entries.length).fill(null);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= entries.length) return;
        const entry = entries[i]!;
        let slot: StarSlot;
        try {
          slot = this.slot(entry);
        } catch (e) {
          const message = (e as Error).message;
          const code: HubFailureCode = /identity mismatch|another star's name/.test(message) ? "identity-mismatch" : "open-failed";
          this.log(JSON.stringify({ hub: "error", star: entry.name, code }));
          out[i] = { slot: null, outcome: { error: { star: entry.name, code, message } } };
          continue;
        }
        out[i] = { slot, outcome: await fn(slot) };
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, entries.length) }, worker));
    return out.filter((x): x is Row => x !== null);
  }
}

const clamp = (n: number, lo: number, hi: number): number => (Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), lo), hi) : lo);
