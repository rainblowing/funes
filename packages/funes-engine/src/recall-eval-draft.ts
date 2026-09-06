// Draft an eval fixture SKELETON (PLAN-0.2.1 step 8, the "~30 queries, ~10 from pages recall_stats
// has never recorded" half).
//
// It samples pages and writes one case per page. It does NOT write `relevant`, and that omission is
// the point: expected ids are the human's, authored before any run output is visible. A gate whose
// answers were produced by the system under test measures agreement with itself.
//
// The SPLIT comes from telemetry, not from retrieval: `seen` = a page `recall_stats` has recorded,
// `unseen` = one it never has. That is a fact about what has been asked, not about what the index
// would return, so using it here does not leak the answer key.
import type { FunesIndexStore } from "funes-core";
import type { EvalCase, EvalFixture } from "./recall-eval.ts";

export interface DraftOpts {
  vault: string;
  seen: number;
  unseen: number;
  k?: number;
}

interface Row { id: string; title: string | null; path: string | null }

/** Sample pages and emit the skeleton. `store` must expose the underlying libsql handle — the
 *  drafting query is a two-table join the store interface has no verb for, and inventing one for a
 *  drafting tool would put a corpus-sampling method on every backend forever. */
export function draftFixture(store: FunesIndexStore, opts: DraftOpts): EvalFixture {
  const db = (store as unknown as { db?: { prepare(sql: string): { all(...a: unknown[]): unknown[] } } }).db;
  if (!db) throw new Error("eval --draft: this store exposes no libsql handle (libsql-only, like the hub)");

  // TRUSTED pages only, and none from an OUTPUT zone: an eval should ask about the corpus, not
  // about the artifacts the corpus generated about itself. Sampled deterministically (id order,
  // strided) rather than randomly — a fixture that changes between drafts is not a frozen split.
  const seen = db.prepare(
    `select n.id as id, n.title as title, n.path as path
       from recall_stats s join nodes n on n.id = s.memory_id
      where n.trust = 'trusted' and n.id not like 'out/%' and n.id not like 'out_%'
      order by s.hit_count desc, n.id asc limit ?`,
  ).all(Math.max(opts.seen * 4, opts.seen)) as Row[];

  const unseen = db.prepare(
    `select n.id as id, n.title as title, n.path as path
       from nodes n left join recall_stats s on n.id = s.memory_id
      where s.memory_id is null and n.trust = 'trusted' and n.id not like 'out/%' and n.id not like 'out_%'
      order by n.id asc limit ?`,
  ).all(Math.max(opts.unseen * 8, opts.unseen)) as Row[];

  const stride = (rows: Row[], want: number): Row[] => {
    if (rows.length <= want) return rows;
    const step = rows.length / want;
    return Array.from({ length: want }, (_, i) => rows[Math.floor(i * step)]!);
  };

  const caseOf = (r: Row, split: EvalCase["split"], i: number): EvalCase => ({
    id: `${split}-${String(i + 1).padStart(2, "0")}`,
    // A DRAFT question, derived from the page's title. Rewrite it: a query that echoes the title is
    // a keyword lookup, and an eval built from those reports that exact-match retrieval works.
    query: `DRAFT — ask a real question this page answers: ${r.title ?? r.id}`,
    relevant: [],
    split,
    note: `drafted from ${r.path ?? r.id}`,
  });

  const cases = [
    ...stride(seen, opts.seen).map((r, i) => caseOf(r, "seen", i)),
    ...stride(unseen, opts.unseen).map((r, i) => caseOf(r, "unseen", i)),
  ];

  return {
    vault: opts.vault,
    k: opts.k ?? 5,
    // Thresholds are a DECISION, not a measurement — these are placeholders the author replaces
    // before the baseline run, and `validateFixture` accepts any number in [0,1], so nothing here
    // stops a careless value. The plan's rule is the real control: commit them before running.
    thresholds: { pAtK: 0.8, mrr: 0.6, negativeRate: 0.1, unseenPAtK: 0.6 },
    cases,
  };
}
