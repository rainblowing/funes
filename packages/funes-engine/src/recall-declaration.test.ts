// RAI-206 (PLAN-0.5.0 item 9; ADR-0013; records 28, 31, 33): the pure `memory.recall` declaration
// validator, exported from `funes-engine/light` because twinkl.ing's star.yaml validator calls it.
// One case per refusal of record 33; each refuses the WHOLE declaration.
import { describe, expect, test } from "bun:test";
import { validateRecallDeclaration } from "funes-core";
import type { RecallDeclaration } from "funes-core/internal";

// The taste star's block: record 28's keys/values/predicates, record 31's serve and collapse.
const TASTE: RecallDeclaration = {
  keys: ["domain", "type", "creator", "taste_status", "suggested", "my_score", "year"],
  values: { domain: ["books", "movies", "games", "music", "youtube"], taste_status: ["done", "todo"] },
  predicates: {
    taste: [{ suggested: { ne: true }, domain: { exists: true } }, { my_score: { exists: true } }],
    suggestion: [{ suggested: true, my_score: { exists: false } }],
  },
  serve: ["domain", "taste_status", "suggested", "my_score", "plays"],
  collapse: ["type", "creator"],
};

const refusal = (decl: unknown): string[] => {
  const r = validateRecallDeclaration(decl);
  if (r.ok) throw new Error("expected a refusal, got an accepted declaration");
  return r.errors;
};

describe("validateRecallDeclaration", () => {
  test("accepts the taste declaration and returns it normalized", () => {
    const r = validateRecallDeclaration(TASTE);
    expect(r).toEqual({ ok: true, declaration: TASTE });
  });

  test("absent parts default to empty", () => {
    expect(validateRecallDeclaration({ keys: ["domain"] })).toEqual({
      ok: true, declaration: { keys: ["domain"], values: {}, predicates: {}, serve: [], collapse: [] },
    });
  });

  test("refuses a writer-owned key (ADR-0010)", () => {
    for (const k of ["trust", "superseded_by", "supersedes", "forgotten", "created", "id", "generated"]) {
      expect(refusal({ keys: ["domain", k] }).join("\n")).toContain(`"${k}" is writer-owned`);
    }
    expect(refusal({ keys: ["domain"], serve: ["trust"] }).join("\n")).toContain('"trust" is writer-owned');
  });

  test("refuses a prototype-polluting name wherever a name stands", () => {
    for (const bad of ["__proto__", "constructor", "prototype"]) {
      expect(refusal({ keys: [bad] }).join("\n")).toContain(`"${bad}"`);
      // JSON.parse, as a YAML loader does, makes `__proto__` an OWN key rather than the prototype.
      const asPredicate = JSON.parse(`{"keys":["domain"],"predicates":{"${bad}":[{"domain":{"exists":true}}]}}`);
      expect(refusal(asPredicate).join("\n")).toContain(`"${bad}"`);
      const inClause = JSON.parse(`{"keys":["domain"],"predicates":{"p":[{"${bad}":true}]}}`);
      expect(refusal(inClause).join("\n")).toContain(`"${bad}"`);
      expect(refusal({ keys: ["domain"], collapse: [bad] }).join("\n")).toContain(`"${bad}"`);
    }
  });

  test("refuses a predicate over an undeclared key", () => {
    const errors = refusal({ keys: ["domain"], predicates: { taste: [{ my_score: { exists: true } }] } });
    expect(errors.join("\n")).toContain('memory.recall.predicates.taste[0]: "my_score" is not a declared key');
  });

  test("refuses a name collision: a predicate named like a key, or a name declared twice", () => {
    expect(refusal({ keys: ["domain", "taste"], predicates: { taste: [{ domain: { exists: true } }] } }).join("\n"))
      .toContain('memory.recall.predicates: "taste" collides with a declared key');
    expect(refusal({ keys: ["domain", "domain"] }).join("\n")).toContain('"domain" is declared twice');
  });

  test("refuses values for an undeclared key, a non-scalar value, and a malformed condition", () => {
    expect(refusal({ keys: ["domain"], values: { year: [2020] } }).join("\n")).toContain('"year" is not a declared key');
    expect(refusal({ keys: ["domain"], values: { domain: [{ a: 1 }] } }).join("\n")).toContain("scalar");
    expect(refusal({ keys: ["domain"], predicates: { p: [{ domain: { exists: "yes" } }] } }).join("\n")).toContain("condition");
    expect(refusal({ keys: ["domain"], predicates: { p: [{ domain: null }] } }).join("\n")).toContain("condition");
    expect(refusal({ keys: ["domain"], predicates: { p: [] } }).join("\n")).toContain("non-empty list");
  });

  test("refuses an unknown part rather than ignoring it", () => {
    expect(refusal({ keys: ["domain"], predicate: {} }).join("\n")).toContain('"predicate"');
    expect(refusal(["domain"]).join("\n")).toContain("mapping");
  });
});
