// The hub's stdio MCP surface (RAI-39, PLAN-0.2.1 Ticket A step 15/16).
//
// A SEPARATE server from mcp-server.ts, not a mode inside it. The single-star server is built
// around one vault, one store, an optional daemon proxy and a mutation surface; the hub has none of
// those. Branching one file over both would put a `if (hub)` in front of every one of those
// concerns and leave a reader unsure which invariants still hold. Four tools, no writes, no vault.
//
// Wired by `twinkling star catalogue --hub <star> --write`, whose derived `.mcp.hub.json` names
// exactly: `bun <funes>/…/mcp.ts mcp --stars-file ~/.twinkling/stars.json`.
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Hub } from "./hub.ts";
import type { OpInputSchema } from "./ops.ts";
import { FUNES_VERSION } from "./version.ts";

interface HubToolDef { name: string; description: string; inputSchema: OpInputSchema }

/** Hand-written rather than derived from a zod registry, because these four are not the ops — they
 *  are the hub's own arguments over the ops. `star` is required where an answer names ONE star and
 *  absent where the hub fans out; nothing here takes a trust argument, and nothing writes. */
const HUB_TOOLS: HubToolDef[] = [
  {
    name: "stars",
    description: "List the stars this hub serves (id, name, constellation, notes). Reads the catalogue only — it opens no index, so it is the cheap call to make first.",
    inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" }, description: "optional: restrict to these star ids or canonical keys" } } },
  },
  {
    name: "recall",
    description: "Recall across every served star at once. Results come back GROUPED BY STAR, each group ranked within its own index — scores are not comparable across stars, so the hub does not pretend they are. A star that fails or stalls returns an error entry; the others still answer.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "free-text question" },
        perStar: { type: "number", description: "max hits per star (default 5, max 50)" },
        total: { type: "number", description: "max hits overall (default 25, max 200)" },
        stars: { type: "array", items: { type: "string" }, description: "optional: only these star ids or canonical keys" },
      },
      required: ["query"],
    },
  },
  {
    name: "indexed_page",
    description: "Read one page's INDEXED snapshot from ONE named star. Serves the database, never a filesystem — an index_scope-excluded page is not found even when the file exists.",
    inputSchema: {
      type: "object",
      properties: {
        star: { type: "string", description: "the star's id, canonical key, or name" },
        id: { type: "string", description: "node id" },
        path: { type: "string", description: "vault-relative path" },
      },
      required: ["star"],
    },
  },
  {
    name: "health",
    description: "Per-star index health: node/edge counts, embedding signature, the served generation, and whether each star's vault has changed since its last reindex.",
    inputSchema: { type: "object", properties: { stars: { type: "array", items: { type: "string" }, description: "optional: only these star ids or canonical keys" } } },
  },
];

const asStrings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

const asNumber = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;   // the hub clamps; garbage falls back to the default
};

/** Run the hub MCP server to completion. `argv` is the args AFTER the command name. */
export async function runHubMcp(argv: string[]): Promise<void> {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const starsFile = flag("--stars-file")!;
  const stars = argv.includes("--stars") ? (flag("--stars") ?? "").split(",").map((s) => s.trim()).filter(Boolean) : undefined;

  // Fail closed BEFORE a byte is served: a broken catalogue, a mixed-constellation catalogue with
  // no explicit allowlist, or an unreadable file must never reach the wire.
  let hub: Hub;
  try {
    hub = await Hub.open(starsFile, { stars });
  } catch (e) {
    process.stderr.write(`funes mcp: ${(e as Error).message}\n`);
    process.exit(2);
  }

  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (name) {
      case "stars":
        return hub.stars({ ids: asStrings(args.ids) });
      case "recall": {
        const query = args.query;
        if (typeof query !== "string" || query === "") throw new Error('operation recall: missing required argument "query"');
        return hub.recall({ query, perStar: asNumber(args.perStar), total: asNumber(args.total), stars: asStrings(args.stars) });
      }
      case "indexed_page": {
        const star = args.star;
        if (typeof star !== "string" || star === "") throw new Error('operation indexed_page: missing required argument "star"');
        if (!args.id && !args.path) throw new Error("operation indexed_page: provide an `id` or a `path`");
        return hub.indexedPage({ star, id: typeof args.id === "string" ? args.id : undefined, path: typeof args.path === "string" ? args.path : undefined });
      }
      case "health":
        return hub.health({ stars: asStrings(args.stars) });
      default:
        throw new Error(`unknown operation: ${name} — the hub serves ${HUB_TOOLS.map((t) => t.name).join(", ")} and nothing else`);
    }
  };

  const buildServer = (): Server => {
    const server = new Server({ name: "funes-hub", version: FUNES_VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", async () => ({ tools: HUB_TOOLS }));
    server.setRequestHandler("tools/call", async (req) => {
      const { name, arguments: args = {} } = req.params;
      try {
        return { content: [{ type: "text", text: JSON.stringify(await call(name, args as Record<string, unknown>), null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `error: ${(e as Error).message}` }], isError: true };
      }
    });
    return server;
  };

  serveStdio(buildServer);
  const served = hub.stars().stars.map((s) => s.name).join(",");
  process.stderr.write(`funes mcp: HUB over ${starsFile} [stars: ${served || "none"}]\n`);
}
