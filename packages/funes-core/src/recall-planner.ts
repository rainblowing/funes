// The recall planner, kernel side (PLAN-0.5.0 item 23, ADR-0013). the kernel reads the star's
// `memory.recall` declaration (through the dispatcher's star-config thunk — at a folder, star.yaml's
// stat memo) and compiles a `recall` `where` against it into a funes-core RecallFilter. No store
// reads star.yaml and funes names no key: every filterable key, value list and predicate is the
// star's. A filter is never dropped silently — every case it cannot honour refuses, naming why.
import { parse as parseYaml } from "yaml";
import type { RecallFilter } from "./filter.ts";
import { validateRecallDeclaration, type Condition, type RecallDeclaration } from "./recall-declaration.ts";

/** star.yaml's `memory.recall`, read. `absent`: no star.yaml or no block — recall serves as it always
 *  has, and a `where` refuses. `invalid`: refused whole (the validator's errors), so it refuses
 *  every recall at the star rather than serve without its declared fields and collapse keys. */
export type RecallDeclarationRead =
  | { kind: "absent" }
  | { kind: "valid"; declaration: RecallDeclaration }
  | { kind: "invalid"; reason: string };

/** readRecallDeclaration over star.yaml's text. */
export function recallDeclarationFromText(text: string): RecallDeclarationRead {
  let data: unknown;
  try { data = parseYaml(text); } catch (e) {
    return { kind: "invalid", reason: `star.yaml is not valid YAML: ${(e as Error).message.split("\n")[0]}` };
  }
  const recall = (data as { memory?: { recall?: unknown } } | null)?.memory?.recall;
  if (recall == null) return { kind: "absent" };
  const r = validateRecallDeclaration(recall);
  return r.ok ? { kind: "valid", declaration: r.declaration } : { kind: "invalid", reason: r.errors.join("; ") };
}

/** The declaration a recall serves under, or null when the star declares none. Invalid refuses. */
export function servedDeclaration(read: RecallDeclarationRead | undefined): RecallDeclaration | null {
  if (read?.kind === "invalid") throw new Error(`recall refused — star.yaml memory.recall is invalid (${read.reason})`);
  return read?.kind === "valid" ? read.declaration : null;
}

export type Where = Record<string, Condition>;

/** Compile a `where` against the live declaration: the filter the store applies, and the canonical
 *  echo for `plan.where` (keys sorted, conditions as given, a predicate by its name). */
export function planWhere(query: string, where: Where, read: RecallDeclarationRead | undefined): { filter: RecallFilter; where: Where } {
  if (!query.trim()) throw new Error("recall: `where` refused on a blank query — listing is not recall");
  const decl = servedDeclaration(read);
  if (!decl) throw new Error("recall: `where` refused — star.yaml declares no memory.recall, so no key may be filtered");
  const keys = new Set(decl.keys);
  const all: RecallFilter["all"] = [];
  const names = Object.keys(where).sort();
  for (const k of names) {
    const cond = where[k]!;
    if (Object.hasOwn(decl.predicates, k)) {
      if (typeof cond !== "boolean") throw new Error(`recall: predicate "${k}" takes true or false`);
      all.push({ any: decl.predicates[k]!, not: !cond });
      continue;
    }
    if (!keys.has(k)) throw new Error(`recall: "${k}" is neither a key nor a predicate star.yaml memory.recall declares`);
    const enumerated = Object.hasOwn(decl.values, k) ? decl.values[k]! : null;
    const value = typeof cond !== "object" ? cond : Object.hasOwn(cond, "ne") ? (cond as { ne: Condition }).ne : undefined;
    if (enumerated && value !== undefined && !enumerated.includes(value as string)) {
      throw new Error(`recall: ${JSON.stringify(value)} is not one of the values star.yaml declares for "${k}" (${enumerated.map((v) => JSON.stringify(v)).join(", ")})`);
    }
    all.push({ any: [{ [k]: cond }] });
  }
  return { filter: { all }, where: Object.fromEntries(names.map((k) => [k, where[k]!])) };
}
