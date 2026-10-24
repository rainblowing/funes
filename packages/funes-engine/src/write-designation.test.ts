import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertWriteAllowed, normalizeDesignation, writeAllowed } from "funes-core/internal";
import { resolveLocus, resolveWriteDesignation } from "./process-locus.ts";
import { readStarIdentity } from "./factory.ts";

// 0.3.0 item 25 / ADR-0005, as RAI-302 amends it: one rule — no declared writer, or this process's
// locus equal to it. A decision is allowed or refused; there is no mode and no audit line.

/** The rule's answer as an observer sees it: refused (the error) or allowed (nothing thrown). */
const refusal = (locus: string | null, authority: string | null, op = "remember"): (Error & Record<string, unknown>) | null => {
  try { assertWriteAllowed({ locus, authority }, op); return null; } catch (e) { return e as Error & Record<string, unknown>; }
};

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
  expect(refusal("nas-1", "nas-10")).toMatchObject({ code: "not-write-locus", writeLocus: "nas-10" });
});

test("designation: the rule allows or refuses, and a refusal names both values", () => {
  expect(refusal("nas-1", "nas-1")).toBeNull();
  expect(refusal("nas-1", null)).toBeNull(); // undeclared: any locus may write, by declaration
  expect(refusal(null, null)).toBeNull();
  expect(refusal("laptop", "nas-1")).toMatchObject({ code: "not-write-locus", writeLocus: "nas-1" });
  expect(refusal(null, "nas-1")).toMatchObject({ code: "not-write-locus", writeLocus: "nas-1" }); // RAI-302: no locus refuses
  // the refusal must be diagnosable without reading config on two machines
  const msg = refusal("laptop", "nas-1", "forget")!.message;
  expect(msg).toContain("operation forget");
  expect(msg).toContain("locus=laptop");
  expect(msg).toContain("write_locus=nas-1");
  expect(refusal(null, "nas-1")!.message).toContain("locus=(none)");
});

test("designation: resolveLocus — --locus over FUNES_LOCUS, normalized, null when unset; FACE_LOCUS is gone", () => {
  expect(resolveLocus({ env: {} })).toBeNull(); // no hostname passed: portable code never reads one
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
  // declaring no writer, which would pass every surface's startup and misdiagnose the star.
  for (const w of ['"a@b"', '"host a"', '""', "[host-a, host-b]", "2026", "true"]) {
    const v = vaultWith(`meta:\n  name: funes\n  write_locus: ${w}\n`);
    expect(() => resolveWriteDesignation(v, { locus: "host-a", env: {} })).toThrow(/star\.yaml meta\.write_locus .*fail-closed/);
  }
});

