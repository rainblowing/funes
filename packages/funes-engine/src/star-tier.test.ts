// B5 (RAI-337; ADR-0019, ADR-0021): `memory.tier` and `memory.substrate`, and the refusal of every
// local open of a Turso star other than its `funes serve` and its builder (B8b); the refusal names
// the serve URL.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLocalOpen, starMemory } from "./factory.ts";
import { starIdentityFromText } from "funes-core/internal";

const memoryOf = (yaml: string) => starMemory(starIdentityFromText(yaml), "star.yaml");

test("an absent tier is home and an absent substrate is libsql", () => {
  expect(memoryOf("meta:\n  id: rainblow.ing/a\n")).toEqual({ tier: "home", substrate: "libsql" });
  expect(memoryOf("memory:\n  tier: home\n  substrate: turso\n")).toEqual({ tier: "home", substrate: "turso" });
  expect(memoryOf("memory:\n  tier: org\n  substrate: turso\n")).toEqual({ tier: "org", substrate: "turso" });
});

test("postgres, an unknown substrate, an unknown tier and an org star off Turso refuse, naming the key", () => {
  expect(() => memoryOf("memory:\n  substrate: postgres\n")).toThrow(/star\.yaml memory\.substrate: postgres.*removed in funes 0\.6\.0/);
  expect(() => memoryOf("memory:\n  substrate: pglite\n")).toThrow(/memory\.substrate.*"libsql" or "turso"/);
  expect(() => memoryOf("memory:\n  tier: edge\n")).toThrow(/memory\.tier.*"home" or "org"/);
  expect(() => memoryOf("memory:\n  tier: org\n")).toThrow(/memory\.tier: org requires memory\.substrate: turso/);
});

test("a Turso star refuses a local open and names the serve URL; a libsql star opens", () => {
  const star = mkdtempSync(join(tmpdir(), "funes-turso-"));
  try {
    writeFileSync(join(star, "star.yaml"), "meta:\n  id: rainblow.ing/org\n  write_locus: host-a\nmemory:\n  tier: org\n  substrate: turso\n");
    expect(() => assertLocalOpen(star)).toThrow(/Turso.*funes serve.*type: http.*http:\/\/host-a:8787\/mcp/s);
    writeFileSync(join(star, "star.yaml"), "memory:\n  substrate: turso\n");
    expect(() => assertLocalOpen(star)).toThrow(/http:\/\/127\.0\.0\.1:8787\/mcp/); // no write locus: this machine's serve
    writeFileSync(join(star, "star.yaml"), "memory:\n  substrate: libsql\n");
    expect(() => assertLocalOpen(star)).not.toThrow();
  } finally {
    rmSync(star, { recursive: true, force: true });
  }
});

test("a star.yaml that does not parse refuses: its tier and substrate are unknowable, never home and libsql", () => {
  expect(() => memoryOf("memory: [tier: org\n  substrate: turso\n")).toThrow(/star\.yaml does not parse/);
});
