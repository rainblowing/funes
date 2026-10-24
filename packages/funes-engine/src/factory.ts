// The store factory: the ONE construction point of a star's index store. The backend is the star's
// own choice, `star.yaml memory.substrate: libsql|turso` (absent = libsql; ADR-0019); no variable
// chooses it (FUNES_BACKEND is retired, funes-home.ts). PGLite was removed 2026-07-20 and postgres in
// 0.6.0 (RAI-325). A Turso star has one owner, its `funes serve` (ADR-0021): `makeStore` refuses it,
// and only the builder (`reindex`) and `funes serve` open it, through `openStore`.
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Embedder } from "funes-core";
// manifest-v3 (PRD 2026-08-27): the identity grammar. funes-core owns it (D12).
import { canonicalKey } from "funes-core";
import { mayClaimIndex, ownerClaimRefused } from "funes-core/internal";
import { libsqlBase } from "./funes-home.ts";
import { withScopedWriteLock } from "./write-lock.ts";
import type { FunesIndexStore } from "funes-core";
import { noIdentity, starIdentityFromText, UNPARSED, type StarIdentity } from "funes-core/internal";
import { E5Embedder } from "./embedder.ts";
import { assertIndexNotInSyncRoot } from "./sync-root.ts";

/** On-disk index location for a vault: a libsql or a Turso FILE (the star's substrate decides the
 *  engine, not the path; the star's write lock keys on this path either way, RAI-309). It belongs on
 *  a TRUE-local FS — SQLite WAL's -shm shared memory + file locking are unreliable on the CloudStorage FileProvider. It is
 *  `<funes home>/libsql/<vault-name>/index.db` (ADR-0016; FUNES_HOME relocates the funes home).
 *  Stack-review fix 2026-07-02: the old fallback was `vault/.funes/index.db`, which meant an unset env
 *  var silently FORKED a second empty index onto Dropbox. */
export function funesDbDir(vault: string): string {
  return join(libsqlBase(), basename(vault), "index.db");
}

export function readStarIdentity(vault: string): StarIdentity {
  const p = join(vault, "star.yaml");
  if (!existsSync(p)) return noIdentity();
  try {
    return starIdentityFromText(readFileSync(p, "utf8"));
  } catch {
    return { ...noIdentity(), writeLocus: UNPARSED, tier: UNPARSED, substrate: UNPARSED }; // unreadable (a TCC denial): as one that does not parse
  }
}

/** A star's tier and substrate (ADR-0019): `memory.tier` absent is home, `memory.substrate` absent
 *  is libsql. An org star needs Turso. Anything else refuses, naming the key. */
export interface StarMemory { tier: "home" | "org"; substrate: "libsql" | "turso" }
export function starMemory(identity: StarIdentity, source: string): StarMemory {
  if (identity.tier === UNPARSED) throw new Error(`${source}: star.yaml does not parse — its tier and substrate are unknowable; fix it (fail-closed)`);
  const tier = identity.tier ?? "home";
  const substrate = identity.substrate ?? "libsql";
  if (substrate === "postgres") throw new Error(`${source} memory.substrate: postgres — the postgres backend was removed in funes 0.6.0`);
  if (substrate !== "libsql" && substrate !== "turso") throw new Error(`${source}: memory.substrate must be "libsql" or "turso" (got ${JSON.stringify(substrate)})`);
  if (tier !== "home" && tier !== "org") throw new Error(`${source}: memory.tier must be "home" or "org" (got ${JSON.stringify(tier)})`);
  if (tier === "org" && substrate !== "turso") throw new Error(`${source}: memory.tier: org requires memory.substrate: turso`);
  return { tier, substrate };
}

/** The port `funes serve` listens on when no `--port` is given (the broker face's default). */
export const DEFAULT_SERVE_PORT = 8787;

/** ADR-0021: a Turso star has one owner, its `funes serve`, so every other local open (`makeStore`,
 *  stdio `funes mcp`, the CLI op verbs) refuses and names that server's URL: the write locus (the one
 *  serve owner), else this machine. A star.yaml that does not validate refuses here. */
export function assertLocalOpen(vault: string): void {
  const identity = readStarIdentity(vault);
  const source = join(vault, "star.yaml");
  if (starMemory(identity, source).substrate !== "turso") return;
  const host = typeof identity.writeLocus === "string" && identity.writeLocus.trim() ? identity.writeLocus.trim() : "127.0.0.1";
  throw new Error(
    `${source} declares memory.substrate: turso — a Turso star is reached only through its one \`funes serve\`, never a local open. ` +
    `Connect over HTTP MCP (type: http) to http://${host}:${DEFAULT_SERVE_PORT}/mcp.`,
  );
}

