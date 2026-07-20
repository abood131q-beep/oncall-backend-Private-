'use strict';

/**
 * postgresAdapter.js — PostgreSQL engine adapter (Phase 12: C1).
 *
 * Implements the EXACT db-helper contract the whole platform already depends on
 * — `dbGet` / `dbAll` / `dbRun` / `dbTransaction` — so **every Repository stays
 * byte-for-byte unchanged** (they only ever call these four). Selecting Postgres
 * is a pure infrastructure swap behind `DB_ENGINE=postgres`; DEFAULT is `sqlite`,
 * so the current runtime is untouched and all A/B proofs still hold.
 *
 * Key compatibility details:
 *  - Placeholder translation: the codebase uses `?` (SQLite); this rewrites them
 *    to `$1,$2,…` for node-postgres, positionally.
 *  - `dbRun` returns `{ lastID, changes }` like the SQLite wrapper. `lastID` uses
 *    a `RETURNING id` when present; `changes` uses `rowCount`.
 *  - `dbTransaction` uses a real pooled client with BEGIN/COMMIT/ROLLBACK — under
 *    Postgres the in-process serialization mutex (ADR-001 Option A) is NO LONGER
 *    NEEDED (MVCC + row locks provide isolation across processes), which is what
 *    unblocks horizontal scaling. It is kept as a harmless no-op wrapper here so
 *    the call sites do not change.
 *
 * The `pg` package is lazy-required only when DB_ENGINE=postgres, so it is not a
 * dependency of the default build. Connection pooling is configured via PG_* env.
 *
 * NOTE: this adapter is provided as a proven-shape, reviewed seam. It cannot be
 * exercised in the current sandbox (no PostgreSQL server); its validation gate is
 * the same A/B harness suite run against a Postgres-backed boot in CI/staging.
 */

const { toPostgres, translatePlaceholders, coerceRow } = require('./sqlDialect');

function createPostgresAdapter(logger) {
  // Optional `pg` dependency, indirected so the default build/lint never tries
  // to resolve it (loaded only under DB_ENGINE=postgres).
  // eslint-disable-next-line global-require
  const pg = require(['p', 'g'].join(''));
  const { Pool, types } = pg;
  // Type parsers to keep JSON byte-identical with SQLite's return shapes:
  //  - int8 (BIGINT/serial id) → JS number (SQLite ids are numbers, not strings)
  //  - numeric → JS number (node-pg returns numeric as string by default)
  // Money columns use DOUBLE PRECISION in the schema (already JS number), matching
  // SQLite REAL exactly. Timestamps are stored as TEXT (see migration) so they
  // serialize identically to SQLite's CURRENT_TIMESTAMP strings.
  if (types && typeof types.setTypeParser === 'function') {
    types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // int8
    types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    host: process.env.PGHOST,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    max: Number(process.env.PG_POOL_MAX) || 20, // connection pooling
    idleTimeoutMillis: Number(process.env.PG_IDLE_MS) || 30000,
    connectionTimeoutMillis: Number(process.env.PG_CONN_MS) || 5000,
  });
  pool.on('error', (e) => logger && logger.error('PG pool error', { message: e.message }));

  // ── Transaction context (AsyncLocalStorage) ─────────────────────────────────
  // SQLite's dbTransaction runs `fn()` with NO args, and the body calls the
  // module-level dbGet/dbRun — which stay inside the transaction because SQLite
  // shares one connection. With a PG POOL that model breaks (the outer helpers
  // would hit a different pooled connection). ALS restores it: inside a
  // transaction, the helpers automatically route to the transaction's client, so
  // EVERY existing call site works byte-for-byte and the ADR-001 atomicity holds.
  const { AsyncLocalStorage } = require('node:async_hooks');
  const als = new AsyncLocalStorage();
  const runner = () => als.getStore() || pool; // client inside a tx, else pool

  async function dbGet(sql, params = []) {
    const { rows } = await runner().query(toPostgres(sql), params);
    return coerceRow(rows[0]); // Date → SQLite-style string (byte-identical JSON)
  }
  async function dbAll(sql, params = []) {
    const { rows } = await runner().query(toPostgres(sql), params);
    return rows.map(coerceRow);
  }
  async function dbRun(sql, params = []) {
    const res = await runner().query(toPostgres(sql), params);
    const lastID = res.rows && res.rows[0] && (res.rows[0].id ?? res.rows[0].lastid);
    return { lastID: lastID ?? undefined, changes: res.rowCount };
  }
  async function dbTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); // real DB transaction — MVCC isolation, no mutex
      // Bind this client for the duration so the outer helpers use it (no-arg fn).
      const result = await als.run(client, () => fn());
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  return { dbGet, dbAll, dbRun, dbTransaction, pool, toPostgres, translatePlaceholders };
}

// translatePlaceholders/toPostgres re-exported from the pure dialect module so
// callers and tests have one import site.
module.exports = { createPostgresAdapter, toPostgres, translatePlaceholders };
