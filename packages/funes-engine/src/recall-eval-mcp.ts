// PLAN-0.5.0 item 25 (record 35 Handed on): the eval's recall over MCP under an agent bearer — the
// one door the edge has (record 32: no token, no tools), so the edge baseline is measured through the
// public surface an agent uses, not through a store this process opens. The generation source is
// recall_v2's own envelope: at the edge there is no manifest, and only the database answers the
// content generation (GLOSSARY).
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { isB64Token, type RecallResult } from "funes-core";
import type { Where } from "./recall-planner.ts";
import type { EvalPage } from "./recall-eval.ts";
import { FUNES_VERSION } from "./version.ts";

/** What the answering server named on every recall of a run — one value, or the run throws. */
export interface Answered {
  contentGeneration: string | null;
  generationValid: boolean;
  servingSignature: string | null;
  locus: string | null;
  publicationId: string | null;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export async function connectMcpEval(url: string, token: string): Promise<{
  recall(query: string, k: number, where?: Where): Promise<RecallResult[]>;
  page(id: string): Promise<EvalPage | null>;
  answered(): Answered;
  embeddingSignature(): Promise<string | null>;
  close(): Promise<void>;
}> {
  if (!isB64Token(token)) throw new Error("eval --mcp: the token file holds no bearer token");
  const u = new URL(url);
  // ADR-0014 / A4: a bearer never crosses a network in clear text; plain http only to loopback.
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) {
    throw new Error(`eval --mcp: ${u.origin} — a bearer is sent over https only (plain http to loopback only)`);
  }
  const client = new Client({ name: "funes-eval", version: FUNES_VERSION });
  await client.connect(new StreamableHTTPClientTransport(u, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const r = await client.callTool({ name, arguments: args });
    const text = ((r.content ?? []) as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
    if (r.isError) throw new Error(`eval --mcp: ${name} refused — ${text}`);
    return JSON.parse(text) as Record<string, unknown>;
  };
  let answered: Answered | null = null;
  return {
    async recall(query, k, where) {
      const env = await call("recall_v2", { query, k, ...(where ? { where } : {}) });
      // RAI-176: a server that answers a `where` with no `plan` stripped it — unfiltered results
      // scored as filtered would be a number about a different question.
      if (where && !env.plan) throw new Error("eval --mcp: the server answered a `where` case with no plan — it does not filter (pre-0.5.0?)");
      const now: Answered = {
        contentGeneration: (env.contentGeneration as string | null) ?? null,
        generationValid: env.generationValid === true,
        servingSignature: (env.servingSignature as string | null) ?? null,
        locus: (env.locus as string | null) ?? null,
        publicationId: (env.publicationId as string | null) ?? null,
      };
      // A build or a write landing mid-run means the cases were scored over more than one set of
      // rows: no single generation names the run, so it is not a measurement of one.
      if (answered && JSON.stringify(answered) !== JSON.stringify(now)) {
        throw new Error(`eval --mcp: the server's envelope moved mid-run (${JSON.stringify(answered)} → ${JSON.stringify(now)}) — re-run`);
      }
      answered = now;
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
    answered() {
      if (!answered) throw new Error("eval --mcp: no recall has answered yet");
      return answered;
    },
    async embeddingSignature() {
      return ((await call("health", {})).embeddingSignature as string | null) ?? null;
    },
    close: () => client.close(),
  };
}
