// PLAN-0.5.0 item 35 (ADR-0010 §Revision "The edge apply", ADR-0011 §Consequences, record 24 §1,
// §4–§9): the taste star's one writer, run inside a real SQLite-backed DO under local workerd against
// the R2 double. Each test gets its own DO and its own key prefix in the double. Crashes are real:
// `state.abort()` resets the instance mid-apply, and the next instance finds the journal.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import STAR_YAML from "../src/star.yaml?raw";
import { EdgeStore } from "../src/edge-store.ts";
import { WorkersAiEmbedder } from "../src/workers-ai-embedder.ts";
import { armAlarm, Writer, type Reply } from "../src/writer.ts";
import ABANDON from "../sql/abandon-journal.sql?raw";
import DELETE_CONFLICT from "../sql/delete-conflict.sql?raw";
import CLEAR_SEED from "../sql/clear-seed-built.sql?raw";
import { probeRefusal } from "funes-engine/portable";

const enc = (s: string) => new TextEncoder().encode(s);
const hex = async (b: Uint8Array | string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", typeof b === "string" ? enc(b) : b))].map((x) => x.toString(16).padStart(2, "0")).join("");
const token = (c: string) => `funes_${c.repeat(43)}`;
const OUTBOX = { token: token("o"), actor: "outbox@replica", role: "outbox", label: "replica" };
const BOT = { token: token("b"), actor: "taste-bot", role: "bot", label: "bot" };

/** A ULID minted now (Crockford base32 time, then a 16-character tail). */
function ulid(tail = "0000000000000000", ms = Date.now()): string {
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let t = "";
  for (let i = 0, n = ms; i < 10; i++, n = Math.floor(n / 32)) t = A[n % 32] + t;
  return t + tail;
}

/** A step of an apply as the double sees it: `before-put:<key>` and `after-put:<key>`. */
type Fault = (step: string, bytes: string) => void | Promise<void>;

/** The R2 double under a prefix of its own, with a fault hook around every put (24-crash-model.ts's
 *  crash points). */
function double(prefix: string, fault: { at?: Fault }): R2Bucket {
  const b = env.R2_DOUBLE;
  const k = (key: string) => `${prefix}/${key}`;
  return {
    get: async (key: string) => {
      await fault.at?.(`get:${key}`, "");
      return b.get(k(key));
    },
    // The build's listing (item 39): the double's own keys, with the prefix stripped.
    list: async (o: R2ListOptions = {}) => {
      const r = await b.list({ ...o, prefix: `${prefix}/`, startAfter: o.startAfter && k(o.startAfter) });
      return { ...r, objects: r.objects.map((x) => ({ key: x.key.slice(prefix.length + 1), size: x.size, etag: x.etag })) };
    },
    head: (key: string) => b.head(k(key)),
    put: async (key: string, value: Uint8Array, opts: R2PutOptions) => {
      const text = new TextDecoder().decode(value);
      await fault.at?.(`before-put:${key}`, text);
      const r = await b.put(k(key), value, opts);
      await fault.at?.(`after-put:${key}`, text);
      return r;
    },
  } as unknown as R2Bucket;
}

interface World {
  name: string; prefix: string; fault: { at?: Fault }; waited: number; abort?: () => void; sql?: SqlStorage;
  /** The build's pages per batch (default 500) and its Workers AI (default the fake). */
  batch?: number; ai?: Ai;
}

/** A fresh DO (inert: its name is not the taste star's) with the grants and the base pages. Its
 *  first alarm is the first hold (canary, star.yaml publish), whose no-live-slot trigger runs the
 *  bootstrap full build (item 39) over the pages to its swap. */
async function world(pages: Record<string, string> = {}): Promise<World> {
  const w: World = { name: crypto.randomUUID(), prefix: crypto.randomUUID(), fault: {}, waited: 0 };
  for (const [path, text] of Object.entries(pages)) await env.R2_DOUBLE.put(`${w.prefix}/${path}`, text);
  await inWriter(w, async (_writer, state) => {
    for (const g of [OUTBOX, BOT]) {
      state.storage.sql.exec(
        "insert into grants(token_sha256, actor, role, stars, created_at, label) values (?, ?, ?, ?, ?, ?)",
        await hex(g.token), g.actor, g.role, '["rainblow.ing/taste"]', "2026-10-01T00:00:00Z", g.label,
      );
    }
  });
  await inWriter(w, (writer) => writer.alarm());
  return w;
}

/** Run `fn` with a Writer over the world's DO — a new Writer is a new instance's writer. */
function inWriter<T>(w: World, fn: (writer: Writer, state: DurableObjectState) => Promise<T>): Promise<T> {
  return runInDurableObject(env.TASTE.getByName(w.name), async (_o, state) => {
    w.abort = () => state.abort("crash injected by the test");
    w.sql = state.storage.sql;
    const writer = new Writer({
      storage: state.storage, bucket: double(w.prefix, w.fault), ai: w.ai ?? env.AI, starText: STAR_YAML, locus: "funes-taste",
      waitUntil: () => { w.waited++; }, sleep: async () => {}, batchPages: w.batch,
    });
    return fn(writer, state);
  });
}

const call = (w: World, name: string, args: Record<string, unknown>, who = OUTBOX): Promise<Reply> =>
  inWriter(w, (writer) => writer.call(who.token, name, args));
const r2 = async (w: World, path: string) => (await env.R2_DOUBLE.get(`${w.prefix}/${path}`))?.text() ?? null;
const indexed = (w: World, id: string) =>
  inWriter(w, async (_w, state) => (await new EdgeStore(state.storage, new WorkersAiEmbedder(env.AI, state.storage)).indexedPage({ id }))?.body ?? null);
const sql = <T extends Record<string, SqlStorageValue>>(w: World, q: string, ...b: SqlStorageValue[]) =>
  inWriter(w, async (_w, state) => state.storage.sql.exec<T>(q, ...b).toArray());

const ITEM = "---\ntitle: Heat\ntype: Film\ndomain: movies\n---\nA crime film.\n";

describe("the apply", () => {
  it("a create-once from the outbox lands in R2, is indexed and leaves a receipt; its redelivery answers already-applied", async () => {
    const w = await world();
    const id = ulid();
    const r = await call(w, "put_page", { path: "items/movies/heat.md", content: ITEM, proposalId: id });
    const bytes = await r2(w, "items/movies/heat.md");
    expect(r).toEqual({ status: 200, body: { proposalId: id, status: "applied", writtenHash: await hex(bytes!) } });
    expect(bytes).not.toContain("trust:"); // the outbox's create keeps the zone default
    expect(await indexed(w, "items/movies/heat")).toContain("A crime film.");
    expect(await sql(w, "select proposal_id from receipts")).toEqual([{ proposal_id: id }]);
    expect(await sql(w, "select id from apply_journal")).toEqual([]);
    expect(await call(w, "put_page", { path: "items/movies/heat.md", content: ITEM, proposalId: id }))
      .toEqual({ status: 200, body: { proposalId: id, status: "already-applied", writtenHash: await hex(bytes!) } });
    expect(w.waited).toBeGreaterThan(0); // every apply runs under ctx.waitUntil
  });
});

const REPLACED = "---\ntitle: Heat\ntype: Film\ndomain: movies\n---\nA heist film.\n";

describe("the bytes and the type (record 35 O4, N10)", () => {
  it("a replace with no `type` inherits the base's type", async () => {
    const w = await world({ "items/movies/heat.md": ITEM });
    const r = await call(w, "put_page", { path: "items/movies/heat.md", content: "---\ntitle: Heat\ndomain: movies\n---\nA heist film.\n", base: await hex(ITEM), proposalId: ulid() });
    expect(r.body).toMatchObject({ status: "applied" });
    expect(await r2(w, "items/movies/heat.md")).toMatch(/^type: Film$/m);
  });

  it("vault_page refuses bytes that are not UTF-8 invalid; on valid bytes sha256(utf8(content)) is its sha256", async () => {
    const w = await world({ "items/movies/heat.md": "---\ntitle: Жара\ntype: Film\n---\nA crime film.\n" });
    await env.R2_DOUBLE.put(`${w.prefix}/items/movies/bad.md`, new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a]));
    const bad = await call(w, "vault_page", { path: "items/movies/bad.md" }, BOT);
    expect(bad).toMatchObject({ status: 400, body: { code: "invalid" } });
    expect(bad.body).not.toHaveProperty("content");
    const ok = await call(w, "vault_page", { path: "items/movies/heat.md" }, BOT);
    const page = ok.body as { content: string; sha256: string };
    expect(page.content).toBe(await r2(w, "items/movies/heat.md"));
    expect(page.sha256).toBe(await hex(page.content));
  });
});

