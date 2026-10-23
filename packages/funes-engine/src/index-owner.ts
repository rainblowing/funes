// RAI-311, RAI-315: the owning star's id stamped inside an index, read without opening a store.
import { createRequire } from "node:module";

/** The owning star's id stamped inside a libsql index (`meta.owner_star_id`), read synchronously and
 *  read-only, without the engine (twinkl.ing's publication gate is sync and engine-free). null when
 *  the file is missing, unreadable, not a funes index, or carries no stamp: "no identity", which the
 *  caller refuses. The libSQL adapter is required lazily so importing this entry opens no database code. */
export function readIndexOwner(dbPath: string): string | null {
  try {
    const { openRawIndex } = createRequire(import.meta.url)("./libsql/store.ts") as typeof import("./libsql/store.ts");
    const db = openRawIndex(dbPath, true);
    try {
      const row = db.prepare("select value from meta where key='owner_star_id'").get() as { value?: string } | undefined;
      return row?.value ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
