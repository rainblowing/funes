// B10b (RAI-348; RAI-322, ADR-0019): the org markdown export. One-way: the server writes its page
// rows into `memory.export_dir` and nothing reads them back. Each write exports the paths it touched
// inside the same serialized mutation, after the commit and before the answer, from the CURRENT row
// bytes, so the order of exports never matters. A failed path waits in an in-memory retry set that
// every later write retries; serve start reconciles every row. Nothing here deletes a file without
// a row: a stray is reported (health `exportDirty`), and the operator removes it.
// Owned files: `isPagePath` paths, `star.yaml` (derived) and the `.funes-export` marker.
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { parseDocument } from "yaml";
import type { Vault, VaultPath, VaultTx } from "funes-core/internal";
import { atomicWriteFile } from "./write.ts";
import { FolderVault } from "./folder-vault.ts";
import { funesHome } from "./funes-home.ts";

const MARKER = ".funes-export";
const STAR = "star.yaml";

/** The export's star.yaml: the org star.yaml with no `memory.tier`, `memory.substrate` or
 *  `memory.export_dir`, and `meta.write_locus: <w>.export`. A short host name has no dot, and
 *  resolveLocus refuses a declared locus that ends in `.export`, so a funes write on any copy refuses
 *  `not-write-locus`, the server host included. A Document edit keeps comments. */
export function derivedStarYaml(text: string, writeLocus: string): string {
  const doc = parseDocument(text);
  for (const k of ["tier", "substrate", "export_dir"]) doc.deleteIn(["memory", k]);
  doc.setIn(["meta", "write_locus"], `${writeLocus}.export`);
  return doc.toString();
}

/** A path as the file system names it, when it exists; else resolved (the guards compare both sides alike). */
function real(p: string): string {
  try { return realpathSync(p); } catch { return dirname(p) === p ? p : join(real(dirname(p)), basename(p)); }
}
const within = (child: string, parent: string) => { const r = relative(parent, child); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };

export class OrgExport {
  private readonly retry = new Set<VaultPath>();
  private readonly strays = new Set<VaultPath>();

  private constructor(private readonly dir: string, private readonly rows: Vault, private readonly source: string, private readonly writeLocus: string) {}