// 24-crash-model.ts I1–I3 on the real thing: the instance is reset (ctx.abort) at every step of a
// create-once and of a replace, and the next instance takes the redelivery.
describe("a crash at every step (ctx.abort), then the redelivery", () => {
  const kinds = {
    create: { pages: {}, args: async () => ({ path: "items/movies/heat.md", content: ITEM }) },
    replace: { pages: { "items/movies/heat.md": ITEM }, args: async () => ({ path: "items/movies/heat.md", content: REPLACED, base: await hex(ITEM) }) },
  };

  it("the steps are the journaled puts, history before page, as the crash model has them", async () => {
    for (const [kind, k] of Object.entries(kinds)) {
      const w = await world(k.pages);
      const steps: string[] = [];
      w.fault.at = (s) => { if (s.includes("put:")) steps.push(s); };
      expect((await call(w, "put_page", { ...(await k.args()), proposalId: ulid() })).status).toBe(200);
      const history = `.history/items/movies/heat.md/${await hex(ITEM)}`;
      expect(steps, kind).toEqual([
        ...(kind === "replace" ? [`before-put:${history}`, `after-put:${history}`] : []),
        "before-put:items/movies/heat.md", "after-put:items/movies/heat.md",
      ]);
    }
  });

  for (const [kind, k] of Object.entries(kinds)) {
    const at = kind === "replace"
      ? ["before-put:.history", "after-put:.history", "before-put:items", "after-put:items"]
      : ["before-put:items", "after-put:items"];
    for (const step of at) {
      it(`${kind}, reset at ${step}: no receipt without R2 (I2), no index without receipt (I3), then already-applied with R2 complete (I1)`, async () => {
        const w = await world(k.pages);
        const id = ulid();
        const args = { ...(await k.args()), proposalId: id };
        w.fault.at = (s) => { if (s.startsWith(step)) w.abort!(); };
        await expect(call(w, "put_page", args)).rejects.toThrow();
        w.fault.at = undefined;
        const receipts = await sql(w, "select proposal_id from receipts");
        const page = await r2(w, "items/movies/heat.md");
        if (receipts.length) expect(page).toContain(kind === "replace" ? "A heist film." : "A crime film."); // I2
        expect(receipts).toEqual([]); // the reset comes before S4
        expect(await indexed(w, "items/movies/heat"), "I3").toBe(kind === "replace" ? "A crime film.\n" : null);
        expect(await sql(w, "select state from apply_journal")).toEqual([{ state: "pending" }]);

        const again = await call(w, "put_page", args);
        const now = await r2(w, "items/movies/heat.md");
        expect(again).toEqual({ status: 200, body: { proposalId: id, status: "already-applied", writtenHash: await hex(now!) } });
        expect(now).toContain(kind === "replace" ? "A heist film." : "A crime film.");
        if (kind === "replace") expect(await r2(w, `.history/items/movies/heat.md/${await hex(ITEM)}`)).toBe(ITEM);
        expect(await indexed(w, "items/movies/heat")).toContain(kind === "replace" ? "A heist film." : "A crime film.");
        expect(await sql(w, "select id from apply_journal")).toEqual([]);
      });
    }
  }
});

