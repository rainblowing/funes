// ADR-0016 §The decision (record 33): the ONE credential parser every funes HTTP surface reads
// through. `Authorization: Bearer` is the only credential (RAI-310: no legacy header since 0.6.0).

/** What a request presented: a token, nothing (`token: null`), or a refusal the surface answers 401. */
export type PresentedToken = { token: string | null } | { refused: "malformed" };

// RFC 6750 §2.1 b64token; the scheme is matched case-insensitively.
const B64TOKEN = "[A-Za-z0-9\\-._~+/]+=*";
const BEARER = new RegExp(`^Bearer (${B64TOKEN})$`, "i");

/** Can `token` travel as `Authorization: Bearer`? A client sends a token file's bytes only then. */
export const isB64Token = (token: string): boolean => new RegExp(`^${B64TOKEN}$`).test(token);

/** Read the credential: Authorization present → it must be `Bearer <b64token>`, else refused. Any
 *  other header is never read. The refusal names no value. */
export function presentedToken(get: (name: string) => string | null | undefined): PresentedToken {
  const authorization = get("authorization");
  if (authorization == null) return { token: null };
  const token = BEARER.exec(authorization.trim())?.[1];
  return token ? { token } : { refused: "malformed" };
}
