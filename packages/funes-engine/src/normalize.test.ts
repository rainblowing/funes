// PLAN-0.5.0 item 18 (RAI-219; ADR-0012 §The decision, record 20): the OKF floor's one normalizer.
// Pure, idempotent, line-level: it prepends a frontmatter block, inserts or fills `type`, or renames a
// non-string `type` to `funes_type` — and nothing else. Every line it does not edit keeps its bytes.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePage } from "funes-core";
import { OKF_PIN, okfFloor } from "funes-core/internal";

const ok = (page: string | Uint8Array, opts: { path?: string; baseType?: string } = {}) => {
  const r = normalizePage(page, { path: "wiki/a.md", ...opts });
  if ("invalid" in r) throw new Error(`refused ${r.invalid}: ${r.reason}`);
  return r;
};

// The pages the properties run over: one per edit and per line-ending/BOM shape, plus this repo's own
// star (read only) — real frontmatter, block scalars, comments, wikilink lists.
const SYNTHETIC: Array<[string, string?]> = [
  ["---\ntype: note\n---\n# Already conformant\n"], // "none" without the private corpus
  ["# A\n\ntext\n"], [""], ["no newline at all"], ["--- \nnot a fence\n"], ["\uFEFF# A\r\ntext\r\n"],
  ["---\ntitle: T\ndescription: |\n  type: inside a block scalar\n---\nb"],
  ["---\ntitle: T\ntype:\ntags: [a]\n---\nb"], ["---\r\ntype: ''\r\n---\r\nb\r\n"],
  ["---\ntype:\n  - a\n  - b\nx: 1\n---\nb"], ["---\ntags: [#a, #b]\nrelated: [[x]], [[y]]\n---\nb"],
  ["---\ntitle: T\n---\nb", "decision"], ["body", "a: b"],
];
const REPO = join(import.meta.dir, "../../..");
const corpus = (): Array<[string, string, string?]> => [
  ...SYNTHETIC.map(([p, base], i): [string, string, string?] => [p, `synthetic/${i}.md`, base]),
  // wiki/ and docs/ are private (not projected): the public tree runs the synthetic pages only.
  ...["wiki", "docs/adr"].filter((d) => existsSync(join(REPO, d))).flatMap((d) => (readdirSync(join(REPO, d), { recursive: true }) as string[])
    .filter((f) => f.endsWith(".md")).map((f): [string, string] => [readFileSync(join(REPO, d, f), "utf8"), `${d}/${f}`])),
];

/** Each edit, stated as what it may change: lines not named here are the input's, byte for byte. */
function editedLinesOnly(input: string, out: string, edit: string): boolean {
  const bom = (s: string) => s.startsWith("\uFEFF");
  if (bom(input) !== bom(out)) return false;
  const L = input.replace(/^\uFEFF/, "").split("\n"), O = out.replace(/^\uFEFF/, "").split("\n");
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l === b[i]);
  const typeLine = (l: string) => /^type: \S/.test(l.replace(/\r$/, ""));
  switch (edit) {
    case "none": return out === input;
    case "prepend": return O.slice(0, 3).map((l) => l.replace(/\r$/, "")).join("|").startsWith("---|type: ") && same(O.slice(3), L);
    case "insert-type": return typeLine(O[1]!) && same([O[0]!, ...O.slice(2)], L);
    case "fill-type": return O.length === L.length && O.filter((l, i) => l !== L[i]).length === 1 && O.every((l, i) => l === L[i] || typeLine(l));
    case "rename-type": {
      const rest = [O[0]!, ...O.slice(2)];
      return typeLine(O[1]!) && rest.length === L.length && rest.every((l, i) => l === L[i] || l === `funes_${L[i]}`) && rest.filter((l, i) => l !== L[i]).length === 1;
    }
  }
  return false;
}

