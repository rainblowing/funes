// S2 daemon probe/client — PGLite is single-connection, so every consumer first asks
// "is the daemon already serving this vault?" and routes through it if so.
export const DEFAULT_DAEMON_PORT = 7777;

export interface DaemonClient {
  port: number;
  vault: string;
  call(op: string, args: Record<string, unknown>): Promise<unknown>;
}

/** P1.5: read the funes capability token (the same one the daemon is started with via --capability,
 *  or one an --actor-map names). Injected on EVERY proxied call as x-funes-capability, from this ONE
 *  chokepoint for every proxy consumer (mcp.ts, the surface proxy, the CLI). A --capability daemon
 *  checks it on mutations only; an --actor-map daemon (RAI-159) checks it on EVERY op, so a token its
 *  v2 file does not name — the ~/.twinkling/funes-cap fallback included — is a 401 even on a read.
 *  Path = FUNES_CAPABILITY_FILE, else ~/.twinkling/funes-cap (a stdio session with FUNES_ACTOR_MAP
 *  set refuses to start without the explicit variable, so it never reaches the fallback). Read once
 *  at probe; absent ⇒ no header (a gated daemon then 401s, the signal that launcher and client
 *  disagree on the path).
 *  Dynamic node:fs import keeps this bundle-safe where daemon-client is pulled into the Astro build. */
async function readCapabilityToken(): Promise<string | null> {
  try {
    const path = process.env.FUNES_CAPABILITY_FILE ?? `${process.env.HOME ?? ""}/.twinkling/funes-cap`;
    const { readFileSync } = await import("node:fs");
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null; // no token file ⇒ no header (fine for an un-gated daemon; a gated one signals via 401)
  }
}

/** Probe 127.0.0.1:<port>/api/health. Returns a client ONLY if the daemon is up AND serves the
 *  same vault; null otherwise (callers then open the store directly).
 *
 *  Timeout = 1500ms (was 250ms): a FALSE negative is the dangerous failure here — if a present-but-
 *  slow daemon (cold start, GC pause, busy recall) is declared absent, the caller opens a SECOND
 *  PGLite connection to the same pgdata and corrupts it (PGLite is single-connection). Nothing
 *  listening still fails fast (connection refused, no wait), so the only cost of the larger budget
 *  is bounding a hung listener — cheap insurance for the single-owner invariant. */
export async function daemonProbe(port: number, vault: string): Promise<DaemonClient | null> {
  // A DEFINITIVE answer (HTTP error, or a different vault) returns immediately — no retry. Only a
  // TRANSIENT failure (timeout / connection hiccup, e.g. cold start or a GC pause) retries once,
  // because treating a transient as "no daemon" would open a second PGLite connection and corrupt
  // the pgdata. Nothing listening = connection refused = instant, so the retry costs ~nothing there.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (!r.ok) return null;
      const h = (await r.json()) as { vault?: string };
      if (h.vault !== vault) return null;
      const capability = await readCapabilityToken(); // sent on every call (P1.5, RAI-159); null ⇒ omit
      return {
        port,
        vault,
        async call(op, args) {
          const res = await fetch(`http://127.0.0.1:${port}/api/${op}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(capability ? { "x-funes-capability": capability } : {}),
            },
            body: JSON.stringify(args),
          });
          const body = (await res.json()) as { ok: boolean; result?: unknown; error?: string; code?: string };
          // RAI-159: a grant refusal's code survives the hop, so a proxy host answers it 403 and its
          // inbox does not read it as an empty zone.
          if (!res.ok || !body.ok) throw Object.assign(new Error(body.error ?? `daemon ${op} failed (${res.status})`), body.code ? { code: body.code } : {});
          return body.result;
        },
      };
    } catch {
      if (attempt === 1) return null; // exhausted the retry
    }
  }
  return null;
}
