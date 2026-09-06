// The star identity URI — the estate's one identity grammar (PRD 2026-08-27,
// twinkling/docs/prd-star-identity-discovery.md; RAI-41).
//
//     <access>://<constellation-domain>/<workname>[/<subname>…][?<params>]
//
// The three slots each answer a different question, and the whole point of the grammar is that
// they stopped answering each other's:
//   - <access>      HOW to reach the star (dropbox | git | mcp | file). NOT part of its identity.
//   - <domain>      WHICH constellation owns it — the manifest `id:` (example.org, example.net, …).
//   - <workname>    WHICH star, as a NAME. Segment 1 is the main name, each further segment is the
//                   next name down. A name may coincide with a storage path and never has to.
//   - ?<params>     reserved; inert; excluded from the key (D11).
//
// IDENTITY IS THE SCHEME-FREE PAIR. `canonicalKey()` renders it. Two URIs that differ only in the
// access slot or the parameters name the SAME star, so a star that moves from Dropbox to git
// rewrites its scheme and changes no storage key. That property is what the whole PRD buys.
//
// WHAT THIS FILE IS NOT: a locator. No caller may dereference a star URI —
// `git://example.org/engine` is not a git remote and `mcp://example.net/tool.kit` is not a socket
// address. The real locators live in `star.yaml` `meta.access`. Vlad chose `mcp` over `https`
// for the read face on 2026-08-27 precisely so the identity can never be mistaken for a URL.
//
// Why hand-rolled and not `new URL()`: WHATWG parses these as non-special URLs, which means an
// opaque host it will not lowercase, percent-encoding it will happily accept, and userinfo/port it
// treats as ordinary. This grammar is deliberately NARROWER than a URL, so the narrow parser is
// both shorter and the only one that can enforce it.

/** The access vocabulary. An unrecognized scheme is a REJECTION, never a servable star. */
export const STAR_ACCESS = ["dropbox", "git", "mcp", "file"] as const;
export type StarAccess = (typeof STAR_ACCESS)[number];

/** Maximum workname depth. Bounded so the workname cannot drift back into being a storage path —
 *  which is the exact failure the grammar exists to end. Raise it only with a real fifth name. */
export const MAX_WORKNAME_DEPTH = 4;

/** One workname segment. Lowercase-only by DESIGN, not by normalization: two stars that differ
 *  only by case would collide on a case-insensitive filesystem, so uppercase fails closed. */
const SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** A constellation domain — at least two labels, so a bare hostname cannot pass for one. */
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** scheme :// authority [ /path ] [ ?params ] [ #fragment ] */
const URI_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/;

export interface StarUri {
  /** The access method as written, lowercased. */
  access: StarAccess;
  /** The constellation domain, lowercased. */
  constellation: string;
  /** The workname: [main, secondary, tertiary, …]. Never empty. */
  path: string[];
  /** The query string as authored, WITHOUT the leading "?". Empty when absent. Preserved and
   *  never interpreted — no consumer reads a parameter in this release (D11). */
  params: string;
  /** The canonical key — `<constellation>/<path.join("/")>`. Scheme-free, parameter-free. THIS is
   *  the durable storage key; every durable row persists it. */
  key: string;
}

export type StarUriRejection =
  | "not-a-uri"       // no `scheme://authority` shape at all (a bare key, a single slash, prose)
  | "has-fragment"    // `#…` — a star has no sub-resource
  | "has-userinfo"    // `user@host` — credentials never live in an identity
  | "has-port"        // `:2222` — an identity is not an address, so it has no port
  | "unknown-access"  // a scheme outside STAR_ACCESS (https, ssh, …)
  | "bad-domain"      // not a dotted domain (a bare hostname, an empty authority)
  | "no-workname"     // the path is empty — the star has no name
  | "bad-segment"     // a segment fails SEGMENT_RE (uppercase, space, %, empty, `.`, `..`)
  | "too-deep";       // more than MAX_WORKNAME_DEPTH segments

export type ParseStarUriResult =
  | { ok: true; uri: StarUri }
  | { ok: false; reason: StarUriRejection; detail: string };

export type ParseCanonicalKeyResult =
  | { ok: true; key: string; constellation: string; path: string[] }
  | { ok: false; reason: StarUriRejection; detail: string };

/** The half of the grammar that lives BELOW the scheme: the domain and the workname. Shared so
 *  `<access>://<domain>/<workname>` and the bare `<domain>/<workname>` can never drift apart —
 *  which is the entire reason the key is safe to use as a storage key. */
