// The per-machine writer-endpoint file (PLAN-0.5.0 item 30, ADR-0016): `endpoints.json` in the funes
// home, 0600, mapping a star's `meta.id` to the writer URL this machine proposes to, its token file
// and the replica's `pull` entry. Read by the outbox, the seed and the replica. Not an input to the
// write rule since RAI-324: the taste star's `write_locus` refuses a replica machine there.
import { existsSync } from "node:fs";
import { canonicalKey } from "funes-core";
import { sameStar } from "funes-core/internal";
import { endpointsFilePath } from "../../funes-engine/src/funes-home.ts";
import { readOwnerOnly } from "../../funes-engine/src/actor.ts";

export interface EndpointEntry {
  url: string;
  tokenFile: string;
  /** record 29: the replica's S3 pull, read by `funes replica` (item 32). */
  pull?: { endpoint: string; bucket: string; credentialsFile: string };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Read `endpoints.json` NOW: owner-only on the descriptor it is read from, every entry valid, or the
 *  whole file refuses — a half-loaded file is a file that silently drops a star's endpoint. A bearer
 *  goes over https only (plain http to loopback only, for a local workerd). Absent = no entries. */
export function readEndpoints(path: string = endpointsFilePath()): Map<string, EndpointEntry> {
  const out = new Map<string, EndpointEntry>();
  if (!existsSync(path)) return out;
  const bad = (why: string) => new Error(`endpoints ${path}: ${why} — refusing (fail-closed)`);
  let parsed: unknown;
  try { parsed = JSON.parse(readOwnerOnly(path, "endpoints")); } catch (e) {
    throw (e as Error).message.startsWith("endpoints ") ? e : bad("malformed JSON");
  }
  if (!isObj(parsed)) throw bad("expected a JSON object of {\"<meta.id>\": {url, token_file, pull?}}");
  for (const [id, e] of Object.entries(parsed)) {
    if (canonicalKey(id) === null) throw bad(`${JSON.stringify(id)} is not a star id`);
    if (!isObj(e) || typeof e.url !== "string" || typeof e.token_file !== "string") throw bad(`${id}: needs url and token_file strings`);
    let u: URL;
    try { u = new URL(e.url); } catch { throw bad(`${id}: url does not parse`); }
    if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) throw bad(`${id}: ${u.origin} — a bearer goes over https only (plain http to loopback only)`);
    const entry: EndpointEntry = { url: e.url, tokenFile: e.token_file };
    if (e.pull !== undefined) {
      const p = e.pull;
      if (!isObj(p) || typeof p.endpoint !== "string" || typeof p.bucket !== "string" || typeof p.credentials_file !== "string") {
        throw bad(`${id}: pull needs endpoint, bucket and credentials_file strings`);
      }
      entry.pull = { endpoint: p.endpoint, bucket: p.bucket, credentialsFile: p.credentials_file };
    }
    out.set(id, entry);
  }
  return out;
}

/** This machine's endpoint entry for a star, compared by canonical key; null when it has none. */
export function endpointFor(starId: string, path?: string): EndpointEntry | null {
  for (const [id, e] of readEndpoints(path)) if (sameStar(id, starId)) return e;
  return null;
}
