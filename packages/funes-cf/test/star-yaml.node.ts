// PLAN-0.5.0 item 34: the taste star's star.yaml, bundled with the DO as a Text module (ADR-0011
// "Star configuration"). It must pass funes' own declaration validator — the one funes-engine and
// twinkl.ing run — and declare exactly what ADR-0011, ADR-0013 and ADR-0015 name.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseStarUri } from "funes-core";
import { validateRecallDeclaration } from "funes-engine/light";

const star = parse(readFileSync(join(import.meta.dirname, "..", "src", "star.yaml"), "utf8"));

describe("the taste star.yaml", () => {
  it("passes funes' declaration validator", () => {
    expect(validateRecallDeclaration(star.memory.recall)).toMatchObject({ ok: true });
  });

  it("is the edge taste star of rainblowing, written only by funes-taste (ADR-0011)", () => {
    expect(star.version).toBe(3);
    expect(star.meta).toEqual({
      id: "mcp://rainblow.ing/taste", name: "taste", locus: "edge", write_locus: "funes-taste",
      constellation: "rainblowing", exposure: "user-facing",
    });
    expect(parseStarUri(star.meta.id)).toMatchObject({ ok: true });
    expect(star.trifecta).toEqual({ preset: "user-facing", session_taint: { auto_downgrade: true } });
  });

  it("declares OKF 0.2 and memoryDir items, and no substrate or embedder (the edge index is the DO's)", () => {
    expect(star.memory.okf).toBe("0.2");
    expect(star.memory.memoryDir).toBe("items");
    expect(Object.keys(star.memory).sort()).toEqual(["memoryDir", "okf", "recall"]);
  });

  it("declares record 25's filter keys plus the titles, the two enums, the two predicates, serve and collapse", () => {
    const r = star.memory.recall;
    expect(r.keys).toEqual([
      "domain", "type", "taste_status", "suggested", "suggestion_rank", "my_score", "my_score_proxy",
      "public_score", "public_score_source", "year", "title", "title_ru",
    ]);
    expect(r.values).toEqual({
      domain: ["books", "movies", "games", "music", "youtube"],
      type: ["Book", "Film", "TV Series", "Video Game", "Music Album", "Music Artist", "YouTube Video", "YouTube Channel"],
    });
    expect(r.predicates).toEqual({
      taste: [{ suggested: { ne: true }, domain: { exists: true } }, { my_score: { exists: true } }],
      suggestion: [{ suggested: true, my_score: { exists: false } }],
    });
    expect(r.serve).toEqual(["domain", "taste_status", "suggested", "my_score", "my_score_proxy", "plays", "type", "creator", "year"]);
    expect(r.collapse).toEqual(["type", "creator"]);
  });
});
