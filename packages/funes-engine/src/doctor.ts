// `funes doctor` — the graph audit (PLAN-0.2.1 step 24). Pure: rows in, report out. No store, no
// filesystem, no clock, so the whole thing is testable without a database and neither backend can
// hold a private opinion about what "dangling" means.
//
// It REPORTS and never repairs. That is a decision, not an unfinished half: the three findings
// below have three different remedies (a broken wikilink is edited in the vault, an orphan may be
// perfectly healthy, a spelling fork is already healed at comparison time by
// normalizeRelationType), and a command that rewrote them would be rewriting the user's notes on
// the strength of a heuristic. There is also no `graph.json` write — `graph()` caches an artifact
// beside the index, and an audit that warmed that cache would mutate what it came to measure.
import { normalizeRelationType, type IndexStats } from "funes-core";
import { expectationRefusal, type GraphAuditRows, type OkfCounts, type ServingIndex } from "funes-core/internal";
import { crossStarExpectation, ownStarExpectation } from "funes-core/internal";
import type { StarConfig } from "funes-core/internal";
import type { SyncConflictFinding } from "./sync-conflicts.ts";
import { contractState, type ContractSource, type ContractState } from "funes-core/internal";

/** Locale-INDEPENDENT string order. `localeCompare` resolves against the runtime's DEFAULT LOCALE
 *  and ICU collation, which treats punctuation as secondary — it orders `related_to` before
 *  `related-to`, the reverse of code-unit order, and is free to differ between machines and ICU
 *  builds. That would make two audits of the SAME generation produce different bytes, which is
 *  exactly the property this report is supposed to have. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One relation type's dangling edges, as stored (the RAW spelling — the fork report below is the
 *  place spellings get folded together, and folding them here would hide which producer emitted
 *  the broken edges). */
export interface DanglingTypeRow {
  type: string;
  count: number;
  /** The most-cited absent targets. A single id at the top of this list is the usual shape: one
   *  deleted or renamed page that many notes still point at. */
  topTargets: Array<{ target: string; count: number }>;
  /** A few of the pages holding those edges — where an operator starts reading. */
  sampleSources: string[];
}

/** One relation whose stored spellings disagree. `normalized` is the comparison key every consumer
 *  already uses; `spellings` is what is actually in the rows. */
export interface SpellingFork {
  normalized: string;
  spellings: Array<{ spelling: string; count: number }>;
}

export interface GraphAuditReport {
  nodes: number;
  edges: number;
  /** Edges whose target is not a node. */
  dangling: number;
  danglingByType: DanglingTypeRow[];
  /** Edges with BOTH ends present — the graph that recall's graph arm can actually traverse. */
  resolved: number;
  /** Nodes with zero RESOLVED incident edges, isolated + danglingOnly together. */
  orphans: number;
  /** Orphans with no incident edge at all: a page nothing links to and which links nowhere. */
  isolated: number;
  /** Orphans that DO carry edges, every one of which dangles. Their own class because the remedy
   *  is the opposite of an isolated node's: this page tried to join the graph and missed, so the
   *  finding is a broken link to fix, not a page to connect. */
  danglingOnly: number;
  sampleIsolated: string[];
  sampleDanglingOnly: string[];
  spellingForks: SpellingFork[];
}

export interface AuditOpts {
  /** Absent targets listed per relation type. */
  topTargets?: number;
  /** Ids listed per sample list. */
  samples?: number;
}

