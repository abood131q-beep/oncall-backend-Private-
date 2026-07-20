'use strict';

/**
 * SQLite→PostgreSQL dialect translator tests (Phase 13).
 *
 * The dialect translator is the technical heart of "run on Postgres without
 * touching a query". It is a PURE function, so it is fully verifiable here
 * WITHOUT a live database — these tests exercise every rule against the ACTUAL
 * SQLite constructs surveyed in the codebase, so a regression in translation
 * fails CI immediately (the live-Postgres A/B is the complementary staging gate).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  toPostgres,
  translatePlaceholders,
  translateDatetime,
  translateStrftime,
  appendReturningId,
  formatSqliteDatetime,
  coerceRow,
} = require('../../src/infrastructure/db/sqlDialect');

// ── Placeholders ─────────────────────────────────────────────────────────────

test('placeholders: ? → $n, positional, string-literal safe', () => {
  assert.equal(
    translatePlaceholders('SELECT * FROM users WHERE phone = ? AND balance >= ?'),
    'SELECT * FROM users WHERE phone = $1 AND balance >= $2'
  );
  assert.equal(translatePlaceholders('INSERT INTO t VALUES (?,?,?)'), 'INSERT INTO t VALUES ($1,$2,$3)');
  // A literal '?' inside a string must NOT be renumbered
  assert.equal(
    translatePlaceholders("UPDATE t SET note = 'why?' WHERE id = ?"),
    "UPDATE t SET note = 'why?' WHERE id = $1"
  );
});

// ── datetime('now', …) ───────────────────────────────────────────────────────

test("datetime('now') and modifiers → Postgres timestamp expressions", () => {
  assert.equal(translateDatetime("datetime('now')"), 'NOW()');
  assert.equal(
    translateDatetime("created_at >= datetime('now','-7 days')"),
    "created_at >= (NOW() + INTERVAL '-7 days')"
  );
  assert.equal(
    translateDatetime("created_at >= datetime('now','-1 day')"),
    "created_at >= (NOW() + INTERVAL '-1 day')"
  );
  assert.equal(
    translateDatetime("created_at >= datetime('now','-30 days')"),
    "created_at >= (NOW() + INTERVAL '-30 days')"
  );
  assert.equal(
    translateDatetime("created_at >= datetime('now','start of day')"),
    "created_at >= date_trunc('day', NOW())"
  );
  // uppercase DATETIME (as used in DriverRepository/migrate)
  assert.equal(translateDatetime("DATETIME('now')"), 'NOW()');
});

// ── strftime ─────────────────────────────────────────────────────────────────

test('strftime patterns → to_char', () => {
  assert.equal(translateStrftime("strftime('%Y-%m', created_at)"), "to_char(created_at, 'YYYY-MM')");
  assert.equal(translateStrftime("strftime('%H', created_at)"), "to_char(created_at, 'HH24')");
});

// ── RETURNING id (lastID support) ────────────────────────────────────────────

test('appendReturningId: only for serial-id tables, not for phone-PK tables', () => {
  assert.equal(
    appendReturningId("INSERT INTO taxis (name, lat, lng, status) VALUES (?,?,?,?)"),
    "INSERT INTO taxis (name, lat, lng, status) VALUES (?,?,?,?) RETURNING id"
  );
  assert.equal(
    appendReturningId("INSERT INTO transactions (phone, type, amount) VALUES (?,?,?)"),
    "INSERT INTO transactions (phone, type, amount) VALUES (?,?,?) RETURNING id"
  );
  // phone-PK tables have no id column → must NOT append RETURNING id
  assert.equal(
    appendReturningId('INSERT INTO revoked_tokens (phone, revoked_at) VALUES (?, ?)'),
    'INSERT INTO revoked_tokens (phone, revoked_at) VALUES (?, ?)'
  );
  assert.equal(
    appendReturningId('INSERT INTO rate_limit_locks (phone, locked_until) VALUES (?, ?)'),
    'INSERT INTO rate_limit_locks (phone, locked_until) VALUES (?, ?)'
  );
  // already has RETURNING → unchanged
  assert.equal(
    appendReturningId('INSERT INTO users (phone) VALUES (?) RETURNING id'),
    'INSERT INTO users (phone) VALUES (?) RETURNING id'
  );
  // non-INSERT → unchanged
  assert.equal(appendReturningId('UPDATE users SET name = ? WHERE phone = ?'), 'UPDATE users SET name = ? WHERE phone = ?');
});

// ── Full pipeline on real queries from the codebase ──────────────────────────

test('toPostgres: composed translation on a real INSERT (RETURNING + $n)', () => {
  assert.equal(
    toPostgres('INSERT INTO taxis (name, lat, lng, status) VALUES (?,?,?,?)'),
    'INSERT INTO taxis (name, lat, lng, status) VALUES ($1,$2,$3,$4) RETURNING id'
  );
});

test('toPostgres: real analytics query (datetime + placeholders together)', () => {
  const sqlite = "SELECT COUNT(*) as c FROM trips WHERE status = ? AND created_at >= datetime('now','-7 days')";
  assert.equal(
    toPostgres(sqlite),
    "SELECT COUNT(*) as c FROM trips WHERE status = $1 AND created_at >= (NOW() + INTERVAL '-7 days')"
  );
});

test('toPostgres: ON CONFLICT / excluded / CURRENT_TIMESTAMP pass through unchanged', () => {
  const sql =
    'INSERT INTO revoked_tokens (phone, revoked_at) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET revoked_at = excluded.revoked_at';
  assert.equal(
    toPostgres(sql),
    'INSERT INTO revoked_tokens (phone, revoked_at) VALUES ($1, $2) ON CONFLICT(phone) DO UPDATE SET revoked_at = excluded.revoked_at'
  );
});

// ── Result coercion (byte-identical JSON) ────────────────────────────────────

test('formatSqliteDatetime: Date → SQLite CURRENT_TIMESTAMP text shape', () => {
  const d = new Date('2026-07-20T17:19:59.000Z');
  assert.equal(formatSqliteDatetime(d), '2026-07-20 17:19:59');
  assert.equal(formatSqliteDatetime('already a string'), 'already a string');
  assert.equal(formatSqliteDatetime(null), null);
});

test('coerceRow: converts Date columns, leaves numbers/strings/ints untouched', () => {
  const row = {
    id: 7,
    phone: '55501234',
    balance: 12.5, // stays a JS number (DOUBLE PRECISION)
    is_active: 1, // stays 0/1 integer, NOT boolean
    created_at: new Date('2026-07-20T17:19:59.000Z'),
  };
  assert.deepEqual(coerceRow(row), {
    id: 7,
    phone: '55501234',
    balance: 12.5,
    is_active: 1,
    created_at: '2026-07-20 17:19:59',
  });
  assert.equal(coerceRow(undefined), undefined);
});
