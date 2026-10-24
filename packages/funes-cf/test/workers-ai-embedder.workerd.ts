// PLAN-0.5.0 item 38 (ADR-0015, record 31): the WorkersAiEmbedder and its canary, inside a real
// SQLite-backed DO under local workerd. The AI binding is a fake object, never Workers AI.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { embeddingSignature, type MemoryItem } from "funes-core/internal";
import { EdgeStore } from "../src/edge-store.ts";
import { buildItems } from "./edge-build.ts";
import { FIXTURE_KEY } from "./fixture-star.ts";
import { CANARY, CANARY_TOLERANCE, WorkersAiEmbedder } from "../src/workers-ai-embedder.ts";

/** A fake Workers AI: one unit vector per text (its UTF-8 length picks the dimension), reporting
 *  `pooling`. `tilt` rotates every answer by the angle whose cosine it is. */
class FakeAi {
  calls: Array<{ model: string; inputs: unknown; options: unknown }> = [];
  pooling: string | undefined = "cls";
  dim = 1024;
  tilt = 1;
  fail = false;
  async run(model: string, inputs: { text: string[] }, options?: unknown) {
    this.calls.push({ model, inputs, options });
    if (this.fail) throw new Error("3040: capacity");
    const data = inputs.text.map((t) => {
      const v = new Array(this.dim).fill(0);
      const k = new TextEncoder().encode(t).length % (this.dim - 1);
      v[k] = this.tilt;
      v[k + 1] = Math.sqrt(1 - this.tilt * this.tilt);
      return v;
    });
    return { shape: [data.length, this.dim], data, ...(this.pooling === undefined ? {} : { pooling: this.pooling }) };
  }
}

const SCOPE = { hash: "scope-hash-of-nothing", ignoreScope: false };
const page = (id: string, body: string): MemoryItem => ({ id, path: `${id}.md`, title: id, body, trust: "trusted" });
const PAGES = [page("items/a", "one"), page("items/b", "two two"), page("items/c", "three three three")];

function inDo<T>(fn: (ctx: { ai: FakeAi; e: WorkersAiEmbedder; store: EdgeStore; storage: DurableObjectStorage }) => Promise<T>): Promise<T> {
  return runInDurableObject(env.STAR.getByName(crypto.randomUUID()), async (_o, state) => {
    const ai = new FakeAi();
    const e = new WorkersAiEmbedder(ai as unknown as Ai, state.storage);
    return fn({ ai, e, store: new EdgeStore(state.storage, e), storage: state.storage });
  });
}

const build = (store: EdgeStore, items: MemoryItem[]) => buildItems(store, items, { scope: SCOPE });

describe("the canary (acceptance)", () => {
  it("a fake embedder's drift moves cfp and re-embeds every chunk", () =>
    inDo(async ({ ai, e, store }) => {
      expect(await e.runCanary()).toBe("recorded");
      const before = embeddingSignature(e);
      expect(before).toMatch(/^@cf\/baai\/bge-m3:1024:pool=cls:fwd=1:plat=workers-ai:cfp=[0-9a-f]{16}$/);
      await build(store, PAGES);
      expect((await store.stats()).embeddingSignature).toBe(`${before}:chunk1800o200`);

      // Steady: nothing written, and a rebuild reuses every vector (no passage call).
      expect(await e.runCanary()).toBe("steady");
      expect(store.buildTrigger(FIXTURE_KEY, { scope: SCOPE })).toBeNull();
      ai.calls = [];
      await build(store, PAGES);
      expect(ai.calls).toEqual([]);

      // Drift: cfp moves, so the embedding spec moves and the built slot is a trigger.
      ai.tilt = 0.999;
      expect(await e.runCanary()).toBe("drift");
      expect(store.buildTrigger(FIXTURE_KEY, { scope: SCOPE })).toBe("versions");
      const after = embeddingSignature(e);
      expect(after).not.toBe(before);
      expect(after.replace(/cfp=.*/, "")).toBe(before.replace(/cfp=.*/, ""));

      // The build that follows re-embeds every chunk (one call each) and signs the new cfp.
      ai.calls = [];
      await build(store, PAGES);
      expect(ai.calls.length).toBe(PAGES.length);
      expect((await store.stats()).embeddingSignature).toBe(`${after}:chunk1800o200`);
    }));
});

