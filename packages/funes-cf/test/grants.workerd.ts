// PLAN-0.5.0 item 42 (ADR-0014, record 32): the edge face's grants, read from the DO's own SQLite on
// every request, and the host ceiling at dispatch. The ceiling and preset tests are generated from
// the op registry, so a new op is refused at the edge until someone names it here.
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Embedder } from "funes-core";
import { ceiling, dispatchToolCall, type OperationContext } from "funes-core";
import { grantRow, operations, PRESETS, validateGrants, type StarConfig } from "funes-core/internal";
import { EdgeStore } from "../src/edge-store.ts";
import { EDGE_OPERATIONS, grantForRequest, HOST_CEILING, liveGrantRows } from "../src/grants.ts";
import { FIXTURE_KEY } from "./fixture-star.ts";

class OneHot implements Embedder {
  readonly dim = 1024;
  readonly id = "test/one-hot";
  private v(t: string) { const v = new Float32Array(1024); v[t.length % 1024] = 1; return v; }
  async embedQuery(t: string) { return this.v(t); }
  async embedPassage(t: string) { return this.v(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.v(t)); }
}

const STAR = {
  identity: { id: FIXTURE_KEY, writeLocus: "funes-taste" },
  scope: { kind: "valid", excludes: [] },
} as unknown as StarConfig;
const NOW = new Date("2026-10-13T12:00:00Z");
const ULID = "01JA0000000000000000000000";
const token = (c: string) => `funes_${c.repeat(43)}`;
const sha256 = async (t: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join("");

interface Row { token: string; actor: string; role: string; label: string; stars?: string; expires_at?: string | null; revoked_at?: string | null }

/** A fresh DO whose grants table holds `rows`; `fn` runs inside it with the DO's SQL. */
async function withGrants(rows: Row[], fn: (sql: SqlStorage) => Promise<void> | void): Promise<void> {
  const hashed = await Promise.all(rows.map(async (r) => ({ ...r, hash: await sha256(r.token) })));
  await runInDurableObject(env.STAR.getByName(crypto.randomUUID()), async (_o, state) => {
    new EdgeStore(state.storage, new OneHot()); // the protocol tables are the edge store's schema (item 37)
    for (const r of hashed) {
      state.storage.sql.exec(
        "insert into grants(token_sha256, actor, role, stars, created_at, expires_at, revoked_at, label) values (?, ?, ?, ?, ?, ?, ?, ?)",
        r.hash, r.actor, r.role, r.stars ?? JSON.stringify([FIXTURE_KEY]), "2026-10-01T00:00:00Z", r.expires_at ?? null, r.revoked_at ?? null, r.label,
      );
    }
    await fn(state.storage.sql);
  });
}

const OUTBOX: Row = { token: token("o"), actor: "outbox@replica", role: "outbox", label: "replica" };
const BOT: Row = { token: token("b"), actor: "bot:bot", role: "bot", label: "bot" };
const AGENT: Row = { token: token("a"), actor: "agent:claude-code", role: "agent", label: "claude-code", expires_at: "2027-01-01T00:00:00Z" };

const ctxFor = (grant: OperationContext["grant"]) =>
  ({ star: () => STAR, grant, tier: "edge", designation: { locus: "funes-taste", authority: "funes-taste" } }) as unknown as OperationContext;

/** How a dispatch refused: the thrown error's code or message, or the proposal answer's reason. */
async function refusalOf(ops: typeof operations, name: string, args: Record<string, unknown>, ctx: OperationContext): Promise<string> {
  try {
    const out = await dispatchToolCall(name, args, ctx) as { status?: string; reason?: string };
    return out.status === "refused" ? `answer:${out.reason}` : "served";
  } catch (e) {
    return String((e as { code?: string }).code ?? (e as Error).message);
  }
}

it("the host ceiling is ceiling(\"edge\"), and every preset is a role inside it (ADR-0020)", () => {
  expect([...HOST_CEILING].sort()).toEqual(["forget", "health", "indexed_page", "page", "put_page", "recall"]);
  expect(HOST_CEILING).toEqual(ceiling("edge").map((o) => o.name));
  expect(PRESETS.outbox.ops).toEqual(["put_page", "health"]);
  expect(PRESETS.bot.ops).toEqual(["recall", "health", "page", "put_page", "forget"]);
  expect(PRESETS.agent.ops).toEqual(["recall", "indexed_page", "health"]);
  for (const p of Object.values(PRESETS)) for (const op of p.ops) expect(HOST_CEILING, op).toContain(op);
});

it("every registry op outside the host ceiling refuses at dispatch, whatever the grant", async () => {
  const outside = operations.filter((o) => !HOST_CEILING.includes(o.name));
  expect(outside.length).toBeGreaterThan(0);
  const everything = { actor: "test", ops: new Set(operations.map((o) => o.name)), stars: ["*"] };
  for (const op of outside) {
    expect(await refusalOf(EDGE_OPERATIONS, op.name, { proposalId: ULID }, ctxFor(everything)), op.name).toBe(`unknown operation: ${op.name}`);
  }
});

it("every ceiling op outside a preset refuses at dispatch as not granted, a proposal as `not-granted`", async () => {
  await withGrants([OUTBOX, BOT, AGENT], async (sql) => {
    for (const [role, row] of [["outbox", OUTBOX], ["bot", BOT], ["agent", AGENT]] as const) {
      const grant = grantForRequest(sql, row.token, NOW);
      expect(grant?.actor, role).toBe(row.actor);
      for (const op of EDGE_OPERATIONS.filter((o) => !PRESETS[role].ops.includes(o.name))) {
        const got = await refusalOf(EDGE_OPERATIONS, op.name, { proposalId: ULID }, ctxFor(grant!));
        expect(got, `${role} ${op.name}`).toBe(op.readonly ? "not-granted" : "answer:not-granted");
      }
    }
  });
});

it("a live, unexpired row resolves its token to the preset's ops; unknown, revoked and expired tokens get none", async () => {
  const revoked: Row = { token: token("r"), actor: "agent:old", role: "agent", label: "old", expires_at: "2027-01-01T00:00:00Z", revoked_at: "2026-10-02T00:00:00Z" };
  const expired: Row = { token: token("e"), actor: "agent:stale", role: "agent", label: "stale", expires_at: "2026-10-13T11:59:59Z" };
  await withGrants([OUTBOX, BOT, AGENT, revoked, expired], (sql) => {
    const bot = grantForRequest(sql, BOT.token, NOW)!;
    expect(bot.actor).toBe("bot:bot");
    expect([...bot.ops]).toEqual(PRESETS.bot.ops);
    expect(bot.stars).toEqual([FIXTURE_KEY]);
    expect(grantForRequest(sql, AGENT.token, NOW)?.actor).toBe("agent:claude-code");
    expect(grantForRequest(sql, token("u"), NOW)).toBeNull();
    expect(grantForRequest(sql, revoked.token, NOW)).toBeNull();
    expect(grantForRequest(sql, expired.token, NOW)).toBeNull();
    expect(grantForRequest(sql, null, NOW)).toBeNull();
  });
});

it("an empty grants table refuses everyone", async () => {
  await withGrants([], (sql) => expect(grantForRequest(sql, BOT.token, NOW)).toBeNull());
});

// Record 35 A8/A9: one malformed live row refuses every token, the good ones included (everyone 401).
const MALFORMED: Array<[string, Row]> = [
  ["the outbox actor with role bot (record 35 A9)", { token: token("x"), actor: "outbox@replica", role: "bot", label: "bot" }],
  ["an outbox actor that is not outbox@<label>", { token: token("x"), actor: "outbox@other", role: "outbox", label: "replica" }],
  ["an unknown role", { token: token("x"), actor: "bot:x", role: "admin", label: "x" }],
  ["an agent actor that is not agent:<label>", { token: token("x"), actor: "agent:other", role: "agent", label: "mine", expires_at: "2027-01-01T00:00:00Z" }],
  ["an agent row with no expiry", { token: token("x"), actor: "agent:forever", role: "agent", label: "forever" }],
  ["a label with a space", { token: token("x"), actor: "bot:my bot", role: "bot", label: "my bot" }],
  ["stars that are not JSON", { token: token("x"), actor: "agent:x", role: "agent", label: "x", stars: FIXTURE_KEY, expires_at: "2027-01-01T00:00:00Z" }],
  ["empty stars", { token: token("x"), actor: "agent:x", role: "agent", label: "x", stars: "[]", expires_at: "2027-01-01T00:00:00Z" }],
  ["an unparsable expiry", { token: token("x"), actor: "agent:x", role: "agent", label: "x", expires_at: "soon" }],
];
for (const [why, bad] of MALFORMED) {
  it(`one malformed grant row refuses everyone: ${why}`, async () => {
    // The good rows never share the bad row's actor (nor, for an outbox row, its role), so each case
    // fails on its own rule alone.
    const good = [OUTBOX, BOT, AGENT].filter((g) => g.actor !== bad.actor && !(g.role === "outbox" && bad.role === "outbox"));
    await withGrants(good, (sql) => expect(grantForRequest(sql, good[0]!.token, NOW)).not.toBeNull());
    await withGrants([...good, bad], (sql) => {
      for (const g of good) expect(grantForRequest(sql, g.token, NOW), g.actor).toBeNull();
    });
  });
}

it("one malformed grant row refuses everyone: a second live row for one actor", async () => {
  await withGrants([OUTBOX, BOT, AGENT, { token: token("x"), actor: "bot:bot", role: "bot", label: "bot" }], (sql) => {
    for (const g of [OUTBOX, BOT, AGENT]) expect(grantForRequest(sql, g.token, NOW), g.actor).toBeNull();
  });
});

it("one malformed grant row refuses everyone: a second live outbox row, under another locus", async () => {
  await withGrants([OUTBOX, BOT, AGENT, { token: token("x"), actor: "outbox@elsewhere", role: "outbox", label: "elsewhere" }], (sql) => {
    for (const g of [OUTBOX, BOT, AGENT]) expect(grantForRequest(sql, g.token, NOW), g.actor).toBeNull();
  });
});

it("a malformed hash refuses everyone", async () => {
  await withGrants([OUTBOX], (sql) => {
    sql.exec("insert into grants(token_sha256, actor, role, stars, created_at, label) values ('ABC', 'bot:bot', 'bot', ?, '2026-10-01T00:00:00Z', 'bot')", JSON.stringify([FIXTURE_KEY]));
    expect(grantForRequest(sql, OUTBOX.token, NOW)).toBeNull();
  });
});

it("a revoked malformed row is not live and refuses no one", async () => {
  await withGrants([OUTBOX, { token: token("x"), actor: "outbox@replica", role: "bot", label: "bot", revoked_at: "2026-10-02T00:00:00Z" }], (sql) => {
    expect(grantForRequest(sql, OUTBOX.token, NOW)?.actor).toBe("outbox@replica");
  });
});

// RAI-310 probe 7: what `funes token mint --edge` prints is grantRow's statements, run as the deploy
// login runs them, in the star key's DO. Twice for one label leaves one live row, and the rows validate.
it("the edge mint's statements, run twice in the DO for one label, leave one live row and valid grants", async () => {
  await withGrants([OUTBOX, BOT], (sql) => {
    let last = "";
    for (let n = 0; n < 2; n++) {
      const m = grantRow({ role: "agent", label: "claude-code", stars: [FIXTURE_KEY] }, NOW);
      for (const s of m.sql) sql.exec(s);
      last = m.token;
    }
    const live = liveGrantRows(sql);
    expect(live.filter((r) => r.actor === "agent:claude-code")).toHaveLength(1);
    expect(() => validateGrants(live)).not.toThrow();
    expect(grantForRequest(sql, last, NOW)?.actor).toBe("agent:claude-code");
  });
});