function parseDomainAndPath(constellationRaw: string, pathRaw: string): ParseCanonicalKeyResult {
  const constellation = constellationRaw.toLowerCase();
  if (!DOMAIN_RE.test(constellation)) return { ok: false, reason: "bad-domain", detail: constellationRaw };

  // Drop the leading slash and ONE trailing slash; `""` and `"/"` both mean "no workname".
  const trimmed = pathRaw.replace(/^\//, "").replace(/\/$/, "");
  if (trimmed === "") return { ok: false, reason: "no-workname", detail: `${constellationRaw}${pathRaw}` };

  const path = trimmed.split("/");
  if (path.length > MAX_WORKNAME_DEPTH) {
    return { ok: false, reason: "too-deep", detail: `${path.length} segments` };
  }
  for (const seg of path) {
    // `.` and `..` fail here too — SEGMENT_RE requires a leading [a-z0-9].
    if (!SEGMENT_RE.test(seg)) return { ok: false, reason: "bad-segment", detail: seg };
  }
  return { ok: true, key: `${constellation}/${path.join("/")}`, constellation, path };
}

/** Parse a BARE canonical key — `<constellation-domain>/<workname>[/<subname>…]`, no scheme.
 *
 *  This is the form a human says, a catalogue displays, and `--stars` accepts, so it has to be
 *  parseable on its own. It runs the SAME domain and workname rules as the full URI, because a key
 *  that the two forms disagree about is a key that cannot be a storage key. */
export function parseCanonicalKey(input: string): ParseCanonicalKeyResult {
  const raw = input.trim();
  if (raw === "" || raw.includes("://")) return { ok: false, reason: "not-a-uri", detail: raw };
  if (raw.includes("?") || raw.includes("#")) return { ok: false, reason: "not-a-uri", detail: raw };
  const slash = raw.indexOf("/");
  if (slash < 0) return { ok: false, reason: "no-workname", detail: raw };
  return parseDomainAndPath(raw.slice(0, slash), raw.slice(slash));
}

/** Is this string a well-formed canonical key? */
export function isCanonicalKey(input: string): boolean {
  return parseCanonicalKey(input).ok;
}

/** Parse and normalize a star identity URI.
 *
 *  Normalization, in the order the PRD fixes:
 *    1. lowercase the scheme and the domain;
 *    2. require every path segment to match SEGMENT_RE;
 *    3. drop ONE trailing slash;
 *    4. reject a userinfo part, a port, and a fragment;
 *    5. drop the parameters from the key, keep them on the parsed value.
 *
 *  Rejection order is fixed so a caller's diagnostics stay stable across releases: structural
 *  problems (fragment, userinfo, port) are reported before vocabulary ones (scheme, domain),
 *  which are reported before the workname. `ssh://git@host:2222/x` therefore reports
 *  `has-userinfo` and not `unknown-access` — the most specific structural fault wins. */
export function parseStarUri(input: string): ParseStarUriResult {
  const raw = input.trim();
  const m = URI_RE.exec(raw);
  if (!m) return { ok: false, reason: "not-a-uri", detail: raw };

  const [, scheme, authority, rawPath = "", rawQuery = "", fragment] = m;

  if (fragment !== undefined) return { ok: false, reason: "has-fragment", detail: fragment };
  if (authority!.includes("@")) return { ok: false, reason: "has-userinfo", detail: authority! };
  if (authority!.includes(":")) return { ok: false, reason: "has-port", detail: authority! };

  const access = scheme!.toLowerCase();
  if (!(STAR_ACCESS as readonly string[]).includes(access)) {
    return { ok: false, reason: "unknown-access", detail: scheme! };
  }

  const below = parseDomainAndPath(authority!, rawPath);
  if (!below.ok) return below.reason === "no-workname" ? { ...below, detail: raw } : below;

  return {
    ok: true,
    uri: {
      access: access as StarAccess,
      constellation: below.constellation,
      path: below.path,
      params: rawQuery.replace(/^\?/, ""),
      key: below.key,
    },
  };
}

/** The canonical key of a star URI, or `null` if it does not parse. The convenience form for the
 *  overwhelmingly common caller: "give me the storage key for this ref". */
export function canonicalKey(input: string): string | null {
  const r = parseStarUri(input);
  return r.ok ? r.uri.key : null;
}

/** Do two refs name the same star? Equality is on the KEY alone, so the access slot and the
 *  parameters are invisible to it, and EITHER side may be given as a full URI or as a bare
 *  canonical key. An unparsable side is never equal to anything — a bad ref must not silently
 *  match. */
export function sameStar(a: string, b: string): boolean {
  const ka = refKey(a);
  return ka !== null && ka === refKey(b);
}

/** The canonical key of ANY accepted identity form — a full URI or a bare key — or `null`.
 *  The one function a caller wants when it holds "some ref" and needs the storage key. */
export function refKey(input: string): string | null {
  const uri = parseStarUri(input);
  if (uri.ok) return uri.uri.key;
  const bare = parseCanonicalKey(input);
  return bare.ok ? bare.key : null;
}

/** Render a star URI from its parts. Used by `twinkling star reid` (RAI-49) to write the new
 *  identity, and by anything that re-renders a star under a different access method. */
export function formatStarUri(access: StarAccess, key: string, params = ""): string {
  const q = params ? `?${params.replace(/^\?/, "")}` : "";
  return `${access}://${key}${q}`;
}
