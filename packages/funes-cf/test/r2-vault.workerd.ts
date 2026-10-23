// PLAN-0.5.0 item 34: R2Vault over the local R2 double (miniflare's R2, under workerd), ADR-0011
// §The decision and record 24 §4. Each test keeps to its own key prefix: the double is one bucket.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { R2Conflict, R2Vault, type StagedWrite } from "../src/r2-vault.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const hex = async (algo: string, b: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest(algo, b))].map((x) => x.toString(16).padStart(2, "0")).join("");
const noSleep = async () => {};

/** The double, with every put recorded in the order it left, between the hooks' own entries. */
function harness(bucket: R2Bucket = env.R2_DOUBLE, putFault?: (n: number) => Error | null) {
  const log: string[] = [];
  const journals: StagedWrite[][] = [];
  let puts = 0;
  const spy = new Proxy(bucket, {
    get(target, prop) {
      if (prop !== "put") return Reflect.get(target, prop).bind(target);
      return async (key: string, value: Uint8Array, opts: R2PutOptions) => {
        const fault = putFault?.(puts++);
        const only = opts.onlyIf instanceof Headers ? `If-None-Match: ${opts.onlyIf.get("If-None-Match")}` : `etagMatches: ${(opts.onlyIf as R2Conditional).etagMatches}`;
        log.push(`put ${key} [${only}] sha256=${opts.sha256}`);
        if (fault) throw fault;
        return target.put(key, value, opts);
      };
    },
  });
  const vault = new R2Vault(spy, {
    journal: async (writes) => { log.push(`journal ${writes.map((w) => w.path).join(",")}`); journals.push([...writes]); },
    fence: async (step) => { log.push(`fence ${step}`); },
    sleep: noSleep,
  });
  return { vault, log, journals };
}

describe("the R2 double (ADR-0011: any local double asserts both conditional cases)", () => {
  it("refuses a second create-once with If-None-Match: * and a stale etagMatches, storing nothing", async () => {
    const b = env.R2_DOUBLE;
    const first = await b.put("double/a.md", "A", { onlyIf: new Headers({ "If-None-Match": "*" }) });
    expect(first).not.toBeNull();
    expect(await b.put("double/a.md", "B", { onlyIf: new Headers({ "If-None-Match": "*" }) })).toBeNull();
    await b.put("double/a.md", "C");
    expect(await b.put("double/a.md", "D", { onlyIf: { etagMatches: first!.etag } })).toBeNull();
    expect(await (await b.get("double/a.md"))!.text()).toBe("C");
  });
});

