// FolderVault — the folder adapter of the Vault port (PLAN-0.5.0 item 12, ADR-0011 §The decision).
// It holds the node:fs code the port hides: the atomic write, the link(2) create-once, the walk and
// the RAI-156 undo frame. The version is ADR-0007's page stat in its one encoding (funes-core
// `lstatVersion`, the string a build records as PageStat.version), opaque above the adapter.
import {
  closeSync, constants, copyFileSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync,
  readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, type Stats,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { isPagePath, pathOrder } from "funes-core/internal";
import type { SwapResult, Vault, VaultEntry, VaultFile, VaultPath, VaultTx } from "funes-core/internal";
import { lstatVersion } from "funes-core/internal";
import { atomicWriteFile } from "./write.ts";

/** The one folder walk, in the Vault port's order (RAI-314 Q5a): bytewise UTF-8 of the full path,
 *  which a depth-first walk gives by sorting each directory on `name` for a file and `name + "/"`
 *  for a directory (`a/b.md` after `a-c.md`). Dot entries and symlinks are skipped, `exclude` is
 *  asked `<dir>/` before descending and then each file, `isPage` decides which files are yielded,
 *  and `after` resumes strictly after a path, skipping whole directories that sort before it. The
 *  `lstat` is taken BEFORE anything reads the file (RAI-124), so a recorded version is never newer
 *  than the rows. */
export function* walkFolder(
  root: string, dir: string, isPage: (rel: string) => boolean, exclude?: (rel: string) => boolean, after?: string,
): Generator<{ path: string; rel: string; stat: Stats }> {
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith("."))
    .map((e) => ({ name: e.name, key: e.isDirectory() ? `${e.name}/` : e.name }))
    .sort((a, b) => pathOrder(a.key, b.key));
  for (const { name } of entries) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue; // v2: never follow symlinks (assets live outside the vault)
    const rel = relative(root, p);
    if (st.isDirectory()) {
      const prefix = rel + "/";
      if (after !== undefined && !after.startsWith(prefix) && pathOrder(prefix, after) < 0) continue; // all of it sorts before `after`
      if (exclude?.(prefix)) continue;
      yield* walkFolder(root, p, isPage, exclude, after);
    } else if (isPage(rel)) {
      if (after !== undefined && pathOrder(rel, after) <= 0) continue;
      if (exclude?.(rel)) continue;
      yield { path: p, rel, stat: st };
    }
  }
}

const lstatOrNull = (abs: string): Stats | null => {
  try { return lstatSync(abs); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
};

function fsyncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

let seq = 0;
const sibling = (abs: string, ext: string) => join(dirname(abs), `.${basename(abs)}.${process.pid}.${seq++}.${ext}`);

/** Create-once: a sibling temp, fsynced, then link(2), which refuses an existing name — so a page
 *  that appeared after the read is a conflict, never overwritten. */
export function createOnce(abs: string, bytes: Uint8Array): boolean {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = sibling(abs, "tmp");
  const fd = openSync(tmp, "wx");
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    linkSync(tmp, abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
  fsyncDir(dirname(abs));
  return true;
}

export class FolderVault implements Vault {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private abs(path: VaultPath): string {
    return join(this.root, path);
  }

  async read(path: VaultPath): Promise<VaultFile | null> {
    let fd: number;
    try {
      fd = openSync(this.abs(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR") return null;
      throw e;
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return null;
      return { bytes: readFileSync(fd), version: lstatVersion(st) };
    } finally {
      closeSync(fd);
    }
  }

  async *list(opts: { exclude?: (rel: string) => boolean; after?: VaultPath } = {}): AsyncIterable<VaultEntry> {
    for (const { rel, stat } of walkFolder(this.root, this.root, isPagePath, opts.exclude, opts.after)) {
      yield { path: rel, version: lstatVersion(stat) };
    }
  }

  /** The RAI-156 frame. Each swap copies a page aside (a sibling dotfile, FICLONE where the
   *  filesystem clones) BEFORE it writes, while space still exists. If `fn` throws, paths the frame
   *  created are removed first (that frees space), then every copy is renamed back (that needs none);
   *  undo carries on past a failure and names every path it could not put back. A history object
   *  is never removed. The caller's serializer (the star's write lock) keeps the interim private. */
  async atomically<T>(fn: (tx: VaultTx) => Promise<T>): Promise<T> {
    const touched = new Set<VaultPath>();
    const created: VaultPath[] = [];
    const saved = new Map<VaultPath, string>(); // path -> its pre-frame copy
    const tx: VaultTx = {
      swap: async (path, expect, next): Promise<SwapResult> => {
        if (touched.has(path)) throw new Error(`funes: a frame swaps "${path}" at most once`);
        touched.add(path);
        const abs = this.abs(path);
        // Best effort (ADR-0011 Consequences): a folder has no compare-and-swap, so a window remains
        // between this lstat and the rename, under the host lock.
        const cur = lstatOrNull(abs);
        if (expect === null ? cur !== null : cur === null || lstatVersion(cur) !== expect) return { ok: false };
        if (expect === null) {
          if (next === null) return { ok: true, version: null };
          if (!createOnce(abs, next)) return { ok: false };
          if (!path.startsWith(".history/")) created.push(path);
          return { ok: true, version: lstatVersion(lstatSync(abs)) };
        }
        const copy = sibling(abs, "undo");
        copyFileSync(abs, copy, constants.COPYFILE_FICLONE);
        saved.set(path, copy);
        if (next === null) {
          rmSync(abs);
          fsyncDir(dirname(abs));
          return { ok: true, version: null };
        }
        atomicWriteFile(abs, next);
        return { ok: true, version: lstatVersion(lstatSync(abs)) };
      },
    };
    try {
      const out = await fn(tx);
      for (const copy of saved.values()) rmSync(copy, { force: true });
      return out;
    } catch (e) {
      const stuck: string[] = [];
      const dirs = new Set<string>();
      for (const path of created) {
        try { rmSync(this.abs(path), { force: true }); dirs.add(dirname(this.abs(path))); } catch { stuck.push(path); }
      }
      for (const [path, copy] of saved) {
        try { renameSync(copy, this.abs(path)); dirs.add(dirname(copy)); } catch { stuck.push(path); }
      }
      for (const d of dirs) { try { fsyncDir(d); } catch { /* best effort */ } }
      if (stuck.length) {
        throw new Error(`${(e as Error).message} — and the vault could not be put back for ${stuck.join(", ")}`, { cause: e });
      }
      throw e;
    }
  }
}

/** The canonical agent-memory zone for a vault: `out/out_memory` under the v2 layout
 *  (an `out/` container directory exists at the root), else legacy top-level `out_memory`.
 *  The ownership guard (H3/C1 assertOwned) accepts ONLY the active zone — it never widens
 *  to all OUTPUT zones. */
export function memoryZoneOf(vaultRoot: string): string {
  const v2 = join(vaultRoot, "out");
  return existsSync(v2) && statSync(v2).isDirectory() ? "out/out_memory" : "out_memory";
}
