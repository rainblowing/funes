// ADR-0016 / record 33: the one credential parser every funes HTTP surface reads through.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { presentedToken } from "./index.ts";

const LEGACY = "x-presented-token-test"; // a name no surface uses, so this file owns its deprecation line
const headers = (h: Record<string, string>) => (name: string) => h[name];

let warn: ReturnType<typeof spyOn>;
beforeEach(() => { warn = spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => warn.mockRestore());

test("Bearer only → the token; the scheme is case-insensitive", () => {
  expect(presentedToken(headers({ authorization: "Bearer abc-123_x.y~z+/=" }), LEGACY)).toEqual({ token: "abc-123_x.y~z+/=" });
  expect(presentedToken(headers({ authorization: "bearer tok" }), LEGACY)).toEqual({ token: "tok" });
});

test("nothing presented → no token, not a refusal", () => {
  expect(presentedToken(headers({}), LEGACY)).toEqual({ token: null });
});

test("malformed Authorization → refused, and the legacy header is never read", () => {
  for (const authorization of ["", "Bearer", "Bearer ", "Basic dTpw", "Bearer two words", "Bearer a\"b", "tok"]) {
    expect(presentedToken(headers({ authorization, [LEGACY]: "tok" }), LEGACY)).toEqual({ refused: "malformed" });
  }
});

test("Bearer + an equal legacy value → accepted; a different one → refused", () => {
  expect(presentedToken(headers({ authorization: "Bearer tok", [LEGACY]: "tok" }), LEGACY)).toEqual({ token: "tok" });
  expect(presentedToken(headers({ authorization: "Bearer tok", [LEGACY]: "other" }), LEGACY)).toEqual({ refused: "conflicting" });
});

test("legacy alone → accepted, with ONE deprecation line per process that never carries the token", () => {
  expect(presentedToken(headers({ [LEGACY]: "s3cret-legacy" }), LEGACY)).toEqual({ token: "s3cret-legacy" });
  expect(presentedToken(headers({ [LEGACY]: "s3cret-legacy" }), LEGACY)).toEqual({ token: "s3cret-legacy" });
  const lines = warn.mock.calls.map((c: unknown[]) => c.join(" "));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain(LEGACY);
  expect(lines[0]).toContain("Authorization: Bearer");
  expect(lines[0]).not.toContain("s3cret-legacy");
});

test("a surface with no legacy name (the edge) reads Bearer only", () => {
  expect(presentedToken(headers({ "x-funes-capability": "tok" }), null)).toEqual({ token: null });
  expect(presentedToken(headers({ authorization: "Bearer tok" }), null)).toEqual({ token: "tok" });
});
