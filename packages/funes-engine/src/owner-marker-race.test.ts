import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// P3.15 step 12. assertIndexOwner did read-then-write: `if (!current) { writeMine(); return; }`.
// Two DIFFERENT stars sharing a folder basename — the exact scenario the marker exists to catch —
// could both observe no marker and both claim the index. The guard was defeated at the one moment
// it needed to fire: first open. Only a real race exposes it, so this spawns processes.

test("only ONE of N concurrent first-openers may claim an index dir", async () => {
  const root = mkdtempSync(join(tmpdir(), "funes-owner-race-"));
  try {
    const indexDir = join(root, "shared-index");
    const runner = join(root, "claim.ts");
    writeFileSync(runner, `
import { assertIndexOwner } from ${JSON.stringify(join(import.meta.dir, "factory.ts"))};
import { existsSync } from "node:fs";
const [indexDir, vault, gate] = process.argv.slice(2);
// Barrier: every child is already loaded and spinning, so they all enter the claim together.
// Without this, bun's startup jitter serializes them and the race never happens.
while (!existsSync(gate!)) {}
try { assertIndexOwner(indexDir!, vault!); console.log("CLAIMED"); }
catch (e) { console.log("REFUSED:" + (e as Error).message.slice(0, 40)); }
`);

    // 8 distinct vaults, no star.yaml (so the path-fallback arm decides), all pointed at one index.
    const vaults = Array.from({ length: 8 }, (_, i) => {
      const v = join(root, `star-${i}`, "notes");
      mkdirSync(v, { recursive: true });
      return v;
    });

    const gate = join(root, "GO");
    const procs = vaults.map((v) => Bun.spawn(["bun", runner, indexDir, v, gate], { stdout: "pipe", stderr: "ignore" }));
    await Bun.sleep(900); // let every child reach the spin
    writeFileSync(gate, "go");
    const outs = await Promise.all(procs.map((p) => new Response(p.stdout).text()));
    const claimed = outs.filter((o) => o.includes("CLAIMED")).length;
    const refused = outs.filter((o) => o.includes("REFUSED")).length;

    expect(claimed).toBe(1);            // exactly one owner
    expect(refused).toBe(vaults.length - 1); // everyone else hard-stops
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("the winner keeps the index on re-open, and no temp marker is left behind", async () => {
  const root = mkdtempSync(join(tmpdir(), "funes-owner-keep-"));
  try {
    const { assertIndexOwner } = await import("./factory.ts");
    const indexDir = join(root, "idx");
    const a = join(root, "a", "notes");
    const b = join(root, "b", "notes");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });

    assertIndexOwner(indexDir, a);
    assertIndexOwner(indexDir, a); // idempotent for the owner
    expect(() => assertIndexOwner(indexDir, b)).toThrow(/index collision/);

    const { readdirSync } = await import("node:fs");
    expect(readdirSync(indexDir)).toEqual(["owner-vault"]); // link temp cleaned up
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