describe("what counts as drift", () => {
  it("a changed pooling, a changed length, or a cosine under the tolerance; not a cosine at or above it", async () => {
    expect(CANARY_TOLERANCE).toBe(0.9999); // the placeholder until runbook R11b
    const after = (change: (ai: FakeAi) => void) =>
      inDo(async ({ ai, e }) => {
        await e.runCanary();
        change(ai);
        return e.runCanary();
      });
    expect(await after((ai) => { ai.pooling = "mean"; })).toBe("drift");
    expect(await after((ai) => { ai.pooling = undefined; })).toBe("drift"); // absent counts as none
    expect(await after((ai) => { ai.dim = 1023; })).toBe("drift");
    expect(await after((ai) => { ai.tilt = 0.9998; })).toBe("drift");
    expect(await after((ai) => { ai.tilt = 0.99995; })).toBe("steady");
  });

  it("an absent pooling is signed as pool=none", () =>
    inDo(async ({ ai, e }) => {
      ai.pooling = undefined;
      await e.runCanary();
      expect(embeddingSignature(e)).toMatch(/:pool=none:/);
    }));

  it("a Workers AI failure leaves the canary pending: it throws and records nothing", () =>
    inDo(async ({ ai, e, storage }) => {
      ai.fail = true;
      await expect(e.runCanary()).rejects.toThrow(/3040/);
      expect(storage.sql.exec("select count(*) as n from canary").one().n).toBe(0);
      ai.fail = false;
      expect(await e.runCanary()).toBe("recorded");
    }));

  it("a fresh instance over the same storage signs the recorded canary", () =>
    inDo(async ({ ai, e, storage }) => {
      await e.runCanary();
      expect(embeddingSignature(new WorkersAiEmbedder(ai as unknown as Ai, storage))).toBe(embeddingSignature(e));
    }));
});

describe("the calls", () => {
  it("embeds bge-m3, one text per call, with no options, and refuses a vector that is not 1024 long", () =>
    inDo(async ({ ai, e }) => {
      expect((await e.embedPassages(["x", "yy"])).map((v) => v.length)).toEqual([1024, 1024]);
      await e.embedQuery("q");
      await e.runCanary();
      expect(ai.calls.length).toBe(3 + 2 * CANARY.length); // the lazy canary first, then the explicit one
      for (const c of ai.calls) {
        expect(c.model).toBe("@cf/baai/bge-m3");
        expect((c.inputs as { text: string[] }).text.length).toBe(1);
        expect(c.inputs).not.toHaveProperty("truncate_inputs");
        expect(c.options).toBeUndefined();
      }
      ai.dim = 768;
      await expect(e.embedPassage("x")).rejects.toThrow(/768/);
    }));
});

// RAI-316 (ADR-0024): the canary is lazy — once per instance, before its first embedding call — so a
// wake that embeds nothing costs no Workers AI call.
describe("the lazy canary", () => {
  it("runs once per instance before the first embedding call, and a failed run retries at the next call", () =>
    inDo(async ({ ai, e, storage }) => {
      expect(ai.calls).toEqual([]); // the constructor calls nothing
      ai.fail = true;
      await expect(e.embedQuery("q")).rejects.toThrow(/3040/);
      expect(ai.calls.length).toBe(1); // the canary's first text failed: no query call
      ai.fail = false;
      ai.calls = [];
      await Promise.all([e.embedQuery("q"), e.embedPassage("p")]);
      expect(ai.calls.map((c) => (c.inputs as { text: string[] }).text[0])).toEqual([...CANARY, "q", "p"]);
      await e.embedQuery("again");
      expect(ai.calls.length).toBe(CANARY.length + 3);
      expect(storage.sql.exec("select count(*) as n from canary").one().n).toBe(CANARY.length);
    }));
});
