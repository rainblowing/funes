// `funes okf normalize` (PLAN-0.5.0 item 21, ADR-0012 "The conversion"): the dry run is the lint;
// `--apply` converts at the write locus, keeping every pre-image as a history object.
import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { historyPath } from "funes-core";
import { okfApply, okfDryRun } from "./okf-normalize.ts";

const STAR = "meta:\n  id: git://example/fixture\n  write_locus: host-a\nmemory:\n  index_scope:\n    exclude: [\"private/**\"]\n";
const PAGES: Record<string, string> = {
  "wiki/bare.md": "# Bare\n\nno frontmatter\n",
  "wiki/untyped.md": "---\ntitle: Untyped\ntags: [a]\n---\nbody\n",
  "wiki/typed.md": "---\ntype: note\ntitle: Typed\n---\nbody\n",
  "raw/source.md": "an immutable input, never in the OKF scope\n",
  "private/secret.md": "outside the index scope\n",
  "wiki/index.md": "# Wiki\n",
};

function fixture(extra: Record<string, string> = {}): { root: string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), "funes-okf-normalize-"));
  writeFileSync(join(root, "star.yaml"), STAR);
  for (const [p, text] of Object.entries({ ...PAGES, ...extra })) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}
const atWriter = { env: { FUNES_LOCUS: "host-a" } as NodeJS.ProcessEnv };

test("the dry run lists each edit over the OKF scope — not raw/, not an excluded path — and writes nothing", async () => {
  const { root, done } = fixture();
  try {
    const before = readFileSync(join(root, "wiki/bare.md"), "utf8");
    const found = await okfDryRun(root);
    expect(found).toEqual([
      { path: "wiki/bare.md", edit: "prepend", reembed: false, generation: true },
      { path: "wiki/untyped.md", edit: "insert-type", reembed: false, generation: true },
    ]);
    expect(readFileSync(join(root, "wiki/bare.md"), "utf8")).toBe(before);
    expect(existsSync(join(root, ".history"))).toBe(false);
  } finally { done(); }
});

test("dry run -> apply -> dry run reports 0; every pre-image is a history object", async () => {
  const { root, done } = fixture();
  try {
    const pre = readFileSync(join(root, "wiki/bare.md"));
    expect((await okfDryRun(root)).length).toBe(2);
    const r = await okfApply(root, atWriter);
    expect(r.applied.map((f) => f.path)).toEqual(["wiki/bare.md", "wiki/untyped.md"]);
    expect(r.conflicts).toEqual([]);
    expect(await okfDryRun(root)).toEqual([]);
    expect(readFileSync(join(root, "wiki/bare.md"), "utf8")).toBe("---\ntype: note\n---\n# Bare\n\nno frontmatter\n");
    const sha = createHash("sha256").update(pre).digest("hex");
    expect(readFileSync(join(root, historyPath("wiki/bare.md", sha)))).toEqual(pre);
    expect(existsSync(join(root, historyPath("wiki/untyped.md", createHash("sha256").update(PAGES["wiki/untyped.md"]!).digest("hex"))))).toBe(true);
    expect(readFileSync(join(root, "raw/source.md"), "utf8")).toBe(PAGES["raw/source.md"]!); // the incoming zone is never written
    expect((await okfApply(root, atWriter)).applied).toEqual([]); // idempotent
  } finally { done(); }
});

test("--apply refuses unless the designation verdict is `match`, and writes nothing", async () => {
  const { root, done } = fixture();
  try {
    for (const env of [{ FUNES_LOCUS: "host-b" }, {}, { FUNES_LOCUS: "host-a", FUNES_WRITE_DESIGNATION: "off" }]) {
      await expect(okfApply(root, { env: env as NodeJS.ProcessEnv })).rejects.toThrow(/write locus/);
    }
    expect(readFileSync(join(root, "wiki/bare.md"), "utf8")).toBe(PAGES["wiki/bare.md"]!);
    expect(existsSync(join(root, ".history"))).toBe(false);
  } finally { done(); }
});

test("a file the normalizer refuses is listed with its reason, and --apply leaves it as it is", async () => {
  const { root, done } = fixture({ "wiki/broken.md": "---\ntitle: a: b\n---\nbody\n", "wiki/sub/index.md": "---\nkind: index\n---\n# Sub\n" });
  try {
    const found = await okfDryRun(root);
    expect(found.flatMap((f) => ("invalid" in f ? [[f.path, f.invalid]] : []))).toEqual([
      ["wiki/broken.md", "malformed"], ["wiki/sub/index.md", "reserved-shape"],
    ]);
    const r = await okfApply(root, atWriter);
    expect(r.applied.length).toBe(2);
    expect(readFileSync(join(root, "wiki/broken.md"), "utf8")).toBe("---\ntitle: a: b\n---\nbody\n");
    expect((await okfDryRun(root)).map((f) => f.path)).toEqual(["wiki/broken.md", "wiki/sub/index.md"]);
  } finally { done(); }
});
