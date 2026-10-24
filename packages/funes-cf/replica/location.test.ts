import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertReplicaLocation } from "./location.ts";

// Record 29 §2: the replica's paths — `~/taste`, the canon mirror, the endpoint file, every token and
// credential file, and `stateDirFor` — refuse inside a synced or versioned tree. The walk starts at the
// PARENT, so `~/taste` holding its own star.yaml is not refused by it.
test("location refusal: outside every synced, versioned or star tree it passes; inside one it refuses and names why", () => {
  const home = mkdtempSync(join(tmpdir(), "funes-loc-home-"));
  try {
    const at = (...p: string[]) => { const path = join(home, ...p); mkdirSync(path, { recursive: true }); return path; };
    const taste = at("taste");
    writeFileSync(join(taste, "star.yaml"), "meta:\n  id: mcp://rainblow.ing/taste\n");
    for (const ok of [taste, join(home, ".funes", "endpoints.json"), join(at(".funes", "state", "taste-0123456789"), "canon")]) {
      expect(() => assertReplicaLocation(ok, home), ok).not.toThrow();
    }
    const refused: Array<[string, RegExp]> = [
      [join(at("Documents"), "taste"), /Documents/],
      [join(at("Desktop"), "taste"), /Desktop/],
      [join(at("Library", "Mobile Documents"), "taste"), /Mobile Documents/],
      [join(at("Library", "CloudStorage", "Dropbox-Personal"), "taste"), /CloudStorage/],
      [join(at("code", "repo", "sub"), "taste"), /\.git/],
      [join(at("Sync"), "endpoints.json"), /\.stfolder/],
      [join(at("vault", "deep"), "taste"), /star\.yaml/],
    ];
    mkdirSync(join(home, "code", "repo", ".git"));
    writeFileSync(join(home, "Sync", ".stfolder"), "");
    writeFileSync(join(home, "vault", "star.yaml"), "meta:\n  name: personal\n");
    for (const [path, why] of refused) {
      expect(() => assertReplicaLocation(path, home), path).toThrow(why);
      expect(() => assertReplicaLocation(path, home), path).toThrow(/fail-closed/);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
