/** S4 rerank — an OPTIONAL top stage over RRF output. RRF stays always-on and parity-pinned
 *  (PLAN: "parity asserted on RRF output; post-rerank order is profile-specific"); a reranker
 *  only reorders the candidates a profile explicitly opts into via `RecallQuery.rerank`.
 *
 *  Only the CONTRACT lives in the portable core (P3.14) — both backends type against it. The
 *  cross-encoder implementation (CrossEncoderReranker, @huggingface/transformers) stays in
 *  funes-engine, which the core's H7 purity lint would otherwise reject. */
export interface Reranker {
  /** Order doc ids best-first for `query`. Must return a permutation of the input ids. */
  rerank(query: string, docs: Array<{ id: string; text: string }>): Promise<string[]>;
}
