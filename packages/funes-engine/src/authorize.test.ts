// B5 (RAI-337, RAI-310 D5/D8a): the one authorization function. A token plus a policy gives a Grant
// cut to the tier's ceiling, or a refusal: 401 `unauthorized`, 403 `not-granted`.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { authorize } from "funes-core";
import { validateAccessPolicy } from "funes-core/internal";
import { publicOpNames } from "funes-core";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const POLICY = validateAccessPolicy({
  version: 2,
  roles: { curator: { ops: ["recall", "health", "remember", "forget", "put_page"] }, reader: { ops: ["recall", "page"] } },
  actors: {
    alice: { token_sha256: sha("tok-alice"), role: "curator", stars: ["rainblow.ing/a"] },
    bob: { token_sha256: sha("tok-bob"), role: "reader", stars: ["*"] },
  },
}, publicOpNames(), "test");
const at = { tier: "home" as const, star: "rainblow.ing/a", crossStar: false };
const ops = (g: Awaited<ReturnType<typeof authorize>>) => ("ops" in g ? [...g.ops].sort() : g);

test("a token in the policy gets its role cut to the tier's ceiling", async () => {
  expect(ops(await authorize("tok-alice", POLICY, at))).toEqual(["forget", "health", "recall", "remember"]); // put_page is edge only
  expect(ops(await authorize("tok-alice", POLICY, { ...at, tier: "edge" }))).toEqual(["forget", "health", "put_page", "recall"]);
  expect(ops(await authorize("tok-alice", POLICY, { ...at, loopback: false }))).toEqual(["health", "recall", "remember"]);
  expect(ops(await authorize("tok-alice", POLICY, { ...at, crossStar: true }))).toEqual(["health", "recall"]);
  expect(ops(await authorize("tok-alice", POLICY, { ...at, narrow: new Set(["recall", "page"]) }))).toEqual(["recall"]);
  const g = await authorize(" tok-alice\n", POLICY, at);
  expect(g).toMatchObject({ actor: "alice", stars: ["rainblow.ing/a"] });
});

test("no token, an unknown token, or a token to a host with no policy is 401; a star off the grant is 403", async () => {
  for (const [token, policy] of [[null, POLICY], ["tok-nobody", POLICY], ["", POLICY], ["tok-alice", null]] as const) {
    expect(await authorize(token, policy, at), String(token)).toMatchObject({ status: 401, error: "unauthorized" });
  }
  const refused = await authorize("tok-alice", POLICY, { ...at, star: "rainblow.ing/b" });
  expect(refused).toMatchObject({ status: 403, error: "not-granted" });
  expect((refused as { message: string }).message).toContain("alice");
  expect(await authorize("tok-alice", POLICY, { ...at, star: null })).toMatchObject({ status: 403 }); // a star with no id: "*" only
  expect(ops(await authorize("tok-bob", POLICY, { ...at, star: null }))).toEqual(["page", "recall"]);
});

test("no policy and no token: the tokenless floor is the ceiling's reads, actor unknown", async () => {
  const g = await authorize(null, null, { ...at, loopback: true });
  expect(g).toMatchObject({ actor: "unknown", stars: ["*"] });
  expect(ops(g)).toEqual(["graph", "health", "hotlist", "indexed_page", "neighbors", "page", "recall", "tree"]);
  expect(ops(await authorize(null, null, { ...at, loopback: false }))).toEqual(["health", "hotlist", "indexed_page", "recall"]);
});
