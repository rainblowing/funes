// Record 35 N9 (Phase 0): a `funes home move` with a pending taste proposal, on a scratch HOME whose
// outbox targets a LOCAL funes-taste — this package's entry and DO under `wrangler dev` with the test
// config (test/local-endpoint.entry.ts: a fake env.AI, and a test outbox grant provisioned by the
// named statement). The outbox, dismissed/, replica.json and canon/ survive the move, the canon's
// owner-vault is rewritten to its new path on the next open, and the pending proposal answers
// applied, its redelivery already-applied. Never against a real home or the edge: no Cloudflare
// login, CLOUDFLARE_* stripped, metrics off. The engine half (test/n9.engine.ts) runs under Bun.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PKG = join(import.meta.dirname, "..");

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address() as { port: number };
    s.close(() => resolve(port));
  });
});

const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLOUDFLARE_") && !k.startsWith("FUNES_")));
let dev: ChildProcess;
let base: string;
const persist = mkdtempSync(join(tmpdir(), "funes-cf-n9-"));
const home = realpathSync(mkdtempSync(join(tmpdir(), "funes-n9-home-")));

beforeAll(async () => {
  const [port, inspector] = [await freePort(), await freePort()];
  dev = spawn(join(PKG, "node_modules/.bin/wrangler"), [
    "dev", "test/local-endpoint.entry.ts", "-c", "wrangler.test.jsonc", "--ip", "127.0.0.1", "--port", String(port),
    "--inspector-port", String(inspector), "--local-protocol", "https", "--persist-to", persist, "--show-interactive-dev-session=false",
  ], { cwd: PKG, env: { ...clean, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  await new Promise<void>((resolve, reject) => {
    const seen = (b: Buffer) => { out += b; if (out.includes("Ready on")) resolve(); };
    dev.stdout!.on("data", seen);
    dev.stderr!.on("data", seen);
    dev.on("exit", (code) => reject(new Error(`wrangler dev exited ${code}:\n${out}`)));
  });
  base = `https://127.0.0.1:${port}`;
}, 90_000);

// workerd writes to --persist-to until wrangler has exited: remove it only after, SIGKILL if it hangs.
afterAll(async () => {
  if (dev && dev.exitCode === null && dev.signalCode === null) {
    const exited = new Promise((r) => dev.once("exit", r));
    dev.kill("SIGTERM");
    const kill = setTimeout(() => dev.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(kill);
  }
  rmSync(persist, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}, 20_000);

/** One engine phase in a fresh Bun process under the scratch HOME; its one JSON line. The local
 *  workerd's certificate is self-signed, so this process alone skips TLS verification. */
function engine(...args: string[]): Record<string, any> {
  const r = spawnSync("bun", [join(PKG, "test/n9.engine.ts"), ...args], {
    cwd: PKG, encoding: "utf8", env: { ...clean, HOME: home, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
  });
  expect(r.status, `${args[0]}: ${r.stderr}`).toBe(0);
  return JSON.parse(r.stdout.trim().split("\n").at(-1)!);
}

describe("N9: a home move with a pending taste proposal, against a local funes-taste", () => {
  it("the outbox survives, owner-vault is rewritten, and the proposal answers applied, then already-applied", async () => {
    const url = `${base}/mcp`;
    const before = engine("before", url);
    expect(before.provisioned).toBe(200);
    expect(before.home).toBe(join(home, ".twinkling"));
    expect(before.ownerVault).toBe(before.canon);
    expect(before.canon.startsWith(join(home, ".twinkling", "state"))).toBe(true);

    expect(engine("move").log.at(-1)).toBe(`the funes home is ${join(home, ".funes")}`);

    const after = engine("after", url);
    expect(after.home).toBe(join(home, ".funes"));
    expect(after.survived).toEqual({ outbox: [[before.proposalId, "pending"]], dismissed: true, replica: true, canon: true });
    expect(after.canon).toBe(before.canon.replace(join(home, ".twinkling"), join(home, ".funes")));
    expect(after.ownerVault).toBe(after.canon);
    expect(after.drained).toMatchObject({ probe: "ok", applied: [before.proposalId], refused: [], retried: [] });
    expect(after.again).toMatchObject({ answer: { proposalId: before.proposalId, status: "already-applied" } });
    expect(after.left).toBe(0);
  }, 120_000);
});
