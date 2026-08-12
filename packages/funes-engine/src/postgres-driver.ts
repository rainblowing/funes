// node-postgres → PgDriver adapter: the SERVER tier of ADR-0001 §1 (sparkling, big stars,
// constellations — database-per-star, role-per-star). The store code is identical to the PGLite
// path; only this ~40-line adapter differs.
//
// EXPERIMENTAL until the first live cluster run: PGLite structurally proves the seam (the whole
// suite runs through it), but this adapter has not yet spoken to a real server. Two known
// server-side prerequisites, both deliberate non-goals here:
//   1. `create extension vector` needs pgvector INSTALLED on the cluster (superuser/managed-pg
//      checkbox) — the store's init surfaces the Postgres error verbatim if it's missing.
//   2. The write mutex is a LOCAL file lock — correct for every same-machine writer, blind to
//      writers on other hosts. Before a genuinely multi-host constellation, beginReindex must
//      take `pg_advisory_lock(hashtext(<star>))` through this driver (server-side mutex).
import type { PgDriver, PgQueryResult, PgTx } from "./driver.ts";

/** Build a PgDriver over a node-postgres Pool. `pg` is imported lazily so the dependency loads
 *  only on the server tier (PGLite/libsql users never pay for it). No connection is attempted
 *  until the first query. */
export async function postgresDriver(connectionString: string): Promise<PgDriver> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString });
  // Every pooled connection gets the HNSW recall floor (store.init()'s SET only reaches the one
  // connection that ran it — pools need the per-connection hook). See store.ts init() for the
  // 2026-07-13 bench rationale (ef=40 default → cross-language recall collapse; ef=200 ≡ exact).
  const efSearch = Number(process.env.FUNES_EF_SEARCH ?? 200) || 200;
  pool.on("connect", (client) => {
    client.query(`set hnsw.ef_search = ${efSearch}`).catch(() => { /* pre-pgvector init window */ });
  });
  const mapResult = <T>(r: { rows: unknown[]; rowCount: number | null }): PgQueryResult<T> => ({
    rows: r.rows as T[], // the store owns its row shapes; pg types rows as QueryResultRow
    affectedRows: r.rowCount ?? 0,
  });
  return {
    async query<T = unknown>(sql: string, params?: unknown[]): Promise<PgQueryResult<T>> {
      return mapResult<T>(await pool.query(sql, params as unknown[]));
    },
    async exec(sql: string): Promise<unknown> {
      return pool.query(sql);
    },
    async transaction<T>(cb: (tx: PgTx) => Promise<T>): Promise<T | undefined> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await cb({
          async query<T2 = unknown>(sql: string, params?: unknown[]): Promise<PgQueryResult<T2>> {
            return mapResult<T2>(await client.query(sql, params as unknown[]));
          },
        });
        await client.query("commit");
        return out;
      } catch (e) {
        await client.query("rollback").catch(() => { /* connection already gone */ });
        throw e;
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