const TOO_MANY = () => new Error("put: Too Many Requests (10058)");
const HISTORY = async () => `.history/items/movies/heat.md/${await hex(ITEM)}`;

/** A replace journaled and cut by a reset at `cutAt`: the I6/I7 start. */
async function stuckReplace(cutAt = "before-put:items") {
  const w = await world({ "items/movies/heat.md": ITEM });
  const id = ulid();
  const args = { path: "items/movies/heat.md", content: REPLACED, base: await hex(ITEM), proposalId: id };
  w.fault.at = (s) => { if (s.startsWith(cutAt)) w.abort!(); };
  await expect(call(w, "put_page", args)).rejects.toThrow();
  w.fault.at = undefined;
  return { w, id, args };
}

// 24-crash-model.ts I6: a hold whose recover() leaves a journal pending answers 503 and does nothing else.
it("a 429 in recovery answers 503 (applyState pending) to every mutation until it clears, then already-applied; a put_page on the prefix is stale-base", async () => {
  const { w, id, args } = await stuckReplace();
  expect(await r2(w, await HISTORY())).toBe(ITEM); // the prefix a replica's pull can see
  // only the journaled page put faults: a hold that went on past recovery would land the other one
  w.fault.at = (s, bytes) => { if (s.startsWith("before-put:") && bytes.includes("A heist film.")) throw TOO_MANY(); };
  const onPrefix = { path: "items/movies/heat.md", content: ITEM.replace("crime", "noir"), base: await hex(ITEM), proposalId: ulid("1111111111111111") };
  for (const [what, a] of [["an unrelated put_page", onPrefix], ["the redelivery", args]] as const) {
    const r = await call(w, "put_page", a);
    expect(r.status, what).toBe(503);
    expect(r.body, what).toMatchObject({ applyState: "pending" });
  }
  expect(await r2(w, "items/movies/heat.md")).toBe(ITEM);
  expect(await sql(w, "select proposal_id from receipts")).toEqual([]);

  w.fault.at = undefined;
  const now = async () => hex((await r2(w, "items/movies/heat.md"))!);
  expect(await call(w, "put_page", args)).toEqual({ status: 200, body: { proposalId: id, status: "already-applied", writtenHash: await now() } });
  expect(await call(w, "put_page", onPrefix))
    .toEqual({ status: 200, body: { proposalId: onPrefix.proposalId, status: "refused", reason: "stale-base", currentHash: await now() } });
});

