import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actorForCapability, assertActorName, loadActorMap, resolveWriteActor, UNKNOWN_ACTOR } from "./actor.ts";
import { operations } from "./ops.ts";

// 0.3.0 item 24: an actor comes from trusted process configuration or from a credential mapping,
// and from nowhere else. The negative tests are the point of the item.

const tmp = () => mkdtempSync(join(tmpdir(), "funes-actor-"));

function mapFile(contents: string, mode = 0o600): string {
  const p = join(tmp(), "actors.json");
  writeFileSync(p, contents);
  chmodSync(p, mode);
  return p;
}

test("actor: no trusted source stamps `unknown` — never a guess, never an invented name", () => {
  expect(resolveWriteActor({ env: {} })).toBe(UNKNOWN_ACTOR);
  expect(resolveWriteActor({ actor: "  ", env: {} })).toBe(UNKNOWN_ACTOR);
});

test("actor: --actor over FUNES_ACTOR over the mapping — the flag is the more specific statement", () => {
  const map = mapFile(JSON.stringify({ "tok-1": "homai" }));
  const cap = join(tmp(), "cap");
  writeFileSync(cap, "tok-1\n");
  expect(resolveWriteActor({ actor: "operator", env: { FUNES_ACTOR: "from-env" }, mapPath: map, capabilityPath: cap })).toBe("operator");
  expect(resolveWriteActor({ env: { FUNES_ACTOR: "from-env" }, mapPath: map, capabilityPath: cap })).toBe("from-env");
  expect(resolveWriteActor({ env: {}, mapPath: map, capabilityPath: cap })).toBe("homai");
});

test("actor: an UNMAPPED capability stamps `unknown` — it does not fall back to an ambient default", () => {
  const map = mapFile(JSON.stringify({ "tok-1": "homai" }));
  const cap = join(tmp(), "cap");
  writeFileSync(cap, "some-other-token\n");
  expect(resolveWriteActor({ env: {}, mapPath: map, capabilityPath: cap })).toBe(UNKNOWN_ACTOR);
  expect(actorForCapability(new Map([["tok-1", "homai"]]), "nope")).toBe(UNKNOWN_ACTOR);
  expect(actorForCapability(null, "tok-1")).toBe(UNKNOWN_ACTOR);
  expect(actorForCapability(new Map([["tok-1", "homai"]]), null)).toBe(UNKNOWN_ACTOR);
  // an unreadable capability file authorizes nobody either — the capability check refuses first
  expect(resolveWriteActor({ env: {}, mapPath: map, capabilityPath: join(tmp(), "absent") })).toBe(UNKNOWN_ACTOR);
});

test("actor: the mapping file must be owner-readable-only — it holds the capability tokens themselves", () => {
  const loose = mapFile(JSON.stringify({ "tok-1": "homai" }), 0o644);
  expect(() => loadActorMap(loose)).toThrow(/group\/world readable/);
  expect(() => loadActorMap(mapFile(JSON.stringify({ "tok-1": "homai" }), 0o640))).toThrow(/group\/world readable/);
  expect(loadActorMap(mapFile(JSON.stringify({ "tok-1": "homai" }))).get("tok-1")).toBe("homai");
});