describe("R2Vault", () => {
  it("read: the exact bytes and the etag they are; absent is null", async () => {
    const o = await env.R2_DOUBLE.put("read/a.md", enc("﻿alpha\r\n"));
    const f = await new R2Vault(env.R2_DOUBLE, { journal: noSleep, fence: noSleep }).read("read/a.md");
    expect([...f!.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // no BOM or newline change
    expect(dec(f!.bytes.slice(3))).toBe("alpha\r\n");
    expect(f!.version).toBe(o!.etag);
    expect(await new R2Vault(env.R2_DOUBLE, { journal: noSleep, fence: noSleep }).read("read/missing.md")).toBeNull();
  });

  it("list: pages only, with read's version; exclude sees each ancestor dir, then the file", async () => {
    for (const k of ["list/a.md", "list/w/b.md", "list/star.yaml", "list/index.md", "list/a.summary.md", `.history/list/a.md/${"a".repeat(64)}`, "list/drafts/d.md"]) {
      await env.R2_DOUBLE.put(k, k);
    }
    const { vault } = harness();
    const seen: string[] = [];
    const out: Record<string, string> = {};
    for await (const e of vault.list({ exclude: (rel) => { seen.push(rel); return !rel.startsWith("list/") || rel === "list/drafts/"; } })) out[e.path] = e.version;
    expect(Object.keys(out).sort()).toEqual(["list/a.md", "list/w/b.md"]);
    expect(out["list/w/b.md"]).toBe((await vault.read("list/w/b.md"))!.version);
    expect(seen).toEqual(expect.arrayContaining(["list/", "list/w/", "list/w/b.md", "list/drafts/"]));
    expect(seen).not.toContain("list/drafts/d.md");
  });

  it("atomically stages: journal first, then each put behind its fence, create-once as If-None-Match: *, replace as etagMatches, every put with sha256", async () => {
    const old = await env.R2_DOUBLE.put("tx/a.md", "one");
    const { vault, log, journals } = harness();
    const hist = `.history/tx/a.md/${await hex("SHA-256", enc("one"))}`;
    const out = await vault.atomically(async (tx) => {
      const h = await tx.swap(hist, null, enc("one"));
      const p = await tx.swap("tx/a.md", old!.etag, enc("ONE"));
      expect(log).toEqual([]); // nothing reaches R2 while fn runs
      return [h, p];
    });
    const sha = await hex("SHA-256", enc("ONE"));
    expect(log).toEqual([
      `journal ${hist},tx/a.md`,
      "fence 0", `put ${hist} [If-None-Match: *] sha256=${await hex("SHA-256", enc("one"))}`,
      "fence 1", `put tx/a.md [etagMatches: ${old!.etag}] sha256=${sha}`,
    ]);
    expect(journals[0]![1]).toMatchObject({ path: "tx/a.md", expect: old!.etag, sha256: sha });
    const now = await vault.read("tx/a.md");
    expect(dec(now!.bytes)).toBe("ONE");
    expect(out[1]).toEqual({ ok: true, version: now!.version }); // the swap's version is the etag R2 then holds
  });

  it("a throw in fn writes nothing: no journal, no fence, no put", async () => {
    const { vault, log } = harness();
    await expect(vault.atomically(async (tx) => { await tx.swap("throw/a.md", null, enc("x")); throw new Error("phase 0 refused"); })).rejects.toThrow("phase 0 refused");
    expect(log).toEqual([]);
    expect(await vault.read("throw/a.md")).toBeNull();
  });

  it("a swap whose expect does not hold is {ok: false} and is not staged", async () => {
    const cur = await env.R2_DOUBLE.put("stale/a.md", "now");
    const { vault, log } = harness();
    const out = await vault.atomically(async (tx) => [
      await tx.swap("stale/a.md", null, enc("create")),
      await tx.swap("stale/b.md", cur!.etag, enc("replace of nothing")),
    ]);
    expect(out).toEqual([{ ok: false }, { ok: false }]);
    expect(log).toEqual([]);
  });

  it("refuses, before anything is journaled, a key over 1,024 bytes, a remove, and a second swap of one path", async () => {
    const { vault, log } = harness();
    const long = `items/${"é".repeat(507)}x.md`; // 6 + 1,014 + 4 = 1,024 UTF-8 bytes: the limit, admitted
    await expect(vault.atomically((tx) => tx.swap(`items/${"é".repeat(508)}.md`, null, enc("x")))).rejects.toThrow(/1,024 bytes/); // 1,025
    await vault.atomically((tx) => tx.swap(long, null, enc("x"))); // the boundary is admitted
    const cur = (await vault.read(long))!.version;
    await expect(vault.atomically((tx) => tx.swap(long, cur, null))).rejects.toThrow(/never deletes/);
    await expect(vault.atomically(async (tx) => { await tx.swap("twice/a.md", null, enc("1")); await tx.swap("twice/a.md", null, enc("2")); })).rejects.toThrow(/at most once/);
    expect(log.filter((l) => l.startsWith("journal"))).toEqual([`journal ${long}`]);
  });

  it("retries a 429 behind a fresh fence, and past its budget throws with the journal left to recovery", async () => {
    const tooMany = () => new Error("put: Reduce your concurrent request rate for the same object. (10058)");
    const once = harness(env.R2_DOUBLE, (n) => (n === 0 ? tooMany() : null));
    await once.vault.atomically((tx) => tx.swap("retry/a.md", null, enc("a")));
    expect(once.log.filter((l) => l.startsWith("fence"))).toEqual(["fence 0", "fence 0"]);
    expect(dec((await once.vault.read("retry/a.md"))!.bytes)).toBe("a");

    const always = harness(env.R2_DOUBLE, () => tooMany());
    await expect(always.vault.atomically((tx) => tx.swap("retry/b.md", null, enc("b")))).rejects.toThrow(/10058/);
    expect(always.log.filter((l) => l.startsWith("fence"))).toHaveLength(5); // the first try, then 1, 2, 4 and 8 s
    expect(await always.vault.read("retry/b.md")).toBeNull();

    const other = harness(env.R2_DOUBLE, (n) => (n === 0 ? new Error("put: BadDigest (10037)") : null));
    await expect(other.vault.atomically((tx) => tx.swap("retry/c.md", null, enc("c")))).rejects.toThrow(/10037/);
    expect(other.log.filter((l) => l.startsWith("fence"))).toHaveLength(1);
  });

  it("rollForward finishes a journal: a refused put over the target bytes is done; over other bytes it is a conflict", async () => {
    const { vault, journals } = harness();
    await vault.atomically(async (tx) => { await tx.swap("roll/a.md", null, enc("target")); });
    await vault.rollForward(journals[0]!); // a restart re-drives the same journal: the bytes are there
    expect(dec((await vault.read("roll/a.md"))!.bytes)).toBe("target");

    await env.R2_DOUBLE.put("roll/a.md", "a foreign writer");
    const err = await vault.rollForward(journals[0]!).catch((e) => e);
    expect(err).toBeInstanceOf(R2Conflict);
    expect(err.path).toBe("roll/a.md");
    expect(dec((await vault.read("roll/a.md"))!.bytes)).toBe("a foreign writer");
  });
});

// RAI-316 (ADR-0024): one bucket per deployment, each star under `<key>/_/`. Only R2Vault adds and
// strips the prefix, so a star never lists, reads or writes another's objects, a nested key included.
describe("R2Vault under a star prefix", () => {
  const vaultAt = (key: string) => new R2Vault(env.R2_DOUBLE, { journal: noSleep, fence: noSleep, sleep: noSleep }, `${key}/_/`);

  it("two stars a.b/x and a.b/x/y in one bucket stay disjoint: list, read and write", async () => {
    const [x, y] = [vaultAt("a.b/x"), vaultAt("a.b/x/y")];
    for (const [key, page] of [["a.b/x", "items/one.md"], ["a.b/x/y", "items/two.md"]] as const) {
      await env.R2_DOUBLE.put(`${key}/_/${page}`, `---\ntitle: ${page}\n---\n`);
      await env.R2_DOUBLE.put(`${key}/_/star.yaml`, "meta: {}\n");
    }
    const paths = async (v: R2Vault, after?: string) => { const out: string[] = []; for await (const e of v.list({ after })) out.push(e.path); return out; };
    expect(await paths(x)).toEqual(["items/one.md"]);
    expect(await paths(y)).toEqual(["items/two.md"]);
    expect(await paths(x, "items/one.md")).toEqual([]);
    expect(await x.read("items/two.md")).toBeNull();
    expect(dec((await y.read("items/two.md"))!.bytes)).toContain("items/two.md");

    const r = await x.atomically((tx) => tx.swap("items/two.md", null, enc("x's own")));
    expect(r).toMatchObject({ ok: true }); // y's page of that name is not x's
    expect(await (await env.R2_DOUBLE.get("a.b/x/_/items/two.md"))!.text()).toBe("x's own");
    expect(await (await env.R2_DOUBLE.get("a.b/x/y/_/items/two.md"))!.text()).toContain("title");
  });

  it("the key cap counts the prefix", async () => {
    const v = vaultAt("a.b/x");
    const path = `items/${"a".repeat(1024 - "a.b/x/_/items/.md".length + 1)}.md`;
    await expect(v.atomically((tx) => tx.swap(path, null, enc("x")))).rejects.toMatchObject({ code: "invalid" });
  });
});