// 24-crash-model.ts I7: the operator's one way out, as the package's SQL file says it.
describe("a journal that can never finish", () => {
  it("answers 503 on every hold until abandoned; then a conflict with no receipt, its page re-indexed from R2, and the next apply proceeds", async () => {
    const { w, id, args } = await stuckReplace();
    w.fault.at = () => { throw TOO_MANY(); }; // a lasting fault
    const other = (n: string) => ({ path: `items/movies/other-${n}.md`, content: ITEM, proposalId: ulid(n.repeat(16)) });
    for (const n of ["1", "2", "3"]) expect((await call(w, "put_page", other(n))).status).toBe(503);
    const jid = (await sql<{ id: number }>(w, "select id from apply_journal where state = 'pending'"))[0]!.id;
    expect(ABANDON).toContain("JOURNAL_ID"); // unedited, the statement fails: no such column
    await sql(w, ABANDON.replaceAll("JOURNAL_ID", String(jid)));
    w.fault.at = undefined;

    expect((await call(w, "put_page", other("4"))).body).toMatchObject({ status: "applied" });
    expect(await sql(w, "select state from apply_journal")).toEqual([{ state: "conflict" }]);
    expect(await sql(w, "select proposal_id from receipts where proposal_id = ?", id)).toEqual([]);
    expect(await indexed(w, "items/movies/heat")).toBe("A crime film.\n"); // R2 as it is
    expect(await r2(w, await HISTORY())).toBe(ITEM); // the orphan history object stays
    // the redelivery is re-checked against R2 as it is now: the page never changed, so it applies fresh
    expect((await call(w, "put_page", args)).body).toMatchObject({ proposalId: id, status: "applied" });

    await sql(w, DELETE_CONFLICT.replaceAll("JOURNAL_ID", String(jid)));
    expect(await sql(w, "select id from apply_journal")).toEqual([]);
  });

  it("an abandon that lands mid-recovery stops the frame at its next fence: the page untouched, a conflict, no receipt", async () => {
    const { w, id } = await stuckReplace("before-put:.history");
    w.fault.at = (s) => {
      if (s.startsWith("after-put:.history")) w.sql!.exec(ABANDON.replaceAll("JOURNAL_ID", "(select id from apply_journal where state = 'pending')"));
    };
    await inWriter(w, (writer) => writer.alarm());
    w.fault.at = undefined;
    expect(await r2(w, await HISTORY())).toBe(ITEM);
    expect(await r2(w, "items/movies/heat.md")).toBe(ITEM);
    expect(await sql(w, "select state from apply_journal")).toEqual([{ state: "conflict" }]);
    expect(await sql(w, "select proposal_id from receipts where proposal_id = ?", id)).toEqual([]);
  });
});

