// Where a write's actor comes from — and the one place it may never come from (0.3.0 item 24).
//
// `Actor` is who performed a mutation (GLOSSARY.md). It is NOT a principal (a publication consumer),
// and it is NOT the locus (an operator-supplied label for a machine). The store already stamps
// `write_actor` from its CONSTRUCTOR and never from an item's frontmatter or an op's arguments —
// that seam was correct and is untouched here. What it lacked was a source: nothing in the repo
// ever passed `writeActor`, so every write in the estate stamps "unknown". This module is that
// source, and it admits exactly two:
//
//   --actor <name> / FUNES_ACTOR   trusted process configuration — the operator naming the process.
//   --actor-map <file>             a capability-to-actor mapping: the presented CREDENTIAL names
//                                  the actor, so the actor is a consequence of authentication
//                                  rather than of a claim.
//
// A request payload is never consulted. That is structural, not conventional: no operation in
// ops.ts declares an actor argument, so there is nothing to ignore at runtime — and the test that
// proves it is generated from the registry, so a future op cannot quietly add one.
//
// A version-1 mapping is read ONCE, at startup. Not a hot reload, deliberately: a running process's
// actor set is fixed, so an operator who edits the map knows exactly when it takes effect (the
// restart), and a half-written file cannot re-key a live process's writes mid-flight.
//
// A version-2 access file (RAI-158, below) is the other case: it names many CALLERS, each with a role,
// and it is read on every request, because there it decides who may run what — and a revocation that
// waits for a restart is not a revocation. It never re-keys a multi-caller process's own `write_actor`
// (a stdio session, one process with one grant, stamps that grant's actor — mcp-server.ts).
//
// Since 0.4.0 a face opens any `--actor-map` it is given at startup, to learn which version it is — so
// a map that is unreadable, group/world readable or malformed refuses startup even when `--actor`
// names the process. Before, `--actor` won the precedence and the map was never opened: a loose token
// file was accepted because it went unread.
import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { refKey, sameStar } from "funes-core";

/** An actor name as it will be stored in `write_actor`. Deliberately narrow: it lands in a text
 *  column that `indexed_page` serves back out, so a name carrying whitespace, control characters or
 *  a newline would be a formatting weapon in a diagnostic surface. */
const ACTOR_NAME = /^[A-Za-z0-9._:@/+-]{1,128}$/;

/** The recorded actor when nothing trusted names one. A guess would be worse than a blank. */
export const UNKNOWN_ACTOR = "unknown";

export function assertActorName(name: string, source: string): string {
  const a = name.trim();
  if (!ACTOR_NAME.test(a)) {
    throw new Error(`${source}: "${name}" is not a usable actor name — expected 1-128 chars of [A-Za-z0-9._:@/+-] (fail-closed)`);
  }
  return a;
}

/** Load the capability-to-actor mapping: JSON `{ "<capability token>": "<actor>" }`.
 *
 *  Owner-readable-only is CHECKED, not documented: the file holds the tokens themselves, so a
 *  group- or world-readable mapping hands every reader on the box the broker's credential. Parsing
 *  is fail-closed in every direction — unreadable, non-JSON, not an object, an empty key, a
 *  non-string or unusable actor name all REFUSE. A mapping that half-loads is a mapping that
 *  silently stamps `unknown` for the entries it dropped. */
export function loadActorMap(path: string): Map<string, string> {
  return actorMapFrom(parseNoEcho(readOwnerOnly(path), path), path);
}

/** The file's bytes, with the owner-only mode checked on the SAME descriptor the bytes come from —
 *  a stat followed by a read by name could check one file and read another. */
