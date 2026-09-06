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
