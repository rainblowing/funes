// Backend factory — the FUNES_BACKEND seam (step 1 of the libSQL evaluation).
//
// ONE construction point + ONE env knob so the daemon, the surface (ctx.ts), both CLIs, mcp.ts and
// serve-local all open the SAME backend for a vault. Default "pglite" (the proven WASM-Postgres
// store): with FUNES_BACKEND unset, behaviour is byte-for-byte today's. "libsql" is reserved for the
// funes-libsql backend (step 2) — selecting it before that package exists throws a clear error
// rather than silently doing the wrong thing.
//
// Both backends implement the shared FunesIndexStore (step 2b), so makeStore returns it with no cast.
// Default stays "pglite" until the libSQL recall-parity decision; FUNES_BACKEND=libsql opts in.
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Embedder } from "funes-core";
// manifest-v3 (PRD 2026-08-27): the identity grammar. funes-core owns it (D12).
import { canonicalKey, embeddingSignature } from "funes-core";
import { INDEX_SCHEMA_VERSION } from "funes-shared";
import type { FunesIndexStore } from "./store.ts";
import { CHUNK_SIG, E5Embedder } from "./embedder.ts";
import { CrossEncoderReranker, type Reranker } from "./rerank.ts";
import { LIBSQL_ONLY } from "./artifact.ts";
import { assertIndexNotInSyncRoot } from "./sync-root.ts";

// libSQL is the default + only LOCAL backend (2026-07-20, PGLite removed). `postgres` is the deferred
// profile-B server tier (node-postgres via postgres-driver.ts + the shared Postgres-dialect store),
// selected by a connection string, not a local path.
export type FunesBackend = "libsql" | "postgres";

/** Selected backend: explicit arg > FUNES_BACKEND env > "libsql". */
export function funesBackend(explicit?: string): FunesBackend {
  const b = (explicit ?? process.env.FUNES_BACKEND ?? "libsql").trim().toLowerCase();
  if (b !== "libsql" && b !== "postgres") {
    throw new Error(`FUNES_BACKEND: unknown backend "${b}" — expected "libsql" or "postgres".`);
  }
  return b;
}

/** On-disk index location for a vault. libSQL -> a FILE; it belongs on a TRUE-local FS — SQLite WAL's
 *  -shm shared memory + file locking are unreliable on the CloudStorage FileProvider. FUNES_LIBSQL_DIR
 *  overrides the base; the DEFAULT is `~/.twinkling/libsql/<vault-name>/index.db` (the live layout).
 *  Stack-review fix 2026-07-02: the old fallback was `vault/.funes/index.db`, which meant an unset env
 *  var silently FORKED a second empty index onto Dropbox. (postgres is pgUrl-selected — it has no
 *  vault path, and makeStore never uses this for it.) */
export function funesDbDir(vault: string, backend: FunesBackend = funesBackend()): string {
  if (backend === "postgres") return join(vault, ".funes", "pgdata"); // unused (postgres uses pgUrl)
  const base = process.env.FUNES_LIBSQL_DIR ?? join(homedir(), ".twinkling", "libsql");
  return join(base, basename(vault), "index.db");
}

/** A star's self-declared identity (twinkling star.yaml meta block). funes reads it so an index
 *  knows WHICH STAR it belongs to — identity is the stable sync URI (ADR-0002), not the machine
 *  path. Absent star.yaml / meta.id -> null id (lone/grandfathered star; the guard falls back to
 *  the vault path, today's behaviour). */
export interface StarIdentity {
  id: string | null;
  name: string | null;
  constellation: string | null;
  /** manifest-v3 (PRD 2026-08-27 D1): the CANONICAL KEY of `id` — `<domain>/<workname>`, or null
   *  when the id predates the grammar. Identity comparisons use this when both sides have one, so
   *  a star that changes transport keeps its index instead of tripping the collision guard. */
  key: string | null;
  /** manifest-v3 (D9): the declared capabilities, with the defaults that describe the estate as it
   *  already is. A v2 star.yaml — which is every star today — yields exactly the defaults. */
  capabilities: StarCapabilities;
  /** ADR-0005: the locus DECLARED to hold write authority over this star. Present in star.yaml
   *  since the manifest existed and read by no code until 0.3.0 item 25 — see write-designation.ts.
   *  Null when undeclared, which is six of the eight catalogued stars today. */
  writeAuthority: string | null;
}
/** The three declared capabilities. See funes-core's star-uri.ts for the identity half of v3. */
export interface StarCapabilities { okf: "0.1" | "0.2" | false; graph: boolean; code: boolean }
export const DEFAULT_STAR_CAPABILITIES: StarCapabilities = { okf: "0.2", graph: true, code: false };

