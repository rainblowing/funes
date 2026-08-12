// The Postgres DRIVER SEAM (ADR-0001 §1, 2026-07-02). The store in this package speaks pure
// Postgres SQL (tsvector FTS, pgvector, `create extension`) and touches its connection through
// exactly this surface — so the SAME store runs on PGLite (embedded WASM Postgres: local dev,
// tests, CI-without-a-server) or on a real server cluster (sparkling, big stars, constellations).
// PGLite satisfies this interface STRUCTURALLY (it is the reference shape); postgres-driver.ts
// adapts node-postgres to it.
export interface PgQueryResult<T = unknown> {
  rows: T[];
  affectedRows?: number;
}

/** What a transaction callback receives — the store only ever calls query() inside one. */
export interface PgTx {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<PgQueryResult<T>>;
}

export interface PgDriver extends PgTx {
  /** DDL / multi-statement init. Return value is ignored. */
  exec(sql: string): Promise<unknown>;
  /** Run `cb` atomically. Matches PGLite's `Promise<T | undefined>` shape. */
  transaction<T>(cb: (tx: PgTx) => Promise<T>): Promise<T | undefined>;
  close(): Promise<void>;
}
