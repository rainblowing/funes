import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizeCanonicalWrite, normalizeDesignation, resolveDesignationMode, resolveWriteDesignation,
} from "./write-designation.ts";
import { readStarIdentity } from "./factory.ts";

// 0.3.0 item 25 / ADR-0005. Audit mode evaluates, reports, and NEVER refuses — so every assertion
// about `allowed` here is `true`, including the mismatch. That is the release's shipped behaviour,
// not a weak test: the verdict is what carries the finding.

function vaultWith(yaml: string): string {
  const v = mkdtempSync(join(tmpdir(), "funes-desig-"));
  writeFileSync(join(v, "star.yaml"), yaml);
  return v;
}

test("designation: star.yaml meta.write_authority is READ — until 0.3.0 no code read it at all", () => {
  const v = vaultWith("meta:\n  name: funes\n  id: git://rainblow.ing/funes\n  write_authority: member-local\n");
  expect(readStarIdentity(v).writeAuthority).toBe("member-local");
  expect(readStarIdentity(vaultWith("meta:\n  name: bare\n")).writeAuthority).toBeNull();
  expect(readStarIdentity(mkdtempSync(join(tmpdir(), "funes-desig-none-"))).writeAuthority).toBeNull();
});

test("designation: normalization is NFC + trim + lowercase, then EXACT equality", () => {
  expect(normalizeDesignation(" Member-Local ")).toBe("member-local");
  expect(normalizeDesignation("nas\u00ed")).toBe(normalizeDesignation("nasi\u0301")); // composed vs decomposed
  expect(normalizeDesignation("   ")).toBeNull();
  expect(normalizeDesignation(null)).toBeNull();
  // exact, not prefix: a machine that merely RESEMBLES the designated one is not it
  const d = { mode: "audit" as const, locus: "nas-1", authority: "nas-10" };
  expect(authorizeCanonicalWrite(d, { op: "remember", vault: "/v" }).verdict).toBe("mismatch");
});

test("designation: modes — off is not evaluated, audit permits, enforce is refused AT CONFIGURATION", () => {
  expect(resolveDesignationMode(undefined, {})).toBe("audit"); // the shipped default
  expect(resolveDesignationMode("off", {})).toBe("off");
  expect(resolveDesignationMode(undefined, { FUNES_WRITE_DESIGNATION: "off" })).toBe("off");
  expect(resolveDesignationMode("audit", { FUNES_WRITE_DESIGNATION: "off" })).toBe("audit"); // flag over env
  expect(() => resolveDesignationMode("enforce", {})).toThrow(/not available in this release/);
  expect(() => resolveDesignationMode(undefined, { FUNES_WRITE_DESIGNATION: "enforce" })).toThrow(/not available in this release/);
  expect(() => resolveDesignationMode("warn", {})).toThrow(/unknown mode/);
});

test("designation: the four verdicts, and audit permits every one of them", () => {
  const at = (locus: string | null, authority: string | null, mode: "off" | "audit" = "audit") =>
    authorizeCanonicalWrite({ mode, locus, authority }, { op: "remember", vault: "/v", actor: "homai" });
  expect(at("nas-1", "nas-1")).toMatchObject({ verdict: "match", allowed: true });
  expect(at("laptop", "nas-1")).toMatchObject({ verdict: "mismatch", allowed: true });
  expect(at("nas-1", null)).toMatchObject({ verdict: "undeclared", allowed: true });
  expect(at(null, "nas-1")).toMatchObject({ verdict: "unidentified", allowed: true });
  expect(at("laptop", "nas-1", "off")).toMatchObject({ verdict: "off", allowed: true });
  // the refusal, when enforce ships, must be diagnosable without reading config on two machines
  const detail = at("laptop", "nas-1").detail;
  expect(detail).toContain("locus=laptop");
  expect(detail).toContain("write_authority=nas-1");
  expect(detail).toContain("actor=homai");
});

test("designation: resolution takes locus from --locus over FACE_LOCUS, authority from the star", () => {
  const v = vaultWith("meta:\n  name: funes\n  write_authority: Member-Local\n");
  expect(resolveWriteDesignation(v, { locus: "member-local", env: {} })).toMatchObject({ mode: "audit", locus: "member-local", authority: "member-local" });
  expect(resolveWriteDesignation(v, { env: { FACE_LOCUS: "nas-1" } }).locus).toBe("nas-1");
  expect(resolveWriteDesignation(v, { locus: "laptop", env: { FACE_LOCUS: "nas-1" } }).locus).toBe("laptop");
  // this repo's own star declares member-local, so a face declaring it is the designated writer
  expect(authorizeCanonicalWrite(resolveWriteDesignation(v, { locus: " MEMBER-LOCAL ", env: {} }), { op: "remember", vault: v }).verdict).toBe("match");
});

/** Set FUNES_WRITE_DESIGNATION for one call and always put it back — these two surfaces read the
 *  LIVE process environment, which is the point (a typo in it must not survive the boot). */
async function withMode<T>(mode: string, fn: () => T | Promise<T>): Promise<T> {
  const saved = process.env.FUNES_WRITE_DESIGNATION;
  process.env.FUNES_WRITE_DESIGNATION = mode;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.FUNES_WRITE_DESIGNATION;
    else process.env.FUNES_WRITE_DESIGNATION = saved;
  }
}

// A typo used to be an OUTAGE, not a boot failure: resolveDesignationMode is fail-closed on an
// unknown value, and dispatchToolCall resolved the designation PER CALL whenever the context
// carried none — so `FUNES_WRITE_DESIGNATION=audti` started fine on the stdio MCP server and the
// HTTP app and then threw on the first write, as a tool error, mid-session. Both surfaces now
// resolve ONCE at startup, as face.ts always did.
test("designation: a misspelled mode fails at STARTUP on the stdio MCP surface, not on the first write", async () => {
  const vault = vaultWith("meta:\n  name: funes\n  write_authority: member-local\n");
  const { runMcp } = await import("./mcp-server.ts");
  await withMode("audti", async () => {
    await expect(runMcp(["--vault", vault])).rejects.toThrow(/unknown mode "audti"/);
  });
});

test("designation: a misspelled mode fails at STARTUP on the HTTP app surface too", async () => {
  const vault = vaultWith("meta:\n  name: funes\n  write_authority: member-local\n");
  const { buildApp } = await import("./app.ts");
  // the store is never touched: the refusal happens while the op context is being built
  const build = () => buildApp({ store: {} as never, vault });
  await withMode("audti", () => { expect(build).toThrow(/unknown mode "audti"/); });
  await withMode("enforce", () => { expect(build).toThrow(/not available in this release/); });
  await withMode("off", () => { expect(build).not.toThrow(); }); // a VALID mode still builds
});

