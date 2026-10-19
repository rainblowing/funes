// The taste eval's committed half (PLAN-0.5.0 item 60; record 35 Overrides, Vlad 2026-10-10). An agent
// drafts the 40 cases on the writer's machine from the converter's out/ (pages only, no recall run)
// and Vlad freezes them by sha256. The fixture, its per-locus baselines and the per-case results stay
// on that machine, outside every repo and synced folder: they name real taste items, and GitHub is not on ADR-0017's recipient
// list. The repo holds only this — the format, the thresholds and the frozen sha256 — and `funes eval
// --taste <name>` runs nothing until the fixture's bytes hash to the pin.
//
// The format is EvalFixture (recall-eval.ts) with k=5, every case `unseen`, these thresholds, and the
// case counts and id-prefix groups below. Files are named `taste-core.json` / `taste-xlang.json`, so a
// locus's baseline lands beside them as `taste-core.baseline.<locus>.json`. Run, on that machine:
//   funes eval --taste core --fixture <dir>/taste-core.json --mcp <edge MCP url> --token-file <f>  (edge)
//   funes eval --taste core --fixture <dir>/taste-core.json --vault ~/taste                       (replica)
// Freezing: Vlad sets `sha256` below to the hash of the reviewed file; the file is never edited after.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EvalFixture, EvalReport, EvalThresholds } from "./recall-eval.ts";
import { canonicalizeExisting, findSyncRoot } from "./sync-root.ts";

export type TasteFixtureName = "core" | "xlang";
export interface TasteFixtureSpec {
  cases: number;
  /** Case-id prefix → exact count. core: the 2 tag-shaped cases (record 31's tag miss class), reported
   *  apart; xlang: one group per direction (12 RU→EN, 6 EN→RU — there are only 13 `title_ru` pages).
   *  An xlang id outside every group refuses; a core id outside one is an ordinary case. */
  groups: Record<string, number>;
  /** Every xlang id must carry a group prefix. */
  closedGroups: boolean;
  thresholds: EvalThresholds;
  /** Vlad's freeze: the sha256 of the fixture file's bytes. Null until he freezes it. */
  sha256: string | null;
}

export const TASTE_K = 5;
export const TASTE_FIXTURES: Record<TasteFixtureName, TasteFixtureSpec> = {
  core: { cases: 22, groups: { "tag-": 2 }, closedGroups: false, thresholds: { pAtK: 0.8, mrr: 0.6, negativeRate: 0.1, unseenPAtK: 0.8 }, sha256: "735e3409abaa015fdfb8c4042167125da3247cbec308127a9ec67871bbcc504d" },
  xlang: { cases: 18, groups: { "ru-en-": 12, "en-ru-": 6 }, closedGroups: true, thresholds: { pAtK: 0.6, mrr: 0.5, negativeRate: 0.1, unseenPAtK: 0.6 }, sha256: "19d8196d3eaa0cdd27ed561e5fdafb9a42c705ab34d2814e370bc112fb60198e" },
};

/** One line per group (record 35 Q2/Q3: the tag cases apart, P@k per direction). */
export function formatTasteGroups(spec: TasteFixtureSpec, r: EvalReport): string {
  return Object.keys(spec.groups).map((p) => {
    const g = r.cases.filter((c) => c.id.startsWith(p));
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    return `  "${p}" n=${g.length}  P@${r.k} ${mean(g.map((c) => (c.hit ? 1 : 0))).toFixed(3)} · MRR ${mean(g.map((c) => (c.rank ? 1 / c.rank : 0))).toFixed(3)}`;
  }).join("\n");
}

/** Why the fixture at `path` (its `bytes`, as read) may not run as the named taste fixture; empty when
 *  it may. The pin is checked first and always: no other answer is worth reading over unfrozen bytes. */
export function checkTasteFixture(name: TasteFixtureName, path: string, bytes: Uint8Array, spec: TasteFixtureSpec = TASTE_FIXTURES[name]): string[] {
  const errors: string[] = [];
  const got = createHash("sha256").update(bytes).digest("hex");
  if (!spec.sha256) errors.push(`taste-${name} is not frozen: no sha256 is committed — Vlad freezes the drafted fixture first (this file hashes to ${got})`);
  else if (got !== spec.sha256) errors.push(`taste-${name}: the fixture's sha256 ${got} differs from the committed ${spec.sha256} — a frozen fixture is never edited`);

  // Baselines are written beside the fixture, so its directory is where they would land.
  const synced = findSyncRoot(path);
  if (synced) errors.push(`the fixture lies in a ${synced.provider} folder (${synced.root}) — it stays on the writer's machine only`);
  for (let d = dirname(canonicalizeExisting(path)); ; d = dirname(d)) {
    const hit = [".git", "star.yaml"].find((m) => existsSync(join(d, m)));
    if (hit) { errors.push(`the fixture lies inside ${d} (it holds ${hit}) — it stays outside every repo and star`); break; }
    if (d === dirname(d)) break;
  }

  let f: EvalFixture;
  try { f = JSON.parse(new TextDecoder().decode(bytes)); } catch { return [...errors, "the fixture is not JSON"]; }
  if (f.k !== TASTE_K) errors.push(`k must be ${TASTE_K}`);
  const t = f.thresholds ?? ({} as EvalThresholds);
  if ((["pAtK", "mrr", "negativeRate", "unseenPAtK"] as const).some((key) => t[key] !== spec.thresholds[key])) {
    errors.push(`thresholds must equal the committed ${JSON.stringify(spec.thresholds)}`);
  }
  const all = Array.isArray(f.cases) ? f.cases : [];
  if (all.length !== spec.cases) errors.push(`taste-${name} has ${spec.cases} cases (found ${all.length})`);
  for (const [prefix, n] of Object.entries(spec.groups)) {
    const found = all.filter((c) => c.id?.startsWith(prefix)).length;
    if (found !== n) errors.push(`taste-${name} has exactly ${n} "${prefix}" cases (found ${found})`);
  }
  for (const c of all) {
    if (spec.closedGroups && !Object.keys(spec.groups).some((p) => c.id?.startsWith(p))) errors.push(`case "${c.id}": its id names no group (${Object.keys(spec.groups).join(", ")})`);
    if (c.split !== "unseen") errors.push(`case "${c.id}": every taste case is unseen`);
  }
  return errors;
}
