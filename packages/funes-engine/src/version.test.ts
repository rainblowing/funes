import { test, expect } from "bun:test";
import { FUNES_VERSION } from "./version.ts";
import manifest from "../package.json" with { type: "json" };

// The MCP server used to advertise a hardcoded "0.1.0" while package.json said "0.0.1". A field
// report could not then be tied to an artifact, which is the entire point of a version.
test("FUNES_VERSION matches the package manifest", () => {
  expect(FUNES_VERSION).toBe(manifest.version);
});
