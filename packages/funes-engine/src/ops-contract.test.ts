import { test, expect } from "bun:test";
import { ceiling, dispatchToolCall, type OperationContext } from "funes-core";
import { contractEntry, operations, buildToolDefs } from "funes-core/internal";
import frozen from "./__fixtures__/ops-contract.json" with { type: "json" };

// P3.15 golden. `ops-contract.json` was frozen from the registry BEFORE zod landed — its git
// history predates the schemas on purpose, so this compares zod's opinion to the hand-written
// contract rather than to itself. `inputSchema` is what `buildToolDefs` ships verbatim to every
// MCP client and what `GET /api/ops` returns; nothing in either repo type-checks it, so a silent
// change here is invisible until a model starts calling tools wrong.
//
// Regenerating this fixture IS a contract change. Do it in its own commit whose diff is the
// release note — never in the same commit as the schema edit that caused it.

test("the registry matches the frozen contract, op by op: flags, tiers, inputSchema and result (all 12)", () => {
  expect(JSON.parse(JSON.stringify(operations.map(contractEntry)))).toEqual(frozen.operations);
});

test("the frozen ceilings are ceiling()'s answers (ADR-0020)", () => {
  const names = (ops: { name: string }[]) => ops.map((o) => o.name);
  expect(frozen.ceilings).toEqual({
    home: names(ceiling("home")),
    "home off loopback": names(ceiling("home", { loopback: false })),
    "cross-star": names(ceiling("home", { crossStar: true })),
    org: names(ceiling("org")),
    edge: names(ceiling("edge")),
  });
});

// ── the total-schema contract: garbage clamps or defaults, it never 400s ────────────────────
// Every case below returns a result TODAY. If any starts throwing, an MCP client that works
// right now has been broken. See the `count()` helper's comment for why `.max()` is banned.

// parse fails before `run` is reached in every case here; the star thunk answers "no manifest"
const ctx = { tier: "home", designation: { locus: null, authority: null }, star: () => ({ identity: { id: null, writeLocus: null }, scope: { kind: "absent" } }) } as unknown as OperationContext;

/** The argument gate's output: the op's own schema, the one `dispatchToolCall` parses with. */
async function argsOf(name: string, args: Record<string, unknown>): Promise<unknown> {
  return operations.find((o) => o.name === name)!.args.parse(args);
}

test("count args clamp and default instead of rejecting (k, n)", async () => {
  expect(await argsOf("recall", { query: "x" })).toEqual({ query: "x", k: 5 });
  expect(await argsOf("recall", { query: "x", k: 100 })).toEqual({ query: "x", k: 50 });
  expect(await argsOf("recall", { query: "x", k: 0 })).toEqual({ query: "x", k: 5 });
  expect(await argsOf("recall", { query: "x", k: -3 })).toEqual({ query: "x", k: 5 });
  expect(await argsOf("recall", { query: "x", k: NaN })).toEqual({ query: "x", k: 5 });
  expect(await argsOf("recall", { query: "x", k: Infinity })).toEqual({ query: "x", k: 5 });
  expect(await argsOf("neighbors", { id: "a", k: 999 })).toEqual({ id: "a", k: 25 });
  expect(await argsOf("hotlist", { n: 999 })).toEqual({ n: 100 });
  expect(await argsOf("hotlist", {})).toEqual({ n: 20 });
});

test("count args coerce strings — the GET surface hands over strings, not numbers", async () => {
  // funes-api no longer hardcodes Number() for `k`/`n`; the schema owns coercion now.
  expect(await argsOf("recall", { query: "x", k: "7" })).toEqual({ query: "x", k: 7 });
  expect(await argsOf("recall", { query: "x", k: "abc" })).toEqual({ query: "x", k: 5 });
  expect(await argsOf("recall", { query: "x", k: "" })).toEqual({ query: "x", k: 5 });
  expect(await argsOf("hotlist", { n: "50" })).toEqual({ n: 50 });
});