describe("phase 0 refuses with no write", () => {
  const nothingWritten = async (w: World) => {
    expect(await sql(w, "select id from apply_journal")).toEqual([]);
    expect(await sql(w, "select proposal_id from receipts")).toEqual([]);
  };

  it("an over-long key: a replace whose history object would pass R2's 1,024 bytes is invalid", async () => {
    // 980 bytes: under R2's limit with the test's 37-byte prefix, its history key 1,054
    const path = `items/movies/${"a".repeat(980 - "items/movies/.md".length)}.md`;
    const w = await world({ [path]: ITEM });
    const id = ulid();
    expect(await call(w, "put_page", { path, content: REPLACED, base: await hex(ITEM), proposalId: id }))
      .toEqual({ status: 200, body: { proposalId: id, status: "refused", reason: "invalid" } });
    expect(await r2(w, path)).toBe(ITEM);
    await nothingWritten(w);
  });

  it("an off-rule create is invalid; a create at exactly 900 bytes applies, at 901 it is invalid", async () => {
    const w = await world();
    for (const path of ["items/Movies/Heat.md", "items/heat.md", "items/movies/жара.md", `items/movies/${"a".repeat(901 - "items/movies/.md".length)}.md`]) {
      expect((await call(w, "put_page", { path, content: ITEM })).body, path).toEqual({ status: "refused", reason: "invalid" });
      expect(await r2(w, path), path).toBeNull();
    }
    await nothingWritten(w);
    const at900 = `items/movies/${"a".repeat(900 - "items/movies/.md".length)}.md`;
    expect((await call(w, "put_page", { path: at900, content: ITEM })).body).toMatchObject({ status: "applied" });
  });

  it("a create carrying a writer-owned key is protected-field", async () => {
    const w = await world();
    for (const key of ["trust: trusted", "created: 2026-01-01", "superseded_by: items/x"]) {
      const r = await call(w, "put_page", { path: "items/movies/heat.md", content: ITEM.replace("domain:", `${key}\ndomain:`) }, BOT);
      expect(r.body, key).toEqual({ status: "refused", reason: "protected-field" });
    }
    expect(await r2(w, "items/movies/heat.md")).toBeNull();
    await nothingWritten(w);
  });

  it("a bot's create is stamped untrusted (H4); the outbox's keeps the zone default", async () => {
    const w = await world();
    expect((await call(w, "put_page", { path: "items/movies/heat.md", content: ITEM }, BOT)).body).toMatchObject({ status: "applied" });
    expect(await r2(w, "items/movies/heat.md")).toContain("trust: untrusted");
    expect((await call(w, "put_page", { path: "items/movies/solaris.md", content: ITEM }, OUTBOX)).body).toMatchObject({ status: "applied" });
    expect(await r2(w, "items/movies/solaris.md")).not.toContain("trust:");
  });

  it("supersede of an item page is refused: the edge's host ceiling has no supersede (FunesStore's own invalid is the engine's test)", async () => {
    const w = await world({ "items/movies/heat.md": ITEM });
    const r = await call(w, "supersede", { oldId: "items/movies/heat", title: "Heat", body: "b", proposalId: ulid() });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: "unknown operation: supersede" });
    expect(await r2(w, "items/movies/heat.md")).toBe(ITEM);
  });

  // ADR-0010's answer shape has no free-text field: the reason is `invalid` itself (the parser's line
  // is the proposer's to show, record 35 R5).
  it("unparsable YAML frontmatter is invalid, on a create and on a replace (record 35 W13(e))", async () => {
    const w = await world({ "items/movies/heat.md": ITEM });
    const BROKEN = "---\ntitle: [Heat\ntype: Film\n---\nA crime film.\n";
    const id = ulid();
    expect((await call(w, "put_page", { path: "items/movies/solaris.md", content: BROKEN, proposalId: id })).body)
      .toEqual({ proposalId: id, status: "refused", reason: "invalid" });
    expect((await call(w, "put_page", { path: "items/movies/heat.md", content: BROKEN, base: await hex(ITEM) })).body)
      .toEqual({ status: "refused", reason: "invalid" });
    expect(await r2(w, "items/movies/solaris.md")).toBeNull();
    expect(await r2(w, "items/movies/heat.md")).toBe(ITEM);
    await nothingWritten(w);
  });

  it("an unknown token is 401, before any hold", async () => {
    const w = await world();
    expect(await inWriter(w, (writer) => writer.call(token("z"), "put_page", { path: "items/movies/heat.md", content: ITEM })))
      .toEqual({ status: 401, body: { error: "unauthorized" } });
  });
});

it("receipts are pruned 30 days after their apply", async () => {
  const w = await world();
  const old = new Date(Date.now() - 31 * 86_400_000).toISOString(), recent = new Date(Date.now() - 29 * 86_400_000).toISOString();
  await sql(w, "insert into receipts values ('old', 'h', '', ?), ('recent', 'h', '', ?)", old, recent);
  await call(w, "put_page", { path: "items/movies/heat.md", content: ITEM });
  expect(await sql(w, "select proposal_id from receipts")).toEqual([{ proposal_id: "recent" }]);
});

it("armAlarm never moves the one alarm later", async () => {
  await runInDurableObject(env.TASTE.getByName(crypto.randomUUID()), async (_o, state) => {
    await armAlarm(state.storage, 2_000_000_000_000);
    await armAlarm(state.storage, 3_000_000_000_000);
    expect(await state.storage.getAlarm()).toBe(2_000_000_000_000);
    await armAlarm(state.storage, 1_900_000_000_000);
    expect(await state.storage.getAlarm()).toBe(1_900_000_000_000);
    await state.storage.deleteAlarm();
  });
});

it("the third operator statement clears seed_built once, and touches nothing else", async () => {
  const w = await world({ "items/movies/heat.md": ITEM }); // a build with pages stamps seed_built
  expect(await sql(w, "select value from meta where key = 'seed_built'")).toEqual([{ value: "1" }]);
  const before = (await sql<{ n: number }>(w, "select count(*) as n from meta"))[0]!.n;
  await sql(w, CLEAR_SEED);
  expect(await sql(w, "select value from meta where key = 'seed_built'")).toEqual([]);
  expect(await sql(w, "select count(*) as n from meta")).toEqual([{ n: before - 1 }]);
});