test("actor: the mapping parses FAIL-CLOSED — half a mapping silently stamps unknown for the rest", () => {
  expect(() => loadActorMap(join(tmp(), "absent.json"))).toThrow(/cannot stat/);
  expect(() => loadActorMap(mapFile("{not json"))).toThrow(/malformed JSON/);
  expect(() => loadActorMap(mapFile('["homai"]'))).toThrow(/expected a JSON object/);
  expect(() => loadActorMap(mapFile("null"))).toThrow(/expected a JSON object/);
  expect(() => loadActorMap(mapFile("{}"))).toThrow(/empty mapping/);
  expect(() => loadActorMap(mapFile(JSON.stringify({ "tok-1": 7 })))).toThrow(/not a string/);
  expect(() => loadActorMap(mapFile(JSON.stringify({ "  ": "homai" })))).toThrow(/empty capability token/);
  expect(() => loadActorMap(mapFile(JSON.stringify({ "tok-1": "" })))).toThrow(/not a usable actor name/);
  // a name is stored in write_actor and served back out by indexed_page — no newlines, no escapes
  expect(() => loadActorMap(mapFile(JSON.stringify({ "tok-1": "hom\nai" })))).toThrow(/not a usable actor name/);
  expect(() => assertActorName("[31mred", "--actor")).toThrow(/not a usable actor name/);
  expect(assertActorName(" homai/broker ", "--actor")).toBe("homai/broker");
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
import { grantFor, grantCoversStar, readAccessPolicy } from "./actor.ts";
import { publicOpNames } from "./ops.ts";

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
  const policy = readAccessPolicy(mapFile(v2()), PUBLIC);
  if (policy === "v1") throw new Error("expected v2");
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

test("RAI-158: a v1 map is recognised and left to today's path", () => {
  expect(readAccessPolicy(mapFile(JSON.stringify({ "tok-1": "homai" })), PUBLIC)).toBe("v1");
});

test("RAI-158: anything malformed refuses everyone — and never repeats a token the file holds", () => {
  const bad: Array<[string, RegExp]> = [
    ['{ "version": 2, raw-token-in-a-typo }', /malformed JSON/],
    [v2({ roles: { agent: { ops: ["remember", "link"] } } }), /unknown or internal operation "link"/],
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
    try { readAccessPolicy(mapFile(contents), PUBLIC); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(why);
    expect(msg).not.toContain("raw-token-in-a-typo");
  }
  expect(() => readAccessPolicy(mapFile(v2(), 0o644), PUBLIC)).toThrow(/group\/world readable/);
});

test("RAI-158: a v1 map wrapped under `actors` names its entries by position — the raw token in the key slot is never repeated", () => {
  const token = sha("a raw capability token"); // 64 hex: a valid actor NAME, so only the entry shape catches it
  for (const entry of ["homai", { token_sha256: "short", role: "agent", stars: ["*"] }]) {
    let msg = "";
    try { readAccessPolicy(mapFile(v2({ actors: { [token]: entry } })), PUBLIC); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/actors entry #1/);
    expect(msg).not.toContain(token);
  }
  let msg = "";
  try { readAccessPolicy(mapFile(v2({ actors: { "tok=with=padding": "homai" } })), PUBLIC); } catch (e) { msg = (e as Error).message; }
  expect(msg).toMatch(/actors entry #1: not a usable actor name/);
  expect(msg).not.toContain("tok=with=padding");
});

test("RAI-158: a v1 map's parse error does not echo its contents (a raw token) into the refusal", () => {
  let msg = "";
  try { loadActorMap(mapFile('{ "abc": "homai", secret-token-typed-bare }')); } catch (e) { msg = (e as Error).message; }
  expect(msg).toMatch(/malformed JSON/);
  expect(msg).not.toContain("secret-token-typed-bare");
});

test("RAI-158: a process on a v2 file stamps its declared actor or `unknown`, never a caller", () => {
  const p = mapFile(v2());
  const cap = join(tmp(), "cap");
  writeFileSync(cap, "tok-agent\n");
  expect(resolveWriteActor({ env: {}, mapPath: p, capabilityPath: cap })).toBe(UNKNOWN_ACTOR);
  expect(resolveWriteActor({ actor: "broker@host-a", env: {}, mapPath: p, capabilityPath: cap })).toBe("broker@host-a");
});

// ── RAI-159 (PLAN-0.4.0 item 22): a stdio session's grant, resolved once at startup ─────────────
import { resolveSessionGrant } from "./actor.ts";

test("RAI-159: FUNES_ACTOR_MAP unset → no grant, today's behaviour; set → everything must line up or startup refuses", () => {
  const map = mapFile(v2());
  const cap = (tok: string) => { const p = join(tmp(), "cap"); writeFileSync(p, tok + "\n"); return p; };
  const FUNES = "git://rainblow.ing/funes";
  expect(resolveSessionGrant(FUNES, PUBLIC, {})).toBeNull();
  expect(resolveSessionGrant(FUNES, PUBLIC, { FUNES_CAPABILITY_FILE: cap("tok-agent") })).toBeNull(); // a token alone grants nothing new
  const g = resolveSessionGrant(FUNES, PUBLIC, { FUNES_ACTOR_MAP: map, FUNES_CAPABILITY_FILE: cap("tok-agent") })!;
  expect(g.actor).toBe("claude@host-b");
  expect(g.ops.has("remember")).toBe(true);
  // the refusals, each naming its repair
  expect(() => resolveSessionGrant(FUNES, PUBLIC, { FUNES_ACTOR_MAP: map })).toThrow(/FUNES_CAPABILITY_FILE must name this session's own token file/);
  expect(() => resolveSessionGrant(FUNES, PUBLIC, { FUNES_ACTOR_MAP: map, FUNES_CAPABILITY_FILE: " " })).toThrow(/never a fallback/);
  expect(() => resolveSessionGrant(FUNES, PUBLIC, { FUNES_ACTOR_MAP: "", FUNES_CAPABILITY_FILE: cap("tok-agent") })).toThrow(/cannot stat/); // set-but-empty is not "unset"
  expect(() => resolveSessionGrant(FUNES, PUBLIC, { FUNES_ACTOR_MAP: map, FUNES_CAPABILITY_FILE: cap("tok-nobody") })).toThrow(/names no actor/);
  expect(() => resolveSessionGrant(FUNES, PUBLIC, { FUNES_ACTOR_MAP: map, FUNES_CAPABILITY_FILE: join(tmp(), "absent") })).toThrow(/unreadable/);
  expect(() => resolveSessionGrant("git://rainblow.ing/personal", PUBLIC, { FUNES_ACTOR_MAP: map, FUNES_CAPABILITY_FILE: cap("tok-agent") }))
    .toThrow(/holds no grant for star "git:\/\/rainblow\.ing\/personal"/);
  expect(() => resolveSessionGrant(null, PUBLIC, { FUNES_ACTOR_MAP: map, FUNES_CAPABILITY_FILE: cap("tok-agent") })).toThrow(/\(no id\)/);
  expect(resolveSessionGrant(null, PUBLIC, { FUNES_ACTOR_MAP: map, FUNES_CAPABILITY_FILE: cap("tok-reader") })!.actor).toBe("sibling-ro@host-a"); // "*" reaches it
  expect(() => resolveSessionGrant(FUNES, PUBLIC, { FUNES_ACTOR_MAP: mapFile(JSON.stringify({ "tok-agent": "homai" })), FUNES_CAPABILITY_FILE: cap("tok-agent") }))
    .toThrow(/version-2 access file only/);
  // no message repeats the token
  let msg = "";
  try { resolveSessionGrant(FUNES, PUBLIC, { FUNES_ACTOR_MAP: map, FUNES_CAPABILITY_FILE: cap("tok-secret-unknown") }); } catch (e) { msg = (e as Error).message; }
  expect(msg).not.toContain("tok-secret-unknown");
});
