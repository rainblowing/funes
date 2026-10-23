// The engine's folder composition (RAI-313 Q6): the one place a folder star's ports are built — the
// FolderVault, the star.yaml thunk, the memory zone, the star's write lock, the folder part and the
// locus. FunesStore and the registry are the kernel's (funes-core); they never construct an adapter.
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import type { FunesIndexStore } from "funes-core";
import type { ServingIndex } from "funes-core/internal";
import { FunesStore, refusal, type FolderPart, type FunesStoreOpts, type StarConfig } from "funes-core/internal";
import { ceiling, portContext, type OperationContext } from "funes-core";
import { FolderVault, memoryZoneOf } from "./folder-vault.ts";
import { funesDbDir, isReadOnlyStore, readStarIdentity } from "./factory.ts";
import { readIndexScopeExcludes } from "./scope.ts";
import { readRecallDeclaration } from "./recall-planner.ts";
import { withScopedWriteLock } from "./write-lock.ts";
import { funesHome } from "./funes-home.ts";
import { processLocus, resolveWriteDesignation } from "./process-locus.ts";

const starMemo = new Map<string, { key: string; config: StarConfig }>();

/** A folder star's config thunk: re-read on every call through a stat-keyed memo, as scope.ts keeps
 *  (never a clock), so a `star.yaml` narrowed during a read is seen by the recheck after it. */
export function folderStar(root: string): () => StarConfig {
  const p = join(root, "star.yaml");
  return () => {
    let key = "absent";
    try { const st = statSync(p); key = `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { /* no manifest */ }
    const hit = starMemo.get(p);
    if (hit?.key === key) return hit.config;
    const config = { identity: readStarIdentity(root), scope: readIndexScopeExcludes(root), recall: readRecallDeclaration(root) };
    starMemo.set(p, { key, config });
    return config;
  };
}

/** A FunesStore over a folder star: the four ports from `root`, any of them overridable. The
 *  serializer is the star's write lock (RAI-309), keyed on the store's live index path,
 *  `lockPathFor(funesDbDir(vault))`, byte for byte 0.5.0's index-lock string: a live read-write index
 *  reports it as its `lockResource`, and a `:memory:` store (null) falls back to it, so two stores on
 *  one star serialize. */
export function folderFunesStore(index: ServingIndex, opts: Partial<FunesStoreOpts> & { root: string }): FunesStore {
  const { root, ...rest } = opts;
  return new FunesStore(index, { ...folderPorts(root, index), ...rest });
}

/** A folder star's four FunesStore ports (RAI-313 Q6). */
function folderPorts(root: string, index: ServingIndex): FunesStoreOpts {
  const res = "lockResource" in index ? index.lockResource : null;
  return {
    vault: new FolderVault(root),
    star: folderStar(root),
    memoryDir: readStarIdentity(root).memoryDir ?? memoryZoneOf(root), // a declared memory.memory_dir wins (RAI-316)
    serialize: (fn) => withScopedWriteLock(typeof res === "string" ? res : funesDbDir(root), fn),
  };
}

/** Resolve a vault-relative path; reject absolute paths, escapes, and any dot-segment. */
function safeResolve(vault: string, rel: string): string {
  if (rel.startsWith("/") || rel.includes(String.fromCharCode(0))) throw refusal("invalid", `invalid path: ${rel}`);
  const norm = normalize(rel);
  if (norm.split(sep).some((seg) => seg === ".." || seg.startsWith("."))) {
    throw refusal("invalid", `invalid path (escapes vault or dot-path): ${rel}`);
  }
  const abs = resolve(vault, norm);
  const root = resolve(vault);
  if (abs !== root && !abs.startsWith(root + sep)) throw refusal("invalid", `path escapes vault: ${rel}`);
  // Lexical containment is not containment: a symlink with an ordinary name inside the vault
  // (`notes/leak.md -> /etc/passwd`) passes every check above. Resolve the real path and re-check.
  let realAbs: string, realRoot: string;
  try { realRoot = realpathSync(root); } catch { realRoot = root; }
  try { realAbs = realpathSync(abs); } catch { return abs; } // not yet on disk — lexical check stands
  if (realAbs !== realRoot && !realAbs.startsWith(realRoot + sep)) {
    throw refusal("invalid", `path escapes vault via a symlink: ${rel}`);
  }
  return realAbs;
}

/** The folder part (RAI-313 Q5): `page` and `tree` read the folder through `safeResolve`. */
export function folderPart(root: string, store: FunesIndexStore): FolderPart {
  return {
    root,
    store,
    readPage(rel) {
      try { return readFileSync(safeResolve(root, rel)); } catch (e) {
        if ((e as { code?: unknown }).code === "invalid") throw e;
        if ((e as NodeJS.ErrnoException).code === "ENOENT") throw refusal("not-found", `page: no page "${rel}"`);
        throw refusal("invalid", `page: "${rel}" is unreadable (${(e as NodeJS.ErrnoException).code ?? "error"})`);
      }
    },
    listDir(rel) {
      const abs = rel ? safeResolve(root, rel) : resolve(root);
      return readdirSync(abs).sort().map((name) => ({ name, dir: !name.startsWith(".") && statSync(join(abs, name)).isDirectory() }));
    },
    privatePaths() {
      const paths = [root];
      try { paths.push(realpathSync(root)); } catch { /* gone: the lexical root covers it */ }
      try { const home = funesHome(); paths.push(home); paths.push(realpathSync(home)); } catch { /* an unusable or absent FUNES_HOME: the lexical path covers it */ }
      return paths;
    },
  };
}

/** The folder half of a dispatcher context: the port, the star thunk, and the folder part — the
 *  root that only `page`, `tree` and health's operator state read, and the full index store the
 *  folder-only ops read (ADR-0015). */
export function folderVaultContext(root: string, store: FunesIndexStore): Pick<OperationContext, "vault" | "star" | "folder" | "tier"> {
  return { vault: new FolderVault(root), star: folderStar(root), folder: folderPart(root, store), tier: "home" };
}

/** The dispatcher's context over a folder vault, with its FunesStore already built (RAI-206,
 *  ADR-0016): twinkl.ing calls this instead of constructing `OperationContext` or `FunesStore`.
 *  `vault` is the folder's path; the context carries the port over it, its star thunk, the folder
 *  part, the home tier and this process's designation (RAI-313: `--locus` over FUNES_LOCUS over the
 *  short hostname, resolved here, not in the kernel). Over a store `makeStore` opened read-only,
 *  `narrow` is the ceiling's read ops (RAI-315 Q9): a mutation refuses before it touches the vault. */
export function folderContext(opts: { vault: string; store: FunesIndexStore }): OperationContext {
  const { vault, store } = opts;
  const designation = resolveWriteDesignation(vault, { locus: processLocus() ?? undefined });
  const narrow = isReadOnlyStore(store) ? new Set(ceiling("home").filter((o) => o.readonly).map((o) => o.name)) : undefined;
  return { ...portContext({ index: store, ...folderPorts(vault, store), tier: "home", designation }), folder: folderPart(vault, store), ...(narrow ? { narrow } : {}) };
}
