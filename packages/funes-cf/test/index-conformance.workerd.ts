// RAI-314 seam (3) on the REAL DO SQLite: the one index module over the DO adapter gives the pinned
// recall golden byte for byte (the libsql suite runs the same fixture), and a BLOB round trip keeps
// the bytes and the blob type.
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { DO_SQLITE_DIALECT, SqlIndex } from "funes-core/internal";
import { doExec } from "../src/edge-store.ts";
import { GoldenEmbedder, goldenCorpus, goldenOf } from "../../funes-core/src/__fixtures__/index-golden.ts";
import GOLDEN from "../../funes-core/src/__fixtures__/recall-golden.json";

const NO_PAGES = { read: async () => null, async *list() {}, atomically: () => { throw new Error("read-only"); } };

const inDo = <T>(fn: (index: SqlIndex) => Promise<T>) =>
  runInDurableObject(env.STAR.getByName(crypto.randomUUID()), async (_o, state) => {
    const index = new SqlIndex({ exec: doExec(state.storage), dialect: DO_SQLITE_DIALECT, embedder: new GoldenEmbedder(), slots: ["_a", "_b"] });
    index.createTables();
    await index.build({ vault: NO_PAGES }); // a live slot: the edge writes only into one
    return fn(index);
  });

it("gate 1: the recall golden, byte for byte, on DO SQLite", () =>
  inDo(async (index) => {
    await index.remember(goldenCorpus());
    expect(await goldenOf((q) => index.recall(q), index.sig)).toEqual(GOLDEN);
  }));

it("gate 4: a BLOB round trip — written, read, written back: still a blob, the same bytes", () =>
  inDo(async (index) => {
    const [item] = goldenCorpus();
    await index.remember([item!]);
    const read = () => index.x.all<{ ty: string; e: ArrayBuffer }>(`select typeof(embedding) ty, embedding e from ${index.live()!.chunks} where page_id=?`, [item!.id])[0]!;
    const first = read();
    expect(first.ty).toBe("blob");
    // written back through the module: the vectors it reads are the vectors it writes
    const { rows } = await index.embed([{ ...item!, trust: "untrusted" }]);
    index.x.tx(() => index.apply(rows.map((put) => ({ put }))));
    const again = read();
    expect(again.ty).toBe("blob");
    expect([...new Uint8Array(again.e)]).toEqual([...new Uint8Array(first.e)]);
  }));
