// B5 (RAI-337; RAI-310 D6): `funes token mint`, one verb with two sinks over one row builder. The
// local sink adds an actor to a v2 access file; the edge sink prints the revoke-and-insert
// transaction for a star key's Durable Object. Neither prints a token.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateGrants, type GrantRow } from "funes-core/internal";
import { readAccessPolicy } from "./actor.ts";
import { grantFor } from "funes-core/internal";


const CLI = join(import.meta.dir, "cli.ts");
const REPO = resolve(import.meta.dir, "..", "..", "..");
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

async function mint(args: string[], home: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", CLI, "token", "mint", ...args], { cwd: REPO, env: { ...process.env, FUNES_HOME: home }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

const withDir = async (fn: (d: string) => Promise<void>) => {
  const d = mkdtempSync(join(tmpdir(), "funes-mint-"));
  try { await fn(d); } finally { rmSync(d, { recursive: true, force: true }); }
};

const ACCESS = (d: string) => {
  const p = join(d, "access.json");
  writeFileSync(p, JSON.stringify({
    version: 2,
    roles: { reader: { ops: ["recall", "health"] }, curator: { ops: ["recall", "remember"] } },
    actors: { old: { token_sha256: sha("tok-old"), role: "reader", stars: ["*"] } },
  }));
  chmodSync(p, 0o600);
  return p;
};

test("the local sink: a 0600 token file, the actor in the access file, and only paths on stdout", async () => {
  await withDir(async (d) => {
    const access = ACCESS(d);
    const out = join(d, "alice.cap");
    const r = await mint(["--access", access, "--actor", "alice", "--role", "curator", "--star", "rainblow.ing/a", "--star", "rainblow.ing/b", "--out", out], d);
    expect(r.code, r.err).toBe(0);
    const token = readFileSync(out, "utf8");
    expect(token).toMatch(/^funes_[A-Za-z0-9_-]{43}$/);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(statSync(access).mode & 0o777).toBe(0o600);
    expect(r.out + r.err).not.toContain(token);
    expect(r.out).toContain(out);
    const policy = readAccessPolicy(access);
    expect(policy).not.toBe("v1");
    const g = grantFor(policy as Exclude<typeof policy, "v1">, token)!;
    expect({ actor: g.actor, ops: [...g.ops].sort(), stars: g.stars }).toEqual({ actor: "alice", ops: ["recall", "remember"], stars: ["rainblow.ing/a", "rainblow.ing/b"] });
    expect(grantFor(policy as Exclude<typeof policy, "v1">, "tok-old")?.actor).toBe("old"); // the other actors stay

    // a second mint to the same --out refuses, and leaves the file and the access file as they were
    const before = readFileSync(access, "utf8");
    const again = await mint(["--access", access, "--actor", "alice", "--role", "curator", "--star", "*", "--out", out], d);
    expect(again.code).not.toBe(0);
    expect(readFileSync(out, "utf8")).toBe(token);
    expect(readFileSync(access, "utf8")).toBe(before);
  });
}, 30_000);

test("the local sink refuses a role the file does not define, and changes nothing", async () => {
  await withDir(async (d) => {
    const access = ACCESS(d);
    const before = readFileSync(access, "utf8");
    const r = await mint(["--access", access, "--actor", "alice", "--role", "admin", "--star", "*", "--out", join(d, "a.cap")], d);
    expect(r.code).toBe(1);
    expect(r.err).toContain('role "admin"');
    expect(readFileSync(access, "utf8")).toBe(before);
    expect(() => statSync(join(d, "a.cap"))).toThrow();
  });
}, 30_000);

test("the edge sink prints one transaction that passes the edge row checks; a second mint leaves one live row", async () => {
  await withDir(async (d) => {
    const db = new Database(":memory:");
    db.run(`create table grants(token_sha256 text primary key, actor text not null, role text not null, stars text not null,
      created_at text not null, expires_at text, revoked_at text, label text not null)`);
    const tokens: string[] = [];
    for (const [n, role, label] of [[1, "agent", "claude-code"], [2, "agent", "claude-code"], [3, "bot", "taste"]] as const) {
      const out = join(d, `${role}-${n}.cap`);
      const r = await mint(["--edge", "rainblow.ing/taste", "--role", role, "--label", label, "--star", "rainblow.ing/taste", "--out", out], d);
      expect(r.code, r.err).toBe(0);
      const token = readFileSync(out, "utf8");
      tokens.push(token);
      expect(r.out).not.toContain(token);
      expect(r.out).toContain("rainblow.ing/taste");
      expect(r.out).toMatch(/BEGIN TRANSACTION;[\s\S]*UPDATE grants[\s\S]*INSERT INTO grants[\s\S]*COMMIT;/);
      db.exec(r.out); // as the deploy login runs it
    }
    const live = db.query("select * from grants where revoked_at is null").all() as GrantRow[];
    expect(live.map((x) => x.actor)).toEqual(["agent:claude-code", "bot:taste"]); // RAI-316: the bot actor is bot:<label>
    expect(live[0]!.token_sha256).toBe(sha(tokens[1]!));
    expect(live[0]!.expires_at).not.toBeNull();
    expect(() => validateGrants(live)).not.toThrow();
  });
}, 30_000);

test("the edge sink takes no --actor, and the two sinks do not mix", async () => {
  await withDir(async (d) => {
    const base = ["--role", "agent", "--label", "x", "--star", "rainblow.ing/taste", "--out", join(d, "x.cap")];
    expect((await mint(["--edge", "rainblow.ing/taste", "--actor", "x", ...base], d)).code).toBe(2);
    expect((await mint(["--edge", "rainblow.ing/taste", "--access", join(d, "a.json"), ...base], d)).code).toBe(2);
    expect((await mint(["--edge", "rainblow.ing/taste", "--bogus", ...base], d)).code).toBe(2);
    expect((await mint(["--edge", "not a key", ...base], d)).code).toBe(2);
    // a --star the object at --edge does not serve gives a token that object refuses forever
    const other = await mint(["--edge", "rainblow.ing/other", ...base], d);
    expect(other.code).toBe(2);
    expect(other.err).toContain("rainblow.ing/taste");
    expect((await mint(["--edge", "rainblow.ing/taste", ...base.slice(0, 4), "--star", "git://rainblow.ing/taste", "--out", join(d, "y.cap")], d)).code).toBe(0);
  });
}, 30_000);
