// PLAN-0.5.0 item 37's proofs at the served surface: recall_v2 dispatched by funes-engine's own
// `dispatchToolCall` over the edge store, under workerd — the own-star scope guard (guardedRead),
// `fields` from the star's declared served keys, `plan` echoed, the generation read after recall,
// the edge's serving signature. The declaration is the bundled taste star.yaml's (item 34).
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { parse } from "yaml";
import type { Embedder, MemoryItem } from "funes-core";
import { validateRecallDeclaration } from "funes-engine/light";
import { dispatchToolCall, operations, type OperationContext, type StarConfig } from "funes-engine/portable";
import { scopeHash } from "funes-shared";
import { EdgeStore } from "../src/edge-store.ts";
import starYaml from "../src/star.yaml?raw";

class OneHot implements Embedder {
  readonly dim = 1024;
  readonly id = "test/one-hot";
  private v(t: string) { const v = new Float32Array(1024); v[t.length % 1024] = 1; return v; }
  async embedQuery(t: string) { return this.v(t); }
  async embedPassage(t: string) { return this.v(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.v(t)); }
}

const declared = validateRecallDeclaration(parse(starYaml).memory.recall);
if (!declared.ok) throw new Error(declared.errors.join("; "));
const TASTE: StarConfig = {
  identity: { id: "rainblow.ing/taste", writeLocus: "funes-taste" } as StarConfig["identity"],
  scope: { kind: "valid", excludes: [] }, // the taste star declares no index_scope: a valid empty scope
  recall: { kind: "valid", declaration: declared.declaration },
};

const item = (id: string, title: string, frontmatter: MemoryItem["frontmatter"]): MemoryItem =>
  ({ id, path: `${id}.md`, title, body: `${title}, a film`, trust: "trusted", frontmatter });
const film = { domain: "movies", type: "Film", creator: "Tarkovsky" };

it("recall_v2 at the edge: fields carry the served keys, my_score beside its proxy, and the envelope names the edge", async () => {
  const stub = env.TASTE.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (_o, state) => {
    const store = new EdgeStore(state.storage, new OneHot());
    const items = [
      item("items/stalker", "Stalker", { ...film, suggested: true, taste_status: "want", title: "Stalker" }),
      item("items/mirror", "Mirror", { ...film, my_score: 9, my_score_proxy: true, title: "Mirror" }),
      item("items/solaris", "Solaris", { ...film, my_score: 8, secret_note: "never served" }),
    ];
    store.beginBuild();
    store.writeBuild(await store.embed(items), items.map((i) => ({ id: i.id, version: `etag-${i.id}` })));
    store.swap({ scope: { hash: scopeHash([]), ignoreScope: false }, ownerStarId: "rainblow.ing/taste", okf: null });

    const ctx = {
      remote: true, trust: "untrusted", star: () => TASTE, store,
      designation: { mode: "audit", locus: "funes-taste", authority: "funes-taste" },
    } as unknown as OperationContext;
    const out = await dispatchToolCall(operations, "recall_v2", { query: "Tarkovsky film", k: 5, where: { domain: "movies" } }, ctx) as {
      results: Array<{ id: string; fields: Record<string, unknown> }>; plan: unknown; generationValid: boolean;
      contentGeneration: string; servingSignature: string; locus: string;
    };
    const byId = Object.fromEntries(out.results.map((r) => [r.id, r.fields]));

    // A suggested hit carries fields.suggested: true.
    expect(byId["items/stalker"]).toEqual({ domain: "movies", taste_status: "want", suggested: true, type: "Film", creator: "Tarkovsky" });
    // my_score never travels without the proxy flag the page carries.
    expect(byId["items/mirror"]).toEqual({ domain: "movies", my_score: 9, my_score_proxy: true, type: "Film", creator: "Tarkovsky" });
    // An undeclared key is never served; a page without the proxy flag serves its score alone.
    expect(byId["items/solaris"]).toEqual({ domain: "movies", my_score: 8, type: "Film", creator: "Tarkovsky" });
    for (const f of Object.values(byId)) if ("my_score_proxy" in f) expect(f).toHaveProperty("my_score");

    expect(out.plan).toEqual({ arms: ["fts", "vector", "graph"], where: { domain: "movies" }, collapse: ["type", "creator"] });
    expect(out.generationValid).toBe(true);
    expect(out.contentGeneration).toMatch(/^v3:/);
    expect(out.servingSignature).toBe(store.servingSignature());
    expect(out.servingSignature).toMatch(/^sv1:/);
    expect(out.locus).toBe("funes-taste");

    // The own-star guard reads the edge's stamped scope: a narrowed star.yaml refuses the read.
    const narrowed = { ...ctx, star: () => ({ ...TASTE, scope: { kind: "valid", excludes: ["items/**"] } }) } as OperationContext;
    await expect(dispatchToolCall(operations, "recall_v2", { query: "Tarkovsky" }, narrowed)).rejects.toThrow(/scope-hash mismatch/);
  });
});
