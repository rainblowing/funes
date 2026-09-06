// Static writer designation (ADR-0005, 0.3.0 item 25): the deployment that mutates a canonical
// vault must be the one DECLARED to do so.
//
// `star.yaml`'s `meta.write_authority` and every face's `--locus` both already existed and were read
// by no code — a grep for either outside the YAML parser found nothing. They become checked inputs
// here. This elects nothing and leases nothing: it verifies a declaration, which is what catches a
// misconfiguration and an accident. It cannot catch a determined duplicate, and ADR-0005 says so —
// two machines configured with the SAME locus are indistinguishable to this check.
//
// Scope, deliberately narrow (ADR-0005): it gates CANONICAL-VAULT MUTATION, and does NOT gate a
// machine rebuilding its own local derived index. Gating every writable open would forbid a
// follower from reindexing its own disposable copy, which contradicts the load-bearing claim of
// ADR-0003 that any machine can rebuild offline.
//
// Three modes, and 0.3.0 ships `audit`: evaluate, log the decision with both values, permit.
// `enforce` is REFUSED AT CONFIGURATION TIME in this release rather than left as a flag an operator
// can flip: two of eight catalogued stars declare `write_authority` today, so enforcing would stop
// the other six, and promotion is estate work rather than a flag flip.
import { readStarIdentity } from "./factory.ts";

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

/** Configuration precedence: command-line flag over environment variable over `star.yaml`. */
export function resolveDesignationMode(flag?: string, env: NodeJS.ProcessEnv = process.env): DesignationMode {
  const raw = (flag ?? env.FUNES_WRITE_DESIGNATION ?? "audit").trim().toLowerCase();
  if (raw === "off" || raw === "audit") return raw;
  if (raw === "enforce") {
    throw new Error(
      "write-designation: `enforce` is not available in this release — 0.3.0 ships `audit` (ADR-0005). " +
      "Two of eight catalogued stars declare star.yaml meta.write_authority; enforcing now would refuse writes on the other six. " +
      "Promotion is estate work, not a flag.",
    );
  }
  throw new Error(`write-designation: unknown mode "${raw}" — expected off|audit (fail-closed)`);
}

export interface WriteDesignation {
  mode: DesignationMode;
  /** This deployment's locus: `--locus` over FACE_LOCUS. Operator-declared, never authenticated. */
  locus: string | null;
  /** The star's declared `meta.write_authority`. */
  authority: string | null;
}

/** Resolve the designation for a vault. `locus` follows the same flag-over-environment precedence
 *  the mode does; the authority can only come from the star's own manifest, which is the point —
 *  it travels with the star rather than with the machine. */
export function resolveWriteDesignation(vault: string, opts: { locus?: string; mode?: string; env?: NodeJS.ProcessEnv } = {}): WriteDesignation {
  const env = opts.env ?? process.env;
  return {
    mode: resolveDesignationMode(opts.mode, env),
    locus: normalizeDesignation(opts.locus ?? env.FACE_LOCUS),
    // A serving context with no vault has no star manifest to declare anything, so the authority is
    // undeclared rather than a crash — the audit still reports the attempt.
    authority: vault ? normalizeDesignation(readStarIdentity(vault).writeAuthority) : null,
  };
}

export type WriteVerdict = "off" | "match" | "mismatch" | "undeclared" | "unidentified";

export interface WriteDecision {
  /** In `audit` this is always true — audit evaluates and reports, it never refuses. It is a field
   *  rather than an implied `void` return so the enforce branch, when the estate is ready, changes
   *  one call site and not the shape of every caller. */
  allowed: boolean;
  verdict: WriteVerdict;
  mode: DesignationMode;
  locus: string | null;
  authority: string | null;
  /** One line naming BOTH values, so a mismatch is diagnosable without reading configuration on two
   *  machines (ADR-0005). */
  detail: string;
}

/** THE authorization function. One mandatory place, so the boundary is a place rather than a
 *  convention — every canonical-vault mutation routes through this, and a new mutation that forgets
 *  to is a missing call in one file rather than a missing rule in a review. */
export function authorizeCanonicalWrite(d: WriteDesignation, what: { op: string; vault: string; actor?: string }): WriteDecision {
  const base = { mode: d.mode, locus: d.locus, authority: d.authority, allowed: true as const };
  const who = `op=${what.op} vault=${what.vault} actor=${what.actor ?? "unknown"} locus=${d.locus ?? "(none)"} write_authority=${d.authority ?? "(undeclared)"}`;
  if (d.mode === "off") return { ...base, verdict: "off", detail: `designation off — not evaluated (${who})` };
  if (d.authority == null) return { ...base, verdict: "undeclared", detail: `star declares no write_authority (${who})` };
  if (d.locus == null) return { ...base, verdict: "unidentified", detail: `this deployment declares no locus (${who})` };
  return d.locus === d.authority
    ? { ...base, verdict: "match", detail: `designated writer (${who})` }
    : { ...base, verdict: "mismatch", detail: `NOT the designated writer (${who})` };
}

/** Report a decision. In `audit` every decision is logged — including the matches, because "no
 *  output" and "the check never ran" look identical in a log, and the check that never ran is the
 *  failure mode this item exists to end. */
export function reportWriteDecision(dec: WriteDecision): void {
  if (dec.verdict === "off") return;
  const level = dec.verdict === "match" ? "ok" : "AUDIT";
  process.stderr.write(`funes write-designation [${dec.mode}] ${level}: ${dec.detail}\n`);
}
