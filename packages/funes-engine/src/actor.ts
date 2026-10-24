// The access file's folder half (RAI-313): the owner-only read, the version-2 file reader and the stdio
// session's grant. The validator and the grant match are the kernel's (funes-core actor.ts).
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { grantCoversStar, grantFor, validateAccessPolicy } from "funes-core/internal";
import { publicOpNames, type AccessPolicy, type Grant } from "funes-core";

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The file's bytes, with the owner-only mode checked on the SAME descriptor the bytes come from —
 *  a stat followed by a read by name could check one file and read another. */
export function readOwnerOnly(path: string, label = "access file"): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (e) {
    throw new Error(`${label} ${path}: cannot stat the mapping file (${(e as NodeJS.ErrnoException).code ?? "unreadable"}) — refusing to serve (fail-closed)`);
  }
  try {
    const mode = fstatSync(fd).mode;
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `${label} ${path}: mode ${(mode & 0o777).toString(8)} is group/world readable and the file holds capability tokens — ` +
        "chmod 600 it, then restart (fail-closed)",
      );
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** JSON.parse whose failure never reaches a log: Bun's message quotes the offending identifier,
 *  and a hand-edited file can hold a raw token there (RAI-158). */
function parseNoEcho(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`access file ${path}: malformed JSON — refusing to serve (fail-closed); the parser's message is withheld because it can quote a token`);
  }
}

/** Read and validate a version-2 access file NOW. Any other file refuses (RAI-310 D3: the v1 map is gone). */
export function readAccessPolicy(path: string): AccessPolicy {
  const parsed = parseNoEcho(readOwnerOnly(path), path);
  if (!isObject(parsed) || parsed.version !== 2) {
    throw new Error(`access file ${path}: not a version-2 access file ({"version": 2, "roles": …, "actors": …}); the v1 {token: actor} map was removed in funes 0.6.0 — refusing everyone (fail-closed)`);
  }
  return validateAccessPolicy(parsed, publicOpNames(), `access file ${path}`);
}

/** RAI-159 (PLAN-0.4.0 item 22): a stdio session's grant, resolved ONCE at startup — so revoking it
 *  needs a session restart. `FUNES_ACTOR_MAP` present (presence, not truthiness: set-but-empty is a
 *  misconfiguration and refuses) turns it on, and then everything must line up or the server does not
 *  start: `FUNES_CAPABILITY_FILE` named explicitly — never the shared `~/.twinkling/funes-cap`
 *  fallback, which would resolve the OPERATOR's grant for an agent session — a version-2 file, a
 *  token it names, and a grant that reaches this star. One check covers both paths: the direct store
 *  and the daemon proxy, which never reaches a local dispatch. Returns null when the map is unset. */
export function resolveSessionGrant(starId: string | null, env: NodeJS.ProcessEnv = process.env): Grant | null {
  const mapPath = env.FUNES_ACTOR_MAP;
  if (mapPath == null) return null;
  const capPath = env.FUNES_CAPABILITY_FILE;
  if (capPath == null || capPath.trim() === "") {
    throw new Error(
      "FUNES_ACTOR_MAP is set, so FUNES_CAPABILITY_FILE must name this session's own token file — the shared " +
      "<funes home>/funes-cap is never a fallback here (it would resolve the operator's grant); refusing to start",
    );
  }
  const policy = readAccessPolicy(mapPath);
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