  /** The guards, the marker, then the full reconcile. `source` is the org star.yaml. Refuses, naming
   *  the key: no or a relative `memory.export_dir`; a path equal to, inside or around the star's
   *  directory; a path inside the funes home; the star directory's basename (the index home is keyed
   *  by basename); a non-empty directory without the marker; a marker that names another star. */
  static async open(o: { vault: string; rows: Vault; id: string | null; writeLocus: unknown }): Promise<OrgExport> {
    const source = join(o.vault, STAR);
    const raw = (parseDocument(readFileSync(source, "utf8")).toJS() as { memory?: { export_dir?: unknown } } | null)?.memory?.export_dir;
    const key = `${source} memory.export_dir`;
    if (raw == null) throw new Error(`${source}: memory.tier: org requires memory.export_dir, the directory the markdown export mirrors the rows into`);
    if (typeof raw !== "string" || !isAbsolute(raw)) throw new Error(`${key} must be an absolute path (got ${JSON.stringify(raw)})`);
    if (typeof o.writeLocus !== "string" || !o.writeLocus.trim()) throw new Error(`${source}: memory.tier: org requires meta.write_locus — the export names <write_locus>.export`);
    const dir = real(raw), star = real(o.vault), home = real(funesHome());
    if (within(dir, star) || within(star, dir)) throw new Error(`${key} ${raw} overlaps the star's directory ${o.vault} — the export lives outside it`);
    if (within(dir, home)) throw new Error(`${key} ${raw} is inside the funes home ${home}`);
    if (basename(dir) === basename(star)) throw new Error(`${key} ${raw} has the basename of the star's directory — the index home is keyed by basename, so a reindex of the export would collide with the org star`);
    const marker = join(dir, MARKER);
    const mine = JSON.stringify({ id: o.id });
    if (existsSync(marker)) {
      const named = (() => { try { return (JSON.parse(readFileSync(marker, "utf8")) as { id?: unknown }).id; } catch { return undefined; } })();
      if (named !== o.id) throw new Error(`${key} ${raw} is the export of ${JSON.stringify(named)}, not of ${JSON.stringify(o.id)} (${marker})`);
    } else {
      if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${key} ${raw} is not empty and has no ${MARKER} marker — refusing to write into a directory funes does not own`);
      mkdirSync(dir, { recursive: true });
      // link(2): created once, whole, or not at all
      const tmp = `${marker}.${process.pid}.tmp`;
      writeFileSync(tmp, `${mine}\n`, { mode: 0o444 });
      try { linkSync(tmp, marker); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; } finally { unlinkSync(tmp); }
      if (JSON.parse(readFileSync(marker, "utf8")).id !== o.id) throw new Error(`${key} ${raw}: another star claimed it first (${marker})`);
    }
    const ex = new OrgExport(dir, o.rows, source, o.writeLocus.trim());
    await ex.reconcile();
    return ex;
  }

  /** Health's org tier key: a failed path waits for its retry, or a stray exists. */
  get dirty(): boolean {
    for (const p of this.strays) if (!existsSync(join(this.dir, ...p.split("/")))) this.strays.delete(p); // the operator removed it
    return this.retry.size > 0 || this.strays.size > 0;
  }

  /** The serve-start reconcile: every row against its file, the derived star.yaml, and the strays.
   *  It never consults page_stat (derived and scoped) and never deletes. */
  private async reconcile(): Promise<void> {
    const rows = new Set<VaultPath>();
    for await (const { path } of this.rows.list()) rows.add(path);
    await this.flush([...rows, STAR]); // `write` skips a file whose bytes already match
    for await (const { path } of new FolderVault(this.dir).list()) {
      if (rows.has(path)) continue;
      this.strays.add(path);
      process.stderr.write(`funes serve: export stray ${join(this.dir, path)} — it has no row; remove it by hand\n`);
    }
  }

  /** Export `paths` and every path waiting for a retry. Never throws: a failed path is logged and kept. */
  async flush(paths: Iterable<VaultPath>): Promise<void> {
    for (const p of new Set([...this.retry, ...paths])) {
      try {
        await this.write(p);
        this.retry.delete(p);
        this.strays.delete(p);
      } catch (e) {
        this.retry.add(p);
        process.stderr.write(`funes serve: export of ${p} failed (${(e as Error).message}); it retries on the next write\n`);
      }
    }
  }

  private async write(p: VaultPath): Promise<void> {
    const abs = join(this.dir, ...p.split("/"));
    const bytes = p === STAR ? Buffer.from(derivedStarYaml(readFileSync(this.source, "utf8"), this.writeLocus)) : (await this.rows.read(p))?.bytes ?? null;
    if (bytes === null) { rmSync(abs, { force: true }); return; } // the write removed the row
    try { if (readFileSync(abs).equals(bytes)) return; } catch { /* absent */ }
    mkdirSync(dirname(abs), { recursive: true });
    atomicWriteFile(abs, bytes, 0o444);
  }

  /** The Vault FunesStore writes through: each frame that commits exports the paths it swapped,
   *  inside the caller's serializer, before the answer. */
  wrap(rows: Vault): Vault {
    return {
      read: (p) => rows.read(p),
      list: (o) => rows.list(o),
      atomically: async <T>(fn: (tx: VaultTx) => Promise<T>): Promise<T> => {
        const touched: VaultPath[] = [];
        const out = await rows.atomically((tx) => fn({ swap: (path, expect, next) => { touched.push(path); return tx.swap(path, expect, next); } }));
        await this.flush([...touched, STAR]); // the org star.yaml may have changed since the last write
        return out;
      },
    };
  }
}
