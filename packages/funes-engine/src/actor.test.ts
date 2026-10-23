import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertActorName } from "funes-core";
import { operations } from "funes-core/internal";

// 0.3.0 item 24: an actor comes from trusted process configuration or from a grant, and from nowhere
// else. The v1 map, `--actor` and FUNES_ACTOR are gone (RAI-310 D3, D9).

const tmp = () => mkdtempSync(join(tmpdir(), "funes-actor-"));

function mapFile(contents: string, mode = 0o600): string {
  const p = join(tmp(), "actors.json");
  writeFileSync(p, contents);
  chmodSync(p, mode);
  return p;
}

test("actor: a name is stored in write_actor and served back out — no newlines, no escapes", () => {
  expect(() => assertActorName("hom\nai", "access file")).toThrow(/not a usable actor name/);
  expect(() => assertActorName("\u001b[31mred", "access file")).toThrow(/not a usable actor name/);
  expect(assertActorName(" homai/broker ", "access file")).toBe("homai/broker");
});

// The strongest statement item 24 makes is structural, so the test is generated from the registry:
// no operation declares an actor argument, so there is no payload-supplied actor to ignore, and a
// future op cannot quietly add one without failing here.
test("actor: NO operation accepts an actor from its payload — the schemas are generated proof", () => {
  for (const op of operations) {
    const props = Object.keys(op.inputSchema.properties ?? {}).map((k) => k.toLowerCase());
    expect(props.filter((k) => k.includes("actor") || k === "principal" || k === "who")).toEqual([]);
  }
});

// ── RAI-158 (PLAN-0.4.0 item 21): the access file, version 2 ─────────────────────────────────────
// Actors hold roles; the file holds token HASHES; it is read on every request, and anything
// malformed refuses everyone rather than half-loading.
import { createHash } from "node:crypto";
import { grantFor, grantCoversStar } from "funes-core/internal";
import { readAccessPolicy } from "./actor.ts";
import { publicOpNames } from "funes-core";

const PUBLIC = publicOpNames(); // the real registry projection, so "internal ops refuse" is the registry's
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const v2 = (over: Record<string, unknown> = {}) => JSON.stringify({
  version: 2,
  roles: { reader: { ops: ["recall", "health"] }, agent: { ops: ["recall", "health", "remember"] } },
  actors: {
    "claude@host-b": { token_sha256: sha("tok-agent"), role: "agent", stars: ["rainblow.ing/funes"] },
    "sibling-ro@host-a": { token_sha256: sha("tok-reader"), role: "reader", stars: ["*"] },
  },
  ...over,
});

test("RAI-158: a v2 access file resolves a presented token to {actor, ops, stars} — trimmed, hashed, constant-time", () => {
  const policy = readAccessPolicy(mapFile(v2()));
  const g = grantFor(policy, "tok-agent\n")!;
  expect(g.actor).toBe("claude@host-b");
  expect([...g.ops].sort()).toEqual(["health", "recall", "remember"]);
  expect(grantFor(policy, "tok-reader")!.ops.has("remember")).toBe(false);
  expect(grantFor(policy, "tok-unknown")).toBeNull();
  expect(grantFor(policy, "")).toBeNull();
  expect(grantCoversStar(g, "git://rainblow.ing/funes")).toBe(true); // one canonical key, any access method
  expect(grantCoversStar(g, "git://rainblow.ing/personal")).toBe(false);
  expect(grantCoversStar(grantFor(policy, "tok-reader")!, "git://anything.org/x")).toBe(true);
  expect(grantCoversStar(g, null)).toBe(false); // a star with no id is covered by "*" only
  expect(grantCoversStar(grantFor(policy, "tok-reader")!, null)).toBe(true);
});

test("RAI-310 D3: a v1 map refuses everyone — the version-2 file is the only server-side format", () => {
  expect(() => readAccessPolicy(mapFile(JSON.stringify({ "tok-1": "homai" })))).toThrow(/not a version-2 access file/);
  expect(() => readAccessPolicy(mapFile(JSON.stringify({ "tok-1": "homai" })))).not.toThrow(/tok-1/);
});

