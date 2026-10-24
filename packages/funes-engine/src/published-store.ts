// ADR-0018, ADR-0021 (RAI-338): published mode. `funes serve --published` and `funes mcp --published`
// serve the star's `<home>/published.db` read-only, and reopen the path when a publish swaps it: one
// stat per call, keyed by the file's dev:ino. The old handle stays until its last call ends, and it
// keeps serving while the new file cannot be opened (absent, or not an index yet).
import { statSync } from "node:fs";
import { dirname } from "node:path";
import type { Embedder } from "funes-core";
import type { FunesIndexStore } from "funes-core";
import { funesDbDir, makeStore } from "./factory.ts";
import { publishedDbPath } from "./publication.ts";

/** A store that a host borrows for one call at a time. */
export interface StoreLease {
  use<T>(fn: (store: FunesIndexStore) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** The star's published index: `<home>/published.db`, where `<home>` holds its live `index.db`. */
export const publishedPathOf = (vault: string): string => publishedDbPath(dirname(funesDbDir(vault)));

/** Open the star's published index read-only. Refuses when nothing is published yet. */
export async function openPublished(vault: string, opts: { embedder?: Embedder } = {}): Promise<StoreLease> {
  const path = publishedPathOf(vault);
  // shortcut: dev:ino identifies the file, and ext4 can reuse an inode at once; add a birth time for a Linux host.
  const fileId = (): string | null => { try { const s = statSync(path); return `${s.dev}:${s.ino}`; } catch { return null; } };
  type Handle = { id: string | null; store: FunesIndexStore; inflight: number; retired: boolean };
  // No vault: the owner-marker guard writes, and published.db is 0444.
  const handle = async (id: string | null): Promise<Handle> => ({ id, store: await makeStore({ dbDir: path, readonly: true, embedder: opts.embedder }), inflight: 0, retired: false });
  const release = async (h: Handle) => { if (h.retired && h.inflight === 0) await h.store.close().catch(() => {}); };
  const first = fileId();
  if (first === null) throw new Error(`${path}: nothing is published for ${vault} — run \`funes publish --vault ${vault}\` first`);
  let cur = await handle(first);
  let reopening: Promise<void> | null = null;
  return {
    async use(fn) {
      const now = fileId();
      if (now !== null && now !== cur.id) {
        reopening ??= handle(now).then(async (next) => {
          const old = cur;
          cur = next;
          old.retired = true;
          await release(old);
        }, () => {}).finally(() => { reopening = null; });
        await reopening;
      }
      const h = cur;
      h.inflight++;
      try { return await fn(h.store); } finally { h.inflight--; await release(h); }
    },
    close: async () => { cur.retired = true; await release(cur); },
  };
}
