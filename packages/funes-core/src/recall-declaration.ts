// The `star.yaml` `memory.recall` declaration validator (RAI-206, PLAN-0.5.0 item 9; ADR-0013,
// records 28, 31, 33). PURE: no I/O and no imports, so twinkl.ing's star.yaml validator runs exactly
// the check funes-engine runs, and item 23's compiler compiles only what this accepts. One error
// refuses the WHOLE declaration: a half-applied filter declaration is a lie about what `where` means.

export type Scalar = string | number | boolean;
/** Strict equality (no coercion), presence, or inequality (ADR-0013). */
export type Condition = Scalar | { exists: boolean } | { ne: Scalar };
/** One predicate: an OR of ANDs over declared keys. */
export type Predicate = Array<Record<string, Condition>>;

export interface RecallDeclaration {
  /** Scalar frontmatter keys a `where` may filter on. */
  keys: string[];
  /** An optional enum per declared key. */
  values: Record<string, Scalar[]>;
  /** Named predicates; a `where` passes `true`/`false` for one. */
  predicates: Record<string, Predicate>;
  /** Keys returned in the additive `fields` object (record 31). */
  serve: string[];
  /** Keys that join the collapse identity (record 31). */
  collapse: string[];
}

export type RecallDeclarationResult = { ok: true; declaration: RecallDeclaration } | { ok: false; errors: string[] };

/** Keys only the writer sets (ADR-0010, record 28): a declaration may neither filter on, serve nor
 *  collapse on them. */
const WRITER_OWNED = new Set(["trust", "superseded_by", "supersedes", "forgotten", "created", "id", "generated"]);
const POLLUTING = new Set(["__proto__", "constructor", "prototype"]);
const PARTS = new Set(["keys", "values", "predicates", "serve", "collapse"]);
const P = "memory.recall";

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isScalar = (v: unknown): v is Scalar =>
  typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
const isCondition = (v: unknown): v is Condition => {
  if (isScalar(v)) return true;
  if (!isMap(v)) return false;
  const ks = Object.keys(v);
  if (ks.length !== 1) return false;
  return (ks[0] === "exists" && typeof v.exists === "boolean") || (ks[0] === "ne" && isScalar(v.ne));
};

/** Validate the value of `memory.recall`. Every problem is reported, each naming its path. */
export function validateRecallDeclaration(recall: unknown): RecallDeclarationResult {
  const errors: string[] = [];
  if (!isMap(recall)) return { ok: false, errors: [`${P} must be a mapping ({keys, values, predicates, serve, collapse})`] };
  for (const part of Object.keys(recall)) {
    if (!PARTS.has(part)) errors.push(`${P}: unknown part "${part}" (allowed: ${[...PARTS].join(", ")})`);
  }

  /** A name that may stand anywhere: non-empty, not prototype-polluting. */
  const badName = (where: string, name: string): boolean => {
    if (name === "") { errors.push(`${where}: a name must be non-empty`); return true; }
    if (POLLUTING.has(name)) { errors.push(`${where}: "${name}" is a prototype name and may not be declared`); return true; }
    return false;
  };
  const nameList = (part: "keys" | "serve" | "collapse"): string[] => {
    const v = recall[part];
    if (v == null) return [];
    if (!Array.isArray(v)) { errors.push(`${P}.${part} must be a list of key names`); return []; }
    const seen = new Set<string>();
    v.forEach((name, i) => {
      const where = `${P}.${part}[${i}]`;
      if (typeof name !== "string") { errors.push(`${where} must be a string`); return; }
      if (badName(where, name)) return;
      if (WRITER_OWNED.has(name)) errors.push(`${where}: "${name}" is writer-owned (ADR-0010) and may not be declared`);
      if (seen.has(name)) errors.push(`${where}: "${name}" is declared twice`);
      seen.add(name);
    });
    return v as string[];
  };

  const keys = nameList("keys");
  const serve = nameList("serve");
  const collapse = nameList("collapse");
  const declared = new Set(keys);

  const values = recall.values ?? {};
  if (!isMap(values)) errors.push(`${P}.values must be a mapping of key → list of scalars`);
  else for (const [k, list] of Object.entries(values)) {
    const where = `${P}.values.${k}`;
    if (badName(`${P}.values`, k)) continue;
    if (!declared.has(k)) errors.push(`${where}: "${k}" is not a declared key`);
    if (!Array.isArray(list) || list.length === 0 || !list.every(isScalar)) {
      errors.push(`${where} must be a non-empty list of scalars (string, number, boolean)`);
    }
  }

  const predicates = recall.predicates ?? {};
  if (!isMap(predicates)) errors.push(`${P}.predicates must be a mapping of name → list of clauses`);
  else for (const [name, branches] of Object.entries(predicates)) {
    const where = `${P}.predicates.${name}`;
    if (badName(`${P}.predicates`, name)) continue;
    if (declared.has(name)) errors.push(`${P}.predicates: "${name}" collides with a declared key`);
    if (!Array.isArray(branches) || branches.length === 0) { errors.push(`${where} must be a non-empty list of clauses`); continue; }
    branches.forEach((clause, i) => {
      const at = `${where}[${i}]`;
      if (!isMap(clause) || Object.keys(clause).length === 0) { errors.push(`${at} must be a non-empty mapping of key → condition`); return; }
      for (const [k, cond] of Object.entries(clause)) {
        if (badName(at, k)) continue;
        if (!declared.has(k)) errors.push(`${at}: "${k}" is not a declared key`);
        if (!isCondition(cond)) errors.push(`${at}.${k}: a condition is a scalar, {exists: boolean} or {ne: scalar}`);
      }
    });
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    declaration: {
      keys, serve, collapse,
      values: values as RecallDeclaration["values"],
      predicates: predicates as RecallDeclaration["predicates"],
    },
  };
}
