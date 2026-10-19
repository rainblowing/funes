// PLAN-0.5.0 item 60: the taste eval's committed half — the format, the thresholds and the frozen
// sha256. Every fixture here is synthetic; the real one lives on the writer's machine only.
import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTasteFixture, formatTasteGroups, TASTE_FIXTURES } from "./taste-eval.ts";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const cases = (prefixes: Record<string, number>) =>
  Object.entries(prefixes).flatMap(([p, n]) =>
    Array.from({ length: n }, (_, i) => ({ id: `${p}${i}`, query: `q ${p}${i}`, relevant: [`items/books/b${i}`], split: "unseen" as const })));
const coreFixture = () => ({
  vault: "rainblow.ing/taste", k: 5,
  thresholds: { pAtK: 0.8, mrr: 0.6, negativeRate: 0.1, unseenPAtK: 0.8 },
  cases: cases({ "tag-": 2, "en-": 20 }),
});
const xlangFixture = () => ({
  vault: "rainblow.ing/taste", k: 5,
  thresholds: { pAtK: 0.6, mrr: 0.5, negativeRate: 0.1, unseenPAtK: 0.6 },
  cases: cases({ "ru-en-": 12, "en-ru-": 6 }),
});

/** A fixture file in a fresh directory outside every repo and synced folder. */
function place(fixture: object): { path: string; bytes: Uint8Array; dir: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "funes-taste-eval-")));
  const path = join(dir, "taste-core.json");
  const bytes = new TextEncoder().encode(JSON.stringify(fixture));
  writeFileSync(path, bytes);
  return { path, bytes, dir };
}

test("thresholds are committed exactly as record 35 states them", () => {
  expect(TASTE_FIXTURES.core.thresholds).toEqual({ pAtK: 0.8, mrr: 0.6, negativeRate: 0.1, unseenPAtK: 0.8 });
  expect(TASTE_FIXTURES.xlang.thresholds).toEqual({ pAtK: 0.6, mrr: 0.5, negativeRate: 0.1, unseenPAtK: 0.6 });
});

test("a fixture whose sha256 differs from the committed sha256 refuses", () => {
  const { path, bytes, dir } = place(coreFixture());
  const frozen = { ...TASTE_FIXTURES.core, sha256: "0".repeat(64) };
  expect(checkTasteFixture("core", path, bytes, frozen).join("\n")).toContain("sha256");
  expect(checkTasteFixture("core", path, bytes, { ...frozen, sha256: sha(bytes) })).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

test("an unfrozen pin (no sha256 committed yet) refuses every fixture", () => {
  const { path, bytes, dir } = place(coreFixture());
  expect(checkTasteFixture("core", path, bytes, { ...TASTE_FIXTURES.core, sha256: null }).join("\n")).toContain("not frozen");
  rmSync(dir, { recursive: true, force: true });
});

test("the format: case counts, groups, k=5, every case unseen, thresholds equal the committed ones", () => {
  const check = (name: "core" | "xlang", f: object) => {
    const { path, bytes, dir } = place(f);
    const errs = checkTasteFixture(name, path, bytes, { ...TASTE_FIXTURES[name], sha256: sha(bytes) });
    rmSync(dir, { recursive: true, force: true });
    return errs.join("\n");
  };
  expect(check("core", coreFixture())).toBe("");
  expect(check("xlang", xlangFixture())).toBe("");
  expect(check("core", { ...coreFixture(), cases: cases({ "tag-": 2, "en-": 19 }) })).toContain("22 cases");
  expect(check("core", { ...coreFixture(), cases: cases({ "tag-": 3, "en-": 19 }) })).toContain(`2 "tag-"`);
  expect(check("xlang", { ...xlangFixture(), cases: cases({ "ru-en-": 11, "en-ru-": 7 }) })).toContain(`12 "ru-en-"`);
  expect(check("xlang", { ...xlangFixture(), cases: cases({ "ru-en-": 12, "en-ru-": 5, "xx-": 1 }) })).toContain(`"xx-0"`);
  expect(check("core", { ...coreFixture(), k: 10 })).toContain("k");
  expect(check("core", { ...coreFixture(), thresholds: { pAtK: 0.7, mrr: 0.6, negativeRate: 0.1, unseenPAtK: 0.8 } })).toContain("thresholds");
  const seen = coreFixture();
  seen.cases[0] = { ...seen.cases[0]!, split: "seen" as never };
  expect(check("core", seen)).toContain("unseen");
});

test("each group is reported apart: the tag cases, and P@k per direction", () => {
  const hit = (id: string, rank: number | null) => ({ id, split: "unseen" as const, query: id, rank, hit: rank !== null, negativesHit: [], returned: [], scores: [] });
  const report = { cases: [hit("ru-en-0", 1), hit("ru-en-1", null), hit("en-ru-0", 2)], k: 5 } as never;
  expect(formatTasteGroups(TASTE_FIXTURES.xlang, report)).toBe('  "ru-en-" n=2  P@5 0.500 · MRR 0.500\n  "en-ru-" n=1  P@5 1.000 · MRR 0.500');
});

test("a fixture inside a git repo, a star or a synced folder refuses — so its baselines never land there", () => {
  for (const marker of [".git", "star.yaml", ".stfolder"]) {
    const { dir } = place({});
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, marker), "");
    const path = join(dir, "sub", "taste-core.json");
    const bytes = new TextEncoder().encode(JSON.stringify(coreFixture()));
    writeFileSync(path, bytes);
    const errs = checkTasteFixture("core", path, bytes, { ...TASTE_FIXTURES.core, sha256: sha(bytes) }).join("\n");
    expect(errs).toContain(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
