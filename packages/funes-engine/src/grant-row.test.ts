// B5 (RAI-337; RAI-310 D6): the one edge grant-row builder. The CLI's `token mint --edge` and the
// Telegram `/mint` both build a row here, and both run the same revoke-and-insert statements.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { grantRow, validateGrants, type GrantRow } from "funes-core/internal";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
/** The edge store's grants table (funes-cf edge-store.ts), in SQLite. */
const grantsDb = () => {
  const db = new Database(":memory:");
  db.run(`create table grants(token_sha256 text primary key, actor text not null, role text not null, stars text not null,
    created_at text not null, expires_at text, revoked_at text, label text not null)`);
  return db;
};
const live = (db: Database) => db.query("select * from grants where revoked_at is null").all() as GrantRow[];

test("an agent row: a funes_ token, its sha256, the derived actor and the 90-day expiry", () => {
  const { row, token } = grantRow({ role: "agent", label: "claude-code", stars: ["rainblow.ing/taste"] }, NOW);
  expect(token).toMatch(/^funes_[A-Za-z0-9_-]{43}$/);
  expect(row).toEqual({
    token_sha256: sha(token), actor: "agent:claude-code", role: "agent", stars: '["rainblow.ing/taste"]',
    created_at: NOW.toISOString(), expires_at: "2027-01-19T12:00:00.000Z", revoked_at: null, label: "claude-code",
  });
  expect(() => validateGrants([row])).not.toThrow();
  expect(grantRow({ role: "bot", label: "bot", stars: ["rainblow.ing/taste"] }, NOW).row).toMatchObject({ actor: "bot:bot", expires_at: null });
  expect(grantRow({ role: "bot", label: "bot", stars: ["rainblow.ing/taste"], days: 7 }, NOW).row.expires_at).toBe("2026-10-28T12:00:00.000Z");
});

test("a bad role, label, star list or day count refuses the row", () => {
  const ok = { role: "agent", label: "a", stars: ["rainblow.ing/taste"] };
  expect(() => grantRow({ ...ok, role: "admin" }, NOW)).toThrow(/unknown role "admin"/);
  expect(() => grantRow({ ...ok, label: "bad name" }, NOW)).toThrow(/not a usable actor name/);
  expect(() => grantRow({ ...ok, stars: [] }, NOW)).toThrow(/stars/);
  expect(() => grantRow({ ...ok, stars: ["not a star"] }, NOW)).toThrow(/stars/);
  expect(() => grantRow({ ...ok, days: 0 }, NOW)).toThrow(/days/);
});

test("the statements revoke the actor's live row, so a second mint for one label leaves one live row", () => {
  const db = grantsDb();
  const run = (role: string, label: string) => {
    const m = grantRow({ role, label, stars: ["rainblow.ing/taste"] }, NOW);
    db.transaction(() => { for (const s of m.sql) db.run(s); })();
    return m;
  };
  run("agent", "claude-code");
  const second = run("agent", "claude-code");
  run("outbox", "replica");
  run("outbox", "replica-2"); // every live outbox row goes: there is one outbox
  run("bot", "bot");
  const rows = live(db);
  expect(rows.map((r) => r.actor).sort()).toEqual(["agent:claude-code", "bot:bot", "outbox@replica-2"]);
  expect(rows.find((r) => r.actor === "agent:claude-code")!.token_sha256).toBe(second.row.token_sha256);
  expect(() => validateGrants(rows)).not.toThrow();
});
