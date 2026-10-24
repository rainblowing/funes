// RAI-317 Q10: the one argv parser. These probes also run under Node in CI (the engines floor, 22.14):
// node:util.parseArgs is the parser, so its behaviour on that floor is what this file checks.
import { test, expect } from "bun:test";
import { parse, type Command } from "./cli-parse.ts";

const TABLE: Command[] = [
  { verb: "remember", flags: { title: { type: "string" }, body: { type: "string" }, tags: { type: "string" }, json: { type: "boolean" } } },
  { verb: "recall", positionals: 1, flags: { k: { type: "string" }, json: { type: "boolean" } } },
  { verb: "forget", positionals: 1, flags: {} },
  { verb: "token mint", flags: { actor: { type: "string" }, star: { type: "string", multiple: true } } },
  { verb: "token", flags: {} },
];
const run = (argv: string[]) => {
  const p = parse(argv, TABLE);
  if (p.kind !== "run") throw new Error(JSON.stringify(p));
  return p;
};
const error = (argv: string[]) => {
  const p = parse(argv, TABLE);
  if (p.kind !== "error") throw new Error(`expected an error, got ${JSON.stringify(p)}`);
  return p.message;
};

test("a value that starts with a dash parses: --title -draft, --body '- [ ] buy milk', --k -1", () => {
  const r = run(["remember", "--title", "-draft", "--body", "- [ ] buy milk"]);
  expect(r.values).toEqual({ title: "-draft", body: "- [ ] buy milk" });
  expect(run(["recall", "q", "--k", "-1"]).values.k).toBe("-1");
});

test("a positional that starts with a dash comes after --; a retired name after -- is a value", () => {
  expect(run(["recall", "--", "-neg q"]).positionals).toEqual(["-neg q"]);
  expect(run(["recall", "--", "--live"]).positionals).toEqual(["--live"]);
});

test("a retired flag refuses and names its replacement; an unknown flag refuses as unknown", () => {
  expect(error(["recall", "q", "--live"])).toContain("--published");
  expect(error(["forget", "x", "--hard"])).toContain("funes purge");
  expect(error(["remember", "--title", "t", "--actor", "me"])).toContain("removed in funes 0.6.0");
  expect(error(["recall", "q", "--bogus"])).toBe("recall: unknown flag --bogus");
});

test("a verb that declares a retired name keeps it: token mint --actor", () => {
  expect(run(["token", "mint", "--actor", "me", "--star", "a", "--star", "b"]).values).toEqual({ actor: "me", star: ["a", "b"] });
});

test("an unknown command, a stray positional and a flag with no value are usage errors", () => {
  expect(error(["query", "q"])).toBe('unknown command "query"');
  expect(error(["forget", "a", "b"])).toContain('unexpected argument "b"');
  expect(error(["remember", "--title"])).toContain("--title");
});

test("--help anywhere before -- asks for help, for that command", () => {
  expect(parse([], TABLE)).toEqual({ kind: "help", code: 2 });
  expect(parse(["--help"], TABLE)).toEqual({ kind: "help", code: 0 });
  expect(parse(["recall", "q", "-h"], TABLE)).toEqual({ kind: "help", code: 0, cmd: TABLE[1] });
  expect(parse(["recall", "--", "--help"], TABLE).kind).toBe("run");
  // a declared value option's value is a value, never a help flag
  expect(parse(["remember", "--title", "t", "--body", "-h"], TABLE)).toMatchObject({ kind: "run", values: { title: "t", body: "-h" } });
  expect(parse(["remember", "--title", "--help"], TABLE)).toMatchObject({ kind: "run", values: { title: "--help" } });
  expect(parse(["remember", "--json", "-h"], TABLE)).toEqual({ kind: "help", code: 0, cmd: TABLE[0] });
});
