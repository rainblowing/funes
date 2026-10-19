// Static writer designation (ADR-0005, 0.3.0 item 25; revised by PLAN-0.4.0 item 10, RAI-130): the
// deployment that mutates a canonical vault must be the one DECLARED to do so.
//
// Two halves, one comparison. The AUTHORITY is `star.yaml`'s `meta.write_locus` — the machine the star
// declares as its canonical writer, twinkling's manifest-v3 field (star-config.ts:339-346, whose D6
// gloss PLAN-0.4.0 item 10 amends to "the canonical writer; derived indexes rebuild per locus"). It
// travels with the star. The LOCUS is this process's own machine name,
// `--locus` over FUNES_LOCUS, resolved ONCE per process by `resolveLocus` below. It is process-local
// and nothing else: never a hostname default, never `star.yaml`, never machine state.
//
// 0.3.0 read `meta.write_authority` as the authority, and that was the wrong field: in twinkling's v3
// it is a write POLICY enum (`member-local | server-write-service`), not a machine, so the check
// compared a machine name against a policy value and could only ever say `mismatch` — or `match`
// for a process that claimed `--locus member-local`. funes no longer reads `write_authority` at all.
// Nor does it read `meta.locus`: that is twinkling's deployment KIND (`local | server | edge`,
// star-config.ts:255), a different word for a different thing.
//
// This elects nothing and leases nothing: it verifies a declaration, which is what catches a
// misconfiguration and an accident. It cannot catch a determined duplicate, and ADR-0005 says so —
// two machines configured with the SAME locus are indistinguishable to this check.
//
// Scope, deliberately narrow (ADR-0005): it gates CANONICAL-VAULT MUTATION, and does NOT gate a
// machine rebuilding or publishing its own local derived index. Gating every writable open would
// forbid a follower from reindexing its own disposable copy, which contradicts the load-bearing
// claim of ADR-0003 that any machine can rebuild offline (twinkling D7: rebuild per machine).
//
// Three modes, and this release ships `audit`: evaluate, log the decision with both values, permit.
// `enforce` is REFUSED AT CONFIGURATION TIME rather than left as a flag an operator can flip: the
// promotion gate is that every catalogued star declares `write_locus`, and that is estate work
// rather than a flag flip.
import { readStarIdentity } from "./factory.ts";
import { endpointFor, readEndpoints } from "./endpoints.ts";

export type DesignationMode = "off" | "audit" | "enforce";

/** Unicode NFC, trim, lowercase — then EXACT equality. Two operator-typed strings that look the
 *  same must compare the same: `member-local` typed on one machine and `Member-Local ` pasted into
 *  another star.yaml are one declaration, and a composed-vs-decomposed accented locus name is one
 *  declaration too. Anything looser (prefix, substring, case-insensitive-ish "contains") would
 *  admit a machine that merely resembles the designated one. */
export function normalizeDesignation(v: string | null | undefined): string | null {
  if (v == null) return null;
  const n = v.normalize("NFC").trim().toLowerCase();
  return n.length ? n : null;
}

/** What a locus may not contain: `@`, `/`, `\`, whitespace, control characters. Each breaks a compound
 *  identity or a filename, which is all this refuses — there is deliberately no grammar beyond it,
 *  because an accented machine name is a first-class case of the NFC rule above (ADR-0005). */
const REFUSED_IN_LOCUS = /[@/\\\s\p{Cc}]/u;

/** Normalize one declared machine name and refuse what cannot be one — fail-closed, never a
 *  best-effort repair. `source` names where the value came from, so the refusal says what to fix. */
export function validLocus(raw: string, source: string): string {
  const n = normalizeDesignation(raw);
  if (n == null) throw new Error(`${source} is empty — name this machine, or leave it unset (fail-closed)`);
  const bad = REFUSED_IN_LOCUS.exec(n);
  if (bad) {
    throw new Error(
      `${source} ${JSON.stringify(raw)} carries ${JSON.stringify(bad[0])} — a locus is one machine name; ` +
      "@, /, \\, whitespace and control characters are refused (fail-closed)",
    );
  }
  return n;
}

/** PLAN-0.4.0 item 10: THIS process's locus — `--locus` over FUNES_LOCUS, normalized, `null` when
 *  neither is set. Resolved ONCE per process at startup (like `--ops`) and carried from that one value
 *  into the designation audit, `OperatorState.locus` (health, /api/health, doctor), recall_v2's
 *  envelope, the face's /health and the hub's groups. A set-but-empty value is refused, not unset.
 *  FACE_LOCUS, which nothing ever set, is gone without an alias. */
