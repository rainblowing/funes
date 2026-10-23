// A publisher in its own process, for the publication tests that need a second process (the fence is
// an fcntl lock, per process) or a real kill -9. Prints one JSON line: the result, or {ok:false,error}.
//   bun publish-child.ts <vault> <home> [--force] [--crash-at build|<step>] [--pause-at <step> --pause-ms N] [--wait-for <file>]
// A pause prints `paused <step>` first, so a test knows the fence is held.
import { existsSync, writeSync } from "node:fs";
import type { Embedder } from "funes-core";
import { publishReindex } from "../publication.ts";

/** The suite's deterministic bag-of-words embedder: signature `e:16`, no model. */
export class FakeEmbedder implements Embedder {
  readonly dim = 16;
  private vec(t: string): Float32Array {
    const v = new Float32Array(this.dim);
    for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) v[[...w].reduce((a, c) => a + c.charCodeAt(0), 0) % this.dim]! += 1;
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i]! /= n;
    return v;
  }
  async embedQuery(t: string) { return this.vec(t); }
  async embedPassage(t: string) { return this.vec(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.vec(t)); }
}

if (import.meta.main) {
  const [vault, home, ...rest] = process.argv.slice(2) as [string, string, ...string[]];
  const arg = (n: string): string | undefined => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const crashAt = arg("--crash-at");
  const pauseAt = arg("--pause-at");
  const waitFor = arg("--wait-for");
  while (waitFor && !existsSync(waitFor)) await Bun.sleep(5);
  try {
    const r = await publishReindex({
      vault, home, embedder: new FakeEmbedder(), force: rest.includes("--force"), batch: 1,
      onProgress: crashAt === "build" ? () => process.kill(process.pid, "SIGKILL") : undefined,
      onStep: (s) => {
        if (s === crashAt) process.kill(process.pid, "SIGKILL");
        if (s === pauseAt) { writeSync(1, `paused ${s}\n`); Bun.sleepSync(Number(arg("--pause-ms") ?? 0)); }
      },
    });
    console.log(JSON.stringify({ ok: true, ...r }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: (e as Error).message }));
    process.exitCode = 1;
  }
}
