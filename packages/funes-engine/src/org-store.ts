// B10a (RAI-347; RAI-312, RAI-314 Q7/Q10, ADR-0019): an org star, opened by its one `funes serve`.
// Its Turso database holds the canonical pages (the RowVault) and the index in two slots. No other
// process opens it (ADR-0021), so the build runs here too: in place when the live slot was built under
// this schema and embedding spec, and writes proceed; into the shadow slot on a new embedder or
// schema, and writes refuse `building` until the flip. Every write is one org write transaction, and
// the serializer is in-process: the server is the star's one writer.
import { dirname, join } from "node:path";
import type { Embedder } from "funes-core";
import { corpusOf, FunesStore, ORG_DIALECT, ORG_SLOTS, RowVault, serialize, SqlIndex } from "funes-core/internal";
import type { BuildInput, ServingIndex, StarConfig } from "funes-core/internal";
import { assertIndexOwner, assertOwnerClaim, funesDbDir, readStarIdentity, starMemory } from "./factory.ts";
import { assertIndexNotInSyncRoot } from "./sync-root.ts";
import { libsqlExec, openTurso } from "./libsql/store.ts";
import { folderStar } from "./funes-store.ts";
import { E5Embedder } from "./embedder.ts";
import { OrgExport } from "./org-export.ts";

/** The dispatcher's ports over an org star: no folder part (RAI-304: the org ceiling has no UI op). */
export interface OrgStar {
  readonly vault: RowVault;
  readonly store: ServingIndex;
  readonly funes: FunesStore;
  readonly star: () => StarConfig;
  /** Health's org tier keys, a closed list (RAI-308 as amended by RAI-322, C8). */
  tierFields(): { exportDirty: boolean };
  close(): Promise<void>;
}

/** Open an org star. Refuses, naming the key, without `memory.memory_dir` (the zone org writes land
 *  in, RAI-322 Q8), over a home index file, or over another star's database. Before the first build
 *  finishes nothing serves, so that build runs before this returns; any later one runs behind it. */
export async function openOrgStar(o: { vault: string; embedder?: Embedder }): Promise<OrgStar> {
  const source = join(o.vault, "star.yaml");
  const identity = readStarIdentity(o.vault);
  if (starMemory(identity, source).tier !== "org") throw new Error(`${source} does not declare memory.tier: org`);
  if (!identity.memoryDir) throw new Error(`${source}: memory.tier: org requires memory.memory_dir, the zone org writes land in`);
  const dbPath = funesDbDir(o.vault);
  assertIndexOwner(dirname(dbPath), o.vault);
  assertIndexNotInSyncRoot(dbPath);
  let db: ReturnType<typeof openTurso>;
  try {
    db = openTurso(dbPath);
  } catch (e) {
    throw new Error(`funes: cannot open the org database at ${dbPath} — ${(e as Error).message}. If another funes serve holds it, stop that process.`);
  }
  try {
    const exec = libsqlExec(db);
    if (exec.all("select 1 from sqlite_master where name='nodes'").length) {
      throw new Error(`funes: ${dbPath} holds a home index — an org star keeps its pages as rows, and this build has no import into one`);
    }
    const index = new SqlIndex({ exec, dialect: ORG_DIALECT, embedder: o.embedder ?? new E5Embedder(), slots: ORG_SLOTS, inPlaceOnSameSpec: true, where: dbPath });
    index.createTables();
    assertOwnerClaim(index.meta("owner_star_id"), o.vault, dbPath);
    const rows = new RowVault(index);
    const exported = await OrgExport.open({ vault: o.vault, rows, id: identity.id, writeLocus: identity.writeLocus }); // RAI-322: guards, then the full reconcile
    const star = folderStar(o.vault);
    const input = (): BuildInput => {
      const { exclude, scopeSignature } = corpusOf(star().scope);
      return { vault: rows, exclude, scope: scopeSignature, owner: identity.id ? { id: identity.id, was: identity.idWas } : undefined, okf: identity.capabilities.okf !== false };
    };
    let closed = false;
    if (index.live() == null) await index.build(input());
    else if (index.building || index.meta("build_spec") !== index.buildSpec(input())) {
      // behind the server: a resumed build, a new scope or parser (in place), or a migration (shadow)
      void index.build(input()).catch((e) => {
        if (!closed) process.stderr.write(`funes serve: the org build failed (${(e as Error).message}); it resumes at its cursor on the next start\n`);
      });
    }
    const funes = new FunesStore(rows.serving, { vault: exported.wrap(rows), star, memoryDir: identity.memoryDir, serialize: (fn) => serialize(`org:${dbPath}`, fn, 10_000) });
    return {
      vault: rows, store: rows.serving, funes, star,
      tierFields: () => ({ exportDirty: exported.dirty }),
      async close() { closed = true; db.close(); },
    };
  } catch (e) {
    db.close();
    throw e;
  }
}
