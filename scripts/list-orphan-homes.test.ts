// RAI-332: list-orphan-homes recognizes a home by its published.db (RAI-306 S1), and names what the
// 0.3.0-0.5.0 protocol and killed runs leave behind as litter. It deletes nothing.
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("an S1 home is recognized by published.db, and generation.json, gen-*.db, .building.* and a stray T0 copy are its litter", () => {
  const root = mkdtempSync(join(tmpdir(), "orphan-homes-"));
  try {
    const base = join(root, "libsql");
    const s1 = join(base, "personal"), live = join(base, "scratch");
    mkdirSync(s1, { recursive: true });
    mkdirSync(live, { recursive: true });
    writeFileSync(join(s1, "owner-vault"), JSON.stringify({ id: "rainblow.ing/personal", vault: join(root, "vaults/personal") }) + "\n");
    for (const f of ["published.db", "published.db.prev", "index.db", "generation.json", "gen-0a1b2c.db", "published.db.building.4242.deadbeef", "published.db.t0.777", "gen-0a1b2c.db.retain"]) {
      writeFileSync(join(s1, f), "");
    }
    writeFileSync(join(live, "index.db"), "");
    const r = spawnSync(process.execPath, [join(import.meta.dir, "list-orphan-homes.ts")], {
      encoding: "utf8", env: { ...process.env, HOME: root, FUNES_HOME: root }, // the index base is <FUNES_HOME>/libsql
    });
    expect(r.status).toBe(0);
    const block = (home: string) => r.stdout.split("\n\n").find((b) => b.startsWith(`${home}\n`)) ?? "";
    expect(block(s1)).toContain("published     published.db present");
    expect(block(s1)).toContain("litter        gen-0a1b2c.db, gen-0a1b2c.db.retain, generation.json, published.db.building.4242.deadbeef, published.db.t0.777");
    expect(block(live)).toContain("published     published.db absent");
    expect(block(live)).toContain("litter        none");
    expect(r.stdout).toContain("1 serving a published.db · 1 carrying litter");
    expect(readdirSync(s1)).toHaveLength(9); // the eight files and the marker: it deletes nothing
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