test("unknown keys are stripped, not rejected", async () => {
  // The constellation view sends `?star=<name>` to graph; the daemon has always ignored it.
  expect(await argsOf("graph", { star: "personal" })).toEqual({});
  expect(await argsOf("recall", { query: "x", rerank: true, trust: "trusted" })).toEqual({ query: "x", k: 5 });
});

// `as_of` is the ONE deliberate exception to "garbage clamps, never 400s", and it is an exception
// because there is no honest clamp. `count` has one: a model asking for 500 hits obviously wants
// as many as it can get, so 50 serves the intent. An unparseable `as_of` has no such reading —
// dropping it silently writes the memory as never-expiring, which is the exact staleness failure
// the field was added to prevent, and the model gets no signal that its freshness marker vanished.
// One correctable error beats a silent lie in canonical frontmatter. Do not "restore" totality here.
test("as_of rejects unparseable dates instead of silently dropping them", async () => {
  expect(await argsOf("remember", { title: "t", body: "b", as_of: "2026-07-19" })).toMatchObject({ as_of: "2026-07-19" });
  expect(await argsOf("remember", { title: "t", body: "b", as_of: "" })).toMatchObject({ as_of: undefined });
  await expect(dispatchToolCall("remember", { title: "t", body: "b", as_of: "banana" }, ctx))
    .rejects.toThrow(/as_of must be an ISO-8601 date/);
});

// `where` (recall, ADR-0013) is the SECOND deliberate exception, for the same reason: a filter
// has no honest clamp, and one dropped or loosened in silence answers a narrower question with the
// whole star — the caller reads unfiltered hits as matches. A malformed condition refuses at the
// argument gate; a well-formed one reaches the planner intact. (The declaration checks — undeclared
// key, value outside `values` — run in the planner, against star.yaml: recall-planner.test.ts covers them.)
test("where rejects a malformed condition instead of stripping it", async () => {
  const where = { domain: "film", taste: true, rating: { exists: true }, status: { ne: "done" } };
  expect(await argsOf("recall", { query: "x", where })).toEqual({ query: "x", k: 5, where });
  await expect(dispatchToolCall("recall", { query: "x", where: { rating: { gt: 3 } } }, ctx))
    .rejects.toThrow(/^operation recall: where\.rating: /);
});

test('empty-string optionals mean "absent", as they did pre-zod', async () => {
  expect(await argsOf("remember", { title: "t", body: "b", type: "" })).toMatchObject({ type: undefined });
  expect(await argsOf("remember", { title: "t", body: "b", type: "note" })).toMatchObject({ type: "note" });
  expect(await argsOf("tree", {})).toEqual({ dir: "" });
  expect(await argsOf("forget", { id: "a" })).toEqual({ id: "a" });
});

// ── the error surface ──────────────────────────────────────────────────────────────────────

test("missing required keeps its own wording (not zod's type-error phrasing)", async () => {
  expect(dispatchToolCall("recall", {}, ctx)).rejects.toThrow(/missing required argument "query"/);
});

test("schema failures render as ONE line — MCP clients print this verbatim", async () => {
  let msg = "";
  try { await dispatchToolCall("recall", { query: 5 }, ctx); } catch (e) { msg = (e as Error).message; }
  expect(msg).not.toContain("\n");
  expect(msg).toMatch(/^operation recall: query: /);
});

test("indexed_page's id-OR-path rule is truthiness, and invisible in the advertised schema", async () => {
  expect(dispatchToolCall("indexed_page", {}, ctx)).rejects.toThrow(/provide an `id` or a `path`/);
  expect(dispatchToolCall("indexed_page", { id: "" }, ctx)).rejects.toThrow(/provide an `id` or a `path`/);
  const schema = operations.find((o) => o.name === "indexed_page")!.inputSchema;
  expect(Object.keys(schema.properties).sort()).toEqual(["id", "path"]);
  expect(schema.required).toBeUndefined();
});

test("buildToolDefs advertises every op a host lists: 12 in the registry, 11 at home (ADR-0020)", () => {
  expect(buildToolDefs(operations)).toHaveLength(12);
  expect(buildToolDefs(ceiling("home"))).toHaveLength(11);
});