/** The persisted owner marker. `id` is the HARD identity (portable across machines/moves); `vault`
 *  is the local materialization (informational). Legacy markers hold a bare path -> {id:null}. */
interface OwnerMarker { id: string | null; vault: string; star?: string | null; constellation?: string | null; }
function readMarker(markerPath: string): OwnerMarker | null {
  if (!existsSync(markerPath)) return null;
  const raw = readFileSync(markerPath, "utf8").trim();
  if (raw.startsWith("{")) { try { return JSON.parse(raw) as OwnerMarker; } catch { /* fall through */ } }
  return { id: null, vault: raw }; // legacy bare-path marker (pre-identity)
}

/** Multi-star collision guard (2026-07-02; identity-keyed 2026-07-04): the libsql index home is
 *  keyed by the vault's folder BASENAME — two DIFFERENT stars that share a folder name would
 *  silently share (and clobber) one index. The `owner-vault` marker records the owning star's
 *  IDENTITY (star.yaml meta.id) as the hard key, with the local path as fallback. A star that
 *  MOVES on disk keeps its id, so it no longer trips a false collision; two different stars still
 *  hard-stop. Grandfathered: a legacy path-only marker upgrades in place on the next matching open. */
export function assertIndexOwner(indexDir: string, vault: string): void {
  const markerPath = join(indexDir, "owner-vault");
  const me = resolve(vault);
  const mine = readStarIdentity(vault);
  const current = readMarker(markerPath);
  const payload = JSON.stringify({ id: mine.id, vault: me, star: mine.name, constellation: mine.constellation }) + "\n";
  const writeMine = () => {
    mkdirSync(indexDir, { recursive: true });
    writeFileSync(markerPath, payload);
  };
  if (!current) {
    // P3.15: the FIRST write must be atomic-or-lose. Read-then-write let two different stars that
    // share a folder basename both see no marker and both claim the index — the collision guard
    // defeated precisely at the moment it exists to fire. link(2) fails with EEXIST if the name is
    // taken, and the temp is fully written first, so a racing reader never sees a half marker.
    mkdirSync(indexDir, { recursive: true });
    const tmp = `${markerPath}.${process.pid}.tmp`;
    writeFileSync(tmp, payload);
    try {
      linkSync(tmp, markerPath);
      return; // we created it — this index is ours
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    } finally {
      try { unlinkSync(tmp); } catch { /* already gone */ }
    }
    // Someone won the race: re-read THEIR marker and validate against it like any other open.
    const theirs = readMarker(markerPath);
    if (theirs) return assertOwnerAgainst(indexDir, vault, me, mine, theirs, writeMine);
    return; // marker vanished again (concurrent teardown) — nothing to validate against
  }
  return assertOwnerAgainst(indexDir, vault, me, mine, current, writeMine);
}

/** The validation half of assertIndexOwner, shared by the first-open loser path and every
 *  subsequent open. */
function assertOwnerAgainst(
  indexDir: string,
  vault: string,
  me: string,
  mine: StarIdentity,
  current: OwnerMarker,
  writeMine: () => void,
): void {

  // Both sides have a star identity -> ids are authoritative (path may legitimately differ).
  if (current.id && mine.id) {
    // manifest-v3 (PRD 2026-08-27 D1): compare CANONICAL KEYS when both sides have one, so a star
    // that changed transport — one access scheme re-declared as another — keeps its index
    // instead of reading as a different star. Falls back to string equality when either side
    // predates the grammar, which is every star until the renumber runs, so today's behaviour is
    // bit-for-bit unchanged. This is a WIDENING of what counts as the same star, never a
    // narrowing: nothing that used to match stops matching.
    // RAI-311: the star's declared previous id (`meta.id_was`, written by `twinkling star reid`) also
    // matches, and the marker upgrades in place below — as the owner stamp's compare-and-set does.
    const same = (a: string, b: string | null) => !!b && (a === b || (canonicalKey(a) !== null && canonicalKey(a) === canonicalKey(b)));
    if (!same(current.id, mine.id) && !same(current.id, mine.idWas)) {
      throw new Error(
        `funes: index collision — ${indexDir} belongs to star "${current.id}"${current.star ? ` (${current.star})` : ""}, ` +
        `but "${vault}" is star "${mine.id}" (same folder basename). Rename one star's folder.`,
      );
    }
    if (current.vault !== me || current.id !== mine.id) writeMine(); // moved on disk, or re-rendered under a new access method
    return;
  }
  // Fallback (one/both sides lack an id): compare the materialization path, as before.
  if (current.vault !== me) {
    throw new Error(
      `funes: index collision — ${indexDir} belongs to vault "${current.vault}", but "${me}" maps to the same index dir ` +
      `(same folder basename). Rename one star's folder; if "${current.vault}" no longer exists, remove ${indexDir} and reindex.`,
    );
  }
  if (!current.id && mine.id) writeMine(); // legacy path-only marker, this star now has an id -> upgrade
}

