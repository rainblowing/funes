// `funes scan` — the share-clean gate (PLAN-0.5.0 item 22, ADR-0012 §The decision). It is what
// survived of the retired OKF exporter: that exporter's one live duty was this scan, which
// twinkl.ing ADR-0002 relies on before a star is shared. READ-ONLY on the vault — it opens no index
// and writes nothing there; gitleaks reads a throwaway copy of the scope in the OS temp dir.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { walkFolder } from "./folder-vault.ts";
import { redact } from "./redact.ts";

export interface ScanResult {
  /** Markdown files scanned — every `.md` the scope admits, reserved files and derivatives included. */
  files: number;
  /** Findings from the pure detector, which always runs: the file and a per-kind count, never the value. */
  regexFindings: Array<{ file: string; kinds: Record<string, number> }>;
  /** Findings from the gitleaks binary (run with --redact); empty when it did not run. */
  gitleaks: string[];
  /** false ⇒ gitleaks was not runnable. Never a pass on its own — the pure detector is the floor. */
  gitleaksRan: boolean;
}

/** Scan every markdown file under `vault` that `exclude` admits (the index scope's predicate).
 *  `redact()` runs over every file, always; gitleaks runs additionally when it is on PATH. Not
 *  `gitleaksRedact`: that fails OPEN when the binary is absent, and "could not scan" must never
 *  read as clean for something about to be shared. */
export function scanScope(vault: string, exclude?: (rel: string) => boolean): ScanResult {
  const copy = mkdtempSync(join(tmpdir(), "funes-scan-")); // 0700
  try {
    const regexFindings: ScanResult["regexFindings"] = [];
    let files = 0;
    for (const { path, rel } of walkFolder(vault, vault, (r) => r.endsWith(".md"), exclude)) {
      files++;
      const r = redact(readFileSync(path, "utf8"));
      if (r.count > 0) regexFindings.push({ file: rel, kinds: r.kinds });
      mkdirSync(dirname(join(copy, rel)), { recursive: true });
      copyFileSync(path, join(copy, rel));
    }

    // node:child_process, not Bun.spawnSync: the published artifact runs on Node.
    let gitleaksRan = false;
    const gitleaks: string[] = [];
    try {
      const run = spawnSync("gitleaks", ["dir", copy, "--no-banner", "--redact"], { encoding: "utf8" });
      if (!run.error && typeof run.status === "number") {
        gitleaksRan = true;
        if (run.status !== 0) {
          gitleaks.push(...`${run.stdout ?? ""}${run.stderr ?? ""}`.replaceAll(`${copy}/`, "").split("\n").filter(Boolean).slice(-12));
        }
      }
    } catch { /* absent or unrunnable — the pure detector already ran and is the floor */ }
    return { files, regexFindings, gitleaks, gitleaksRan };
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}
