// B5 (RAI-338; RAI-305 Q2/Q11/Q13, RAI-310 D5, RAI-315 Q8; ADR-0021): the MCP host over a folder
// star. `funes serve` mounts `mcpHandler(folderMcpHost(…))`, and so may a host that embeds the handler
// on loopback (the twinkl.ing surface). The loopback rule lives here once:
//   - the bind is an IP literal, never a wildcard;
//   - the tier comes from the star's `memory.tier` (absent = home; anything else refuses), and a
//     tier other than home needs the star's write_locus to be this process's locus;
//   - off loopback it refuses to build unless all four hold: an access file, an exact host, the
//     star's write_locus equal to this process's locus, and (home tier) a Tailscale bind.
// Each request re-reads the access file, so a revocation needs no restart. With no access file a
// loopback host serves tokenless reads only (RAI-310 D5). `ops` (`--ops`) and a read-only store narrow
// the ops through `ctx.narrow` and the grant (C14).
import { BlockList, isIP } from "node:net";
import { join } from "node:path";
import type { FunesIndexStore } from "funes-core";
import type { McpHost } from "funes-core/mcp-http";
import type { Refusal } from "funes-core";
import { authorize } from "funes-core";
import { readAccessPolicy } from "./actor.ts";
import { type AccessPolicy } from "funes-core";
import { readStarIdentity, starMemory } from "./factory.ts";
import { FunesStore } from "funes-core/internal";
import { folderVaultContext, folderFunesStore } from "./funes-store.ts";
import { dispatchToolCall, type OperationContext } from "funes-core";
import { operations } from "funes-core/internal";
import { resolveExposedOps } from "./mcp-config.ts";
import { processLocus } from "./process-locus.ts";
import { resolveWriteDesignation } from "./process-locus.ts";
import type { StoreLease } from "./published-store.ts";
import type { OrgStar } from "./org-store.ts";

const WILDCARDS = new Set(["0.0.0.0", "::", "*", "0:0:0:0:0:0:0:0"]);

/** Loopback classification of an address: the whole 127.0.0.0/8 block, and ::1 in its spellings. */
export function isLoopbackAddress(addr: string): boolean {
  const a = addr.trim().toLowerCase();
  return a.startsWith("127.") || a === "::1" || a === "0:0:0:0:0:0:0:1" || a.startsWith("::ffff:127.");
}

/** Tailscale's address space. 100.64.0.0/10 is also RFC 6598 carrier-grade NAT space, so behind CGNAT
 *  this cannot tell a tailnet address from the ISP's: a known limit; the operator names the exact bind. */
const TAILSCALE = new BlockList();
TAILSCALE.addSubnet("100.64.0.0", 10, "ipv4");
TAILSCALE.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");
export const isTailscaleAddress = (addr: string): boolean => isIP(addr) !== 0 && TAILSCALE.check(addr, isIP(addr) === 6 ? "ipv6" : "ipv4");

export interface FolderMcpHostOpts {
  /** The star's folder. */
  vault: string;
  /** The live index, a lease (published mode: read-only, reopened on a swap), or an org star's ports
   *  (its RowVault and its staging index, `openOrgStar`). */
  store: FunesIndexStore | StoreLease | OrgStar;
  /** The address the host listens on. It decides the startup checks only; each request's peer decides `loopback`. */
  bind: string;
  /** The exact Host clients present. Required off loopback; a host may fill it once it knows its port. */
  host?: string;
  /** `--ops`: read-only op names that narrow the ceiling (fail-closed). */
  ops?: string[];
  /** `--access`: a version-2 access file, re-read per request. */
  access?: string;
}