export function auditGraphRows(rows: GraphAuditRows, opts: AuditOpts = {}): GraphAuditReport {
  const topTargets = opts.topTargets ?? 5;
  const samples = opts.samples ?? 5;
  // PLAN-0.4.0 item 17 (RAI-128): the release gate deep-equals two loci's reports, and neither
  // backend's auditGraph() selects with an ORDER BY (the libSQL store.ts:751-752, engine
  // store.ts:1069), while the sample lists and each type's `sampleSources` below follow row order —
  // so one content generation could audit to two reports. Sorted HERE with `cmp`, not in SQL: an
  // `order by` under a non-C Postgres collation is the machine-dependent order `cmp` exists to avoid.
  const nodeIds = [...rows.nodeIds].sort(cmp);
  const edges = [...rows.edges].sort((x, y) => cmp(x.source, y.source) || cmp(x.type, y.type) || cmp(x.target, y.target));
  const nodes = new Set(nodeIds);

  // One pass over the edges collects everything: what dangles, by which type, from where, and
  // which nodes end the pass with a resolved edge attached.
  const resolvedIncident = new Set<string>();
  const incident = new Set<string>();
  const perType = new Map<string, { count: number; targets: Map<string, number>; sources: string[] }>();
  const spellings = new Map<string, number>();
  let dangling = 0;

  for (const e of edges) {
    spellings.set(e.type, (spellings.get(e.type) ?? 0) + 1);
    const sourceIsNode = nodes.has(e.source);
    const targetIsNode = nodes.has(e.target);
    // Only a real node can be incident to anything; a dangling target is a string, not a page.
    if (sourceIsNode) incident.add(e.source);
    if (targetIsNode) incident.add(e.target);
    if (sourceIsNode && targetIsNode) {
      resolvedIncident.add(e.source);
      resolvedIncident.add(e.target);
      continue;
    }
    dangling++;
    let t = perType.get(e.type);
    if (!t) perType.set(e.type, (t = { count: 0, targets: new Map(), sources: [] }));
    t.count++;
    t.targets.set(e.target, (t.targets.get(e.target) ?? 0) + 1);
    if (t.sources.length < samples && !t.sources.includes(e.source)) t.sources.push(e.source);
  }

  const sampleIsolated: string[] = [];
  const sampleDanglingOnly: string[] = [];
  let isolated = 0;
  let danglingOnly = 0;
  for (const id of nodeIds) {
    if (resolvedIncident.has(id)) continue;
    if (incident.has(id)) {
      danglingOnly++;
      if (sampleDanglingOnly.length < samples) sampleDanglingOnly.push(id);
    } else {
      isolated++;
      if (sampleIsolated.length < samples) sampleIsolated.push(id);
    }
  }

  // Count desc, then key asc — a TOTAL order everywhere, so two audits of the same generation
  // produce byte-identical output and an operator can diff them.
  const danglingByType: DanglingTypeRow[] = [...perType.entries()]
    .map(([type, t]) => ({
      type,
      count: t.count,
      topTargets: [...t.targets.entries()]
        .map(([target, count]) => ({ target, count }))
        .sort((a, b) => (b.count - a.count) || cmp(a.target, b.target))
        .slice(0, topTargets),
      sampleSources: t.sources,
    }))
    .sort((a, b) => (b.count - a.count) || cmp(a.type, b.type));

  const forks = new Map<string, Array<{ spelling: string; count: number }>>();
  for (const [spelling, count] of spellings) {
    const n = normalizeRelationType(spelling);
    const list = forks.get(n);
    if (list) list.push({ spelling, count });
    else forks.set(n, [{ spelling, count }]);
  }
  const spellingForks: SpellingFork[] = [...forks.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([normalized, list]) => ({
      normalized,
      spellings: list.sort((a, b) => (b.count - a.count) || cmp(a.spelling, b.spelling)),
    }))
    .sort((a, b) => cmp(a.normalized, b.normalized));

  return {
    nodes: nodeIds.length,
    edges: edges.length,
    dangling,
    danglingByType,
    resolved: edges.length - dangling,
    orphans: isolated + danglingOnly,
    isolated,
    danglingOnly,
    sampleIsolated,
    sampleDanglingOnly,
    spellingForks,
  };
}

// ── sync conflicts (0.4.0 item 7, RAI-129) ─────────────────────────────────────────────────────
/** Paths listed in TEXT; `--json` carries every one. A long partition can leave hundreds,
 *  and a report that scrolls the rest of the audit away is one an operator stops reading. */
const SYNC_CONFLICT_TEXT_CAP = 20;

/** Red in the override-finding style: a conflict copy is two versions of one page, and only a
 *  person can say which is right — the walkers skip the copy, so nothing here is ever indexed or
 *  exported again, but nothing merges it either. Same TTY-only colour, same byte-stable text. */
export function formatSyncConflicts(f: SyncConflictFinding, opts: { color: boolean } = { color: false }): string {
  if (f.onDisk.length === 0) return "  sync conflicts: none";
  const red = (s: string) => (opts.color ? `\u001b[31m${s}\u001b[0m` : s);
  return [
    `  SYNC CONFLICTS: ${f.onDisk.length} on disk — Syncthing kept both sides of a concurrent edit`,
    "    on disk (never indexed or exported; merge each into its page by hand, then delete it):",
    ...f.onDisk.slice(0, SYNC_CONFLICT_TEXT_CAP).map((p) => `      ${p}`),
    ...(f.onDisk.length > SYNC_CONFLICT_TEXT_CAP ? [`      … ${f.onDisk.length - SYNC_CONFLICT_TEXT_CAP} more (--json lists every one)`] : []),
  ].map(red).join("\n");
}