/** `reindex --fresh` (RAI-307 Q4, RAI-309 Q2): rebuild the star's live index IN PLACE, in the same
 *  file, and run `build` (the caller's full walk, which finalizes) on it. The star's write lock is
 *  held from before the first guard until `build` returns, so every writer waits, then refuses after
 *  10 s. In order: the owner marker and sync-root guards; a raw read of `meta`; the owner claim
 *  (RAI-157: before the destructive step); then dirty + DROP/CREATE + restamp in ONE immediate
 *  transaction (`resetIndexInPlace`); then the builder's own open. Nothing deletes an index file: one
 *  this cannot read as a funes index is refused, never wiped.
 *
 *  The raw handle opens READ-WRITE although it only SELECTs: a WAL database whose -shm is gone — what
 *  a clean close by the previous writer leaves — cannot be opened read-only by this SQLite build
 *  (found on the first real repair, 2026-09-08). The write lock admits no other funes writer.
 *
 *  `onStep` is a test seam: `inspected` after the owner claim, `reset` after the transaction. */
export async function rebuildFresh<T>(
  opts: { vault: string; embedder: Embedder; onStep?: (step: "inspected" | "reset") => void | Promise<void> },
  build: (store: FunesIndexStore) => Promise<T>,
): Promise<T> {
  const dbPath = funesDbDir(opts.vault);
  return withScopedWriteLock(dbPath, async () => {
    assertIndexOwner(dirname(dbPath), opts.vault);
    assertIndexNotInSyncRoot(dbPath);
    const { openRawIndex, resetIndexInPlace } = await import("./libsql/store.ts");
    const engine = substrateOf(opts.vault);
    if (existsSync(dbPath)) {
      let meta: Record<string, string>;
      try {
        const db = openRawIndex(dbPath, false, engine);
        try {
          meta = Object.fromEntries((db.prepare("select key, value from meta").all() as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]));
        } finally {
          db.close();
        }
      } catch (e) {
        throw new Error(`funes: reindex --fresh cannot inspect the index at ${dbPath} (${(e as Error).message}) — not rebuilding it; move it aside by hand if it is not a funes index.`);
      }
      assertOwnerClaim(meta.owner_star_id ?? null, opts.vault, dbPath);
      await opts.onStep?.("inspected");
      resetIndexInPlace(dbPath, opts.embedder, { embeddingSignature: meta.embedding_signature ?? null, schemaVersion: meta.schema_version ?? null }, engine);
      await opts.onStep?.("reset");
    }
    const store = await openStore({ vault: opts.vault, allowDirty: true, embedder: opts.embedder });
    try {
      return await build(store);
    } finally {
      await store.close();
    }
  });
}

export interface MakeStoreOpts {
  /** Resolve dbDir from the vault (via funesDbDir) when `dbDir` is omitted. */
  vault?: string;
  /** Explicit index path. With a vault, a read-write path must be `funesDbDir(vault)`; without one,
   *  a private store (no star, no owner check). */
  dbDir?: string;
  /** Embedder override; defaults to a fresh E5Embedder. */
  embedder?: Embedder;
  /** Open the index READ-ONLY (SQLite mode=ro): no WAL flip, no DDL, no meta writes, telemetry
   *  forced off. `folderContext` over such a store serves only the read ops (RAI-315 Q9). */
  readonly?: boolean;
  /** R8 recall telemetry (the unified surface). */
  trackRecalls?: boolean;
  /** Provenance-v1 STAMPED write actor — the authenticated principal the serving context sets on
   *  every write it performs. NEVER sourced from item frontmatter/op args. Omitted → "unknown". */
  writeActor?: string;
}

/** The stores `makeStore` opened read-only: `folderContext` narrows them to the read ops. */
const READ_ONLY = new WeakSet<FunesIndexStore>();
export const isReadOnlyStore = (store: FunesIndexStore): boolean => READ_ONLY.has(store);

/** The ONE place a funes index store is constructed for a caller (RAI-315: `allowDirty` is not in
 *  the contract — only the builder, inside `reindex`, opens a dirty index). A Turso star refuses
 *  (ADR-0021, C17): its one owner is its `funes serve`. */
export async function makeStore(opts: MakeStoreOpts = {}): Promise<FunesIndexStore> {
  if (opts.vault != null) assertLocalOpen(opts.vault);
  return openStore(opts);
}

