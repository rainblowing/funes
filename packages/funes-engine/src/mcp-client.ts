// RAI-317 Q3: the HTTP MCP client of the CLI's remote mode (`--url`) and of `eval --url` — the same call
// a local op verb makes, sent to `funes serve` or the edge Worker. Rules:
//   - a bearer crosses a network over https only; plain http goes to loopback only (ADR-0014 A4);
//   - the default token (FUNES_CAPABILITY_FILE, else <funes home>/funes-cap) applies to a LOOPBACK url
//     only: off loopback the operator names the file, because the default is the surface's bearer and
//     the https rule protects the transport, not the destination;
//   - a tool error `{status, code?, error}` (RAI-310 D4) is rethrown with its `code`, so a remote
//     refusal exits as a local one does.
import { existsSync, readFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { isB64Token } from "funes-core/internal";
import { capabilityFilePath } from "./funes-home.ts";
import { FUNES_VERSION } from "funes-core/internal";

const LOOPBACK = new Set(["127.0.0.1", "[::1]"]);
const usage = (message: string) => Object.assign(new Error(message), { code: "invalid" });

/** The url, refused when it names `localhost`: `funes serve` and the surface answer their exact Host,
 *  `127.0.0.1:<port>`, so a localhost url only ever gets 421. */
function serveUrl(url: string): URL {
  const u = new URL(url);
  if (u.hostname === "localhost") throw usage(`--url ${u.origin}: name the loopback address, as in ${new URL(u.pathname, `${u.protocol}//127.0.0.1${u.port ? `:${u.port}` : ""}`).href} — funes serve answers its exact Host only`);
  return u;
}

export interface McpClient {
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** The bearer for `url`: the named file, else on loopback the default file when it exists (absent:
 *  tokenless, which a loopback `funes serve` with no access file answers for reads). */
export function remoteToken(url: string, tokenFile: string | undefined): string | null {
  const u = serveUrl(url);
  let file = tokenFile;
  if (file === undefined) {
    if (!LOOPBACK.has(u.hostname)) throw usage(`--url ${u.origin} is not loopback: name its token with --token-file`);
    file = capabilityFilePath();
    if (process.env.FUNES_CAPABILITY_FILE === undefined && !existsSync(file)) return null;
  }
  let token: string;
  try { token = readFileSync(file, "utf8").trim(); } catch (e) { throw usage(`cannot read the token file ${file}: ${(e as NodeJS.ErrnoException).code ?? "error"}`); }
  if (!isB64Token(token)) throw usage(`the token file ${file} holds no bearer token`);
  return token;
}

export async function connectMcp(url: string, token: string | null): Promise<McpClient> {
  const u = serveUrl(url);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) {
    throw usage(`--url ${u.origin}: a bearer is sent over https only (plain http to loopback only)`);
  }
  if (token !== null && !isB64Token(token)) throw usage("the token file holds no bearer token");
  const client = new Client({ name: "funes-cli", version: FUNES_VERSION });
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  await client.connect(new StreamableHTTPClientTransport(u, { requestInit: { headers } }));
  return {
    async call(name, args) {
      const r = await client.callTool({ name, arguments: args });
      const text = ((r.content ?? []) as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
      if (r.isError) {
        let shape: { code?: unknown; error?: unknown } = {};
        try { shape = JSON.parse(text) as typeof shape; } catch { /* not the edge shape: the text is the message */ }
        const message = typeof shape.error === "string" ? shape.error : text;
        throw Object.assign(new Error(message), typeof shape.code === "string" ? { code: shape.code } : {});
      }
      return JSON.parse(text) as unknown;
    },
    close: () => client.close(),
  };
}
