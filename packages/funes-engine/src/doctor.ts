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
import { normalizeRelationType, type GraphAuditRows } from "funes-core";
import { syncRootOverrides } from "./sync-root.ts";
import type { SyncConflictFinding } from "./sync-conflicts.ts";

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
  // backend's auditGraph() selects with an ORDER BY (funes-libsql store.ts:751-752, engine
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

// ── active overrides: the red half of the report (0.3.0 item 23) ─────────────────────────────────
/** One standing exception to a safety rule. An override that nobody can see is a permanent silent
 *  exception — which is how a machine ends up serving a torn index for a year — so `doctor` names
 *  every one of them, in red, every run. */
export interface OverrideFinding {
  /** The configuration surface that carries it, so the operator knows what to unset. */
  name: string;
  /** What it was set to. */
  value: string;
  /** The rule it suspends, in one line. */
  why: string;
}

/** Reads the ENVIRONMENT only — no store, no filesystem, no clock, like everything else in this
 *  module — so the finding list is a pure function of configuration and two runs of one
 *  configuration produce identical bytes. */
export function activeOverrides(env: NodeJS.ProcessEnv = process.env): OverrideFinding[] {
  const findings: OverrideFinding[] = syncRootOverrides(env).map((path) => ({
    name: "FUNES_SYNC_ROOT_OK",
    value: path,
    why: "this exact index path is permitted inside a sync-provider root; a synced SQLite index is a TORN index (item 23)",
  }));
  // item 25's audit, reported under item 23's rule: `off` is the ONE value that stops the
  // canonical-write decision from being evaluated at all, and a disabled audit that nobody can see
  // is the same permanent silent exception a sync-root override would be. `audit` is the shipped
  // default and is not a finding — a report that flagged the normal configuration would train an
  // operator to skip this section. The value is normalized the way write-designation.ts resolves
  // it, so `OFF ` and `off` read alike here and there.
  const mode = (env.FUNES_WRITE_DESIGNATION ?? "").trim().toLowerCase();
  if (mode === "off") {
    findings.push({
      name: "FUNES_WRITE_DESIGNATION",
      value: mode,
      why: "the writer-designation audit is DISABLED; canonical-vault mutations are not evaluated against star.yaml write_locus (item 25, ADR-0005)",
    });
  }
  return findings;
}

/** RED, but only when a terminal is watching. The report's other property is that two runs of one
 *  generation produce byte-identical output an operator can diff, and escape codes injected into a
 *  pipe would break exactly that — so the finding is always present as TEXT and the colour is the
 *  decoration a TTY gets. */
export function formatOverrideFindings(findings: OverrideFinding[], opts: { color: boolean } = { color: false }): string {
  if (findings.length === 0) return "  active overrides: none";
  const red = (s: string) => (opts.color ? `\u001b[31m${s}\u001b[0m` : s);
  const out = [red(`  ACTIVE OVERRIDES: ${findings.length} — a safety rule is suspended on this machine`)];
  for (const f of findings) out.push(red(`    ${f.name}=${f.value}`), red(`      ${f.why}`));
  return out.join("\n");
}

// ── sync conflicts (0.4.0 item 7, RAI-129) ─────────────────────────────────────────────────────
/** Paths listed per half in TEXT; `--json` carries every one. A long partition can leave hundreds,
 *  and a report that scrolls the rest of the audit away is one an operator stops reading. */
const SYNC_CONFLICT_TEXT_CAP = 20;

/** Red in the override-finding style: a conflict copy is two versions of one page, and only a
 *  person can say which is right — the walkers skip the copy, so nothing here is ever indexed or
 *  exported again, but nothing merges it either. Same TTY-only colour, same byte-stable text.
 *
 *  `live` picks the remedy for the `indexed` half, because the two modes audit different files:
 *  `--live` reads the working index, which `funes reindex` rewrites; the default reads the
 *  published generation, which reindex never touches — only the next `funes publish` builds one
 *  without the row. The libsql-only build reaches here only with --live, so it never names publish. */
export function formatSyncConflicts(f: SyncConflictFinding, opts: { color: boolean; live?: boolean } = { color: false }): string {
  if (f.onDisk.length === 0 && f.indexed.length === 0) return "  sync conflicts: none";
  const red = (s: string) => (opts.color ? `\u001b[31m${s}\u001b[0m` : s);
  const list = (paths: string[]): string[] => [
    ...paths.slice(0, SYNC_CONFLICT_TEXT_CAP).map((p) => `      ${p}`),
    ...(paths.length > SYNC_CONFLICT_TEXT_CAP ? [`      … ${paths.length - SYNC_CONFLICT_TEXT_CAP} more (--json lists every one)`] : []),
  ];
  const out = [`  SYNC CONFLICTS: ${f.onDisk.length} on disk, ${f.indexed.length} indexed — Syncthing kept both sides of a concurrent edit`];
  if (f.onDisk.length) out.push("    on disk (never indexed or exported; merge each into its page by hand, then delete it):", ...list(f.onDisk));
  if (f.indexed.length) {
    const remedy = opts.live ? "a full `funes reindex` drops them" : "the next `funes publish` drops them";
    out.push(`    indexed (built before conflict copies were skipped; ${remedy}):`, ...list(f.indexed));
  }
  return out.map(red).join("\n");
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

// ── retained artefacts (0.4.0 item 9, RAI-151) ─────────────────────────────────────────────────
/** Red in the override-finding style, from counts `retainedArtefacts` read off the home: a publish
 *  keeps its outgoing artefact 24 h by default, so under an unattended publisher this is the number
 *  that says when the disk cost bites. Not an error and never an exit code — none is stated as none,
 *  and a pipe gets byte-stable text. */
export function formatRetained(r: { artefacts: number; bytes: number }, opts: { color: boolean } = { color: false }): string {
  if (r.artefacts === 0) return "  retained artefacts: none";
  const red = (s: string) => (opts.color ? `\u001b[31m${s}\u001b[0m` : s);
  return [
    `  RETAINED ARTEFACTS: ${r.artefacts}, ${r.bytes} bytes (${(r.bytes / 1e6).toFixed(1)} MB) beside the served one`,
    "    each is held by a rollback pin (default 24h), a live acknowledgement, or an id nothing can recover;",
    "    the next pass collects whatever none of those holds",
  ].map(red).join("\n");
}

const pct = (n: number, of: number): string => (of === 0 ? "0%" : `${((n / of) * 100).toFixed(0)}%`);

export interface ReportHeader {
  vault: string;
  /** The generation audited, or null in --live mode. */
  generation: string | null;
  /** Where the rows came from — a generation db path, or the live index. */
  source: string;
  /** False in --live mode: the four-layer identity check did not run. */
  verified: boolean;
}

export function formatAuditReport(r: GraphAuditReport, h: ReportHeader): string {
  const out: string[] = [];
  out.push(`doctor: ${h.vault}`);
  out.push(h.verified
    ? `  generation ${h.generation}`
    : `  UNVERIFIED — the LIVE index at ${h.source}. It is a writer's working file, it can move` +
      "\n              under this read, and no star identity was checked. Publish and re-run for a" +
      "\n              result worth quoting.");
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
