// Where a write's actor comes from — and the one place it may never come from (0.3.0 item 24).
//
// `Actor` is who performed a mutation (CONTEXT.md). It is NOT a principal (a publication consumer),
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
// The mapping is read ONCE, at startup. Not a hot reload, deliberately: a running process's actor
// set is fixed, so an operator who edits the map knows exactly when it takes effect (the restart),
// and a half-written file cannot re-key a live process's writes mid-flight.
import { readFileSync, statSync } from "node:fs";

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
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch (e) {
    throw new Error(`--actor-map ${path}: cannot stat the mapping file (${(e as Error).message}) — refusing to serve (fail-closed)`);
  }
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `--actor-map ${path}: mode ${(mode & 0o777).toString(8)} is group/world readable and the file holds capability tokens — ` +
      "chmod 600 it, then restart (fail-closed)",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`--actor-map ${path}: unreadable or malformed JSON (${(e as Error).message}) — refusing to serve (fail-closed)`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`--actor-map ${path}: expected a JSON object of {"<capability token>": "<actor>"} — refusing to serve (fail-closed)`);
  }
  const map = new Map<string, string>();
  for (const [token, actor] of Object.entries(parsed as Record<string, unknown>)) {
    if (token.trim().length === 0) throw new Error(`--actor-map ${path}: an empty capability token maps to "${String(actor)}" — refusing to serve (fail-closed)`);
    if (typeof actor !== "string") throw new Error(`--actor-map ${path}: the actor for one entry is ${typeof actor}, not a string — refusing to serve (fail-closed)`);
    map.set(token.trim(), assertActorName(actor, `--actor-map ${path}`));
  }
  if (map.size === 0) throw new Error(`--actor-map ${path}: empty mapping — refusing to serve (fail-closed)`);
  return map;
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
  const map = loadActorMap(cfg.mapPath); // fail-closed: a broken map refuses startup, never degrades
  if (cfg.capabilityPath == null) return UNKNOWN_ACTOR;
  let token: string;
  try {
    token = readFileSync(cfg.capabilityPath, "utf8").trim();
  } catch {
    return UNKNOWN_ACTOR; // an unreadable capability authorizes nobody either — the check refuses every request
  }
  return actorForCapability(map, token);
}