test("RAI-158: anything malformed refuses everyone — and never repeats a token the file holds", () => {
  const bad: Array<[string, RegExp]> = [
    ['{ "version": 2, raw-token-in-a-typo }', /malformed JSON/],
    [v2({ roles: { agent: { ops: ["remember", "elevate"] } } }), /unknown or internal operation "elevate"/],
    [v2({ roles: { agent: { ops: ["guarded_recall"] } } }), /unknown or internal operation "guarded_recall"/],
    [v2({ roles: { agent: { ops: [] } } }), /role "agent": no operations/],
    [v2({ actors: {} }), /no actors/],
    [v2({ actors: { a: { token_sha256: sha("x").toUpperCase(), role: "agent", stars: ["*"] } } }), /64 lowercase hex/],
    [v2({ actors: { a: { token_sha256: sha("x"), role: "agent", stars: ["*"] }, b: { token_sha256: sha("x"), role: "agent", stars: ["*"] } } }), /share one token hash/],
    [v2({ actors: { a: { token_sha256: sha("x"), role: "curator", stars: ["*"] } } }), /unknown role "curator"/],
    [v2({ actors: { "has space": { token_sha256: sha("x"), role: "agent", stars: ["*"] } } }), /not a usable actor name/],
    [v2({ actors: { a: { token_sha256: sha("x"), role: "agent", stars: [] } } }), /stars/],
    [v2({ actors: { a: { token_sha256: sha("x"), role: "agent", stars: ["not a ref"] } } }), /stars/],
  ];
  for (const [contents, why] of bad) {
    let msg = "";
    try { readAccessPolicy(mapFile(contents)); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(why);
    expect(msg).not.toContain("raw-token-in-a-typo");
  }
  expect(() => readAccessPolicy(mapFile(v2(), 0o644))).toThrow(/group\/world readable/);
});

// RAI-239 (PLAN-0.5.0 item 41): the same rule, run on the PARSED document — the edge face's grants
// (ADR-0014) have no file, so the file reader and the DO share this one validator.
import { validateAccessPolicy } from "funes-core/internal";

test("RAI-239: the shared validator resolves the same grants the file reader does", () => {
  const policy = validateAccessPolicy(JSON.parse(v2()), PUBLIC, "grants");
  const g = grantFor(policy, "tok-agent")!;
  expect(g.actor).toBe("claude@host-b");
  expect([...g.ops].sort()).toEqual(["health", "recall", "remember"]);
  expect(grantFor(policy, "tok-unknown")).toBeNull();
});

test("RAI-239: the shared validator refuses everyone on every malformed entry the file reader refuses", () => {
  const bad: Array<[Record<string, unknown>, RegExp]> = [
    [{ roles: { agent: { ops: ["remember", "elevate"] } } }, /unknown or internal operation "elevate"/],
    [{ roles: { agent: { ops: ["guarded_recall"] } } }, /unknown or internal operation "guarded_recall"/],
    [{ roles: { agent: { ops: [] } } }, /role "agent": no operations/],
    [{ roles: [] }, /`roles` must be an object/],
    [{ actors: {} }, /no actors/],
    [{ actors: { a: { token_sha256: sha("x").toUpperCase(), role: "agent", stars: ["*"] } } }, /64 lowercase hex/],
    [{ actors: { a: { token_sha256: sha("x"), role: "agent", stars: ["*"] }, b: { token_sha256: sha("x"), role: "agent", stars: ["*"] } } }, /share one token hash/],
    [{ actors: { a: { token_sha256: sha("x"), role: "curator", stars: ["*"] } } }, /unknown role "curator"/],
    [{ actors: { "has space": { token_sha256: sha("x"), role: "agent", stars: ["*"] } } }, /actors entry #1: not a usable actor name/],
    [{ actors: { a: { token_sha256: sha("x"), role: "agent", stars: [] } } }, /stars/],
    [{ actors: { a: { token_sha256: sha("x"), role: "agent", stars: ["not a ref"] } } }, /stars/],
  ];
  for (const [over, why] of bad) {
    expect(() => validateAccessPolicy(JSON.parse(v2(over)), PUBLIC, "grants")).toThrow(why);
    expect(() => validateAccessPolicy(JSON.parse(v2(over)), PUBLIC, "grants")).toThrow(/^grants: .* refusing everyone \(fail-closed\)$/);
  }
});

test("RAI-158: a v1 map wrapped under `actors` names its entries by position — the raw token in the key slot is never repeated", () => {
  const token = sha("a raw capability token"); // 64 hex: a valid actor NAME, so only the entry shape catches it
  for (const entry of ["homai", { token_sha256: "short", role: "agent", stars: ["*"] }]) {
    let msg = "";
    try { readAccessPolicy(mapFile(v2({ actors: { [token]: entry } }))); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/actors entry #1/);
    expect(msg).not.toContain(token);
  }
  let msg = "";
  try { readAccessPolicy(mapFile(v2({ actors: { "tok=with=padding": "homai" } }))); } catch (e) { msg = (e as Error).message; }
  expect(msg).toMatch(/actors entry #1: not a usable actor name/);
  expect(msg).not.toContain("tok=with=padding");
});

// ── RAI-159 (PLAN-0.4.0 item 22): a stdio session's grant, resolved once at startup ─────────────
import { resolveSessionGrant } from "./actor.ts";

test("RAI-159: FUNES_ACTOR_MAP unset → no grant, today's behaviour; set → everything must line up or startup refuses", () => {
  const map = mapFile(v2());
  const cap = (tok: string) => { const p = join(tmp(), "cap"); writeFileSync(p, tok + "\n"); return p; };
  const FUNES = "git://rainblow.ing/funes";
  expect(resolveSessionGrant(FUNES, {})).toBeNull();
  expect(resolveSessionGrant(FUNES, { FUNES_CAPABILITY_FILE: cap("tok-agent") })).toBeNull(); // a token alone grants nothing new
  const g = resolveSessionGrant(FUNES, { FUNES_ACTOR_MAP: map, FUNES_CAPABILITY_FILE: cap("tok-agent") })!;
  expect(g.actor).toBe("claude@host-b");
  expect(g.ops.has("remember")).toBe(true);
  // the refusals, each naming its repair
  expect(() => resolveSessionGrant(FUNES, { FUNES_ACTOR_MAP: map })).toThrow(/FUNES_CAPABILITY_FILE must name this session's own token file/);
  expect(() => resolveSessionGrant(FUNES, { FUNES_ACTOR_MAP: map, FUNES_CAPABILITY_FILE: " " })).toThrow(/never a fallback/);
  expect(() => resolveSessionGrant(FUNES, { FUNES_ACTOR_MAP: "", FUNES_CAPABILITY_FILE: cap("tok-agent") })).toThrow(/cannot stat/); // set-but-empty is not "unset"
  expect(() => resolveSessionGrant(FUNES, { FUNES_ACTOR_MAP: map, FUNES_CAPABILITY_FILE: cap("tok-nobody") })).toThrow(/names no actor/);
  expect(() => resolveSessionGrant(FUNES, { FUNES_ACTOR_MAP: map, FUNES_CAPABILITY_FILE: join(tmp(), "absent") })).toThrow(/unreadable/);
  expect(() => resolveSessionGrant("git://rainblow.ing/personal", { FUNES_ACTOR_MAP: map, FUNES_CAPABILITY_FILE: cap("tok-agent") }))
    .toThrow(/holds no grant for star "git:\/\/rainblow\.ing\/personal"/);
  expect(() => resolveSessionGrant(null, { FUNES_ACTOR_MAP: map, FUNES_CAPABILITY_FILE: cap("tok-agent") })).toThrow(/\(no id\)/);
  expect(resolveSessionGrant(null, { FUNES_ACTOR_MAP: map, FUNES_CAPABILITY_FILE: cap("tok-reader") })!.actor).toBe("sibling-ro@host-a"); // "*" reaches it
  expect(() => resolveSessionGrant(FUNES, { FUNES_ACTOR_MAP: mapFile(JSON.stringify({ "tok-agent": "homai" })), FUNES_CAPABILITY_FILE: cap("tok-agent") }))
    .toThrow(/not a version-2 access file/);
  // no message repeats the token
  let msg = "";
  try { resolveSessionGrant(FUNES, { FUNES_ACTOR_MAP: map, FUNES_CAPABILITY_FILE: cap("tok-secret-unknown") }); } catch (e) { msg = (e as Error).message; }
  expect(msg).not.toContain("tok-secret-unknown");
});