test("designation: resolution takes the locus from resolveLocus, the authority from write_locus", () => {
  // the estate's shape after item 10: the policy stays, the machine is named beside it
  const v = vaultWith("meta:\n  name: funes\n  write_authority: member-local\n  write_locus: Host-A\n");
  expect(resolveWriteDesignation(v, { locus: "host-a", env: {} })).toEqual({ locus: "host-a", authority: "host-a" });
  expect(resolveWriteDesignation(v, { env: { FUNES_LOCUS: "host-b" } }).locus).toBe("host-b");
  expect(resolveWriteDesignation(v, { locus: "laptop", env: { FUNES_LOCUS: "host-b" } }).locus).toBe("laptop");
  expect(() => assertWriteAllowed(resolveWriteDesignation(v, { locus: " HOST-A ", env: {} }), "remember")).not.toThrow();
  // 0.3.0 compared against the POLICY value, so `--locus member-local` was "the designated writer".
  // It is not a machine, and it no longer matches anything.
  expect(() => assertWriteAllowed(resolveWriteDesignation(v, { locus: "member-local", env: {} }), "remember")).toThrow(/not-write-locus/);
  const policyOnly = vaultWith("meta:\n  name: funes\n  write_authority: member-local\n");
  expect(resolveWriteDesignation(policyOnly, { locus: "member-local", env: {} })).toEqual({ locus: "member-local", authority: null });
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

// Both surfaces resolve the designation ONCE at startup, as face.ts always did, so a refused
// star.yaml write_locus (PLAN-0.4.0 item 10) is a boot failure, not a tool error on the first write.
// (A refused LOCUS is a usage error there, exit 2 like `--ops` — which is a process.exit, so
// cli.test.ts drives it in a spawned process rather than here.)
test("designation: a refused write_locus fails at STARTUP on the stdio MCP surface, not on the first write", async () => {
  const { runMcp } = await import("./mcp-server.ts");
  const refused = vaultWith('meta:\n  name: funes\n  write_locus: "a@b"\n');
  await expect(runMcp({ vault: refused })).rejects.toThrow(/star\.yaml meta\.write_locus "a@b" carries "@"/);
});

// RAI-324 (RAI-302): THE write rule — a mutation proceeds when the star declares no write_locus, or
// when this process's locus equals it; otherwise it refuses. The locus is FUNES_LOCUS over the
// normalized short hostname, which only a Node/Bun process entry passes in.
test("the write rule: a table over the declared writer, the locus and where the locus came from", () => {
  const rows: Array<[writeLocus: string | null, env: Record<string, string>, hostname: string | undefined, allowed: boolean]> = [
    [null, {}, undefined, true], // undeclared, no locus
    [null, {}, "host-a.local", true], // undeclared, hostname locus
    [null, { FUNES_LOCUS: "laptop" }, "host-a", true], // undeclared, override
    ["host-a", {}, "host-a.local", true], // declared, hostname equal (short, FQDN dropped)
    ["host-a", {}, "Host-A", true], // declared, hostname equal after normalization
    ["host-a", {}, "laptop.example.ts.net", false], // declared, hostname different
    ["host-a", {}, undefined, false], // declared, no locus at all
    ["host-a", { FUNES_LOCUS: "host-a" }, "host-b", true], // declared, override equal (wins over the hostname)
    ["host-a", { FUNES_LOCUS: "host-b" }, "host-a", false], // declared, override different (wins over the hostname)
    ["funes-taste", { FUNES_LOCUS: "funes-taste" }, undefined, true], // the edge: FUNES_LOCUS, no hostname fallback
  ];
  for (const [writeLocus, env, hostname, allowed] of rows) {
    const locus = resolveLocus({ env, hostname });
    expect({ writeLocus, env, hostname, allowed: writeAllowed(writeLocus, locus) }).toEqual({ writeLocus, env, hostname, allowed });
  }
  expect(resolveLocus({ env: {}, hostname: "Host-A.local" })).toBe("host-a");
  expect(resolveLocus({ env: {}, hostname: "" })).toBeNull();
});

test("the write rule's refusal: code not-write-locus, writeLocus names the writer, and no endpoint field", () => {
  let err: (Error & Record<string, unknown>) | undefined;
  try { assertWriteAllowed({ locus: null, authority: "host-a" }, "forget"); }
  catch (e) { err = e as Error & Record<string, unknown>; }
  expect(err).toMatchObject({ code: "not-write-locus", writeLocus: "host-a" });
  expect(err).not.toHaveProperty("endpoint");
  expect(err!.message).toContain("not-write-locus");
});

// RAI-324, RAI-313: the hostname default lives only at the engine's entries. The kernel cannot reach
// it (lint:core refuses node:os; the Worker metafile gate checks the edge bundle). In the engine,
// process-locus.ts reads the hostname for a locus and write-lock.ts for the lock owner's host field,
// which is never a locus — so write-lock.ts does not import process-locus.ts.
test("the engine's hostname readers are process-locus.ts and write-lock.ts, and the lock never reads a locus", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const readers = readdirSync(import.meta.dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .filter((f) => /import \{[^}]*\bhostname\b[^}]*\} from "node:os"/.test(readFileSync(join(import.meta.dir, f), "utf8")));
  expect(readers.sort()).toEqual(["process-locus.ts", "write-lock.ts"]);
  expect(readFileSync(join(import.meta.dir, "write-lock.ts"), "utf8")).not.toContain("process-locus");
});

// RAI-302: a star.yaml that does not parse declares nothing knowable — not "no writer". A write
// refuses there; a read and the startup do not.
test("designation: a star.yaml that does not parse refuses every write, and resolves at startup", () => {
  const bad = vaultWith("meta: [this is not a mapping\n  write_locus: host-a\n");
  const d = resolveWriteDesignation(bad, { locus: "host-b", env: {} });
  expect(refusal(d.locus, d.authority)).toMatchObject({ code: "not-write-locus" });
  expect(refusal("host-a", resolveWriteDesignation(bad, { locus: "host-a", env: {} }).authority)).toMatchObject({ code: "not-write-locus" });
  expect(String(refusal(d.locus, d.authority))).toContain("star.yaml does not parse");
});

// RAI-322: the org export's star.yaml declares `<w>.export`. A process locus may never be one, so a
// write on the export refuses on every machine, the server host included.
test("designation: a process locus that ends in .export is REFUSED — the suffix names the org export", () => {
  expect(() => resolveLocus({ flag: "org-host.export", env: {} })).toThrow(/--locus .*\.export.*fail-closed/);
  expect(() => resolveLocus({ env: { FUNES_LOCUS: "Org-Host.EXPORT " } })).toThrow(/FUNES_LOCUS .*\.export.*fail-closed/);
  expect(resolveLocus({ flag: "org-host.exports", env: {} })).toBe("org-host.exports");
});
