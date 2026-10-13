import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizeCanonicalWrite, normalizeDesignation, resolveDesignationMode, resolveLocus, resolveWriteDesignation,
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

// PLAN-0.4.0 item 10: `write_authority` is twinkling's write POLICY enum, not a machine. The authority
// is `write_locus`; a star that declares only the policy declares no writer.
test("designation: star.yaml meta.write_locus is the authority — write_authority is not read at all", () => {
  const v = vaultWith("meta:\n  name: funes\n  id: git://rainblow.ing/funes\n  write_authority: member-local\n  write_locus: host-a\n");
  expect(readStarIdentity(v).writeLocus).toBe("host-a");
  expect(readStarIdentity(vaultWith("meta:\n  name: funes\n  write_authority: member-local\n")).writeLocus).toBeNull();
  expect(readStarIdentity(vaultWith("meta:\n  name: bare\n")).writeLocus).toBeNull();
  expect(readStarIdentity(mkdtempSync(join(tmpdir(), "funes-desig-none-"))).writeLocus).toBeNull();
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
  expect(detail).toContain("write_locus=nas-1");
  expect(detail).toContain("actor=homai");
});

test("designation: resolveLocus — --locus over FUNES_LOCUS, normalized, null when unset; FACE_LOCUS is gone", () => {
  expect(resolveLocus({ env: {} })).toBeNull(); // never a hostname default
  expect(resolveLocus({ env: { FUNES_LOCUS: " Host-A " } })).toBe("host-a");
  expect(resolveLocus({ flag: "Laptop", env: { FUNES_LOCUS: "host-a" } })).toBe("laptop"); // flag over env
  expect(resolveLocus({ env: { FACE_LOCUS: "host-a" } })).toBeNull(); // renamed without an alias
  expect(resolveLocus({ flag: "nas\u00ed", env: {} })).toBe(resolveLocus({ flag: "nasi\u0301", env: {} })); // accented: admitted, NFC
});

test("designation: a locus that breaks a compound identity or a filename is REFUSED, never repaired", () => {
  const bad = ["a@b", "host/a", "host\\a", "host a", "host\ta", "host\u00a0a", "host\u0000a", "host\u007fa", "", "   "];
  for (const v of bad) {
    expect(() => resolveLocus({ flag: v, env: {} })).toThrow(/--locus .*(refused|empty).*fail-closed/);
    expect(() => resolveLocus({ env: { FUNES_LOCUS: v } })).toThrow(/FUNES_LOCUS .*(refused|empty).*fail-closed/);
  }
  // a bad environment value is not consulted when the flag names the machine
  expect(resolveLocus({ flag: "host-a", env: { FUNES_LOCUS: "a@b" } })).toBe("host-a");
  // …and write_locus is refused on READ by the same rule, so the two halves can always be equal. A
  // non-string (a list naming two writers, a number, a boolean) is refused too — never read as
  // "undeclared", which would pass every surface's startup and misdiagnose the star.
  for (const w of ['"a@b"', '"host a"', '""', "[host-a, host-b]", "2026", "true"]) {
    const v = vaultWith(`meta:\n  name: funes\n  write_locus: ${w}\n`);
    expect(() => resolveWriteDesignation(v, { locus: "host-a", env: {} })).toThrow(/star\.yaml meta\.write_locus .*fail-closed/);
  }
});