export function resolveLocus(o: { flag?: string; env?: NodeJS.ProcessEnv }): string | null {
  const raw = o.flag ?? (o.env ?? process.env).FUNES_LOCUS;
  return raw == null ? null : validLocus(raw, o.flag != null ? "--locus" : "FUNES_LOCUS");
}

/** Configuration precedence: command-line flag over environment variable. (`star.yaml` is no tier of
 *  it: the star declares the AUTHORITY, never this process's mode or locus.) */
export function resolveDesignationMode(flag?: string, env: NodeJS.ProcessEnv = process.env): DesignationMode {
  const raw = (flag ?? env.FUNES_WRITE_DESIGNATION ?? "audit").trim().toLowerCase();
  if (raw === "off" || raw === "audit") return raw;
  if (raw === "enforce") {
    throw new Error(
      "write-designation: `enforce` is not available in this release — funes ships `audit` (ADR-0005). " +
      "Promotion waits until every catalogued star declares star.yaml meta.write_locus; enforcing before then would refuse writes on every star that does not. " +
      "Promotion is estate work, not a flag.",
    );
  }
  throw new Error(`write-designation: unknown mode "${raw}" — expected off|audit (fail-closed)`);
}

export interface WriteDesignation {
  mode: DesignationMode;
  /** This deployment's locus: `resolveLocus` (`--locus` over FUNES_LOCUS). Operator-declared, never
   *  authenticated. */
  locus: string | null;
  /** The star's declared `meta.write_locus`, refused on read by the same rule as the locus, so the
   *  two halves can always be equal. */
  authority: string | null;
  /** PLAN-0.5.0 item 29: the star's `meta.id` when this machine's writer-endpoint file has an entry
   *  for it — this machine proposes for the star and never writes it. Also set when the file exists
   *  and cannot be read (fail closed: it may hold this star's entry). Absent at the edge. */
  proposerFor?: string | null;
  /** The endpoint URL this machine proposes to. */
  endpoint?: string;
  /** Why the endpoint file could not be read. */
  endpointError?: string;
}

/** Resolve the designation for a vault. `locus` follows the same flag-over-environment precedence
 *  the mode does; the authority can only come from the star's own manifest, which is the point —
 *  it travels with the star rather than with the machine. Both halves throw on a refused name. */
export function resolveWriteDesignation(vault: string, opts: { locus?: string; mode?: string; env?: NodeJS.ProcessEnv; endpointsPath?: string } = {}): WriteDesignation {
  // A serving context with no vault has no star manifest to declare anything, so the authority is
  // undeclared rather than a crash — the audit still reports the attempt. A folder vault is checked
  // against this machine's writer-endpoint file (item 29); no vault, no folder, nothing to check.
  const identity = vault ? readStarIdentity(vault) : null;
  return {
    ...designationFor(identity?.writeLocus ?? null, `${vault}/star.yaml`, opts),
    ...(identity ? proposerOf(identity.id, opts.endpointsPath) : {}),
  };
}

/** resolveWriteDesignation over a `meta.write_locus` already read (the dispatcher's star thunk,
 *  PLAN-0.5.0 item 12); `source` names where it was read, for the refusal. */
export function designationFor(writeLocus: unknown, source: string, opts: { locus?: string; mode?: string; env?: NodeJS.ProcessEnv } = {}): WriteDesignation {
  const env = opts.env ?? process.env;
  return {
    mode: resolveDesignationMode(opts.mode, env),
    locus: resolveLocus({ flag: opts.locus, env }),
    authority: authorityOf(writeLocus, `${source} meta.write_locus`),
  };
}

/** PLAN-0.5.0 item 29 (record 29 §5): does this machine PROPOSE for the star — has its writer-endpoint
 *  file an entry for `starId`? Re-read on every call. A file that exists and cannot be read or
 *  validated fails closed: it may hold this star's entry, and a mutation let through as
 *  `unidentified` would land in `~/taste`, where the watcher would propose it as trusted.
 *  ponytail: a served surface resolves its designation once at startup, so an endpoint entry added
 *  later takes effect at its restart; re-resolve per mutation if a long-lived writer ever needs it. */
export function proposerOf(starId: string | null, endpointsPath?: string): Pick<WriteDesignation, "proposerFor" | "endpoint" | "endpointError"> {
  try {
    const entry = starId == null ? (readEndpoints(endpointsPath), null) : endpointFor(starId, endpointsPath);
    return entry ? { proposerFor: starId, endpoint: entry.url } : { proposerFor: null };
  } catch (e) {
    return { proposerFor: starId ?? "(a star with no meta.id)", endpointError: (e as Error).message };
  }
}