describe("the properties", () => {
  test("normalize(normalize(x)) === normalize(x), and bytes outside the edited lines are unchanged", () => {
    const pages = corpus();
    expect(pages.length).toBeGreaterThan(existsSync(join(REPO, "wiki")) ? 100 : SYNTHETIC.length - 1); // the real corpus is private
    const edits = new Set<string>();
    for (const [page, path, baseType] of pages) {
      const once = normalizePage(page, { path, baseType });
      if ("invalid" in once) continue; // a refusal has nothing to re-normalize; its cases are below
      edits.add(once.edit);
      expect(normalizePage(once.text, { path, baseType }), path).toEqual({ text: once.text, edit: "none" });
      expect(editedLinesOnly(page, once.text, once.edit), `${path} (${once.edit})`).toBe(true);
    }
    expect([...edits].sort()).toEqual(["fill-type", "insert-type", "none", "prepend", "rename-type"]); // the corpus exercised every edit
  });
});

describe("the pin", () => {
  test("one constant names the OKF text; `0.1` is normalized to it and reported as a mismatch; `false` opts out", () => {
    expect(OKF_PIN).toEqual({ version: "0.2", commit: "ad30107c" });
    expect(okfFloor("0.2")).toEqual({ pin: OKF_PIN });
    expect(okfFloor("0.1")).toEqual({ pin: OKF_PIN, mismatch: 'star.yaml memory.okf "0.1": normalized to the pinned OKF 0.2 at ad30107c' });
    expect(okfFloor(false)).toBeNull();
  });
});

describe("refused `invalid`, one case per refusal", () => {
  const refused = (page: string | Uint8Array, path = "wiki/a.md") => normalizePage(page, { path });

  test("frontmatter that does not parse: no closing fence, invalid YAML, a scalar or a list, not UTF-8", () => {
    expect(refused("---\ntitle: x\nbody")).toEqual({ invalid: "malformed", reason: "the frontmatter fence opens and never closes" });
    expect(refused("---\nfoo: bar: baz\n---\nb")).toMatchObject({ invalid: "malformed", reason: expect.stringContaining("Nested mappings") });
    expect(refused("---\njust a scalar\n---\nb")).toEqual({ invalid: "malformed", reason: "the frontmatter is not a YAML map" });
    expect(refused("---\n- a\n---\nb")).toEqual({ invalid: "malformed", reason: "the frontmatter is not a YAML map" });
    expect(refused(new Uint8Array([0x23, 0x20, 0xc3, 0x28, 0x0a]))).toEqual({ invalid: "malformed", reason: "the page is not UTF-8" });
  });

  test("a concept at a reserved filename", () => {
    expect(refused("---\ntype: project\ntitle: P\n---\n# P\n", "work/p/index.md")).toMatchObject({ invalid: "reserved-concept" });
    expect(refused("---\ntype: note\n---\n## 2026-10-13\n", "wiki/log.md")).toMatchObject({ invalid: "reserved-concept" });
  });

  test("a reserved file out of shape (§8 index.md, §9 log.md); one in shape passes untouched", () => {
    expect(refused("---\ntitle: music\nkind: index\n---\n# music\n", "music/index.md")).toMatchObject({ invalid: "reserved-shape" }); // frontmatter
    expect(refused("---\nokf_version: \"0.2\"\n---\n# Root\n", "sub/index.md")).toMatchObject({ invalid: "reserved-shape" }); // okf_version only at the bundle root
    expect(refused("just prose, no heading\n", "music/index.md")).toMatchObject({ invalid: "reserved-shape" });
    expect(refused("# Log\n## 2026-10-01\na\n## 2026-10-02\nb\n", "log.md")).toMatchObject({ invalid: "reserved-shape" }); // oldest first
    expect(refused("## [2026-10-02] ingest | x\n", "wiki/log.md")).toMatchObject({ invalid: "reserved-shape" }); // not a date heading
    expect(refused("2026-10-13T00:00:00Z remember {}\n", "log.md")).toMatchObject({ invalid: "reserved-shape" }); // an event log is no §9 log
    for (const [page, path] of [
      ["# music\n\n## Albums\n- [[a]]\n", "music/index.md"],
      ["---\nokf_version: \"0.2\"\n---\n# Root\n", "index.md"],
      ["# Log\n\n## 2026-10-02\nb\n\n## 2026-10-01\na\n", "wiki/log.md"],
    ] as const) expect(normalizePage(page, { path })).toEqual({ text: page, edit: "none" }); // checked, never normalized
  });

  test("an edit the line editor cannot make safely", () => {
    expect(refused("---\ntype: 3\nfunes_type: old\n---\nb")).toMatchObject({ invalid: "unsafe-edit", reason: expect.stringContaining("funes_type") });
    expect(refused("---\n{title: T, type: null}\n---\nb")).toMatchObject({ invalid: "unsafe-edit" }); // a flow map: no `type:` line to fill
  });
});