function readCapabilities(memory: Record<string, unknown>): StarCapabilities {
  const okf = memory.okf === false || memory.okf === "0.1" || memory.okf === "0.2"
    ? (memory.okf as StarCapabilities["okf"])
    : DEFAULT_STAR_CAPABILITIES.okf;
  return {
    okf,
    graph: typeof memory.graph === "boolean" ? memory.graph : DEFAULT_STAR_CAPABILITIES.graph,
    code: typeof memory.code === "boolean" ? memory.code : DEFAULT_STAR_CAPABILITIES.code,
  };
}

export function readStarIdentity(vault: string): StarIdentity {
  const none: StarIdentity = { id: null, name: null, constellation: null, key: null, capabilities: { ...DEFAULT_STAR_CAPABILITIES }, writeAuthority: null };
  const p = join(vault, "star.yaml");
  if (!existsSync(p)) return none;
  try {
    const data = parseYaml(readFileSync(p, "utf8")) as { meta?: Record<string, unknown>; memory?: Record<string, unknown> } | null;
    const meta = data?.meta ?? {};
    const s = (v: unknown) => (typeof v === "string" ? v : null);
    const id = s(meta.id);
    return {
      id,
      name: s(meta.name),
      constellation: s(meta.constellation),
      key: id ? canonicalKey(id) : null,
      capabilities: readCapabilities(data?.memory ?? {}),
      writeAuthority: s(meta.write_authority),
    };
  } catch {
    return none; // malformed -> path fallback, never a crash
  }
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
    const same = current.id === mine.id || (canonicalKey(current.id) !== null && canonicalKey(current.id) === canonicalKey(mine.id));
    if (!same) {
      throw new Error(
        `funes: index collision — ${indexDir} belongs to star "${current.id}"${current.star ? ` (${current.star})` : ""}, ` +
        `but "${vault}" is star "${mine.id}". Set FUNES_LIBSQL_DIR for one of them, or rename a folder.`,
      );
    }
    if (current.vault !== me || current.id !== mine.id) writeMine(); // moved on disk, or re-rendered under a new access method
    return;
  }
  // Fallback (one/both sides lack an id): compare the materialization path, as before.
  if (current.vault !== me) {
    throw new Error(
      `funes: index collision — ${indexDir} belongs to vault "${current.vault}", but "${me}" maps to the same index dir ` +
      `(same folder basename). Set FUNES_LIBSQL_DIR for one of the stars, or rename its folder.`,
    );
  }
  if (!current.id && mine.id) writeMine(); // legacy path-only marker, this star now has an id -> upgrade
}

/** Rewrite the owner marker of `indexDir` from one identity to another — the FIFTH layer of the
 *  renumber (`twinkling star reid`, RAI-49). Nothing else may move a marker.
 *
 *  The guard above is a hard stop by design, and this does not soften it: the caller must name the
 *  identity it expects to find, and a marker holding anything else refuses. That is what makes the
 *  renumber safe to re-run — a second pass over an already-renumbered star reports `already`, and a
 *  pass against the wrong index reports `refused` instead of stealing it.
 *
 *  Returns what happened, so a --dry-run can print the plan without writing. */
export function rewriteIndexOwner(
  indexDir: string,
  opts: { expectedId: string; newId: string; star?: string | null; constellation?: string | null; dryRun?: boolean },
): { outcome: "rewritten" | "already" | "absent" | "refused"; detail: string } {
  const markerPath = join(indexDir, "owner-vault");
  const current = readMarker(markerPath);
  if (!current) return { outcome: "absent", detail: `no owner marker at ${markerPath}` };
  if (current.id === opts.newId) return { outcome: "already", detail: `marker already holds "${opts.newId}"` };
  if (current.id !== opts.expectedId) {
    return { outcome: "refused", detail: `marker holds "${current.id ?? "(path-only)"}", expected "${opts.expectedId}"` };
  }
  if (opts.dryRun) return { outcome: "rewritten", detail: `would rewrite "${opts.expectedId}" -> "${opts.newId}"` };
  const payload = JSON.stringify({
    id: opts.newId,
    vault: current.vault,
    star: opts.star ?? current.star ?? null,
    constellation: opts.constellation ?? current.constellation ?? null,
  }) + "\n";
  // Write through a temp + rename so a crash mid-write cannot leave a half marker, which the
  // guard would then read as a path-only legacy marker and silently "upgrade".
  const tmp = `${markerPath}.${process.pid}.reid`;
  writeFileSync(tmp, payload);
  renameSync(tmp, markerPath);
  return { outcome: "rewritten", detail: `"${opts.expectedId}" -> "${opts.newId}"` };
}

