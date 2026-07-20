'use strict';

/**
 * sqlDialect.js — SQLite → PostgreSQL query dialect translator (Commerce-grade,
 * PURE, fully unit-testable without a live database).
 *
 * The whole platform speaks one SQL dialect (SQLite) through four helpers
 * (dbGet/dbAll/dbRun/dbTransaction). To run on PostgreSQL WITHOUT touching a
 * single repository or query string, this module rewrites the handful of
 * SQLite-specific constructs the codebase actually uses into their Postgres
 * equivalents — verified by a survey of the real queries:
 *
 *   1. `?` placeholders            → `$1, $2, …` (positional)
 *   2. `datetime('now', mod)`      → `NOW()` / `NOW() ± INTERVAL '…'` / date_trunc
 *   3. `DATETIME('now')`           → `NOW()`  (case-insensitive)
 *   4. `strftime('%Y-%m', c)`      → `to_char(c, 'YYYY-MM')`; `%H` → `HH24`
 *   5. INSERT lastID               → append `RETURNING id` for tables with a
 *                                     serial `id` PK (so dbRun can report lastID)
 *
 * NOT rewritten because they are ALREADY Postgres-compatible (confirmed by the
 * survey): `ON CONFLICT (…) DO UPDATE/NOTHING`, `excluded.*`, `CURRENT_TIMESTAMP`,
 * `COUNT/SUM/AVG`, `CASE WHEN`, `LIMIT ?`. No `INSERT OR IGNORE/REPLACE` exists in
 * the codebase (it already uses `ON CONFLICT`).
 *
 * Every rule below maps to a construct proven present in the repository; nothing
 * speculative is added.
 */

// Tables with a serial `id` PK — an INSERT into these can report lastID via
// RETURNING id. Tables keyed by (phone) or composite PK are intentionally
// excluded so we never append an invalid RETURNING.
const TABLES_WITH_ID = new Set([
  'users',
  'drivers',
  'scooters',
  'taxis',
  'trips',
  'wallets',
  'transactions',
  'login_logs',
  'notifications',
  'reports',
  'scooter_rides',
  'device_tokens',
  'refresh_tokens',
  'driver_approval_logs',
]);

/** `?` → `$1,$2,…` (skips `?` inside single-quoted string literals). */
function translatePlaceholders(sql) {
  let i = 0;
  let inString = false;
  let out = '';
  for (let c = 0; c < sql.length; c++) {
    const ch = sql[c];
    if (ch === "'") inString = !inString;
    if (ch === '?' && !inString) {
      out += `$${++i}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Translate `datetime('now', modifiers…)` into a Postgres timestamp expression. */
function translateDatetime(sql) {
  return sql.replace(/datetime\(\s*'now'\s*((?:,\s*'[^']*'\s*)*)\)/gi, (_m, modsRaw) => {
    const mods = [...modsRaw.matchAll(/'([^']*)'/g)].map((x) => x[1].trim().toLowerCase());
    let expr = 'NOW()';
    for (const mod of mods) {
      if (mod === 'start of day') {
        expr = `date_trunc('day', ${expr})`;
      } else {
        // e.g. "-7 days", "-1 day", "-30 days", "+1 hour" — keep the unit verbatim
        const m = /^([+-]?\d+)\s+(seconds?|minutes?|hours?|days?|months?|years?)$/.exec(mod);
        if (m) {
          const n = m[1].startsWith('-') || m[1].startsWith('+') ? m[1] : `+${m[1]}`;
          expr = `(${expr} + INTERVAL '${n} ${m[2]}')`;
        }
      }
    }
    return expr;
  });
}

/** Translate the two strftime patterns the codebase uses. */
function translateStrftime(sql) {
  return sql.replace(/strftime\(\s*'([^']*)'\s*,\s*([^)]+)\)/gi, (_m, fmt, col) => {
    const pgFmt = fmt
      .replace(/%Y/g, 'YYYY')
      .replace(/%m/g, 'MM')
      .replace(/%H/g, 'HH24')
      .replace(/%d/g, 'DD');
    return `to_char(${col.trim()}, '${pgFmt}')`;
  });
}

/** If this is an INSERT into a serial-id table without RETURNING, append it. */
function appendReturningId(sql) {
  const trimmed = sql.trim();
  if (!/^insert\s+into/i.test(trimmed)) return sql;
  if (/returning\s+/i.test(trimmed)) return sql;
  const m = /^insert\s+into\s+["']?(\w+)["']?/i.exec(trimmed);
  if (!m || !TABLES_WITH_ID.has(m[1].toLowerCase())) return sql;
  return `${trimmed.replace(/;\s*$/, '')} RETURNING id`;
}

/**
 * Full translation pipeline. Order matters: datetime/strftime BEFORE placeholder
 * numbering (they contain no `?`), RETURNING before placeholders is irrelevant.
 */
function toPostgres(sql) {
  let out = sql;
  out = translateDatetime(out);
  out = translateStrftime(out);
  out = appendReturningId(out);
  out = translatePlaceholders(out);
  return out;
}

/**
 * Format a PG timestamptz (returned by node-postgres as a JS Date) into SQLite's
 * `CURRENT_TIMESTAMP` text shape `YYYY-MM-DD HH:MM:SS` (UTC) so JSON is identical.
 */
function formatSqliteDatetime(value) {
  if (!(value instanceof Date)) return value;
  return value.toISOString().replace('T', ' ').slice(0, 19);
}

/** Coerce a result row's Date values to SQLite-style strings (byte-identity). */
function coerceRow(row) {
  if (!row || typeof row !== 'object') return row;
  for (const k of Object.keys(row)) {
    if (row[k] instanceof Date) row[k] = formatSqliteDatetime(row[k]);
  }
  return row;
}

module.exports = {
  toPostgres,
  translatePlaceholders,
  translateDatetime,
  translateStrftime,
  appendReturningId,
  formatSqliteDatetime,
  coerceRow,
  TABLES_WITH_ID,
};