/** 0.4.0 item 11 (RAI-134): `vault.unparsed` — the pages in the indexed scope whose frontmatter does
 *  not parse (reindex.ts unparsedPages), as a count and the first ids. A vault fact, named so it
 *  cannot be read as row parity: it describes the files now, not the rows audited above. */
export interface UnparsedFinding {
  count: number;
  first: string[];
  /** The walk stopped early (unparsedPages): `count` covers only the pages read before it. */
  walkError?: string;
}
export const UNPARSED_FIRST = 5;

/** Red, like the other two findings: a page whose YAML does not parse is skipped by every build
 *  (0.5.0 item 20, ADR-0012 — fail-closed, so it is out of recall), and `supersede`/`forget` refuse to
 *  rewrite it. Only a person can fix the YAML — the tolerant parser already recovered everything it
 *  knows how to. */
export function formatUnparsed(f: UnparsedFinding, opts: { color: boolean } = { color: false }): string {
  const red = (s: string) => (opts.color ? `\u001b[31m${s}\u001b[0m` : s);
  const partial = f.walkError ? [red(`      the vault walk stopped early (${f.walkError}) — this counts only the pages read before it`)] : [];
  if (f.count === 0) return ["  vault unparsed: none", ...partial].join("\n");
  return [
    ...[
      `  VAULT UNPARSED: ${f.count} page(s) whose frontmatter does not parse — skipped by the build, out of recall until the YAML is fixed`,
      ...f.first.map((id) => `      ${id}`),
      ...(f.count > f.first.length ? [`      … ${f.count - f.first.length} more`] : []),
    ].map(red),
    ...partial,
  ].join("\n");
}

/** The line `funes reindex` prints under its summary (cli.ts): the same cap and overflow as the
 *  doctor list above, on one line. */
export function formatUnparsedLine(ids: string[]): string {
  const more = ids.length - UNPARSED_FIRST;
  return `  unparsed frontmatter (skipped, not indexed): ${ids.slice(0, UNPARSED_FIRST).join(", ")}${more > 0 ? ` … ${more} more` : ""}`;
}

const pct = (n: number, of: number): string => (of === 0 ? "0%" : `${((n / of) * 100).toFixed(0)}%`);

export interface ReportHeader {
  vault: string;
  /** The content generation of the published index audited, or null for the live index. */
  generation: string | null;
  /** Where the rows came from — published.db, or the live index. */
  source: string;
  /** False for the live index (the default): the owner check did not run. */
  verified: boolean;
}

export function formatAuditReport(r: GraphAuditReport, h: ReportHeader): string {
  const out: string[] = [];
  out.push(`doctor: ${h.vault}`);
  out.push(h.verified
    ? `  generation ${h.generation}`
    : `  UNVERIFIED — the LIVE index at ${h.source}. It is a writer's working file, it can move` +
      "\n              under this read, and no star identity was checked. For a result worth quoting," +
      "\n              publish, then run `funes doctor --published`.");
  if (h.verified) out.push(`  ${h.source}`);
  out.push("");
  out.push(`  nodes ${r.nodes}   edges ${r.edges}   resolved ${r.resolved}   dangling ${r.dangling} (${pct(r.dangling, r.edges)})`);
  out.push("");

  if (r.danglingByType.length === 0) {
    out.push("  dangling edges: none");
  } else {
    out.push("  dangling edges by type (target absent from nodes):");
    for (const t of r.danglingByType) {
      out.push(`    ${t.type}  ${t.count}`);
      for (const g of t.topTargets) out.push(`      -> ${g.target}  ×${g.count}`);
      if (t.sampleSources.length) out.push(`      from: ${t.sampleSources.join(", ")}`);
    }
  }
  out.push("");
  out.push(`  orphan nodes (no resolved typed edge): ${r.orphans} (${pct(r.orphans, r.nodes)})`);
  out.push(`    isolated (no edges at all): ${r.isolated}${r.sampleIsolated.length ? `  e.g. ${r.sampleIsolated.join(", ")}` : ""}`);
  out.push(`    dangling-only (every edge misses): ${r.danglingOnly}${r.sampleDanglingOnly.length ? `  e.g. ${r.sampleDanglingOnly.join(", ")}` : ""}`);
  out.push("");
  if (r.spellingForks.length === 0) {
    out.push("  relation spelling forks: none");
  } else {
    out.push("  relation spelling forks (one relation, several stored spellings):");
    for (const f of r.spellingForks) {
      out.push(`    ${f.normalized}: ${f.spellings.map((s) => `${s.spelling} ${s.count}`).join("  vs  ")}`);
    }
    out.push("    Comparison already folds these (normalizeRelationType), so recall is unaffected;");
    out.push("    the count is here because the STORED rows are what a future migration must touch.");
  }
  out.push("");
  out.push("  Reported, not repaired: nothing was written, pruned or rewritten.");
  return out.join("\n");
}

