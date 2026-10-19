#!/usr/bin/env bun
// PLAN-0.4.0 item 12 (RAI-134): rewrite the frontmatter a strict YAML parse cannot read, by the two
// Obsidian line rules the tolerant parser already applies (obsidianYaml) — `tags: [#a, #b]` loses
// the `#`, and `key: [[a]], [[b]]` becomes a quoted list; a block scalar's text is left as written.
// DRY-RUN by default: it prints every line it would change and writes nothing; `--write` rewrites.
// It edits a person's wiki, so the keystroke that passes `--write` is theirs.
//
// Why the fix is a NO-OP for the content generation under fm-wikilinks/3: the generation hashes the
// PARSED item (title, post-fence body, resolved edges, the metadata columns — generation.ts), never
// the YAML bytes, and this script applies obsidianYaml itself — the function parseFrontmatter's
// retry applies, imported, not copied. So parse(fixed) deep-equals parse(original) on every page it
// touches — and each page is checked for exactly that before it is written; one that fails is refused.
// A reindex after the script reports those pages unchanged. Under fm-wikilinks/2 the same edit IS a
// content change (the strict parse succeeds where the old parser dumped the frontmatter into the
// body), so it runs after the wave, on a locus already on parser 3 — never before.
//
// It touches ONLY pages whose strict parse fails and whose tolerant parse succeeds, and in them
// ONLY the frontmatter lines the rules change. Left alone (the middle two are listed):
//   - a page the strict parse already reads — rewriting `related: [[a]]` there would change its
//     meaning (a nested list, in YAML) and with it the generation;
//   - a page neither parse reads (`vault.unparsed` in `funes doctor`) — the rules cannot fix it, a
//     person can;
//   - a page in an incoming zone (`raw/`, `in_*`): immutable inputs, never edited — the tolerant
//     parser is the only fix that reaches them;
//   - a page outside the star's index_scope, which the index never reads either.
// ponytail: a rewritten page comes back with LF line endings and no BOM — parseFrontmatter reads it
// that way, so the parse is unchanged; the funes star has neither.
//
//   bun scripts/fix-frontmatter.ts --vault <path>            # dry run: what would change
//   bun scripts/fix-frontmatter.ts --vault <path> --write    # rewrite those pages
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { zoneOfFile } from "../packages/funes-shared/src/zones.ts";
import { obsidianYaml, parseFrontmatter } from "../packages/funes-engine/src/markdown.ts";
import { walkMd } from "../packages/funes-engine/src/reindex.ts";
import { anyExclude, buildScopeExclude, configlessExclude, readIndexScopeExcludes } from "../packages/funes-engine/src/scope.ts";
import { atomicWriteFile } from "../packages/funes-engine/src/write.ts";

/** The page with its frontmatter fixed, or null when this script leaves it alone: no frontmatter,
 *  a strict parse that already succeeds, or a page the two rules do not recover. */
export function fixFrontmatter(raw: string): string | null {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  // Only the page the retry recovers: the strict parse fails, the tolerant one does not. One the
  // strict parse reads has nothing to fix, and a rewrite could change its meaning.
  if (end === -1 || parseFrontmatter(text, { strict: true }).malformed === undefined || parseFrontmatter(text).malformed !== undefined) return null;
  return [lines[0]!, ...obsidianYaml(lines.slice(1, end)), ...lines.slice(end)].join("\n");
}

export interface FixPlan {
  fix: Array<{ rel: string; before: string; after: string }>;
  unparsed: Array<{ rel: string; error: string }>;
  incoming: string[];
}

/** Every page in the star's index_scope, sorted into what the script does with it. Refuses a
 *  manifest whose scope it cannot read, as reindex does: a broken scope must not widen what an
 *  edit may touch. */
export function planFixes(vault: string): FixPlan {
  const scope = readIndexScopeExcludes(vault);
  if (scope.kind === "invalid") throw new Error(`star.yaml index_scope is invalid — ${scope.reason}`);
  const exclude = anyExclude(
    buildScopeExclude(scope.kind === "valid" ? scope.excludes : []),
    scope.kind === "absent" ? configlessExclude() : undefined,
  );
  const plan: FixPlan = { fix: [], unparsed: [], incoming: [] };
  for (const abs of walkMd(vault, { exclude })) {
    const rel = relative(vault, abs);
    const before = readFileSync(abs, "utf8");
    const { malformed: error } = parseFrontmatter(before);
    const after = fixFrontmatter(before);
    if (error === undefined && after === null) continue;
    if (zoneOfFile(rel) === "incoming") { plan.incoming.push(rel); continue; }
    if (error !== undefined) plan.unparsed.push({ rel, error });
    else if (after !== null) plan.fix.push({ rel, before, after });
  }
  return plan;
}

if (import.meta.main) {
  const at = process.argv.indexOf("--vault");
  const vault = at >= 0 ? process.argv[at + 1] : undefined;
  if (!vault) {
    console.error("usage: bun scripts/fix-frontmatter.ts --vault <path> [--write]   (dry run unless --write)");
    process.exit(2);
  }
  const write = process.argv.includes("--write");
  const plan = planFixes(vault);
  let refused = 0;
  for (const { rel, before, after } of plan.fix) {
    // The equivalence the plan's gate rests on, checked per page before anything is written.
    if (!Bun.deepEquals(parseFrontmatter(after), parseFrontmatter(before))) {
      console.error(`REFUSED ${rel}: the fixed page does not parse to what the original parses to`);
      refused++;
      continue;
    }
    console.log(`${write ? "fixed" : "would fix"} ${rel}`);
    const a = after.split("\n");
    before.replace(/\r\n/g, "\n").split("\n").forEach((line, i) => {
      if (line !== a[i]) console.log(`  - ${line}\n  + ${a[i]}`);
    });
    if (write) atomicWriteFile(join(vault, rel), after);
  }
  for (const { rel, error } of plan.unparsed) console.log(`unparsed, fix by hand: ${rel} — ${error}`);
  for (const rel of plan.incoming) console.log(`left alone (incoming zone, immutable): ${rel}`);
  console.log(
    `${plan.fix.length - refused} page(s) ${write ? "fixed" : "to fix"}, ${refused} refused, ` +
    `${plan.unparsed.length} unparsed, ${plan.incoming.length} in incoming zones` +
    (write ? "" : " — dry run, nothing written; pass --write to rewrite"),
  );
  if (refused) process.exit(1);
}