function authorityOf(w: unknown, source: string): string | null {
  if (w == null) return null;
  // twinkling's v3 validator refuses these too ("meta.write_locus must name a machine",
  // star-config.ts:343); read as "undeclared" they would pass every startup and misdiagnose the star.
  if (typeof w !== "string") throw new Error(`${source} must name one machine, got ${JSON.stringify(w)} (fail-closed)`);
  return validLocus(w, source);
}

/** `proposer` (PLAN-0.5.0 item 29): this machine proposes for the star, so it never writes it. */
export type WriteVerdict = "off" | "match" | "mismatch" | "undeclared" | "unidentified" | "proposer";

export interface WriteDecision {
  /** False for `mismatch` and `proposer` (ADR-0010 §Revision); `undeclared` and `unidentified` still
   *  proceed, so the estate gate for `enforce` is unchanged. Every caller throws on false. */
  allowed: boolean;
  verdict: WriteVerdict;
  mode: DesignationMode;
  locus: string | null;
  authority: string | null;
  /** One line naming BOTH values, so a mismatch is diagnosable without reading configuration on two
   *  machines (ADR-0005). */
  detail: string;
  /** `proposer`: the endpoint this machine proposes to (absent when the endpoint file was unreadable). */
  endpoint?: string;
}

/** THE authorization function. One mandatory place, so the boundary is a place rather than a
 *  convention — every canonical-vault mutation routes through this, and a new mutation that forgets
 *  to is a missing call in one file rather than a missing rule in a review. Pure: the endpoint file
 *  was read when the designation was resolved, so the edge shares this function. */
export function authorizeCanonicalWrite(d: WriteDesignation, what: { op: string; vault: string; actor?: string }): WriteDecision {
  const base = { mode: d.mode, locus: d.locus, authority: d.authority, allowed: true };
  const who = `op=${what.op} vault=${what.vault} actor=${what.actor ?? "unknown"} locus=${d.locus ?? "(none)"} write_locus=${d.authority ?? "(undeclared)"}`;
  // PLAN-0.5.0 item 29 (record 29 §5): BEFORE the `off` branch — the rule keys on this machine being
  // a proposer for the star, not on the locus or the mode.
  if (d.proposerFor != null) {
    const why = d.endpointError
      ? `the writer-endpoint file cannot be read, so this machine may propose for ${d.proposerFor} — ${d.endpointError}`
      : `this machine proposes for ${d.proposerFor} through ${d.endpoint} — edits go through the replica watcher, never a funes mutation`;
    return { ...base, allowed: false, verdict: "proposer", ...(d.endpoint ? { endpoint: d.endpoint } : {}), detail: `${why} (${who})` };
  }
  if (d.mode === "off") return { ...base, verdict: "off", detail: `designation off — not evaluated (${who})` };
  if (d.authority == null) return { ...base, verdict: "undeclared", detail: `star declares no write_locus (${who})` };
  if (d.locus == null) return { ...base, verdict: "unidentified", detail: `this deployment declares no locus (${who})` };
  return d.locus === d.authority
    ? { ...base, verdict: "match", detail: `designated writer (${who})` }
    : { ...base, allowed: false, verdict: "mismatch", detail: `NOT the designated writer (${who})` };
}

/** ADR-0010 §Revision, ADR-0016: a mutation at a non-writer locus refuses with this code, naming the
 *  write locus and, when this machine has an endpoint entry for the star, the endpoint. */
export function notWriteLocus(op: string, writeLocus: string | null, endpoint?: string, detail?: string): Error {
  return Object.assign(
    new Error(`operation ${op}: this locus is not the write locus — the star's writer is "${writeLocus}"${endpoint ? ` (endpoint ${endpoint})` : ""}${detail ? `: ${detail}` : ""}`),
    { code: "not-write-locus", writeLocus, ...(endpoint ? { endpoint } : {}) },
  );
}

/** Throw the refusal when the decision refuses — the one line every mutation surface ends with. */
export function assertWriteAllowed(dec: WriteDecision, op: string): void {
  if (!dec.allowed) throw notWriteLocus(op, dec.authority, dec.endpoint, dec.detail);
}

/** Report a decision. In `audit` every decision is logged — including the matches, because "no
 *  output" and "the check never ran" look identical in a log, and the check that never ran is the
 *  failure mode this item exists to end. */
export function reportWriteDecision(dec: WriteDecision): void {
  if (dec.verdict === "off") return;
  const level = dec.verdict === "match" ? "ok" : "AUDIT";
  process.stderr.write(`funes write-designation [${dec.mode}] ${level}: ${dec.detail}\n`);
}
