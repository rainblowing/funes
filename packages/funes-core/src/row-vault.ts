// The org RowVault (RAI-314 Q7, ADR-0019; B10a, RAI-347): the Vault port over the canonical `pages`
// table of an org star's database. The pages are rows, not files, in the same database as the index,
// so one transaction — the org write transaction — commits a write's page rows, its index rows and
// its page_stat rows, or none of them. A frame stages: `tx.swap` checks `expect` against the row and
// records the write, and the staging index (`serving`) records the index ops; the commit rechecks
// every swap by compare-and-swap. The version of a page is its row revision, one counter for the
// whole table, so a path removed and created again never repeats a version.
import type { PageSwap, RememberResult } from "./types.ts";
import type { ServingIndex } from "./index-store.ts";
import type { IndexOp, SqlIndex } from "./sql-index.ts";
import { listedPage, type SwapResult, type Vault, type VaultEntry, type VaultFile, type VaultPath, type VaultTx, type Version } from "./vault.ts";

interface Write { path: VaultPath; expect: Version | null; next: Uint8Array | null; revision: number }

/** The refusal of every org write while a migration fills the shadow slot (RAI-314 Q10): the shadow
 *  slot would miss it. 503, as at the edge. */
const building = () => Object.assign(new Error("funes: a migration of this org index is building its shadow slot; writes refuse until the flip — retry"), { status: 503, code: "building" });

export class RowVault implements Vault {
  readonly index: SqlIndex;
  /** The index FunesStore holds at org: inside a frame its writes stage and commit with the page rows. */
  readonly serving: ServingIndex;
  private frame: { writes: Write[]; ops: IndexOp[] } | null = null;

  constructor(index: SqlIndex) {
    this.index = index;
    index.x.run("create table if not exists pages(path text primary key, revision integer not null, bytes blob not null)");
    const stage = (ops: IndexOp[]) => {
      if (this.frame) this.frame.ops.push(...ops);
      else index.x.tx(() => { if (index.shadowBuilding) throw building(); index.apply(ops); });
    };
    this.serving = {
      async remember(items, swaps: PageSwap[] = []): Promise<RememberResult> {
        const { rows, unchanged } = await index.embed(items);
        stage([...rows.map((put) => ({ put })), ...swaps.map((stat) => ({ stat }))]);
        return { indexed: items.length - unchanged, skipped: unchanged };
      },
      async remove(ids, swaps: PageSwap[] = []) {
        const t = index.live();
        const n = t == null || !ids.length ? 0 : index.x.all<{ n: number }>(`select count(*) n from ${t.nodes} where id in (select value from json_each(?))`, [JSON.stringify(ids)])[0]!.n;
        stage([...ids.map((del) => ({ del })), ...swaps.map((stat) => ({ stat }))]);
        return Number(n);
      },
      recall: (q) => index.recall(q),
      indexedPage: (ref) => index.indexedPage(ref),
      stats: () => index.stats(),
      pageStats: () => index.pageStats(),
      guardedRead: (expected, retrieve) => index.guardedRead(expected, retrieve),
      servingSignature: () => index.servingSignature(),
      close: () => index.close(),
    };
  }

  private row(path: VaultPath): { revision: number; bytes: Uint8Array | ArrayBuffer } | undefined {
    return this.index.x.all<{ revision: number; bytes: Uint8Array | ArrayBuffer }>("select revision, bytes from pages where path=?", [path])[0];
  }

  /** The bytes and the revision that came with them (the build records that version, ADR-0007). */
  async read(path: VaultPath): Promise<VaultFile | null> {
    const r = this.row(path);
    return r ? { bytes: r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes), version: String(r.revision) } : null;
  }

  /** `order by path` is BINARY collation, memcmp on UTF-8: the port's bytewise order. */
  async *list(opts: { exclude?: (rel: string) => boolean; after?: VaultPath } = {}): AsyncIterable<VaultEntry> {
    const listed = listedPage(opts.exclude);
    for (const r of this.index.x.all<{ path: string; revision: number }>("select path, revision from pages where path > ? order by path", [opts.after ?? ""])) {
      if (listed(r.path)) yield { path: r.path, version: String(r.revision) };
    }
  }

  /** One frame, one transaction. A throw from `fn` writes nothing; a migration refuses `building`, at
   *  the start and again inside the commit. The caller's serializer holds one frame at a time. */
  async atomically<T>(fn: (tx: VaultTx) => Promise<T>): Promise<T> {
    if (this.frame) throw new Error("funes: a RowVault frame is already open — the caller's serializer must hold one frame at a time");
    if (this.index.shadowBuilding) throw building();
    const frame: { writes: Write[]; ops: IndexOp[] } = { writes: [], ops: [] };
    this.frame = frame;
    try {
      const out = await fn({
        swap: async (path, expect, next): Promise<SwapResult> => {
          if (frame.writes.some((w) => w.path === path)) throw new Error(`funes: "${path}" swapped twice in one frame`);
          const cur = this.row(path);
          if ((cur ? String(cur.revision) : null) !== expect) return { ok: false };
          const revision = Number(this.index.meta("pages_revision") ?? 0) + frame.writes.length + 1;
          frame.writes.push({ path, expect, next, revision });
          return { ok: true, version: next === null ? null : String(revision) };
        },
      });
      if (frame.writes.length || frame.ops.length) this.index.x.tx(() => this.commit(frame));
      return out;
    } finally {
      this.frame = null;
    }
  }

  private commit(frame: { writes: Write[]; ops: IndexOp[] }): void {
    if (this.index.shadowBuilding) throw building();
    const x = this.index.x;
    for (const w of frame.writes) {
      const changed = w.expect === null
        ? x.run("insert into pages(path, revision, bytes) values (?, ?, ?) on conflict(path) do nothing", [w.path, w.revision, w.next!])
        : w.next === null
          ? x.run("delete from pages where path=? and revision=?", [w.path, Number(w.expect)])
          : x.run("update pages set revision=?, bytes=? where path=? and revision=?", [w.revision, w.next, w.path, Number(w.expect)]);
      if (changed !== 1) throw new Error(`funes: conflict on "${w.path}" — its row moved since the frame read it; nothing was written`);
    }
    if (frame.writes.length) this.index.setMeta("pages_revision", String(frame.writes.at(-1)!.revision));
    this.index.apply(frame.ops);
  }
}
