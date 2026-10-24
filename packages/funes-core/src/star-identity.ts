// A star's self-declared identity, from its star.yaml text (RAI-313: the kernel's half of factory.ts;
// the folder read `readStarIdentity` stays in the engine).
import { parse as parseYaml } from "yaml";
import { canonicalKey } from "./star-uri.ts";

/** A star's self-declared identity (twinkling star.yaml meta block). funes reads it so an index
 *  knows WHICH STAR it belongs to — identity is the stable sync URI (twinkl.ing ADR-0002 §3.1), not the machine
 *  path. Absent star.yaml / meta.id -> null id (lone/grandfathered star; the guard falls back to
 *  the vault path, today's behaviour). */
export interface StarIdentity {
  id: string | null;
  name: string | null;
  constellation: string | null;
  /** manifest-v3 (PRD 2026-08-27 D1): the CANONICAL KEY of `id` — `<domain>/<workname>`, or null
   *  when the id predates the grammar. Identity comparisons use this when both sides have one, so
   *  a star that changes transport keeps its index instead of tripping the collision guard. */
  key: string | null;
  /** `meta.id_was` — the id this star had before `twinkling star reid` re-identified it. The owner
   *  stamp's compare-and-set (RAI-157) accepts it, so a re-identified star keeps its live index. */
  idWas: string | null;
  /** manifest-v3 (D9): the declared capabilities, with the defaults that describe the estate as it
   *  already is. A v2 star.yaml — which is every star today — yields exactly the defaults. */
  capabilities: StarCapabilities;
  /** RAI-45 (PLAN-0.4.0 item 16): `memory.okf` as WRITTEN, JSON-encoded, when it is present and is
   *  none of "0.1" | "0.2" | false. `capabilities.okf` then holds the default, which is right for a
   *  capability READ and wrong for a command that ACTS on it (the retired `export --okf` refused rather
   *  than publish under a version the star never declared; PLAN-0.5.0 item 22) — YAML reads an unquoted `okf: 0.1` as a
   *  number and `okf: no` as the string "no", and neither is an opt-out. Null when absent or valid. */
  okfInvalid: string | null;
  /** ADR-0005 (PLAN-0.4.0 item 10): `meta.write_locus`, the machine DECLARED to mutate this star's
   *  canonical vault — raw, as written, and UNTYPED on purpose: write-designation.ts normalizes and
   *  refuses it, a non-string included (`[host-a, host-b]` is an attempt at two writers, not "no
   *  writer"), so this must not filter it to null the way the identity fields are. Null when
   *  undeclared. `meta.write_authority` is deliberately not read: in twinkling's manifest v3 it is a
   *  write POLICY (`member-local | server-write-service`), never a machine name. */
  writeLocus: unknown;
  /** B5 (ADR-0019, ADR-0021): `memory.tier` and `memory.substrate`, raw, as written. `starMemory`
   *  validates them; a malformed value refuses at open, never here. */
  tier: unknown;
  substrate: unknown;
  /** `memory.memory_dir`, when it is a vault path (no empty, dot or `..` segment): the zone the
   *  mutation ops write. Declared, it wins on every tier; absent, a folder probes its layout. */
  memoryDir: string | null;
}
/** The three declared capabilities. See funes-core's star-uri.ts for the identity half of v3. */
export interface StarCapabilities { okf: "0.1" | "0.2" | false; graph: boolean; code: boolean }
export const DEFAULT_STAR_CAPABILITIES: StarCapabilities = { okf: "0.2", graph: true, code: false };

function readCapabilities(memory: Record<string, unknown>): StarCapabilities {
  const okf = memory.okf === false || memory.okf === "0.1" || memory.okf === "0.2"
    ? (memory.okf as StarCapabilities["okf"])
    : DEFAULT_STAR_CAPABILITIES.okf;
  return {
    okf,
    graph: typeof memory.graph === "boolean" ? memory.graph : DEFAULT_STAR_CAPABILITIES.graph,
    code: typeof memory.code === "boolean" ? memory.code : DEFAULT_STAR_CAPABILITIES.code,
  };
}

const vaultDir = (v: unknown): string | null =>
  typeof v === "string" && v !== "" && v.split("/").every((seg) => seg !== "" && !seg.startsWith(".")) ? v : null;

export const noIdentity = (): StarIdentity => ({ id: null, name: null, constellation: null, key: null, idWas: null, capabilities: { ...DEFAULT_STAR_CAPABILITIES }, okfInvalid: null, writeLocus: null, tier: null, substrate: null, memoryDir: null });

/** A star's identity from its star.yaml text (the engine's readStarIdentity reads a folder's; the edge
 *  DO passes its bundled copy, ADR-0011 "Star configuration"). */
export function starIdentityFromText(text: string): StarIdentity {
  const none = noIdentity();
  try {
    const data = parseYaml(text) as { meta?: Record<string, unknown>; memory?: Record<string, unknown> } | null;
    const meta = data?.meta ?? {};
    const s = (v: unknown) => (typeof v === "string" ? v : null);
    const id = s(meta.id);
    const memory = data?.memory ?? {};
    const capabilities = readCapabilities(memory);
    return {
      id,
      name: s(meta.name),
      constellation: s(meta.constellation),
      key: id ? canonicalKey(id) : null,
      idWas: s(meta.id_was),
      capabilities,
      // readCapabilities takes `okf` verbatim only when it is valid, so present-but-not-taken is junk.
      // `!= null`, as twinkling's validator reads it: `okf: ~` is the default, not junk.
      okfInvalid: memory.okf != null && memory.okf !== capabilities.okf ? JSON.stringify(memory.okf) : null,
      writeLocus: meta.write_locus ?? null,
      tier: memory.tier ?? null,
      substrate: memory.substrate ?? null,
      memoryDir: vaultDir(memory.memory_dir),
    };
  } catch {
    // malformed -> path fallback, never a crash; but the writer and the tier are unknowable, never
    // "none declared": a write refuses and an open refuses (RAI-302, ADR-0019)
    return { ...none, writeLocus: UNPARSED, tier: UNPARSED, substrate: UNPARSED };
  }
}

/** The `writeLocus`, `tier` and `substrate` of a star.yaml that does not parse (or cannot be read). */
export const UNPARSED: unique symbol = Symbol("star.yaml does not parse");

/** RAI-316 (ADR-0024): `memory.item_pages` (a boolean, else null) and `edge.mint.telegram_ids` (ids
 *  as decimal strings; absent is [], anything but a list of positive whole ids is null). */
export function edgeKeysFromText(text: string): { itemPages: boolean | null; mintIds: string[] | null } {
  let data: { memory?: { item_pages?: unknown }; edge?: { mint?: { telegram_ids?: unknown } } } | null;
  try {
    data = parseYaml(text) as typeof data;
  } catch {
    data = null; // malformed: nothing here is declared
  }
  const ids = data?.edge?.mint?.telegram_ids;
  const id = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? String(v) : typeof v === "string" && /^[1-9]\d*$/.test(v) ? v : null);
  return {
    itemPages: typeof data?.memory?.item_pages === "boolean" ? data.memory.item_pages : null,
    mintIds: ids == null ? [] : Array.isArray(ids) && ids.every((v) => id(v) != null) ? ids.map((v) => id(v)!) : null,
  };
}
