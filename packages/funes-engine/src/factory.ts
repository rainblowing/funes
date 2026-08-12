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
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Embedder } from "funes-core";
import type { FunesIndexStore } from "./store.ts";
import { E5Embedder } from "./embedder.ts";
import { CrossEncoderReranker, type Reranker } from "./rerank.ts";
import { LIBSQL_ONLY } from "./artifact.ts";

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
export interface StarIdentity { id: string | null; name: string | null; constellation: string | null; }
export function readStarIdentity(vault: string): StarIdentity {
  const p = join(vault, "star.yaml");
  if (!existsSync(p)) return { id: null, name: null, constellation: null };
  try {
    const data = parseYaml(readFileSync(p, "utf8")) as { meta?: Record<string, unknown> } | null;
    const meta = data?.meta ?? {};
    const s = (v: unknown) => (typeof v === "string" ? v : null);
    return { id: s(meta.id), name: s(meta.name), constellation: s(meta.constellation) };
  } catch {
    return { id: null, name: null, constellation: null }; // malformed -> path fallback, never a crash
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
    if (current.id !== mine.id) {
      throw new Error(
        `funes: index collision — ${indexDir} belongs to star "${current.id}"${current.star ? ` (${current.star})` : ""}, ` +
        `but "${vault}" is star "${mine.id}". Set FUNES_LIBSQL_DIR for one of them, or rename a folder.`,
      );
    }
    if (current.vault !== me) writeMine(); // same star, moved on disk -> record the new materialization
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
  const embedder = opts.embedder ?? new E5Embedder();
  const reranker = opts.reranker ?? (opts.rerank ? new CrossEncoderReranker() : undefined);
  if (backend === "postgres") {
    // P3.15: the published artifact is libsql-only. Refuse BEFORE resolving a path or a driver, so
    // the failure is a deliberate sentence rather than an obscure module-resolution error.
    if (LIBSQL_ONLY) {
      throw new Error('funes: FUNES_BACKEND=postgres is not available in this build — @funes-tech/cli ships the libsql path only. Run funes from source for the Postgres tier.');
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
