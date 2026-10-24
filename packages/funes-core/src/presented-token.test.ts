// ADR-0016 / record 33: the one credential parser every funes HTTP surface reads through.
import { expect, test } from "bun:test";
import { presentedToken } from "./presented-token.ts";

const headers = (h: Record<string, string>) => (name: string) => h[name];

test("Bearer only → the token; the scheme is case-insensitive", () => {
  expect(presentedToken(headers({ authorization: "Bearer abc-123_x.y~z+/=" }))).toEqual({ token: "abc-123_x.y~z+/=" });
  expect(presentedToken(headers({ authorization: "bearer tok" }))).toEqual({ token: "tok" });
});

test("nothing presented → no token, not a refusal; another header is never a token", () => {
  expect(presentedToken(headers({}))).toEqual({ token: null });
  expect(presentedToken(headers({ "x-funes-capability": "tok" }))).toEqual({ token: null });
});

test("malformed Authorization → refused", () => {
  for (const authorization of ["", "Bearer", "Bearer ", "Basic dTpw", "Bearer two words", "Bearer a\"b", "tok"]) {
    expect(presentedToken(headers({ authorization }))).toEqual({ refused: "malformed" });
  }
});
