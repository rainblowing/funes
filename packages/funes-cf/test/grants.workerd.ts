// PLAN-0.5.0 item 42 (ADR-0014, record 32): the edge face's grants, read from the DO's own SQLite on
// every request, and the host ceiling at dispatch. The ceiling and preset tests are generated from
// the op registry, so a new op is refused at the edge until someone names it here.
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Embedder } from "funes-core";
import { dispatchToolCall, operations, type OperationContext, type StarConfig } from "funes-engine/portable";
import { EdgeStore } from "../src/edge-store.ts";
import { EDGE_OPERATIONS, grantForRequest, HOST_CEILING, PRESETS } from "../src/grants.ts";

class OneHot implements Embedder {
  readonly dim = 1024;
  readonly id = "test/one-hot";
  private v(t: string) { const v = new Float32Array(1024); v[t.length % 1024] = 1; return v; }
  async embedQuery(t: string) { return this.v(t); }
  async embedPassage(t: string) { return this.v(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.v(t)); }
}

const TASTE = {
  identity: { id: "rainblow.ing/taste", writeLocus: "funes-taste" },
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
  await runInDurableObject(env.TASTE.getByName(crypto.randomUUID()), async (_o, state) => {
    new EdgeStore(state.storage, new OneHot()); // the protocol tables are the edge store's schema (item 37)
    for (const r of hashed) {
      state.storage.sql.exec(
        "insert into grants(token_sha256, actor, role, stars, created_at, expires_at, revoked_at, label) values (?, ?, ?, ?, ?, ?, ?, ?)",
        r.hash, r.actor, r.role, r.stars ?? '["rainblow.ing/taste"]', "2026-10-01T00:00:00Z", r.expires_at ?? null, r.revoked_at ?? null, r.label,
      );
    }
    await fn(state.storage.sql);
  });
}

const OUTBOX: Row = { token: token("o"), actor: "outbox@replica", role: "outbox", label: "replica" };
const BOT: Row = { token: token("b"), actor: "taste-bot", role: "bot", label: "bot" };
const AGENT: Row = { token: token("a"), actor: "agent:claude-code", role: "agent", label: "claude-code", expires_at: "2027-01-01T00:00:00Z" };

const ctxFor = (grant: OperationContext["grant"]) =>
  ({ remote: true, trust: "untrusted", star: () => TASTE, grant, designation: { mode: "audit", locus: "funes-taste", authority: "funes-taste" } }) as unknown as OperationContext;

/** How a dispatch refused: the thrown error's code or message, or the proposal answer's reason. */
async function refusalOf(ops: typeof operations, name: string, args: Record<string, unknown>, ctx: OperationContext): Promise<string> {
  try {
    const out = await dispatchToolCall(ops, name, args, ctx) as { status?: string; reason?: string };
    return out.status === "refused" ? `answer:${out.reason}` : "served";
  } catch (e) {
    return String((e as { code?: string }).code ?? (e as Error).message);
  }
}

it("the host ceiling and every preset name only public registry ops, and every preset sits inside the ceiling", () => {
  const publicOps = new Set(operations.filter((o) => !o.internal).map((o) => o.name));
  expect([...HOST_CEILING].sort()).toEqual(["forget", "health", "indexed_page", "link", "put_page", "recall_v2", "vault_page"]);
  for (const name of HOST_CEILING) expect(publicOps.has(name), name).toBe(true);
  expect(PRESETS.outbox.ops).toEqual(["put_page", "health"]);
  expect(PRESETS.bot.ops).toEqual(["recall_v2", "health", "vault_page", "put_page", "forget"]);
  expect(PRESETS.agent.ops).toEqual(["recall_v2", "indexed_page", "health"]);
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
        expect(got, `${role} ${op.name}`).toBe(op.readonly ? "FUNES_NOT_GRANTED" : "answer:not-granted");
      }
    }
  });
});

it("forget with hard: true is refused invalid at the edge, before it reaches the store", async () => {
  const grant = { actor: "taste-bot", ops: new Set(["forget"]), stars: ["rainblow.ing/taste"] };
  expect(await refusalOf(EDGE_OPERATIONS, "forget", { id: "items/x", hard: true, proposalId: ULID }, ctxFor(grant))).toBe("answer:invalid");
  expect(await refusalOf(EDGE_OPERATIONS, "forget", { id: "items/x", hard: true }, ctxFor(grant))).toBe("invalid");
});

it("a live, unexpired row resolves its token to the preset's ops; unknown, revoked and expired tokens get none", async () => {
  const revoked: Row = { token: token("r"), actor: "agent:old", role: "agent", label: "old", expires_at: "2027-01-01T00:00:00Z", revoked_at: "2026-10-02T00:00:00Z" };
  const expired: Row = { token: token("e"), actor: "agent:stale", role: "agent", label: "stale", expires_at: "2026-10-13T11:59:59Z" };
  await withGrants([OUTBOX, BOT, AGENT, revoked, expired], (sql) => {
    const bot = grantForRequest(sql, BOT.token, NOW)!;
    expect(bot.actor).toBe("taste-bot");
    expect([...bot.ops]).toEqual(PRESETS.bot.ops);
    expect(bot.stars).toEqual(["rainblow.ing/taste"]);
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
  ["an unknown role", { token: token("x"), actor: "taste-bot", role: "admin", label: "x" }],
  ["an agent actor that is not agent:<label>", { token: token("x"), actor: "agent:other", role: "agent", label: "mine", expires_at: "2027-01-01T00:00:00Z" }],
  ["an agent row with no expiry", { token: token("x"), actor: "agent:forever", role: "agent", label: "forever" }],
  ["a label with a space", { token: token("x"), actor: "taste-bot", role: "bot", label: "my bot" }],
  ["stars that are not JSON", { token: token("x"), actor: "agent:x", role: "agent", label: "x", stars: "rainblow.ing/taste", expires_at: "2027-01-01T00:00:00Z" }],
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
  await withGrants([OUTBOX, BOT, AGENT, { token: token("x"), actor: "taste-bot", role: "bot", label: "bot2" }], (sql) => {
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
    sql.exec("insert into grants(token_sha256, actor, role, stars, created_at, label) values ('ABC', 'taste-bot', 'bot', '[\"rainblow.ing/taste\"]', '2026-10-01T00:00:00Z', 'bot')");
    expect(grantForRequest(sql, OUTBOX.token, NOW)).toBeNull();
  });
});

it("a revoked malformed row is not live and refuses no one", async () => {
  await withGrants([OUTBOX, { token: token("x"), actor: "outbox@replica", role: "bot", label: "bot", revoked_at: "2026-10-02T00:00:00Z" }], (sql) => {
    expect(grantForRequest(sql, OUTBOX.token, NOW)?.actor).toBe("outbox@replica");
  });
});
