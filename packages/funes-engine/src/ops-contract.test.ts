import { test, expect } from "bun:test";
import { operations, buildToolDefs, dispatchToolCall, opCapabilities, type OperationContext } from "./ops.ts";
import frozen from "./__fixtures__/ops-contract.json" with { type: "json" };

// P3.15 golden. `ops-contract.json` was frozen from the registry BEFORE zod landed — its git
// history predates the schemas on purpose, so this compares zod's opinion to the hand-written
// contract rather than to itself. `inputSchema` is what `buildToolDefs` ships verbatim to every
// MCP client and what `GET /api/ops` returns; nothing in either repo type-checks it, so a silent
// change here is invisible until a model starts calling tools wrong.
//
// Regenerating this fixture IS a contract change. Do it in its own commit whose diff is the
// release note — never in the same commit as the schema edit that caused it.

test("advertised inputSchema matches the frozen contract, op by op (all 13, incl. internal)", () => {
  const live = operations.map((o) => ({ name: o.name, internal: o.internal ?? false, inputSchema: o.inputSchema }));
  expect(live).toEqual(frozen.operations as typeof live);
});

test("opCapabilities matches the frozen contract (twinkling's cross-star validator reads this)", () => {
  expect(opCapabilities()).toEqual(frozen.capabilities as ReturnType<typeof opCapabilities>);
});

test("the guarded twins advertise the same schema as the ops they stand in for", () => {
  // guarded_* are internal, so no client ever sees them — a drift here is invisible to every
  // consumer AND to buildToolDefs (which filters them out). This is the only thing that catches it.
  const by = (n: string) => operations.find((o) => o.name === n)!.inputSchema;
  expect(by("guarded_recall")).toEqual(by("recall"));
  expect(by("guarded_indexed_page")).toEqual(by("indexed_page"));
});

// ── the total-schema contract: garbage clamps or defaults, it never 400s ────────────────────
// Every case below returns a result TODAY. If any starts throwing, an MCP client that works
// right now has been broken. See the `count()` helper's comment for why `.max()` is banned.

const ctx = {} as OperationContext; // parse fails before `run` is reached in every case here

async function argsOf(name: string, args: Record<string, unknown>): Promise<unknown> {
  // Reach the parsed args without a store: swap in a run() that echoes them.
  const real = operations.find((o) => o.name === name)!;
  const spy = { ...real, run: async (_c: OperationContext, a: unknown) => a };
  return dispatchToolCall([spy], name, args, ctx);
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

test('empty-string optionals mean "absent", as they did pre-zod', async () => {
  expect(await argsOf("remember", { title: "t", body: "b", type: "" })).toMatchObject({ type: undefined });
  expect(await argsOf("remember", { title: "t", body: "b", type: "note" })).toMatchObject({ type: "note" });
  expect(await argsOf("tree", {})).toEqual({ dir: "" });
  expect(await argsOf("forget", { id: "a" })).toEqual({ id: "a", hard: false });
});

// ── the error surface ──────────────────────────────────────────────────────────────────────

test("missing required keeps its own wording (not zod's type-error phrasing)", async () => {
  expect(dispatchToolCall(operations, "recall", {}, ctx)).rejects.toThrow(/missing required argument "query"/);
});

test("schema failures render as ONE line — MCP clients print this verbatim", async () => {
  let msg = "";
  try { await dispatchToolCall(operations, "recall", { query: 5 }, ctx); } catch (e) { msg = (e as Error).message; }
  expect(msg).not.toContain("\n");
  expect(msg).toMatch(/^operation recall: query: /);
});

test("indexed_page's id-OR-path rule is truthiness, and invisible in the advertised schema", async () => {
  expect(dispatchToolCall(operations, "indexed_page", {}, ctx)).rejects.toThrow(/provide an `id` or a `path`/);
  expect(dispatchToolCall(operations, "indexed_page", { id: "" }, ctx)).rejects.toThrow(/provide an `id` or a `path`/);
  const schema = operations.find((o) => o.name === "indexed_page")!.inputSchema;
  expect(Object.keys(schema.properties).sort()).toEqual(["id", "path"]);
  expect(schema.required).toBeUndefined();
});

test("buildToolDefs still advertises 11 of 13 (guarded_* stay internal)", () => {
  expect(buildToolDefs(operations)).toHaveLength(11);
  expect(operations).toHaveLength(13);
});
