// PLAN-0.5.0 item 25 (record 35 Handed on): the eval's recall over MCP under an agent bearer — the
// one door the edge has (record 32: no token, no tools), so the edge baseline is measured through the
// public surface an agent uses, not through a store this process opens. The generation source is
// recall's own envelope: at the edge there is no manifest, and only the database answers the
// content generation (GLOSSARY). The serving identity (serving and embedding signatures, locus) is
// health's, read before the first case and after the last (RAI-308 Q10).
import type { RecallResult } from "funes-core/internal";
import type { Where } from "funes-core/internal";
import type { EvalPage } from "./recall-eval.ts";
import { connectMcp } from "./mcp-client.ts";

/** What the answering server named for a run: the generation on every recall, and the serving
 *  identity at the start equal to the one at the end — one value each, or the run throws. An A→B→A
 *  flip of identity in mid-run is not observed: one process serves one star, its posture fixed. */
export interface Answered {
  contentGeneration: string | null;
  servingSignature: string | null;
  embeddingSignature: string | null;
  locus: string | null;
}
type Identity = Omit<Answered, "contentGeneration">;

export async function connectMcpEval(url: string, token: string | null): Promise<{
  recall(query: string, k: number, where?: Where): Promise<RecallResult[]>;
  page(id: string): Promise<EvalPage | null>;
  answered(): Promise<Answered>;
  close(): Promise<void>;
}> {
  const client = await connectMcp(url, token);
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    try {
      return await client.call(name, args) as Record<string, unknown>;
    } catch (e) {
      throw Object.assign(new Error(`eval --url: ${name} refused — ${(e as Error).message}`), { code: (e as { code?: unknown }).code });
    }
  };
  const identity = async (): Promise<Identity> => {
    const h = await call("health", {});
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    return { servingSignature: str(h.servingSignature), embeddingSignature: str(h.embeddingSignature), locus: str(h.locus) };
  };
  let start: Identity | null = null;
  let generation: { value: string | null } | null = null;
  return {
    async recall(query, k, where) {
      start ??= await identity();
      const env = await call("recall", { query, k, ...(where ? { where } : {}) });
      // RAI-176: a server that answers a `where` with no `plan` stripped it — unfiltered results
      // scored as filtered would be a number about a different question.
      if (where && !env.plan) throw new Error("eval --url: the server answered a `where` case with no plan — it does not filter (pre-0.5.0?)");
      const now = (env.contentGeneration as string | null) ?? null;
      // A build or a write landing mid-run means the cases were scored over more than one set of
      // rows: no single generation names the run, so it is not a measurement of one.
      if (generation && generation.value !== now) {
        throw new Error(`eval --url: the content generation moved mid-run (${generation.value} → ${now}) — re-run`);
      }
      generation = { value: now };
      return (env.results as Array<{ id: string; title: string; score: number }>).map((h) => ({ id: h.id, title: h.title, score: h.score }));
    },
    async page(id) {
      // ponytail: no MCP op serves a page's edges, so links are unknown and no hit is ever claimed
      // for the vector arm over MCP; add an edge-served links read if Q3 needs `vector` at the edge.
      try {
        const p = await call("indexed_page", { id });
        return { text: [p.title, p.description, p.body].filter((s) => typeof s === "string").join("\n"), links: null };
      } catch {
        return null;
      }
    },
    async answered() {
      if (!start || !generation) throw new Error("eval --url: no recall has answered yet");
      const end = await identity();
      if (JSON.stringify(end) !== JSON.stringify(start)) {
        throw new Error(`eval --url: the server's serving identity moved mid-run (${JSON.stringify(start)} → ${JSON.stringify(end)}) — re-run`);
      }
      return { contentGeneration: generation.value, ...start };
    },
    close: () => client.close(),
  };
}
