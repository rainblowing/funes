// B5 (RAI-338; RAI-305, RAI-310; ADR-0021): `funes serve`, the one HTTP host. A `node:http` server that
// adapts each request to a web Request and runs `mcpHandler(folderMcpHost(…))` on POST /mcp: Host
// 421, browser origin 403, Bearer 401, star 403, method 405, byte cap 413, parse 400, then dispatch.
// Every check that can refuse at startup does, before a socket opens (folder-mcp-host.ts): an IP
// literal bind, no wildcard, the tier from `memory.tier`, and off loopback the four checks.
//   funes serve --vault <star> --bind <ip> [--port 8787] [--host <name:port>] [--access <v2 file>]
//               [--ops a,b] [--published] [--stats]
// Each request's `loopback` comes from its peer address, never from the bind (RAI-308).
// B10a (RAI-347, ADR-0019): with `memory.tier: org` it serves the star's rows (`openOrgStar`) and
// runs the star's builds itself, since no other process opens an org database.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { join, resolve } from "node:path";
import type { Embedder } from "funes-core";
import type { FunesIndexStore } from "funes-core";
import { DEFAULT_SERVE_PORT, openStore, readStarIdentity, starMemory } from "./factory.ts";
import { mcpHandler } from "funes-core/mcp-http";
import { folderMcpHost, isLoopbackAddress } from "./folder-mcp-host.ts";
import { openPublished, type StoreLease } from "./published-store.ts";
import { openOrgStar, type OrgStar } from "./org-store.ts";
import type { Values } from "./cli-parse.ts";

export interface ServeOpts {
  vault: string;
  /** The explicit IP literal to listen on. */
  bind: string;
  /** 0 = a port the kernel picks (tests). */
  port: number;
  /** The exact Host clients present; default `<bind>:<port>`. Required off loopback. */
  host?: string;
  /** A version-2 access file, re-read per request. */
  access?: string;
  /** `--ops`: read-only op names that narrow the ceiling. */
  ops?: string[];
  /** Serve `<home>/published.db` read-only, reopened when a publish swaps it. */
  published?: boolean;
  /** R8 recall telemetry (`--stats`). Off by default; a published index records none. */
  stats?: boolean;
  /** Tests: the store to serve instead of the one serve opens. */
  store?: FunesIndexStore | StoreLease | OrgStar;
  /** Tests: a fake embedder for the store serve opens. */
  embedder?: Embedder;
}

export interface RunningServe {
  port: number;
  url: string;
  close(): Promise<void>;
}

const hostOf = (bind: string, port: number) => `${bind.includes(":") ? `[${bind}]` : bind}:${port}`;

/** web Request from a node request; its body is read by the handler, under its cap. */
function toRequest(req: IncomingMessage, base: string): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : (Readable.toWeb(req) as ReadableStream<Uint8Array>);
  return new Request(new URL(req.url ?? "/", base).href, { method: req.method, headers, body, duplex: "half" } as RequestInit);
}

async function send(res: ServerResponse, r: Response): Promise<void> {
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(r.status, headers);
  res.end(Buffer.from(await r.arrayBuffer()));
}

export async function startServe(o: ServeOpts): Promise<RunningServe> {
  const vault = resolve(o.vault);
  const build = (store: FunesIndexStore | StoreLease | OrgStar) =>
    folderMcpHost({ vault, store, bind: o.bind, host: o.host, ops: o.ops, access: o.access });
  // The checks run once before any store opens (a refusal leaves nothing to close), and once more on the real store.
  build(o.store ?? { use: () => Promise.reject(new Error("not open")), close: async () => {} });
  const memory = starMemory(readStarIdentity(vault), join(vault, "star.yaml"));
  if (o.published && memory.substrate === "turso") {
    throw new Error("funes serve: --published refused — a Turso star is never published; serve its live index (fail-closed)");
  }
  // openStore, not makeStore: serve is a Turso star's one owner (ADR-0021); an org star's, its rows' (ADR-0019).
  const store = o.store ?? (memory.tier === "org"
    ? await openOrgStar({ vault, embedder: o.embedder })
    : o.published
      ? await openPublished(vault, { embedder: o.embedder })
      : await openStore({ vault, embedder: o.embedder, trackRecalls: o.stats })); // writeActor unset: a multi-actor server stamps unknown
  const host = build(store);
  const handle = mcpHandler(host);
  const bind = o.bind.trim().toLowerCase();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://serve.local");
      if (url.pathname !== "/mcp") {
        res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
        return void res.end(`${JSON.stringify({ error: "not-found", message: "this server serves POST /mcp only" })}\n`);
      }
      await send(res, await handle(toRequest(req, "http://serve.local"), { loopback: isLoopbackAddress(req.socket.remoteAddress ?? "") }));
    } catch (e) {
      process.stderr.write(`funes serve: request failed: ${(e as Error).message}\n`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(`${JSON.stringify({ error: "internal", message: "internal error" })}\n`);
      else res.end();
    }
  });
  try {
    await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(o.port, bind, () => ok()); });
  } catch (e) {
    if (!o.store) await store.close();
    throw e;
  }
  const port = (server.address() as { port: number }).port;
  if (!o.host) host.host = hostOf(bind, port);
  process.stderr.write(
    `funes serve: ${vault} on ${hostOf(bind, port)} [tier: ${host.tier}] [host: ${host.host}]` +
    `${o.published ? " [published, read-only]" : ""}${o.access ? " [access file: per-request grants]" : " [no access file: tokenless reads only]"}` +
    `${o.ops ? ` [ops: ${o.ops.join(",")}]` : ""}${o.stats ? " [recall telemetry]" : ""}\n`,
  );
  return {
    port,
    url: `http://${hostOf(bind, port)}`,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      if (!o.store) await store.close();
    },
  };
}

/** `funes serve …`, its flags as the CLI parsed them: exit 2 on a usage error or a startup refusal;
 *  else serve until a signal. A retired flag never reaches here: the CLI parser refuses it. */
export async function runServe(v: Values): Promise<void> {
  const fail = (msg: string): never => { process.stderr.write(`funes serve: ${msg}\n`); process.exit(2); };
  const str = (k: string) => v[k] as string | undefined;
  const port = Number(str("port") ?? DEFAULT_SERVE_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`--port must be a port number, got ${JSON.stringify(str("port"))}`);
  let running: RunningServe;
  try {
    running = await startServe({
      vault: str("vault") ?? process.cwd(),
      bind: str("bind") ?? "",
      port,
      host: str("host"),
      access: str("access"),
      ops: str("ops")?.split(",").map((s) => s.trim()).filter(Boolean),
      published: v.published === true,
      stats: v.stats === true,
    });
  } catch (e) {
    return fail((e as Error).message.replace(/^funes serve: /, ""));
  }
  const stop = async () => { await running.close().catch(() => {}); process.exit(0); };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}
