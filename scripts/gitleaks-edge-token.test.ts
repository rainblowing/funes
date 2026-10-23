// PLAN-0.5.0 item 45 — the repo's .gitleaks.toml catches a minted edge bearer (ADR-0014).
//
// Runs /ship's gate verbatim (`gitleaks git --staged --redact --no-banner -v`) in a scratch git repo
// holding a copy of the root .gitleaks.toml: gitleaks reads `<source>/.gitleaks.toml` on its own, so
// this is the same lookup /ship and CI's gitleaks-action make here. The token is minted at run time
// in the ADR-0014 shape (`funes_` + 32 random bytes base64url), so this file never holds one.
// Skips where the binary is absent (CI's test job); CI's `secrets` job runs gitleaks with the config.
import { test, expect } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const it = Bun.which("gitleaks") ? test : test.skip;
const CONFIG = join(import.meta.dir, "..", ".gitleaks.toml");

function gate(content: string) {
  const repo = mkdtempSync(join(tmpdir(), "funes-gitleaks-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: repo });
    copyFileSync(CONFIG, join(repo, ".gitleaks.toml"));
    writeFileSync(join(repo, "notes.md"), content);
    spawnSync("git", ["add", "notes.md"], { cwd: repo });
    const report = join(repo, "report.json");
    const r = spawnSync("gitleaks", ["git", "--staged", "--redact", "--no-banner", "-v", "--report-path", report], { cwd: repo });
    const rules = (JSON.parse(readFileSync(report, "utf8")) as { RuleID: string }[]).map(f => f.RuleID);
    return { status: r.status, rules };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

it("a staged edge token fails the gate under the funes rule", () => {
  const token = "funes_" + randomBytes(32).toString("base64url");
  expect(token).toMatch(/^funes_[A-Za-z0-9_-]{43}$/);
  const { status, rules } = gate(`bearer: ${token}\n`);
  expect(status).not.toBe(0);
  expect(rules).toContain("funes-edge-token");
});

it("funes_ identifiers that are not tokens pass the gate", () => {
  const { status, rules } = gate("funes_store, funes_index_scope_hash_is_a_long_name_and_not_a_bearer_token are names\n");
  expect(rules).toEqual([]);
  expect(status).toBe(0);
});
