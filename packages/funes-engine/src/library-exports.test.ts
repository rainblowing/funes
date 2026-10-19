// RAI-206 (PLAN-0.5.0 item 9; ADR-0016): the Library is an enumerated symbol list per entry. This
// pins the symbols twinkl.ing and the bot import by PACKAGE NAME, so a rename or a dropped export
// fails here rather than in a consumer's release. Types are pinned by the type-only import below
// (typecheck is part of the gate); runtime symbols by the lists.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRawIndex } from "funes-libsql";
import type { IndexResult } from "funes-engine";
import type { RecallDeclaration } from "funes-engine/light";
import type { FunesStoreOpts, OperationContext, StarConfig } from "funes-engine/portable";

const ENGINE_ADDITIONS = ["buildReferenceMaps", "capabilityFilePath", "folderContext"];
// PLAN-0.5.0 item 16 (RAI-217): the workerd-portable subpath, per item 4's placement table. The
// bot's codec entry is its render() + parseFrontmatter; item 18 adds the normalizer.
const PORTABLE = [
  "FunesStore",
  "parseFrontmatter", "normalizePage", "render", "textToItemWithMeta", "sanitizeText",
  "walkMd", "statParity", "referenceMaps", "resolveEdgeTargets",
  "operations", "dispatchToolCall", "publicOpNames",
  "assertActorName", "grantFor", "validateAccessPolicy", // item 42: the edge grants
  "starConfigFromText", "designationFor", // item 35: the edge writer's star.yaml and locus proof
  "PROPOSAL_PROTOCOL", "probeRefusal", "vaultChangedSince", // item 40: edge health and the outbox probe's check
  "grantCoversStar", "FUNES_VERSION", // item 43: /mcp's 403 for a star not granted, and its server version
  "sha256Hex", // RAI-234: the edge's token hashes use the engine's one helper
  "itemPaths", // item 55: the bot's /new path follows the page-id rule's one composition
];
const LIGHT = [
  "opCapabilities", "publicOpNames", "assertActorName", "grantFor", "readAccessPolicy",
  "resolveSessionGrant", "scopeHash", "validateRecallDeclaration", "readIndexOwner",
];

describe("Library entries", () => {
  test('funes-engine "." exports the 0.5.0 additions', async () => {
    const engine = await import("funes-engine");
    for (const name of ENGINE_ADDITIONS) expect(typeof (engine as Record<string, unknown>)[name], name).toBe("function");
    // A folder host's ceiling (ADR-0010 §Revision: no folder host serves put_page in 0.5.0), so a
    // consumer lists and dispatches what the daemon does instead of re-deriving it.
    expect(engine.folderOperations.some((o) => o.name === "put_page")).toBe(false);
    expect(engine.folderOperations.length).toBe(engine.operations.filter((o) => !o.edgeOnly).length);
    const _typesResolve: Array<IndexResult | RecallDeclaration> = [];
    expect(_typesResolve).toEqual([]);
  });

  test("funes-engine/light exports exactly its enumerated symbols", async () => {
    const light = await import("funes-engine/light");
    expect(Object.keys(light).sort()).toEqual([...LIGHT].sort());
    for (const name of LIGHT) expect((light as Record<string, unknown>)[name], name).toBeDefined();
  });

  test("funes-engine/portable exports exactly its enumerated symbols", async () => {
    const portable = await import("funes-engine/portable");
    expect(Object.keys(portable).sort()).toEqual([...PORTABLE].sort());
    for (const name of PORTABLE) expect((portable as Record<string, unknown>)[name], name).toBeDefined();
    const _typesResolve: Array<OperationContext | FunesStoreOpts | StarConfig> = [];
    expect(_typesResolve).toEqual([]);
  });
});

describe("the codec entry (funes-engine/portable)", () => {
  // A page as FunesStore writes it: render's key order, a blank line after the fence.
  const PAGE = [
    "---",
    "title: Stalker",
    "type: taste-item",
    "created: 2026-10-01T00:00:00.000Z",
    "trust: curated",
    "tags:",
    "  - film",
    "domain: film",
    "---",
    "",
    "Tarkovsky, 1979.",
    "",
  ].join("\n");

  test("render(parse(bytes)) returns the bytes", async () => {
    const { parseFrontmatter, render } = await import("funes-engine/portable");
    const { data, body, malformed } = parseFrontmatter(PAGE);
    expect(malformed).toBeUndefined();
    expect(data.domain).toBe("film");
    expect(render(data, body)).toBe(PAGE);
  });

  test("render orders the known keys first and keeps a key funes does not know", async () => {
    const { render } = await import("funes-engine/portable");
    expect(render({ domain: "film", tags: ["film"], title: "Stalker", created: "2026-10-01T00:00:00.000Z", trust: "curated", type: "taste-item" }, "\nTarkovsky, 1979.\n"))
      .toBe(PAGE);
  });
});

describe("readIndexOwner", () => {
  test("reads the stamped owner synchronously; null with no index or no stamp", async () => {
    const { readIndexOwner } = await import("funes-engine/light");
    const dbPath = join(mkdtempSync(join(tmpdir(), "funes-owner-")), "index.db");
    expect(readIndexOwner(dbPath)).toBeNull(); // missing file: no identity

    const db = openRawIndex(dbPath, false);
    db.prepare("create table meta(key text primary key, value text)").run();
    expect(readIndexOwner(dbPath)).toBeNull(); // a funes index with no stamp
    db.prepare("insert into meta(key,value) values ('owner_star_id', ?)").run("star-1234");
    db.close();
    expect(readIndexOwner(dbPath)).toBe("star-1234");
  });
});
