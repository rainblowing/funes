// PLAN-0.5.0 item 36 — the Cloudflare session script, dry-run with a stub `wrangler`.
//
// Each test builds a temp tree: a COPY of cf-session.sh at funes/scripts/, a stub wrangler where the
// package-pinned one lives (packages/funes-cf/node_modules/.bin/wrangler), a stub bot deploy script in
// the side-by-side checkout (../taste-bot/deploy.sh), and stubs first on PATH for npm and curl. Every
// stub appends one line per call to one log, and the stdin it was handed on the next line, so the log
// is the order of the session. Nothing here reaches Cloudflare.
import { test, expect } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = join(import.meta.dir, "cf-session.sh");
const URL = "https://funes-probe.example-sub.workers.dev";
const REPORT = '{"spike":{"pass":true},"probe":{"pass":true}}';

/** The one stub, symlinked in as wrangler, npm, curl and the bot's deploy.sh (one file, so macOS
 *  scans one new executable per run, not four per test). It logs `<name> <argv>` and, when stdin is
 *  not a terminal, `  stdin=<what it read>`. It exits 1 when FAKE_FAIL prefixes its line (e.g.
 *  `wrangler deploy`). wrangler's deploy prints a workers.dev URL; curl writes the report to -o. */
const STUB = `#!/usr/bin/env bash
name="$(basename "$0")"; [ "$name" = deploy.sh ] && name=bot-deploy
in=""; [ -t 0 ] || in="$(cat)"
echo "$name $*" >> "$CALLS"
[ -z "$in" ] || echo "  stdin=$in" >> "$CALLS"
case "$name $*" in "$FAKE_FAIL"*) [ -n "$FAKE_FAIL" ] && exit 1;; esac
[ "$name $1 $2" = "wrangler deploy -c" ] && echo "Deployed to ${URL}"
if [ "$name" = curl ]; then while [ $# -gt 0 ]; do [ "$1" = -o ] && printf '%s' '${REPORT}' > "$2"; shift; done; fi
exit 0
`;
const STUB_FILE = join(mkdtempSync(join(tmpdir(), "cf-session-stub-")), "stub");
writeFileSync(STUB_FILE, STUB);
chmodSync(STUB_FILE, 0o755);
const SLOW = 30_000;

function tree() {
  const t = mkdtempSync(join(tmpdir(), "cf-session-"));
  const root = join(t, "funes");
  const bin = join(t, "bin");
  const link = (path: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    symlinkSync(STUB_FILE, path);
  };
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(SCRIPT, join(root, "scripts", "cf-session.sh"));
  link(join(root, "packages/funes-cf/node_modules/.bin/wrangler"));
  link(join(t, "taste-bot/deploy.sh"));
  link(join(bin, "npm"));
  link(join(bin, "curl"));
  mkdirSync(join(t, "home"));
  const run = (args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}) => {
    const r = spawnSync("bash", [join(root, "scripts", "cf-session.sh"), ...args], {
      input: opts.stdin ?? "",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: join(t, "home"), CALLS: join(t, "calls"), FAKE_FAIL: "", ...opts.env },
      encoding: "utf8",
    });
    let calls = "";
    try { calls = readFileSync(join(t, "calls"), "utf8"); } catch {}
    return { status: r.status, out: r.stdout + r.stderr, calls: calls.replaceAll(root, "ROOT").trimEnd().split("\n").filter(Boolean) };
  };
  return { t, root, run };
}

const CF = "ROOT/packages/funes-cf";

test("a session: login, the acts in argv order, logout", () => {
  const { run } = tree();
  const r = run(["bucket-create", "funes-taste-vault", "secret-put", "TELEGRAM_LOGIN_KEY", "funes-taste", "deploy", "deploy-bot", "bucket-delete", "old-bucket"], { stdin: "v1\n" });
  expect(r.status).toBe(0);
  expect(r.calls).toEqual([
    "wrangler login",
    "wrangler r2 bucket create funes-taste-vault",
    "wrangler secret put TELEGRAM_LOGIN_KEY --name funes-taste",
    "  stdin=v1",
    "npm test",
    `wrangler deploy -c ${CF}/wrangler.jsonc`,
    "bot-deploy --in-session",
    "wrangler r2 bucket delete old-bucket",
    "wrangler logout",
  ]);
}, SLOW);

test("a failed act ends the session: the later acts never run, and logout still does", () => {
  const { run } = tree();
  const r = run(["deploy", "deploy-bot"], { env: { FAKE_FAIL: "wrangler deploy" } });
  expect(r.status).not.toBe(0);
  expect(r.calls).toEqual(["wrangler login", "npm test", `wrangler deploy -c ${CF}/wrangler.jsonc`, "wrangler logout"]);
}, SLOW);

test("deploy fails closed on funes-cf's workerd tests: no wrangler deploy", () => {
  const { run } = tree();
  const r = run(["deploy"], { env: { FAKE_FAIL: "npm test" } });
  expect(r.status).not.toBe(0);
  expect(r.calls).toEqual(["wrangler login", "npm test", "wrangler logout"]);
}, SLOW);

