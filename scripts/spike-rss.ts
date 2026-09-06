// Spike 1 (RAI-39, docs/funes-mcp-hub.architecture.md): does ONE process with N stores and ONE
// shared E5Embedder cost materially less RSS than N processes with one store and one embedder each?
//
// Decision rule from the architecture doc: proceed if one process is well under half the
// eight-process total. Measured 2026-08-22 — see the architecture doc for the result and its reading.
//
// Usage (from the repo root):
//   bun scripts/spike-rss.ts multi           one process, all stars, one embedder
//   bun scripts/spike-rss.ts single <star>   one process, one star, its own embedder
//   bun scripts/spike-rss.ts compare         multi, then one `single` per star, summing peak RSS
//
// Every open is READ-ONLY (libsql mode=ro): a measurement must never touch a live index.
import { makeStore } from "../packages/funes-engine/src/factory.ts";
import { E5Embedder } from "../packages/funes-engine/src/embedder.ts";
import { homedir } from "node:os";
import { join } from "node:path";

/** The eight stars that actually hold an index on this machine (FUNES_LIBSQL_DIR default home). */
const STARS = ["personal", "bigvault", "pieui", "guarding", "alphai", "memegen", "kchain", "dacha"];
const QUERY = "how does publishing work";
const dbOf = (star: string): string => join(process.env.FUNES_LIBSQL_DIR ?? join(homedir(), ".twinkling", "libsql"), star, "index.db");
const mb = (bytes: number): number => Math.round(bytes / 1024 / 1024);
const rss = (): number => mb(process.memoryUsage.rss());

async function openAndRecall(star: string, embedder: E5Embedder): Promise<number> {
  const store = await makeStore({ dbDir: dbOf(star), embedder, readonly: true });
  return (await store.recall({ query: QUERY, k: 5 })).length;
}

async function multi(stars: string[]): Promise<Record<string, unknown>> {
  const baselineMb = rss();
  const embedder = new E5Embedder(); // the lever under test: ONE embedder for every store
  const steps: Array<{ star: string; hits: number; rssMb: number }> = [];
  for (const star of stars) steps.push({ star, hits: await openAndRecall(star, embedder), rssMb: rss() });
  return { mode: "multi", stars: stars.length, baselineMb, afterFirstMb: steps[0]?.rssMb, peakMb: rss(), steps };
}

async function single(star: string): Promise<Record<string, unknown>> {
  const baselineMb = rss();
  const hits = await openAndRecall(star, new E5Embedder()); // its own embedder — the N-process case
  return { mode: "single", star, hits, baselineMb, peakMb: rss() };
}

const [mode, arg] = process.argv.slice(2);

if (mode === "single") {
  console.log(JSON.stringify(await single(arg ?? "personal")));
} else if (mode === "multi") {
  console.log(JSON.stringify(await multi(STARS), null, 2));
} else if (mode === "compare") {
  const one = await multi(STARS);
  const singles: Array<Record<string, unknown>> = [];
  for (const star of STARS) { // sequential: 8 concurrent model loads is memory pressure, not signal
    const p = Bun.spawn(["bun", import.meta.path, "single", star], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    try { singles.push(JSON.parse(out.trim().split("\n").pop() ?? "{}")); }
    catch { singles.push({ star, error: out.slice(0, 200) }); }
  }
  const eightSumMb = singles.reduce((a, s) => a + (Number(s.peakMb) || 0), 0);
  console.log(JSON.stringify({
    onePeakMb: one.peakMb,
    eightSumMb,
    ratio: Number((Number(one.peakMb) / eightSumMb).toFixed(3)),
    rulePassed: Number(one.peakMb) < eightSumMb / 2,
    one,
    singles,
  }, null, 2));
} else {
  console.error("usage: spike-rss.ts multi | single <star> | compare");
  process.exit(2);
}
