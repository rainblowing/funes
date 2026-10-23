// PLAN-0.5.0 item 37's proofs at the served surface: recall dispatched by the kernel's own
// `dispatchToolCall` over the edge store, under workerd — the own-star scope guard (guardedRead),
// `fields` from the star's declared served keys, `plan` echoed, the generation read after recall,
// and (RAI-308) the answer parsed against the frozen strict schema. The declaration is the fixture
// star's (test/fixture-star.ts).
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Embedder } from "funes-core";
import type { MemoryItem } from "funes-core/internal";
import { dispatchToolCall, type OperationContext } from "funes-core";
import { operations, starConfigFromText } from "funes-core/internal";
import { scopeHash } from "funes-core";
import { EdgeStore } from "../src/edge-store.ts";
import { buildItems } from "./edge-build.ts";
import { FIXTURE_YAML } from "./fixture-star.ts";

class OneHot implements Embedder {
  readonly dim = 1024;
  readonly id = "test/one-hot";
  private v(t: string) { const v = new Float32Array(1024); v[t.length % 1024] = 1; return v; }
  async embedQuery(t: string) { return this.v(t); }
  async embedPassage(t: string) { return this.v(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.v(t)); }
}

const STAR = starConfigFromText(FIXTURE_YAML); // no index_scope: a valid empty scope
if (STAR.recall?.kind !== "valid") throw new Error("the fixture's recall declaration does not validate");

const item = (id: string, title: string, frontmatter: MemoryItem["frontmatter"]): MemoryItem =>
  ({ id, path: `${id}.md`, title, body: `${title}, a film`, trust: "trusted", frontmatter });
const film = { domain: "movies", type: "Film", creator: "Tarkovsky" };

it("recall at the edge: fields carry the served keys, score beside its proxy, and the envelope parses strictly", async () => {
  const stub = env.STAR.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (_o, state) => {
    const store = new EdgeStore(state.storage, new OneHot());
    const items = [
      item("items/stalker", "Stalker", { ...film, suggested: true, status: "want", title: "Stalker" }),
      item("items/mirror", "Mirror", { ...film, score: 9, score_proxy: true, title: "Mirror" }),
      item("items/solaris", "Solaris", { ...film, score: 8, secret_note: "never served" }),
    ];
    await buildItems(store, items, { scope: { hash: scopeHash([]), ignoreScope: false } });

    const ctx = {
      star: () => STAR, store, tier: "edge",
      designation: { locus: "funes-taste", authority: "funes-taste" },
    } as unknown as OperationContext;
    const out = await dispatchToolCall("recall", { query: "Tarkovsky film", k: 5, where: { domain: "movies" } }, ctx) as {
      results: Array<{ id: string; fields: Record<string, unknown> }>; plan: unknown; contentGeneration: string;
    };
    operations.find((o) => o.name === "recall")!.result!.parse(out);
    const byId = Object.fromEntries(out.results.map((r) => [r.id, r.fields]));

    // A suggested hit carries fields.suggested: true.
    expect(byId["items/stalker"]).toEqual({ domain: "movies", status: "want", suggested: true, type: "Film", creator: "Tarkovsky" });
    // score never travels without the proxy flag the page carries.
    expect(byId["items/mirror"]).toEqual({ domain: "movies", score: 9, score_proxy: true, type: "Film", creator: "Tarkovsky" });
    // An undeclared key is never served; a page without the proxy flag serves its score alone.
    expect(byId["items/solaris"]).toEqual({ domain: "movies", score: 8, type: "Film", creator: "Tarkovsky" });
    for (const f of Object.values(byId)) if ("score_proxy" in f) expect(f).toHaveProperty("score");

    expect(out.plan).toEqual({ arms: ["fts", "vector", "graph"], where: { domain: "movies" }, collapse: ["type", "creator"] });
    expect(out.contentGeneration).toMatch(/^v3:/);
    // RAI-308: the serving signature and the locus are health's, not recall's; no stale flag at the edge
    expect(Object.keys(out).sort()).toEqual(["contentGeneration", "plan", "results"]);
    expect(store.servingSignature()).toBe("do-sqlite:rank/2");

    // The own-star guard reads the edge's stamped scope: a narrowed star.yaml refuses the read.
    const narrowed = { ...ctx, star: () => ({ ...STAR, scope: { kind: "valid", excludes: ["items/**"] } }) } as OperationContext;
    await expect(dispatchToolCall("recall", { query: "Tarkovsky" }, narrowed)).rejects.toMatchObject({ code: "out-of-scope" });
  });
});
