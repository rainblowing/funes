// `funes-engine/light` (RAI-206, PLAN-0.5.0 item 9, ADR-0016): the twinkl.ing-facing light entry.
// A re-export file over today's modules, so a consumer imports these symbols by package name and
// never names a funes `src/` path. It is NOT ADR-0011's workerd-portable subpath: actor.ts and
// ops.ts use node:fs and node:crypto. Every symbol here is contract; add one only with the
// contract page (wiki/synthesis/funes-twinkling-contract.md).
import { createRequire } from "node:module";

export { opCapabilities, publicOpNames } from "./ops.ts";
export { assertActorName, grantFor, readAccessPolicy, resolveSessionGrant } from "./actor.ts";
export { scopeHash } from "./scope.ts";
export { validateRecallDeclaration } from "./recall-declaration.ts";
export type { RecallDeclaration, RecallDeclarationResult, Condition, Predicate, Scalar } from "./recall-declaration.ts";

/** The owning star's id stamped inside a libsql index (`meta.owner_star_id`), read synchronously and
 *  read-only, without the engine (twinkl.ing's publication gate is sync and engine-free). null when
 *  the file is missing, unreadable, not a funes index, or carries no stamp: "no identity", which the
 *  caller refuses. funes-libsql is required lazily so importing this entry opens no database code. */
export function readIndexOwner(dbPath: string): string | null {
  try {
    const { openRawIndex } = createRequire(import.meta.url)("funes-libsql") as typeof import("funes-libsql");
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