it("a foreign write between the journal and the put is a conflict: no receipt, the page re-indexed as R2 holds it, the redelivery stale-base", async () => {
  const w = await world({ "items/movies/heat.md": ITEM });
  const FOREIGN = ITEM.replace("crime", "foreign");
  const args = { path: "items/movies/heat.md", content: REPLACED, base: await hex(ITEM), proposalId: ulid() };
  w.fault.at = async (s) => { if (s === "before-put:items/movies/heat.md") await env.R2_DOUBLE.put(`${w.prefix}/items/movies/heat.md`, FOREIGN); };
  expect((await call(w, "put_page", args)).status).toBe(500);
  w.fault.at = undefined;
  expect(await r2(w, "items/movies/heat.md")).toBe(FOREIGN);
  expect(await sql(w, "select state from apply_journal")).toEqual([{ state: "conflict" }]);
  expect(await sql(w, "select proposal_id from receipts")).toEqual([]);
  expect(await indexed(w, "items/movies/heat")).toBe("A foreign film.\n");
  expect((await call(w, "put_page", args)).body).toMatchObject({ status: "refused", reason: "stale-base", currentHash: await hex(FOREIGN) });
});

it("a conflict re-indexes a page R2 holds malformed as the build does: skipped fail-closed, not served with default meta (ADR-0012)", async () => {
  const w = await world({ "items/movies/heat.md": ITEM });
  const BROKEN = "---\ntitle: [unclosed\nforgotten: true\n---\nA crime film.\n";
  const args = { path: "items/movies/heat.md", content: REPLACED, base: await hex(ITEM), proposalId: ulid() };
  w.fault.at = async (s) => { if (s === "before-put:items/movies/heat.md") await env.R2_DOUBLE.put(`${w.prefix}/items/movies/heat.md`, BROKEN); };
  expect((await call(w, "put_page", args)).status).toBe(500);
  w.fault.at = undefined;
  expect(await sql(w, "select state from apply_journal")).toEqual([{ state: "conflict" }]);
  expect(await indexed(w, "items/movies/heat")).toBeNull();
});