/** `reindex --fresh`'s PRE-OPEN repair (0.3.0 close-out, the schema fence).
 *
 *  The fence (PLAN-0.3.0 R2#2) makes a read-write open REFUSE any index whose `schema_version` is
 *  not exactly INDEX_SCHEMA_VERSION, and the H1 drift guard has always refused a mismatched
 *  embedding signature. `--fresh` wipes with `prune([])` — INSIDE an open store — so after the fence
 *  the repair verb refused its own patient: the one index that most needs rebuilding is the one it
 *  could not open. So the wipe of a stale index happens here, on the files, BEFORE the store opens,
 *  and only for the two conditions the open itself would refuse; a current, matching index is left
 *  for the ordinary in-epoch wipe, which keeps the dirty marker over the rebuild.
 *
 *  Ordered like the normal opener, because a removal must clear every check an open would: the
 *  caller has already run the daemon probe; this runs the owner-marker/star-identity guard (a
 *  foreign star's index is refused BEFORE it is deleted) and the sync-root guard, and the caller
 *  holds the index's write lock across inspection, removal and the first open so no other funes
 *  writer can open the file between the two.
 *
 *  Inspection is a raw read-only `bun:sqlite` handle, not `LibsqlStore.create`: that opener is the
 *  thing that refuses. ponytail: same ceiling as `readPublishedMeta` (publication.ts) — Bun-only,
 *  dynamically imported inside a CLI-only verb, so no serving path evaluates it. A file the handle
 *  cannot read as a funes index is NOT removed: a repair that cannot inspect its patient says so
 *  rather than deleting on a guess. */
export async function repairIndexForFresh(opts: { vault: string; dbPath: string; embedder: Embedder }): Promise<"removed" | "kept" | "absent"> {
  assertIndexOwner(dirname(opts.dbPath), opts.vault);
  assertIndexNotInSyncRoot(opts.dbPath);
  if (!existsSync(opts.dbPath)) return "absent";
  let meta: Record<string, string>;
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(opts.dbPath, { readonly: true });
    try {
      meta = Object.fromEntries((db.query("select key, value from meta").all() as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]));
    } finally {
      db.close();
    }
  } catch (e) {
    throw new Error(`funes: reindex --fresh cannot inspect the index at ${opts.dbPath} (${(e as Error).message}) — not removing it; delete it by hand if it is not a funes index.`);
  }
  const sig = `${embeddingSignature(opts.embedder)}:${CHUNK_SIG}`;
  const staleSchema = meta.schema_version !== INDEX_SCHEMA_VERSION;
  // An absent signature is grandfathered by the open (it stamps one), so only a DIFFERENT one is drift.
  const drifted = meta.embedding_signature != null && meta.embedding_signature !== sig;
  if (!staleSchema && !drifted) return "kept";
  process.stderr.write(
    `reindex --fresh: removing the index at ${opts.dbPath} before the rebuild — ` +
    (staleSchema ? `schema_version "${meta.schema_version ?? "pre-2"}" != "${INDEX_SCHEMA_VERSION}"` : `embedding signature "${meta.embedding_signature}" != "${sig}"`) +
    " (a read-write open would refuse it).\n",
  );
  // Mirrors publication.ts's rmDbFiles (module-private there, and it also drops a publication-only
  // retention pin this live index never has).
  for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(opts.dbPath + suffix, { force: true });
  return "removed";
}

export interface MakeStoreOpts {
  /** Resolve dbDir from the vault (via funesDbDir) when `dbDir` is omitted. */
  vault?: string;
  /** Explicit index path (wins over `vault`). */
  dbDir?: string;
  /** Server tier (backend "postgres"): connection string; falls back to FUNES_PG_URL. */
  pgUrl?: string;
  /** Backend override; defaults to funesBackend(). */
  backend?: FunesBackend;
  /** Embedder override; defaults to a fresh E5Embedder. */
  embedder?: Embedder;
  allowDirty?: boolean;
  /** Open the index READ-ONLY (libsql only — SQLite mode=ro): no WAL flip, no DDL, no meta writes,
   *  telemetry forced off. The read face's open mode (canon host RO index mount); other backends refuse. */
  readonly?: boolean;
  /** R8 recall telemetry (daemon --stats / unified surface). */
  trackRecalls?: boolean;
  /** Construct the cross-encoder final stage. */
  rerank?: boolean;
  /** Pass an already-constructed reranker (wins over `rerank`). */
  reranker?: Reranker;
  /** Provenance-v1 STAMPED write actor — the authenticated principal the serving context sets on
   *  every write it performs. NEVER sourced from item frontmatter/op args. Omitted → "unknown"
   *  (legacy/local/unauthenticated). Threaded from the daemon/operator-session in twinkling Rev 8. */
  writeActor?: string;
}