describe("the three edits", () => {
  test("a page with no frontmatter gets ---/type: note/--- prepended, its body untouched", () => {
    expect(ok("# A\n\ntext\n")).toEqual({ text: "---\ntype: note\n---\n# A\n\ntext\n", edit: "prepend" });
  });

  test("a frontmatter without `type` gets the line inserted first; every authored line stays as written", () => {
    const page = "---\ntitle:   Spaced  # a comment\nstatus: accepted\nsources: ['[[x]]']\n---\nbody\n";
    expect(ok(page)).toEqual({ text: "---\ntype: note\ntitle:   Spaced  # a comment\nstatus: accepted\nsources: ['[[x]]']\n---\nbody\n", edit: "insert-type" });
  });

  test("an empty, null or blank `type` is filled in place", () => {
    for (const line of ["type:", "type: ~", "type: null", 'type: ""', "type: '  '", "type:   # none yet"]) {
      expect(ok(`---\ntitle: T\n${line}\ntags: [a]\n---\nb`)).toEqual({ text: "---\ntitle: T\ntype: note\ntags: [a]\n---\nb", edit: "fill-type" });
    }
  });

  test("a non-string `type` is renamed to `funes_type`, its value lines kept, and `type: note` inserted", () => {
    expect(ok("---\ntitle: T\ntype: 3\n---\nb")).toEqual({ text: "---\ntype: note\ntitle: T\nfunes_type: 3\n---\nb", edit: "rename-type" });
    expect(ok("---\ntype:\n  - a\n  - b\nx: 1\n---\nb").text).toBe("---\ntype: note\nfunes_type:\n  - a\n  - b\nx: 1\n---\nb");
    expect(ok("---\ntype: {k: v}\n---\nb").text).toBe("---\ntype: note\nfunes_type: {k: v}\n---\nb");
    expect(ok("---\ntype: true\n---\nb").text).toBe("---\ntype: note\nfunes_type: true\n---\nb");
  });

  test("on a put_page replace the base's `type` wins over `note`, quoted when YAML would read it otherwise", () => {
    expect(ok("body", { baseType: "decision" }).text).toBe("---\ntype: decision\n---\nbody");
    expect(ok("---\ntitle: T\n---\nb", { baseType: "taste-item" }).text).toBe("---\ntype: taste-item\ntitle: T\n---\nb");
    expect(ok("---\ntype:\n---\nb", { baseType: "a: b" }).text).toBe('---\ntype: "a: b"\n---\nb');
    expect(ok("---\ntype:\n---\nb", { baseType: "" }).text).toBe("---\ntype: note\n---\nb"); // an empty base type is no type
  });

  test("a conformant page is returned as it came, byte for byte", () => {
    const page = "---\ntype: memory\ntitle: x\n---\n\nbody\n";
    expect(ok(page)).toEqual({ text: page, edit: "none" });
    expect(ok(page, { baseType: "decision" })).toEqual({ text: page, edit: "none" }); // the payload's own type stands
  });

  test("CRLF line endings and a BOM are kept; the inserted lines take the file's own line ending", () => {
    expect(ok("\uFEFF# A\r\ntext\r\n").text).toBe("\uFEFF---\r\ntype: note\r\n---\r\n# A\r\ntext\r\n");
    expect(ok("\uFEFF---\r\ntitle: T\r\n---\r\nb\r\n").text).toBe("\uFEFF---\r\ntype: note\r\ntitle: T\r\n---\r\nb\r\n");
    expect(ok("---\r\ntype:\r\n---\r\nb").text).toBe("---\r\ntype: note\r\n---\r\nb");
  });

  test("UTF-8 bytes normalize as their text, the BOM included", () => {
    expect(ok(new TextEncoder().encode("\uFEFF# Ж\n")).text).toBe("\uFEFF---\ntype: note\n---\n# Ж\n");
  });
});