// ── item 20: the operator-facing state contract ────────────────────────────────────────────────
// Moved here from machine-state.ts when the machine-state file was deleted (RAI-327). Unlike the
// audit above it reads a store and the live star.yaml: it is the one doctor/health account.

/** `doctor --json` `state` (RAI-308): the contract state plus the operator fields that left `health`.
 *  Everything an operator needs to answer "what is this process serving, and is it what I asked for". */
export interface OperatorState extends ContractState {
  /** The schema stamped IN the database, or null where the backend persists none. */
  schemaVersion: string | null;
  /** The per-build identity (RAI-306 Q9): when the last FULL build of these rows finished. */
  lastReindexAt: string | null;
  /** The scope the ROWS were built under. */
  builtScopeHash: string | null;
  /** The scope THIS machine's live star.yaml asks for now. Null when no policy is declared
   *  (configless vault) or the manifest cannot be read — `scopeRefusal` then says which. */
  desiredScopeHash: string | null;
  /** Set when the desired scope cannot be established at all (an invalid manifest). */
  scopeRefusal: string | null;
  /** "building" while a full reindex holds the dirty marker; "built" otherwise. */
  buildState: "building" | "built";
  /** PLAN-0.5.0 item 20 (ADR-0012): the OKF drift counters the last FULL build stamped; null when
   *  not counted (no full build yet, or `memory.okf: false`). */
  okf: OkfCounts | null;
}

/** Assemble it over an own-star context. `stats` is passed in rather than re-fetched: the caller
 *  already holds one, and a second read could describe a different moment. */
export function operatorState(ctx: ContractSource, stats: IndexStats): OperatorState {
  const expectation = ownStarExpectation(() => ctx.star().scope)();
  return {
    ...contractState({ ...ctx, crossStar: false }, stats),
    schemaVersion: stats.schemaVersion,
    lastReindexAt: stats.lastReindexAt,
    builtScopeHash: stats.scopeHash,
    desiredScopeHash: expectation && "hash" in expectation ? expectation.hash : null,
    scopeRefusal: expectation && "refusal" in expectation ? expectation.refusal : null,
    buildState: stats.reindexDirty ? "building" : "built",
    okf: stats.okf,
  };
}

/** The text rendering `doctor` prints. Deterministic — two runs over one index produce identical
 *  bytes, the property the audit report beside it already promises. */
export function formatOperatorState(s: OperatorState): string {
  const out: string[] = ["  state:"];
  out.push(`    locus ${s.locus ?? "UNDECLARED (no FUNES_LOCUS and no hostname)"}`);
  out.push(`    schema ${s.schemaVersion ?? "unknown"}   build ${s.buildState}   serving-signature ${s.servingSignature}`);
  out.push(`    last reindex ${s.lastReindexAt ?? "none"}`);
  out.push(`    content generation ${s.contentGeneration ?? "NONE (no named build)"}`);
  out.push(`    built scope ${s.builtScopeHash ?? "none"}   desired ${s.desiredScopeHash ?? (s.scopeRefusal ? "UNREADABLE" : "undeclared")}` +
    `   ${s.scopeMatches === null ? "(nothing declared to compare)" : s.scopeMatches ? "agree" : "DISAGREE"}`);
  if (s.scopeRefusal) out.push(`      ${s.scopeRefusal}`);
  if (s.ignoreScope) out.push("      built with --ignore-scope (pre-0.6.0): index_scope was NOT applied to these rows — run a full reindex");
  out.push(s.okf ? `    okf nonconformant ${s.okf.nonconformant}   malformed ${s.okf.malformed}` : "    okf not counted (no full build yet, or star.yaml memory.okf: false)");
  return out.join("\n");
}