// PLAN-0.5.0 item 40 (record 24 §1, ADR-0015): edge health — stats, freshness by listing parity,
// and the proposal-protocol fields, read without the hold. The outbox's own probe check judges it.
describe("edge health", () => {
  const TASTE_ID = "mcp://rainblow.ing/taste";

  it("answers stats, listing freshness and record 24's fields; the outbox probe accepts it and refuses a mismatched starId or locus", async () => {
    const w = await world({ "items/movies/heat.md": ITEM });
    const r = await call(w, "health", {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      proposalProtocol: 1, starId: TASTE_ID, locus: "funes-taste", applyState: "idle", indexDirty: 0, conflicts: 0,
      nodes: 1, vaultChangedSinceReindex: false, freshnessBasis: "stat",
    });
    const h = r.body as Record<string, unknown>;
    expect(probeRefusal(h, TASTE_ID, "funes-taste")).toBeNull();
    expect(probeRefusal(h, "rainblow.ing/taste", "funes-taste")).toBeNull(); // sameStar: the scheme is not identity
    expect(probeRefusal(h, "mcp://rainblow.ing/other", "funes-taste")).toMatch(/serves "mcp:\/\/rainblow.ing\/taste", not mcp:\/\/rainblow.ing\/other/);
    expect(probeRefusal(h, TASTE_ID, "replica")).toMatch(/locus "funes-taste" is not this star's write_locus "replica"/);
    expect(probeRefusal({ ...h, proposalProtocol: 2 }, TASTE_ID, "funes-taste")).toMatch(/proposal protocol/);
  });

  it("freshness is version parity by listing: a write the build did not record reads changed", async () => {
    const w = await world({ "items/movies/heat.md": ITEM });
    await env.R2_DOUBLE.put(`${w.prefix}/items/movies/heat.md`, REPLACED);
    expect((await call(w, "health", {})).body).toMatchObject({ vaultChangedSinceReindex: true, freshnessBasis: "stat" });
  });

  it("a pending journal is applyState pending while a mutation answers 503; health takes no hold", async () => {
    const { w } = await stuckReplace();
    w.fault.at = () => { throw TOO_MANY(); };
    expect((await call(w, "put_page", { path: "items/movies/x.md", content: ITEM })).status).toBe(503);
    const r = await call(w, "health", {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ applyState: "pending", conflicts: 0 });
  });

  it("a build in progress is applyState building; conflicts and index-dirty pages are counted", async () => {
    const w = await world({ "items/movies/heat.md": ITEM });
    await sql(w, "insert into build_state(id, reason, started_at) values (1, 'test', '2026-10-14T00:00:00Z')");
    await sql(w, "insert into index_dirty(id) values ('items/movies/a'), ('items/movies/b')");
    await sql(w, "insert into apply_journal(state, writes, created_at) values ('conflict', '[]', '2026-10-14T00:00:00Z')");
    expect((await call(w, "health", {})).body).toMatchObject({ applyState: "building", indexDirty: 2, conflicts: 1 });
  });

  it("is served under a grant only", async () => {
    const w = await world();
    expect(await inWriter(w, (writer) => writer.call(token("z"), "health", {}))).toEqual({ status: 401, body: { error: "unauthorized" } });
  });
});

// PLAN-0.5.0 item 39 (ADR-0015, record 31): the full build, in batches on the one alarm.
const film = (n: string, body = `About ${n}.`) => `---\ntitle: ${n}\ntype: Film\ndomain: movies\n---\n${body}\n`;
const meta = async (w: World, key: string) => (await sql<{ value: string }>(w, "select value from meta where key = ?", key))[0]?.value ?? null;
const building = async (w: World) => (await sql(w, "select id from build_state")).length > 0;
const alarm = (w: World) => inWriter(w, (writer) => writer.alarm());
/** Trigger 2 on the next hold: the live slot's built versions are no longer the running code's. */
const staleVersions = (w: World) => sql(w, "update meta set value = '{}' where key = 'built_versions'");
/** Alarms until no build runs: the first one's hold starts any build a trigger calls for. */
const finish = async (w: World) => { for (let i = 0; i < 20; i++) { await alarm(w); if (!(await building(w))) return; } };

describe("the full build (item 39)", () => {
  it("an interrupted build resumes from its last key; recall serves the old slot throughout, and the generation is stamped only at the swap", async () => {
    const w = await world({ "items/movies/a.md": film("a"), "items/movies/b.md": film("b"), "items/movies/c.md": film("c") });
    const g0 = await meta(w, "generation");
    expect(g0).toMatch(/^v3:/);
    await env.R2_DOUBLE.put(`${w.prefix}/items/movies/b.md`, film("b", "Rewritten.")); // canon moves under the index
    await staleVersions(w);
    w.batch = 1;
    const gets: string[] = [];
    w.fault.at = (s) => { if (s.startsWith("get:")) gets.push(s.slice(4)); };

    await alarm(w); // the trigger, then batch 1
    expect(await sql(w, "select reason, last_key from build_state")).toEqual([{ reason: "versions", last_key: "items/movies/a.md" }]);
    const midBuild = async () => {
      expect(await meta(w, "generation")).toBe(g0);
      expect(await indexed(w, "items/movies/b")).toBe("About b.\n");
      const r = await call(w, "recall_v2", { query: "About b", k: 3 }, BOT);
      expect(r.status).toBe(200);
      expect((r.body as { results: Array<{ id: string }> }).results.map((h) => h.id)).toContain("items/movies/b");
    };
    await midBuild();

    w.fault.at = (s) => { if (s === "get:items/movies/b.md") w.abort!(); }; // a reset mid-batch 2
    await expect(alarm(w)).rejects.toThrow();
    expect(await sql(w, "select last_key from build_state")).toEqual([{ last_key: "items/movies/a.md" }]);
    await midBuild();

    gets.length = 0;
    w.fault.at = (s) => { if (s.startsWith("get:")) gets.push(s.slice(4)); };
    await finish(w);
    expect(await building(w)).toBe(false);
    expect(gets.filter((k) => k.startsWith("items/"))).toEqual(["items/movies/b.md", "items/movies/c.md"]); // resumed after a
    const g1 = await meta(w, "generation");
    expect(g1).toMatch(/^v3:/);
    expect(g1).not.toBe(g0);
    expect(await indexed(w, "items/movies/b")).toBe("Rewritten.\n");
    expect(await indexed(w, "items/movies/a")).toBe("About a.\n");
  });

  it("a mutation during a build answers 503 with applyState building, and applies after the swap", async () => {
    const w = await world({ "items/movies/a.md": film("a"), "items/movies/b.md": film("b") });
    await staleVersions(w);
    w.batch = 1;
    await alarm(w);
    expect(await building(w)).toBe(true);
    const args = { path: "items/movies/heat.md", content: ITEM, proposalId: ulid() };
    const r = await call(w, "put_page", args);
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ applyState: "building" });
    expect(await r2(w, "items/movies/heat.md")).toBeNull();
    await finish(w);
    expect((await call(w, "put_page", args)).body).toMatchObject({ proposalId: args.proposalId, status: "applied" });
    expect(await indexed(w, "items/movies/heat")).toContain("A crime film.");
  });

  it("a poison object — listed over 1 MiB, unparsable, or not UTF-8 — is skipped and counted, and writes go on", async () => {
    const w = await world({ "items/movies/a.md": film("a") });
    await env.R2_DOUBLE.put(`${w.prefix}/items/movies/huge.md`, film("huge", "x".repeat(1024 * 1024)));
    await env.R2_DOUBLE.put(`${w.prefix}/items/movies/bad.md`, "---\ntitle: [unclosed\n---\nbody\n");
    await env.R2_DOUBLE.put(`${w.prefix}/items/movies/binary.md`, new Uint8Array([0xff, 0xfe, 0x00, 0x80]));
    await staleVersions(w);
    const gets: string[] = [];
    w.fault.at = (s) => { if (s.startsWith("get:")) gets.push(s.slice(4)); };
    await finish(w);
    expect(await building(w)).toBe(false);
    expect(gets).not.toContain("items/movies/huge.md"); // skipped on its listed size, never read
    expect(await meta(w, "build_skipped")).toBe("3");
    expect(await meta(w, "okf_malformed")).toBe("2");
    for (const id of ["huge", "bad", "binary"]) expect(await indexed(w, `items/movies/${id}`), id).toBeNull();
    expect(await indexed(w, "items/movies/a")).toBe("About a.\n");
    // every listed page has a stat row, the skipped ones too: the listing parity holds
    expect((await call(w, "health", {})).body).toMatchObject({ vaultChangedSinceReindex: false, freshnessBasis: "stat" });
    expect((await call(w, "put_page", { path: "items/movies/heat.md", content: ITEM })).body).toMatchObject({ status: "applied" });
  });

  it("the post-seed build runs once, 15 minutes after the seed's last apply", async () => {
    const w = await world(); // the bootstrap build over an empty bucket stamps a generation, not seed_built
    expect(await meta(w, "generation")).toMatch(/^v3:/);
    expect(await meta(w, "seed_built")).toBeNull();
    expect((await call(w, "put_page", { path: "items/movies/heat.md", content: ITEM })).body).toMatchObject({ status: "applied" });
    expect(await meta(w, "generation")).toBeNull();
    const due = Date.parse((await meta(w, "last_apply_at"))!) + 15 * 60_000;
    expect(await inWriter(w, async (writer, state) => { await state.storage.deleteAlarm(); await writer.alarm(); return state.storage.getAlarm(); })).toBe(due);
    expect(await building(w)).toBe(false);

    const backdate = () => sql(w, "update meta set value = ? where key = 'last_apply_at'", new Date(Date.now() - 16 * 60_000).toISOString());
    await backdate();
    await finish(w);
    expect(await building(w)).toBe(false);
    expect(await meta(w, "seed_built")).toBe("1");
    expect(await meta(w, "generation")).toMatch(/^v3:/);

    // once only: a later burst leaves the generation null and starts no build
    expect((await call(w, "put_page", { path: "items/movies/solaris.md", content: ITEM })).body).toMatchObject({ status: "applied" });
    await backdate();
    await alarm(w);
    expect(await building(w)).toBe(false);
    expect(await meta(w, "generation")).toBeNull();
  });

  it("an owner mismatch starts a build that re-stamps the bundled star", async () => {
    const w = await world({ "items/movies/a.md": film("a") });
    await sql(w, "update meta set value = 'rainblow.ing/other' where key = 'owner_star_id'");
    await alarm(w);
    expect(await building(w)).toBe(false);
    expect(await meta(w, "owner_star_id")).toBe("rainblow.ing/taste");
  });

  it("embeds with at most 6 Workers AI calls in flight and at most 40 in any second", async () => {
    const w = await world();
    for (let i = 0; i < 60; i++) await env.R2_DOUBLE.put(`${w.prefix}/items/movies/p${String(i).padStart(2, "0")}.md`, film(`p${i}`));
    let inFlight = 0, most = 0;
    const starts: number[] = [];
    w.ai = {
      run: async (...a: Parameters<Ai["run"]>) => {
        starts.push(Date.now());
        most = Math.max(most, ++inFlight);
        try { await new Promise((r) => setTimeout(r, 5)); return await env.AI.run(...a); } finally { inFlight--; }
      },
    } as unknown as Ai;
    await staleVersions(w);
    await finish(w);
    expect(await building(w)).toBe(false);
    expect(starts.length).toBeGreaterThan(60);
    expect(most).toBe(6);
    for (let i = 40; i < starts.length; i++) expect(starts[i]! - starts[i - 40]!).toBeGreaterThanOrEqual(1000);
  });
});
