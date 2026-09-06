import { test, expect } from "bun:test";
import { FUNES_VERSION } from "./version.ts";
import engine from "../package.json" with { type: "json" };
import api from "../../funes-api/package.json" with { type: "json" };
import core from "../../funes-core/package.json" with { type: "json" };
import libsql from "../../funes-libsql/package.json" with { type: "json" };
import shared from "../../funes-shared/package.json" with { type: "json" };

// The MCP server used to advertise a hardcoded "0.1.0" while package.json said "0.0.1". A field
// report could not then be tied to an artifact, which is the entire point of a version.
test("FUNES_VERSION matches the package manifest", () => {
  expect(FUNES_VERSION).toBe(engine.version);
});

// RAI-148 (0.3.0 close-out): the five workspace packages once sat at three different versions with
// only funes-engine ever moving (wiki/log.md, 2026-08-18), and the 0.2.0 bump then missed
// version.ts. The test above pins ONE manifest to the string; this one pins the other four to the
// same string, so a bump that touches engine and forgets a sibling fails here rather than in a
// field report. Revert any one package.json to the previous version and it fails.
test("all five workspace packages carry FUNES_VERSION", () => {
  const versions = { "funes-api": api.version, "funes-core": core.version, "funes-libsql": libsql.version, "funes-shared": shared.version };
  for (const [name, version] of Object.entries(versions)) {
    expect(`${name}@${version}`).toBe(`${name}@${FUNES_VERSION}`);
  }
});
