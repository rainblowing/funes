// Static writer designation (ADR-0005, 0.3.0 item 25; revised by PLAN-0.4.0 item 10, RAI-130): the
// deployment that mutates a canonical vault must be the one DECLARED to do so.
//
// Two halves, one comparison. The AUTHORITY is `star.yaml`'s `meta.write_locus` — the machine the star
// declares as its canonical writer, twinkling's manifest-v3 field (star-config.ts:339-346, whose D6
// gloss PLAN-0.4.0 item 10 amends to "the canonical writer; derived indexes rebuild per locus"). It
// travels with the star. The LOCUS is this process's own machine name,
// `--locus` over FUNES_LOCUS over the normalized short hostname (RAI-324), resolved ONCE per process
// by the host's entry (funes-engine process-locus.ts) and passed in. This module is the kernel's
// (RAI-313), so it reads no environment and no hostname; the edge passes FUNES_LOCUS with no
// fallback. Never `star.yaml`, never machine state.
//
// 0.3.0 read `meta.write_authority` as the authority, and that was the wrong field: in twinkling's v3
// it is a write POLICY enum (`member-local | server-write-service`), not a machine, so the check
// compared a machine name against a policy value and could only ever refuse — or admit a process
// that claimed `--locus member-local`. funes no longer reads `write_authority` at all.
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
// RAI-302: ONE rule decides every write — `writeAllowed` below — and a decision is allowed or
// refused: no mode, no verdict, no audit line for an allowed write (RAI-326). `endpoints.json` is no
// input: the taste star's `write_locus: funes-taste` refuses a replica machine through the rule.
import { UNPARSED } from "./star-identity.ts";

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

/** THE write rule (RAI-302): a mutation proceeds when the star declares no `write_locus`, or when
 *  this process's locus equals it. Both halves are already normalized. A process with no locus
 *  refuses on a star that declares a writer. */
export function writeAllowed(writeLocus: string | null, locus: string | null): boolean {
  return writeLocus == null || locus === writeLocus;
}

export interface WriteDesignation {
  /** This deployment's locus: `resolveLocus`. Operator-declared, never authenticated. */
  locus: string | null;
  /** The star's declared `meta.write_locus`, refused on read by the same rule as the locus, so the
   *  two halves can always be equal. */
  authority: string | null;
}

/** The designation over a `meta.write_locus` already read (the dispatcher's star thunk, PLAN-0.5.0
 *  item 12) and a locus the host already resolved at its entry (RAI-313: the kernel reads no
 *  environment and no hostname). `source` names where the write locus was read, for the refusal. */
export function designationFor(writeLocus: unknown, source: string, locus: string | null): WriteDesignation {
  return { locus, authority: authorityOf(writeLocus, `${source} meta.write_locus`) };
}

function authorityOf(w: unknown, source: string): string | null {
  if (w == null) return null;
  // no locus can equal this (validLocus refuses whitespace): every write refuses, reads and startup go on
  if (w === UNPARSED) return "(star.yaml does not parse)";
  // twinkling's v3 validator refuses these too ("meta.write_locus must name a machine",
  // star-config.ts:343); read as declaring no writer they would pass every startup and misdiagnose the star.
  if (typeof w !== "string") throw new Error(`${source} must name one machine, got ${JSON.stringify(w)} (fail-closed)`);
  return validLocus(w, source);
}

/** ADR-0010 §Revision, ADR-0016: a mutation the write rule refuses throws this — code
 *  `not-write-locus`, `writeLocus` naming the writer. No `endpoint`: the rule reads no endpoint file. */
export function notWriteLocus(op: string, writeLocus: string | null, detail?: string): Error {
  return Object.assign(
    new Error(`not-write-locus: operation ${op}: this locus is not the write locus — the star's writer is "${writeLocus}"${detail ? `: ${detail}` : ""}`),
    { code: "not-write-locus", writeLocus },
  );
}

/** THE authorization function (ADR-0005, RAI-302): one mandatory place, so the boundary is a place
 *  rather than a convention — every canonical-vault mutation ends with this call. Pure, so the edge
 *  shares it. Allowed is silent; refused throws, naming both values so a refusal is diagnosable
 *  without reading configuration on two machines. */
export function assertWriteAllowed(d: WriteDesignation, op: string): void {
  if (writeAllowed(d.authority, d.locus)) return;
  throw notWriteLocus(op, d.authority, `locus=${d.locus ?? "(none) — set FUNES_LOCUS"} write_locus=${d.authority}`);
}
