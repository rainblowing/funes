// A builder in its own process, for the kill -9 crash-resume gate (RAI-314 gate 2): it runs the one
// build walk over <vault> into <db> and SIGKILLs itself after <n> committed page batches, having
// written how many passages it embedded to <counter>.
//   bun build-child.ts <vault> <db> <n> <counter>
import { writeFileSync } from "node:fs";
import { LibsqlStore } from "../libsql/store.ts";
import { indexDir } from "../reindex.ts";
import { FakeEmbedder } from "./publish-child.ts";

const [vault, db, n, counter] = process.argv.slice(2) as [string, string, string, string];
let embeds = 0;
const base = new FakeEmbedder();
const embedder = Object.assign(Object.create(base) as FakeEmbedder, {
  embedPassages: async (ts: string[]) => { embeds += ts.length; return base.embedPassages(ts); },
});
const store = await LibsqlStore.create(embedder, db, { allowDirty: true });
let batches = 0;
await indexDir(store, vault, {
  batch: 2,
  onProgress: () => {
    if (++batches < Number(n)) return;
    writeFileSync(counter, String(embeds));
    process.kill(process.pid, "SIGKILL"); // after the batch committed, before the next one
  },
});
writeFileSync(counter, `done ${embeds}`);