/** A star's backend: its `memory.substrate` (absent = libsql). A star.yaml that does not validate
 *  refuses, and so does an org star: its database holds canonical rows in two slots, and only its
 *  `funes serve` opens and builds it (ADR-0019; `openOrgStar`). */
function substrateOf(vault: string): StarMemory["substrate"] {
  const source = join(vault, "star.yaml");
  const m = starMemory(readStarIdentity(vault), source);
  if (m.tier === "org") throw new Error(`${source} declares memory.tier: org — its database is opened and built only by its one \`funes serve\`, never by a local open or \`funes reindex\``);
  return m.substrate;
}

/** makeStore for the Turso star's two owners — the builder (`reindex`, with `allowDirty`: RAI-307,
 *  the repair path for a dirty index) and `funes serve` — on the star's substrate. Turso keeps one
 *  process on its file (a second open fails on the engine's file lock), and it is never opened
 *  read-only here: nothing publishes a Turso index. */
export async function openStore(opts: MakeStoreOpts & { allowDirty?: boolean } = {}): Promise<FunesIndexStore> {
  const engine = opts.vault != null ? substrateOf(opts.vault) : "libsql";
  const dbDir = opts.dbDir ?? (opts.vault != null ? funesDbDir(opts.vault) : undefined);
  // RAI-309 Q2: a star's live read-write index is `funesDbDir(vault)`, and its write lock keys on that
  // path. Another read-write path for the vault would take another lock; a read-only open keeps any.
  if (opts.vault != null && dbDir != null && !opts.readonly && resolve(dbDir) !== resolve(funesDbDir(opts.vault))) {
    throw new Error(`funes: refusing a read-write open of ${dbDir} for ${opts.vault} — the star's live index is ${funesDbDir(opts.vault)}, and its write lock keys on that path. Open another index read-only.`);
  }
  // basename-collision + identity guard: run whenever we know the owning vault, even if the caller
  // passed an explicit dbDir. A bare explicit dbDir with NO vault skips: the caller owns that mapping
  // and there's no star to check. A READ-ONLY open also skips: the guard WRITES the owner marker,
  // and the index home may be an RO mount (the writer side stamped it).
  if (opts.vault != null && dbDir != null && !opts.readonly) assertIndexOwner(dirname(dbDir), opts.vault);
  // 0.3.0 item 23: the index may not live inside a sync provider's root. Checked at the ONE
  // construction point, on read-only opens too — a torn database serves torn answers whoever opened
  // it — and against the INDEX path only: a vault under Syncthing/Dropbox is the estate's normal
  // shape and stays permitted.
  if (dbDir != null) assertIndexNotInSyncRoot(dbDir);
  const embedder = opts.embedder ?? new E5Embedder();
  // Lazy relative import so the native libsql lib loads only when actually used.
  const { LibsqlStore } = await import("./libsql/store.ts");
  const store = await LibsqlStore.create(embedder, dbDir, { engine, allowDirty: opts.allowDirty, trackRecalls: opts.trackRecalls, readonly: opts.readonly, writeActor: opts.writeActor });
  if (opts.readonly) READ_ONLY.add(store);
  // RAI-157 (spike F5): every WRITER open with a known vault checks the owner stamp INSIDE the db —
  // the marker beside it authenticates the directory only, so another star's index.db under this
  // path passes assertIndexOwner. Here, before any caller (reindex, served or CLI mutators) can write
  // a row. Read-only opens skip it as they skip the marker: doctor and the publication readers check
  // the stamp (`readIndexOwner`) themselves.
  if (opts.vault != null && !opts.readonly && dbDir != null) {
    try {
      assertOwnerClaim(await store.getOwnerStarId(), opts.vault, dbDir);
    } catch (e) {
      await store.close().catch(() => {});
      throw e;
    }
  }
  return store;
}

/** May this vault's star write an index whose stamp is `stamped`? The same star (one canonical key),
 *  or the id it declares it had before a re-identification (`meta.id_was`). A stamp with no id on
 *  this side refuses: absence never matches. An unstamped index is anyone's until
 *  a full run stamps it — acceptable only because the marker guard, one writer machine per star and
 *  the rejected shared primary leave no second claimant on it. */
export function assertOwnerClaim(stamped: string | null, vault: string, where: string): void {
  if (stamped === null) return;
  const me = readStarIdentity(vault);
  if (me.id === null) {
    throw new Error(
      `funes: the index at ${where} belongs to star "${stamped}", and ${join(vault, "star.yaml")} declares no star id — ` +
      "refusing to write it (fail-closed: absence never matches). Restore meta.id, or rename this vault's folder so it has its own index.",
    );
  }
  if (!mayClaimIndex(stamped, me.id, me.idWas)) throw ownerClaimRefused(stamped, me.id);
}