test("a failed login still logs out", () => {
  const { run } = tree();
  const r = run(["deploy"], { env: { FAKE_FAIL: "wrangler login" } });
  expect(r.status).not.toBe(0);
  expect(r.calls).toEqual(["wrangler login", "wrangler logout"]);
}, SLOW);

for (const [why, args, env] of [
  ["no act", [], {}],
  ["an unknown act", ["deploy", "versions-upload"], {}],
  ["--name", ["deploy", "--name", "funes-taste-2"], {}],
  ["--env", ["--env", "staging", "deploy"], {}],
  ["a bucket act without a name", ["bucket-create"], {}],
  ["a secret name that is not UPPER_SNAKE", ["secret-put", "telegram", "funes-taste"], {}],
  ["a secret for a Worker outside the list", ["secret-put", "FOO", "funes-taste-2"], {}],
  ["a Cloudflare API token in the environment", ["deploy"], { CLOUDFLARE_API_TOKEN: "x" }],
] as const) {
  test(`refuses ${why} before any login`, () => {
    const { run } = tree();
    const r = run([...args], { env: { ...env } });
    expect(r.status).not.toBe(0);
    expect(r.calls).toEqual([]);
  }, SLOW);
}

test("secret-put: each value comes from stdin, one line per act, never on argv and never echoed", () => {
  const { run } = tree();
  const a = "sentinel-a-7c1e9f";
  const b = "sentinel-b-2d84aa";
  const r = run(["secret-put", "TELEGRAM_BOT_TOKEN", "taste-bot", "secret-put", "OPENROUTER_API_KEY", "taste-bot"], { stdin: `${a}\n${b}\n` });
  expect(r.status).toBe(0);
  const argv = r.calls.filter((l) => !l.startsWith("  stdin="));
  expect(argv.join("\n")).not.toContain("sentinel");
  expect(r.calls).toContain(`  stdin=${a}`);
  expect(r.calls).toContain(`  stdin=${b}`);
  expect(r.out).not.toContain("sentinel");
}, SLOW);

test("secret-put refuses an empty value, and logs out", () => {
  const { run } = tree();
  const r = run(["secret-put", "TELEGRAM_BOT_TOKEN", "taste-bot"], { stdin: "" });
  expect(r.status).not.toBe(0);
  expect(r.calls).toEqual(["wrangler login", "wrangler logout"]);
}, SLOW);

test("probe: deploy, bearer piped in, call, report saved, Worker and throwaway bucket deleted before logout", () => {
  const { t, run } = tree();
  const r = run(["bucket-create", "funes-probe-spike", "probe"]);
  expect(r.status).toBe(0);
  const bearer = r.calls[r.calls.indexOf(`wrangler secret put PROBE_BEARER -c ${CF}/probe/wrangler.jsonc`) + 1]!.replace("  stdin=", "");
  expect(bearer).toMatch(/^[0-9a-f]{64}$/);
  const curl = r.calls.find((l) => l.startsWith("curl "))!;
  expect(curl).toContain(`${URL}/`);
  expect(curl).not.toContain(bearer);
  expect(r.calls.map((l) => l.replace(bearer, "BEARER").replace(/^curl .*/, "curl"))).toEqual([
    "wrangler login",
    "wrangler r2 bucket create funes-probe-spike",
    "npm test",
    `wrangler deploy -c ${CF}/probe/wrangler.jsonc`,
    `wrangler secret put PROBE_BEARER -c ${CF}/probe/wrangler.jsonc`,
    "  stdin=BEARER",
    "curl",
    "  stdin=Authorization: Bearer BEARER",
    `wrangler delete -c ${CF}/probe/wrangler.jsonc --force`,
    "wrangler r2 bucket delete funes-probe-spike",
    "wrangler logout",
  ]);
  expect(r.out).not.toContain(bearer);
  const dir = join(t, "home/.funes/cf-probe");
  const saved = readdirSync(dir);
  expect(saved).toHaveLength(1);
  expect(readFileSync(join(dir, saved[0]!), "utf8")).toBe(REPORT);
}, SLOW);

test("probe: a failed call still deletes the Worker and the throwaway bucket, then logs out", () => {
  const { run } = tree();
  const r = run(["bucket-create", "funes-probe-spike", "probe"], { env: { FAKE_FAIL: "curl" } });
  expect(r.status).not.toBe(0);
  expect(r.calls.slice(-3)).toEqual([`wrangler delete -c ${CF}/probe/wrangler.jsonc --force`, "wrangler r2 bucket delete funes-probe-spike", "wrangler logout"]);
}, SLOW);

test("the throwaway bucket never outlives the login, even when the session fails before the probe", () => {
  const { run } = tree();
  const r = run(["bucket-create", "funes-probe-spike", "deploy"], { env: { FAKE_FAIL: "npm test" } });
  expect(r.status).not.toBe(0);
  expect(r.calls.slice(-2)).toEqual(["wrangler r2 bucket delete funes-probe-spike", "wrangler logout"]);
}, SLOW);
