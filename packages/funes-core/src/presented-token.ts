// ADR-0016 §The decision (record 33): the ONE credential parser every funes HTTP surface reads
// through — the daemon, the broker face, funes-api's hosts, and the edge (ADR-0014, no legacy name).
// `Authorization: Bearer` is authoritative. Each surface keeps exactly one legacy header until 0.6.0.

/** What a request presented: a token, nothing (`token: null`), or a refusal the surface answers 401. */
export type PresentedToken = { token: string | null } | { refused: "malformed" | "conflicting" };

// RFC 6750 §2.1 b64token; the scheme is matched case-insensitively.
const B64TOKEN = "[A-Za-z0-9\\-._~+/]+=*";
const BEARER = new RegExp(`^Bearer (${B64TOKEN})$`, "i");
const warned = new Set<string>();

/** Can `token` travel as `Authorization: Bearer`? A client sends Bearer only then: any other token
 *  is refused `malformed` there, and the legacy header beside it is never read. */
export const isB64Token = (token: string): boolean => new RegExp(`^${B64TOKEN}$`).test(token);

/** Read the credential: (1) Authorization present → it must be `Bearer <b64token>`, else refused and
 *  the legacy header is never read; Bearer beside a different legacy value is refused, an equal one
 *  accepted. (2) No Authorization → the surface's legacy header, accepted with one deprecation line
 *  per process per header name — never the token. Neither refusal names a value. */
export function presentedToken(get: (name: string) => string | null | undefined, legacyName: string | null): PresentedToken {
  const authorization = get("authorization");
  const legacy = legacyName ? (get(legacyName) ?? "").trim() : "";
  if (authorization != null) {
    const token = BEARER.exec(authorization.trim())?.[1];
    if (!token) return { refused: "malformed" };
    if (legacy && legacy !== token) return { refused: "conflicting" };
    return { token };
  }
  if (!legacy) return { token: null };
  if (!warned.has(legacyName!)) {
    warned.add(legacyName!);
    console.warn(`funes: credential header ${legacyName} is deprecated — send Authorization: Bearer (${legacyName} alone is refused from 0.6.0)`);
  }
  return { token: legacy };
}
