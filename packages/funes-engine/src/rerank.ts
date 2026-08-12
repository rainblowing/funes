/** S4 rerank — an OPTIONAL top stage over RRF output. RRF stays always-on and parity-pinned
 *  (PLAN: "parity asserted on RRF output; post-rerank order is profile-specific"); a reranker
 *  only reorders the candidates a profile explicitly opts into via `RecallQuery.rerank`.
 */

/** The rerank contract the store consumes (injected — tests fake it, profiles pick an impl).
 *  MOVED to funes-core in P3.14 (both backends type against it; the core is the shared tier);
 *  re-exported here so existing `./rerank.ts` importers keep working. */
export type { Reranker } from "funes-core";
import type { Reranker } from "funes-core";

/** Xenova mirror of cross-encoder/ms-marco-MiniLM-L-6-v2 (ONNX) — the standard MS MARCO
 *  passage reranker. Same lazy-load + q8 quantization style as the E5 embedder; the
 *  text-classification *pipeline* in transformers.js has no `text_pair` support, so we drive
 *  AutoTokenizer + AutoModelForSequenceClassification directly with query/passage pairs. */
export const RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
const MAX_CHARS = 2000; // mirror the embedder: pre-truncate before tokenizing huge bodies

export class CrossEncoderReranker implements Reranker {
  private tokenizer: any | null = null;
  private model: any | null = null;

  // P3.15: explicit fields, not parameter properties (non-erasable TS — Node's loader refuses it).
  private modelId: string;
  private dtype: string;

  constructor(modelId: string = RERANK_MODEL, dtype: string = "q8") {
    this.modelId = modelId;
    this.dtype = dtype;
  }

  private async load(): Promise<{ tokenizer: any; model: any }> {
    if (!this.model) {
      const { AutoTokenizer, AutoModelForSequenceClassification } = await import("@huggingface/transformers");
      this.tokenizer = await AutoTokenizer.from_pretrained(this.modelId);
      this.model = await AutoModelForSequenceClassification.from_pretrained(this.modelId, { dtype: this.dtype as any });
    }
    return { tokenizer: this.tokenizer, model: this.model };
  }

  async rerank(query: string, docs: Array<{ id: string; text: string }>): Promise<string[]> {
    if (docs.length <= 1) return docs.map((d) => d.id);
    const { tokenizer, model } = await this.load();
    const passages = docs.map((d) => (d.text.length > MAX_CHARS ? d.text.slice(0, MAX_CHARS) : d.text));
    // Cross-encoders score (query, passage) PAIRS — one batched forward, [N, 1] relevance logits.
    const inputs = tokenizer(docs.map(() => query), { text_pair: passages, padding: true, truncation: true });
    const { logits } = await model(inputs);
    const scores = (logits.tolist() as number[][]).map((row) => row[0]!);
    return docs
      .map((d, i) => ({ id: d.id, score: scores[i]! }))
      .sort((a, b) => b.score - a.score) // stable sort: ties keep incoming (RRF) order
      .map((x) => x.id);
  }
}
