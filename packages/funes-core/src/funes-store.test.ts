// RAI-313 Q3: FunesStore is in the kernel, so `assertOwned` refuses a non-canonical id with a segment
// check, not `node:path`'s posix.normalize. The table pins what the old check refused and passed.
import { expect, test } from "bun:test";
import { FunesStore } from "./funes-store.ts";
import type { ServingIndex } from "./index-store.ts";
import type { Vault, VaultFile } from "./vault.ts";
import { starConfigFromText } from "./funes-store.ts";

const pages = new Map<string, VaultFile>();
const vault: Vault = {
  read: async (p) => pages.get(p) ?? null,
  list: async function* () {},
  atomically: (fn) => fn({ swap: async () => ({ ok: true, version: "v" }) }),
};
const index = { remove: async () => 0, remember: async () => ({ added: 0, skipped: 0 }), close: async () => {} } as unknown as ServingIndex;
const store = new FunesStore(index, {
  vault,
  star: () => starConfigFromText("meta:\n  id: test\n"),
  memoryDir: "out_memory",
  serialize: (fn) => fn(),
});

test.each(["a//b", "a/./b", "a/b/", "../x", "a/../b"])("assertOwned refuses the id out_memory/%s", async (rest) => {
  await expect(store.forget(`out_memory/${rest}`)).rejects.toThrow(/only items under out_memory/);
});

test("assertOwned refuses an absolute id", async () => {
  await expect(store.forget("/x")).rejects.toThrow(/only items under out_memory/);
});

test("assertOwned accepts out_memory/a/b", async () => {
  await expect(store.forget("out_memory/a/b")).resolves.toBeUndefined();
});

// RAI-316 (ADR-0024): the edge reads memory.memory_dir, memory.item_pages and edge.mint.telegram_ids.
test("starConfigFromText reads memory_dir, item_pages and the mint allowlist", () => {
  const c = starConfigFromText("meta:\n  id: mcp://example.org/fixture\nmemory:\n  memory_dir: items\n  item_pages: true\nedge:\n  mint:\n    telegram_ids: [4242, \"77\"]\n");
  expect([c.memoryDir, c.itemPages, c.mintIds]).toEqual(["items", true, ["4242", "77"]]);
});

test("starConfigFromText: absent keys are null and an empty allowlist; a malformed allowlist is null", () => {
  const c = starConfigFromText("meta:\n  id: x\n");
  expect([c.memoryDir, c.itemPages, c.mintIds]).toEqual([null, null, []]);
  for (const ids of ["7", "[1.5]", "[-3]", "[abc]", "[true]"]) {
    expect(starConfigFromText(`edge:\n  mint:\n    telegram_ids: ${ids}\n`).mintIds, ids).toBeNull();
  }
  expect(starConfigFromText("memory:\n  item_pages: yes\n").itemPages).toBeNull();
});
