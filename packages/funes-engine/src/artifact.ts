// Build-time posture of the PUBLISHED artifact (P3.15).
//
// `@funes-tech/cli` ships the libsql path only: the Postgres tier is the deferred profile B, has
// never run against a live cluster, and still has the pg_advisory_lock gap — shipping it to
// strangers would invite production use of code we have explicitly not signed off.
//
// The flag is a BARE identifier substituted by `bun build --define`, guarded by `typeof` so that
// running from source — which twinkling does, spawning mcp.ts by path — sees it undefined and keeps
// the full multi-backend behaviour. Measured trade (bun 1.3.14): the `typeof` guard makes the
// branch unreachable but NOT eliminated, so ~160KB of dead Postgres SQL stays in the bundle. The
// bare form without `typeof` does get dead-code-eliminated, but then every source run throws
// ReferenceError. Correctness and source-compatibility beat 160KB.
//
// ponytail: revisit if funes ever stops being run from source — then drop the `typeof` and the
// dead branch disappears too.
declare const __FUNES_LIBSQL_ONLY__: boolean | undefined;

/** True only inside the published CLI bundle. */
export const LIBSQL_ONLY: boolean =
  typeof __FUNES_LIBSQL_ONLY__ !== "undefined" && __FUNES_LIBSQL_ONLY__ === true;

/** The define flag name, so the build script and the tests cannot drift from this module. */
export const LIBSQL_ONLY_DEFINE = "__FUNES_LIBSQL_ONLY__";