test("designation: resolution takes the locus from resolveLocus, the authority from write_locus", () => {
  // the estate's shape after item 10: the policy stays, the machine is named beside it
  const v = vaultWith("meta:\n  name: funes\n  write_authority: member-local\n  write_locus: Host-A\n");
  expect(resolveWriteDesignation(v, { locus: "host-a", env: {} })).toMatchObject({ mode: "audit", locus: "host-a", authority: "host-a" });
  expect(resolveWriteDesignation(v, { env: { FUNES_LOCUS: "host-b" } }).locus).toBe("host-b");
  expect(resolveWriteDesignation(v, { locus: "laptop", env: { FUNES_LOCUS: "host-b" } }).locus).toBe("laptop");
  expect(authorizeCanonicalWrite(resolveWriteDesignation(v, { locus: " HOST-A ", env: {} }), { op: "remember", vault: v }).verdict).toBe("match");
  // 0.3.0 compared against the POLICY value, so `--locus member-local` was "the designated writer".
  // It is not a machine, and it no longer matches anything.
  expect(authorizeCanonicalWrite(resolveWriteDesignation(v, { locus: "member-local", env: {} }), { op: "remember", vault: v }).verdict).toBe("mismatch");
  const policyOnly = vaultWith("meta:\n  name: funes\n  write_authority: member-local\n");
  expect(authorizeCanonicalWrite(resolveWriteDesignation(policyOnly, { locus: "member-local", env: {} }), { op: "remember", vault: policyOnly }))
    .toMatchObject({ verdict: "undeclared", detail: expect.stringContaining("star declares no write_locus") });
  // the promotion gate names the field the estate must declare
  expect(() => resolveDesignationMode("enforce", {})).toThrow(/every catalogued star declares star\.yaml meta\.write_locus/);
});

/** Set one environment variable for one call and always put it back — these two surfaces read the
 *  LIVE process environment, which is the point (a typo in it must not survive the boot). */
async function withEnv<T>(name: string, value: string, fn: () => T | Promise<T>): Promise<T> {
  const saved = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}
const withMode = <T>(mode: string, fn: () => T | Promise<T>) => withEnv("FUNES_WRITE_DESIGNATION", mode, fn);

// A typo used to be an OUTAGE, not a boot failure: resolveDesignationMode is fail-closed on an
// unknown value, and dispatchToolCall resolved the designation PER CALL whenever the context
// carried none — so `FUNES_WRITE_DESIGNATION=audti` started fine on the stdio MCP server and the
// HTTP app and then threw on the first write, as a tool error, mid-session. Both surfaces now
// resolve ONCE at startup, as face.ts always did. PLAN-0.4.0 item 10's refused star.yaml write_locus
// rides the same path. (A refused LOCUS is a usage error there, exit 2 like `--ops` — which is a
// process.exit, so cli.test.ts drives it in a spawned process rather than here.)
test("designation: a misspelled mode or a refused write_locus fails at STARTUP on the stdio MCP surface, not on the first write", async () => {
  const vault = vaultWith("meta:\n  name: funes\n  write_locus: host-a\n");
  const { runMcp } = await import("./mcp-server.ts");
  await withMode("audti", async () => {
    await expect(runMcp(["--vault", vault])).rejects.toThrow(/unknown mode "audti"/);
  });
  const refused = vaultWith('meta:\n  name: funes\n  write_locus: "a@b"\n');
  await expect(runMcp(["--vault", refused, "--locus", "host-a"])).rejects.toThrow(/star\.yaml meta\.write_locus "a@b" carries "@"/);
});

test("designation: a misspelled mode or a refused locus fails at STARTUP on the HTTP app surface too", async () => {
  const vault = vaultWith("meta:\n  name: funes\n  write_locus: host-a\n");
  const { buildApp } = await import("./app.ts");
  // the store is never touched: the refusal happens while the op context is being built
  const build = () => buildApp({ store: {} as never, vault });
  await withMode("audti", () => { expect(build).toThrow(/unknown mode "audti"/); });
  await withMode("enforce", () => { expect(build).toThrow(/not available in this release/); });
  await withMode("off", () => { expect(build).not.toThrow(); }); // a VALID mode still builds
  expect(() => buildApp({ store: {} as never, vault, locus: "host a" })).toThrow(/--locus "host a" carries " "/);
  await withEnv("FUNES_LOCUS", "a@b", () => { expect(build).toThrow(/FUNES_LOCUS "a@b"/); });
});
