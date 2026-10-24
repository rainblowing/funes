// A test's way to fill the edge index from items, through the one build walk (RAI-314): begin a build
// into the shadow slot, write the rows the way a pages batch writes them (each page's version into
// `build_stat`, its id into `build_refs`), then let the walk run over a vault with no pages, which
// finalizes and flips the slot. Recall reads the live slot until the flip.
import type { BuildInput, IndexRow, MemoryItem, OkfCounts, ScopeSignature, Vault } from "funes-core/internal";
import type { EdgeStore } from "../src/edge-store.ts";
import { FIXTURE_KEY } from "./fixture-star.ts";

const NO_PAGES: Vault = { read: async () => null, async *list() {}, atomically: () => { throw new Error("read-only"); } };

export interface BuildOpts { scope?: ScopeSignature; owner?: string; okf?: OkfCounts | null }
const inputOf = (store: EdgeStore, o: BuildOpts): BuildInput => ({
  vault: NO_PAGES, scope: o.scope ?? { hash: "scope-hash-of-nothing", ignoreScope: false }, okf: o.okf != null,
  onFinalize: () => store.finalized(o.owner ?? FIXTURE_KEY),
});

/** Begin the build and write `items` (or ready rows) into the shadow slot; each page's version is
 *  `etag-<id>` unless `version` says otherwise. */
export async function stageBuild(store: EdgeStore, items: MemoryItem[] | IndexRow[], o: BuildOpts & { version?: (id: string) => string } = {}): Promise<void> {
  const x = store.index;
  await x.begin(inputOf(store, o));
  if (o.okf) x.setMeta("build_cursor", JSON.stringify({ ...JSON.parse(x.meta("build_cursor")!), okf: o.okf }));
  const rows = items.length && "item" in items[0]! ? (items as IndexRow[]) : (await x.embed(items as MemoryItem[], x.live(), x.buildSlot())).rows;
  x.x.tx(() => {
    for (const { item } of rows) {
      x.x.run("insert or replace into build_refs(id, aliases) values (?, null)", [item.id]);
      x.x.run("insert or replace into build_stat(id, version) values (?, ?)", [item.id, o.version?.(item.id) ?? `etag-${item.id}`]);
    }
    x.apply(rows.map((put) => ({ put })), x.buildSlot());
  });
}

/** Run the walk to its finalize: the shadow slot goes live. */
export async function finishBuild(store: EdgeStore, o: BuildOpts = {}): Promise<void> {
  await store.index.build(inputOf(store, o));
}

export async function buildItems(store: EdgeStore, items: MemoryItem[], o: BuildOpts = {}): Promise<void> {
  await stageBuild(store, items, o);
  await finishBuild(store, o);
}
