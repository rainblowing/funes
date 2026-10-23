// RAI-315 (ADR-0016): the Library is three exact entries — `funes-core`, `funes-core/mcp-http` and
// `funes-engine` "." — and each symbol has one entry. This pins each entry's runtime exports both
// ways (no symbol missing, no symbol extra), so a rename, a dropped export or a stray re-export
// fails here rather than in a consumer's release. Types are pinned by the type-only imports below
// (typecheck is part of the gate); the contract page test pins them both ways from source.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRawIndex } from "./libsql/store.ts";
import type { IndexResult } from "funes-engine";
import type {
  StarAccess, ReferenceMaps, OpEntry, Tier, OperationContext, Grant, AccessPolicy, Refusal, FunesIndexStore,
  IndexStats, Embedder, RecallHit, RecallEnvelope, Health, Trust, HotlistRow,
} from "funes-core";
import type { McpHost } from "funes-core/mcp-http";
import { dispatchToolCall } from "funes-core";

const ENTRIES: Record<string, string[]> = {
  "funes-core": [
    "parseStarUri", "canonicalKey", "refKey", "formatStarUri", "STAR_ACCESS",
    "isSyncConflict", "normalizeRelationType", "resolveTarget", "parseFrontmatter", "render", "normalizePage",
    "itemPaths", "slug", "pagesDigest", "scopeHash",
    "dispatchToolCall", "ceiling", "opCapabilities", "publicOpNames",
    "authorize", "presentedToken", "assertActorName", "validateRecallDeclaration", "portContext",
  ],
  "funes-core/mcp-http": ["mcpHandler"],
  "funes-engine": [
    "makeStore", "folderContext", "funesDbDir", "reindex", "buildReferenceMaps",
    "readIndexOwner", "readAccessPolicy", "capabilityFilePath", "folderMcpHost",
  ],
};

describe("the Library's three entries", () => {
  for (const [spec, names] of Object.entries(ENTRIES)) {
    test(`${spec} exports exactly its listed symbols`, async () => {
      const mod = (await import(spec)) as Record<string, unknown>;
      expect(Object.keys(mod).sort()).toEqual([...names].sort());
      for (const name of names) expect(mod[name], name).toBeDefined();
    });
  }

  test("no symbol has two entries", () => {
    const all = Object.values(ENTRIES).flat();
    expect(all.length).toBe(new Set(all).size);
  });

  test("the contract types resolve", () => {
    const _types: Array<
      IndexResult | StarAccess | ReferenceMaps | OpEntry | Tier | OperationContext | Grant | AccessPolicy | Refusal | FunesIndexStore
      | IndexStats | Embedder | RecallHit | RecallEnvelope | Health | Trust | HotlistRow | McpHost
    > = [];
    expect(_types).toEqual([]);
  });

  test("dispatchToolCall takes a context with a designation and a tier (RAI-315 Q7)", () => {
    const ctx = {} as Omit<OperationContext, "designation">;
    // @ts-expect-error — a context without `designation` does not typecheck: the kernel reads no locus.
    const call = () => dispatchToolCall("health", {}, ctx);
    expect(typeof call).toBe("function");
    const noTier = {} as Omit<OperationContext, "tier">;
    // @ts-expect-error — nor does one without `tier`: the host names the tier it serves.
    const call2 = () => dispatchToolCall("health", {}, noTier);
    expect(typeof call2).toBe("function");
  });
});

describe("portContext (the harness composition)", () => {
  test("takes star.yaml text, read once, as the star port; or a live thunk", async () => {
    const { portContext } = await import("funes-core");
    const ports = {
      vault: { read: async () => null, list: async function* () {}, atomically: async <T>(fn: (tx: never) => Promise<T>) => fn(undefined as never) },
      index: {} as Parameters<typeof portContext>[0]["index"], memoryDir: "items", serialize: <T>(fn: () => Promise<T>) => fn(),
      tier: "edge" as const, designation: { locus: "edge", authority: "edge" },
    };
    const fromText = portContext({ ...ports, starText: "meta:\n  id: mcp://example.org/taste\n" });
    expect(fromText.star().identity.id).toBe("mcp://example.org/taste");
    expect(fromText.star()).toBe(fromText.star()); // read once
    expect(fromText).toMatchObject({ tier: "edge", designation: { locus: "edge", authority: "edge" } });
    const thunk = portContext({ ...ports, star: () => fromText.star() });
    expect(thunk.star().identity.id).toBe("mcp://example.org/taste");
  });
});

describe("the codec (funes-core)", () => {
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
    const { parseFrontmatter, render } = await import("funes-core");
    const { data, body, malformed } = parseFrontmatter(PAGE);
    expect(malformed).toBeUndefined();
    expect(data.domain).toBe("film");
    expect(render(data, body)).toBe(PAGE);
  });

  test("render orders the known keys first and keeps a key funes does not know", async () => {
    const { render } = await import("funes-core");
    expect(render({ domain: "film", tags: ["film"], title: "Stalker", created: "2026-10-01T00:00:00.000Z", trust: "curated", type: "taste-item" }, "\nTarkovsky, 1979.\n"))
      .toBe(PAGE);
  });
});

describe("readIndexOwner", () => {
  test("reads the stamped owner synchronously; null with no index or no stamp", async () => {
    const { readIndexOwner } = await import("funes-engine");
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