/** Throws, naming the repair, when this host may not serve the star at `bind`. */
export function folderMcpHost(o: FolderMcpHostOpts): McpHost {
  const refuse = (why: string) => new Error(`funes serve: ${why} (fail-closed)`);
  const bind = o.bind.trim().toLowerCase();
  if (!bind) throw refuse("an explicit --bind address is required");
  if (WILDCARDS.has(bind)) throw refuse(`refusing to bind ${bind}: a wildcard names no interface. Bind the exact address clients reach`);
  if (isIP(bind) === 0) throw refuse(`--bind "${o.bind}" is not an IP literal: a server binds an address, never a name`);
  // ADR-0021: this host serves a Turso star too, as its one owner; `makeStore` refuses one elsewhere.
  const identity = readStarIdentity(o.vault);
  const { tier } = starMemory(identity, join(o.vault, "star.yaml"));
  // ADR-0019: an org star's pages are rows in its database, never a folder.
  if (tier === "org" && "lockResource" in o.store) throw refuse(`${join(o.vault, "star.yaml")} declares memory.tier: org — serve its rows (openOrgStar), never a folder index`);
  const designation = resolveWriteDesignation(o.vault, { locus: processLocus() ?? undefined });
  const writer = (why: string) => {
    const { authority, locus } = designation;
    if (authority == null) throw refuse(`${join(o.vault, "star.yaml")} declares no write_locus — ${why}. Declare \`write_locus: <machine>\` and serve on that machine`);
    if (locus !== authority) {
      throw refuse(`${locus == null ? "this process has no locus" : `this locus "${locus}" is not the star's write_locus "${authority}"`} — ${why}. Serve on that machine, with its name in FUNES_LOCUS`);
    }
  };
  if (tier !== "home") writer(`a ${tier}-tier server is the star's one writer`);
  const loopback = isLoopbackAddress(bind);
  if (!loopback) {
    if (!o.access) throw refuse(`--bind ${bind} is off loopback, and no access file is loaded: name one with --access`);
    if (!o.host) throw refuse("--host is required off loopback: name the exact <name>:<port> clients present");
    writer("a remote server serves only on the star's declared writer");
    if (tier === "home" && !isTailscaleAddress(bind)) {
      throw refuse(`--bind ${bind} is not a Tailscale address (100.64.0.0/10 or fd7a:115c:a1e0::/48): a home-tier server never listens on a LAN interface`);
    }
  }
  if (o.access) readAccessPolicy(o.access); // a file that does not validate refuses startup
  const org = "funes" in o.store ? o.store : null;
  const lease = "use" in o.store ? o.store : null;
  const narrowed = o.ops ? new Set(resolveExposedOps(operations, { ops: o.ops }).map((op) => op.name)) : null;
  const narrow = lease ? new Set(operations.filter((op) => op.readonly && (!narrowed || narrowed.has(op.name))).map((op) => op.name)) : narrowed ?? undefined;
  const starId = identity.id;
  const fixed = lease || org ? null : { store: o.store as FunesIndexStore, funes: folderFunesStore(o.store as FunesIndexStore, { root: o.vault }) };
  const use = <T>(fn: (s: { store: FunesIndexStore; funes: FunesStore }) => Promise<T>): Promise<T> =>
    fixed ? fn(fixed) : lease!.use((store) => fn({ store, funes: folderFunesStore(store, { root: o.vault }) }));
  return {
    tier,
    host: o.host ?? "",
    async grant(token, peer): Promise<Awaited<ReturnType<McpHost["grant"]>>> {
      let policy: AccessPolicy | null = null;
      if (o.access) {
        try {
          policy = readAccessPolicy(o.access);
        } catch (e) {
          process.stderr.write(`funes serve: ${(e as Error).message}\n`); // the reader's messages carry no token
          return { status: 401, error: "unauthorized", message: "the access file does not validate, so every request is refused: send Authorization: Bearer <token> once it is repaired" } satisfies Refusal;
        }
      }
      return authorize(token, policy, { tier, star: starId, loopback: peer.loopback, crossStar: false, narrow });
    },
    async call(name, args, auth, peer) {
      // RAI-310 D5: every HTTP mutation needs a grant on every bind, so a tokenless write is 401.
      if (auth.token === null && operations.some((op) => op.name === name && !op.readonly)) {
        throw Object.assign(new Error(`operation ${name}: a write needs a grant — send Authorization: Bearer <token>`), { status: 401, code: "unauthorized" });
      }
      if (org) {
        // RAI-308 as amended (RAI-322): the tier keys first, so a contract key always wins
        const tierKeys = name === "health" ? org.tierFields() : null;
        const body = await dispatchToolCall(name, args, {
          vault: org.vault, star: org.star, store: org.store, funes: org.funes,
          tier, loopback: peer.loopback, designation, grant: auth.grant, ...(narrow ? { narrow } : {}),
        } satisfies OperationContext);
        return tierKeys ? { ...tierKeys, ...(body as object) } : body;
      }
      return use(({ store, funes }) => dispatchToolCall(name, args, {
        ...folderVaultContext(o.vault, store), store, funes,
        tier, loopback: peer.loopback, designation, grant: auth.grant, ...(narrow ? { narrow } : {}),
      } satisfies OperationContext));
    },
    onerror: (e) => process.stderr.write(`funes serve: mcp: ${e.message}\n`),
  };
}