function readOwnerOnly(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (e) {
    throw new Error(`--actor-map ${path}: cannot stat the mapping file (${(e as NodeJS.ErrnoException).code ?? "unreadable"}) — refusing to serve (fail-closed)`);
  }
  try {
    const mode = fstatSync(fd).mode;
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `--actor-map ${path}: mode ${(mode & 0o777).toString(8)} is group/world readable and the file holds capability tokens — ` +
        "chmod 600 it, then restart (fail-closed)",
      );
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** JSON.parse whose failure never reaches a log: Bun's message quotes the offending identifier,
 *  and in a hand-edited v1 map that identifier is a raw token (RAI-158). */
function parseNoEcho(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`--actor-map ${path}: malformed JSON — refusing to serve (fail-closed); the parser's message is withheld because it can quote a token`);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function actorMapFrom(parsed: unknown, path: string): Map<string, string> {
  if (!isObject(parsed)) {
    throw new Error(`--actor-map ${path}: expected a JSON object of {"<capability token>": "<actor>"} — refusing to serve (fail-closed)`);
  }
  const map = new Map<string, string>();
  for (const [token, actor] of Object.entries(parsed)) {
    if (token.trim().length === 0) throw new Error(`--actor-map ${path}: an empty capability token maps to "${String(actor)}" — refusing to serve (fail-closed)`);
    if (typeof actor !== "string") throw new Error(`--actor-map ${path}: the actor for one entry is ${typeof actor}, not a string — refusing to serve (fail-closed)`);
    map.set(token.trim(), assertActorName(actor, `--actor-map ${path}`));
  }
  if (map.size === 0) throw new Error(`--actor-map ${path}: empty mapping — refusing to serve (fail-closed)`);
  return map;
}

// ── RAI-158 (PLAN-0.4.0 item 21): the access file, version 2 ─────────────────────────────────────
// One broker, many callers. A v2 file names ACTORS, each with a ROLE (a named set of operations)
// and the STARS it may touch; a presented token picks the actor. It stores sha256(token), never a
// token, so reading it leaks no credential. It is read on EVERY request that presents a token — no
// cache, so no stale key can hide a revocation (an (mtime, size) key misses a same-size rewrite
// under a restored mtime). Anything malformed refuses everyone: a half-loaded policy is a policy
// that silently admits the entries it did not drop.

/** What a presented credential grants: who is calling, which operations, on which stars. */
export interface Grant {
  actor: string;
  ops: ReadonlySet<string>;
  /** Star refs, compared by canonical key; "*" is every star. */
  stars: readonly string[];
}

export interface AccessPolicy {
  actors: ReadonlyArray<Grant & { hash: Buffer }>;
}

/** Read and validate a version-2 access file NOW, or report that the file is a v1 map. `publicOps`
 *  is the registry's non-internal operation names: a role naming anything else refuses — `link` and
 *  `elevate` are CLI verbs outside the registry, and an internal `guarded_*` op is reached through
 *  its public twin. */
export function readAccessPolicy(path: string, publicOps: ReadonlySet<string>): AccessPolicy | "v1" {
  const parsed = parseNoEcho(readOwnerOnly(path), path);
  if (!isObject(parsed) || parsed.version !== 2) return "v1";
  const bad = (why: string) => new Error(`--actor-map ${path}: ${why} — refusing everyone (fail-closed)`);
  if (!isObject(parsed.roles)) throw bad("`roles` must be an object of {name: {ops: [...]}}");
  const roles = new Map<string, Set<string>>();
  for (const [name, r] of Object.entries(parsed.roles)) {
    const ops = isObject(r) && Array.isArray(r.ops) ? r.ops : null;
    if (!ops) throw bad(`role "${name}": \`ops\` must be a list`);
    if (ops.length === 0) throw bad(`role "${name}": no operations`);
    for (const op of ops) {
      if (typeof op !== "string" || !publicOps.has(op)) throw bad(`role "${name}": unknown or internal operation "${String(op)}"`);
    }
    roles.set(name, new Set(ops as string[]));
  }
  if (!isObject(parsed.actors)) throw bad("`actors` must be an object of {name: {token_sha256, role, stars}}");
  const actors: Array<Grant & { hash: Buffer }> = [];
  const hashes = new Set<string>();
  // Entries are named by POSITION in every refusal, never by key: an operator who wraps an old v1 map
  // under `actors` puts raw tokens in the key slot, and a 64-hex token is a valid actor name.
  for (const [i, [name, a]] of Object.entries(parsed.actors).entries()) {
    const where = `actors entry #${i + 1}`;
    if (!ACTOR_NAME.test(name.trim())) throw bad(`${where}: not a usable actor name — expected 1-128 chars of [A-Za-z0-9._:@/+-]`);
    if (!isObject(a)) throw bad(`${where}: must be an object of {token_sha256, role, stars}`);
    const h = a.token_sha256;
    if (typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) throw bad(`${where}: token_sha256 must be 64 lowercase hex`);
    if (hashes.has(h)) throw bad(`${where}: two actors share one token hash`);
    hashes.add(h);
    const ops = roles.get(String(a.role));
    if (!ops) throw bad(`${where}: unknown role "${String(a.role)}"`);
    const stars = a.stars;
    if (!Array.isArray(stars) || stars.length === 0 || !stars.every((s) => s === "*" || (typeof s === "string" && refKey(s) !== null))) {
      throw bad(`${where}: stars must be a non-empty list of star refs or "*"`);
    }
    actors.push({ actor: name.trim(), ops, stars: stars as string[], hash: Buffer.from(h, "hex") });
  }
  if (actors.length === 0) throw bad("no actors");
  return { actors };
}

/** The grant a presented token names, or null. The token is trimmed (every token reader in the
 *  estate trims) and hashed, then compared against EVERY entry in constant time, with no early exit. */
export function grantFor(policy: AccessPolicy, presented: string | null | undefined): Grant | null {
  const token = (presented ?? "").trim();
  if (!token) return null;
  const h = createHash("sha256").update(token).digest();
  let hit: Grant | null = null;
  for (const a of policy.actors) {
    if (timingSafeEqual(h, a.hash) && hit === null) hit = { actor: a.actor, ops: a.ops, stars: a.stars };
  }
  return hit;
}

/** Does this grant reach the star `starId` names? By canonical key, so one star under two access
 *  methods is one star; a star with no id is reached by "*" only. */
export function grantCoversStar(g: Grant, starId: string | null): boolean {
  return g.stars.includes("*") || (starId !== null && g.stars.some((s) => s !== "*" && sameStar(s, starId)));
}

/** RAI-159 (PLAN-0.4.0 item 22): a stdio session's grant, resolved ONCE at startup — so revoking it
 *  needs a session restart. `FUNES_ACTOR_MAP` present (presence, not truthiness: set-but-empty is a
 *  misconfiguration and refuses) turns it on, and then everything must line up or the server does not
 *  start: `FUNES_CAPABILITY_FILE` named explicitly — never the shared `~/.twinkling/funes-cap`
 *  fallback, which would resolve the OPERATOR's grant for an agent session — a version-2 file, a
 *  token it names, and a grant that reaches this star. One check covers both paths: the direct store
 *  and the daemon proxy, which never reaches a local dispatch. Returns null when the map is unset. */
export function resolveSessionGrant(starId: string | null, publicOps: ReadonlySet<string>, env: NodeJS.ProcessEnv = process.env): Grant | null {
  const mapPath = env.FUNES_ACTOR_MAP;
  if (mapPath == null) return null;
  const capPath = env.FUNES_CAPABILITY_FILE;
  if (capPath == null || capPath.trim() === "") {
    throw new Error(
      "FUNES_ACTOR_MAP is set, so FUNES_CAPABILITY_FILE must name this session's own token file — the shared " +
      "~/.twinkling/funes-cap is never a fallback here (it would resolve the operator's grant); refusing to start",
    );
  }
  const policy = readAccessPolicy(mapPath, publicOps);
  if (policy === "v1") throw new Error(`FUNES_ACTOR_MAP ${mapPath}: a session resolves its role from a version-2 access file only — refusing to start`);
  let token: string;
  try {
    token = readFileSync(capPath, "utf8");
  } catch (e) {
    throw new Error(`FUNES_CAPABILITY_FILE ${capPath}: unreadable (${(e as NodeJS.ErrnoException).code ?? "error"}) — refusing to start`);
  }
  const grant = grantFor(policy, token);
  if (!grant) throw new Error(`FUNES_CAPABILITY_FILE ${capPath}: its token names no actor in ${mapPath} — refusing to start`);
  if (!grantCoversStar(grant, starId)) {
    throw new Error(`actor "${grant.actor}" holds no grant for star "${starId ?? "(no id)"}" (${mapPath}) — refusing to start`);
  }
  return grant;
}

/** The actor a presented capability names. An UNMAPPED capability stamps `unknown` — it does not
 *  fall back to some ambient default and it does not invent a name from the token. (Whether that
 *  capability may write at all is the capability check's business, and it runs first.) */
export function actorForCapability(map: Map<string, string> | null, presented: string | null | undefined): string {
  if (!map || presented == null) return UNKNOWN_ACTOR;
  return map.get(presented.trim()) ?? UNKNOWN_ACTOR;
}

export interface ActorConfig {
  /** `--actor` (or FUNES_ACTOR): the process's own operator-declared actor. */
  actor?: string;
  /** `--actor-map`: the capability-to-actor mapping file. */
  mapPath?: string;
  /** The capability file this process serves behind — its CURRENT token is what the mapping is
   *  looked up by. Read once here, at startup, for the same reason the map is. */
  capabilityPath?: string;
  env?: NodeJS.ProcessEnv;
}

/** Resolve the actor this process stamps on every write it performs, at STARTUP, for the store
 *  constructor's `writeActor`.
 *
 *  Precedence: `--actor` over FUNES_ACTOR over the capability mapping over `unknown`. The explicit
 *  flag wins because it is the more specific statement of the two trusted sources — an operator who
 *  names the actor on the command line has said something about THIS process, while the mapping
 *  says something about a credential that several processes might present.
 *
 *  The mapping is looked up by the capability file's token as it reads at startup. A rotation that
 *  replaces the token later still authenticates (the capability check re-reads per request, for
 *  exactly that reason) but does not re-key the actor: the actor set is fixed for the process's
 *  lifetime, which is the property item 24 asks for. */
export function resolveWriteActor(cfg: ActorConfig = {}): string {
  const env = cfg.env ?? process.env;
  const declared = cfg.actor ?? env.FUNES_ACTOR;
  if (declared != null && declared.trim().length > 0) {
    return assertActorName(declared, cfg.actor != null ? "--actor" : "FUNES_ACTOR");
  }
  if (cfg.mapPath == null) return UNKNOWN_ACTOR;
  const parsed = parseNoEcho(readOwnerOnly(cfg.mapPath), cfg.mapPath); // fail-closed: a broken map refuses startup
  // RAI-158: a v2 access file names its callers PER REQUEST; the process itself stamps only what it
  // declares. `write_actor` stays per process, so a multi-actor broker must not stamp one caller.
  if (isObject(parsed) && parsed.version === 2) return UNKNOWN_ACTOR;
  const map = actorMapFrom(parsed, cfg.mapPath);
  if (cfg.capabilityPath == null) return UNKNOWN_ACTOR;
  let token: string;
  try {
    token = readFileSync(cfg.capabilityPath, "utf8").trim();
  } catch {
    return UNKNOWN_ACTOR; // an unreadable capability authorizes nobody either — the check refuses every request
  }
  return actorForCapability(map, token);
}