/** The ONE place a funes index store is constructed. Returns the shared FunesIndexStore — both
 *  backends implement it, so FUNES_BACKEND swaps with no cast. */
export async function makeStore(opts: MakeStoreOpts = {}): Promise<FunesIndexStore> {
  const backend = opts.backend ?? funesBackend();
  if (opts.readonly && backend !== "libsql") {
    throw new Error(`funes: read-only opens are libsql-only today (backend "${backend}" has no RO path) — serve read-only faces from a libsql index.`);
  }
  const dbDir = opts.dbDir ?? (opts.vault != null ? funesDbDir(opts.vault, backend) : undefined);
  // basename-collision + identity guard: run whenever we know the owning vault, even if the caller
  // passed an explicit dbDir. (Before 2026-07-04 this only fired when dbDir was DERIVED, so every
  // real caller — mcp/daemon/cli all compute + pass dbDir — silently bypassed it.) A bare explicit
  // dbDir with NO vault still skips: the caller owns that mapping and there's no star to check.
  // A READ-ONLY open also skips: the guard WRITES the owner marker, and the index home may be an
  // RO mount (the writer side stamped it).
  if (backend === "libsql" && opts.vault != null && dbDir != null && !opts.readonly) {
    assertIndexOwner(dirname(dbDir), opts.vault);
  }
  // 0.3.0 item 23: the index may not live inside a sync provider's root. Checked at the ONE
  // construction point, on read-only opens too — a torn database serves torn answers whoever opened
  // it — and against the INDEX path only: a vault under Syncthing/Dropbox is the estate's normal
  // shape and stays permitted.
  if (backend === "libsql" && dbDir != null) assertIndexNotInSyncRoot(dbDir);
  const embedder = opts.embedder ?? new E5Embedder();
  const reranker = opts.reranker ?? (opts.rerank ? new CrossEncoderReranker() : undefined);
  if (backend === "postgres") {
    // P3.15: the published artifact is libsql-only. Refuse BEFORE resolving a path or a driver, so
    // the failure is a deliberate sentence rather than an obscure module-resolution error.
    if (LIBSQL_ONLY) {
      throw new Error('funes: FUNES_BACKEND=postgres is not available in this build — @funes-tech/cli ships the libsql path only. Run funes from source for the Postgres tier.');
    }
    // 0.3.0 P0.4: PARKED. PostgresStore neither persists nor validates `schema_version`, so an old
    // Postgres writer would mutate beside new code without clearing the new content generation —
    // and no fence this release adds can stop it without credential rotation or a server-side
    // protocol gate. The tier is EXPERIMENTAL, benched only on docker and never run against a live
    // cluster, so refusing costs nothing real. The live smoke test sets the escape, so CI keeps its
    // coverage. Same shape as the LIBSQL_ONLY refusal above: throw before a path or a driver, so
    // the failure is a sentence rather than an obscure resolution error.
    if (process.env.FUNES_PG_UNSAFE !== "1") {
      throw new Error(
        'funes: the postgres backend is parked for 0.3.0 — PostgresStore does not persist or validate schema_version, ' +
        'so an old writer can mutate an index without clearing its content generation and no fence can stop it. ' +
        'Use the libsql backend, or set FUNES_PG_UNSAFE=1 to run the experimental tier anyway.',
      );
    }
    // Server tier (ADR-0001 §1): the SAME store over node-postgres. Database-per-star,
    // role-per-star — the connection string IS the star scoping; no vault-derived path exists.
    const pgUrl = opts.pgUrl ?? process.env.FUNES_PG_URL;
    if (!pgUrl) throw new Error('FUNES_BACKEND=postgres needs a connection string — pass opts.pgUrl or set FUNES_PG_URL (e.g. "postgres://star_role@host/star_db").');
    const { postgresDriver } = await import("./postgres-driver.ts");
    const { PostgresStore } = await import("./store.ts"); // dynamic: keeps pg off the artifact's path
    return PostgresStore.createWithDriver(await postgresDriver(pgUrl), embedder, {
      allowDirty: opts.allowDirty,
      trackRecalls: opts.trackRecalls,
      writeActor: opts.writeActor,
      ...(reranker ? { reranker } : {}),
    });
  }
  // Default: libSQL (the only local backend). Lazy relative import so the native libsql lib loads
  // only when actually used; funes-libsql shares this package's pure chunk/zone/embedder helpers +
  // the FunesIndexStore type, and bakes typed AND thresholded-similarity edges in graph() (P1b parity).
  const { LibsqlStore } = await import("funes-libsql");
  return LibsqlStore.create(embedder, dbDir, { allowDirty: opts.allowDirty, trackRecalls: opts.trackRecalls, reranker, readonly: opts.readonly, writeActor: opts.writeActor });
}
