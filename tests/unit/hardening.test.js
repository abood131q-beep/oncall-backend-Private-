'use strict';

/**
 * Phase 12 hardening tests — verify the NEW production-hardening modules behave
 * correctly and, crucially, that they are DEFAULT-OFF no-ops (so existing
 * behavior and all A/B contracts are preserved). Pure/unit level — no external
 * Redis/Postgres required.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { validate } = require('../../src/shared/validate');
const { translatePlaceholders } = require('../../src/infrastructure/db/postgresAdapter');
const { runFileMigrations, versionOf } = require('../../src/infrastructure/db/migrator');
const redisState = require('../../src/infrastructure/scaling/redisState');
const {
  createPaymentGatewayProvider,
} = require('../../src/infrastructure/payments/paymentGatewayProvider');

// ── C7: validation helper ────────────────────────────────────────────────────

test('validate enforces required, types, ranges, enum', () => {
  const schema = {
    amount: { type: 'number', required: true, min: 0.001, max: 500 },
    method: { type: 'string', enum: ['cash', 'wallet', 'knet'] },
    phone: { type: 'phone', required: true },
  };
  assert.equal(validate({}, schema).ok, false);
  assert.equal(validate({ amount: 5, phone: '55501234' }, schema).ok, true);
  assert.equal(validate({ amount: 501, phone: '55501234' }, schema).ok, false);
  assert.equal(validate({ amount: 5, phone: 'abc' }, schema).ok, false);
  assert.equal(validate({ amount: 5, phone: '55501234', method: 'btc' }, schema).ok, false);
  const okv = validate({ amount: '12.5', phone: '55501234' }, schema);
  assert.equal(okv.ok, true);
  assert.equal(okv.value.amount, 12.5); // coerced to number
});

// ── C1: Postgres placeholder translation (pure, testable without a DB) ───────

test('translatePlaceholders rewrites ? to positional $n', () => {
  assert.equal(
    translatePlaceholders('SELECT * FROM t WHERE a = ? AND b = ?'),
    'SELECT * FROM t WHERE a = $1 AND b = $2'
  );
  assert.equal(
    translatePlaceholders('INSERT INTO t VALUES (?,?,?)'),
    'INSERT INTO t VALUES ($1,$2,$3)'
  );
  assert.equal(translatePlaceholders('SELECT 1'), 'SELECT 1');
});

// ── C1: versioned migration runner (drives fake db helpers, once-each) ───────

test('runFileMigrations applies each migration once and records versions', async () => {
  assert.equal(versionOf('0007_add_index.sql'), '0007');
  const applied = new Set();
  const seen = new Set();
  const fake = {
    dbRun: async (sql, params) => {
      if (/INSERT INTO schema_migrations/.test(sql)) {
        seen.add(params[0]);
        applied.add(params[0]);
      }
      return { changes: 1 };
    },
    dbGet: async (sql, params) =>
      /SELECT version/.test(sql) && seen.has(params[0]) ? { version: params[0] } : undefined,
    engine: 'sqlite',
  };
  const first = await runFileMigrations(fake);
  assert.ok(first.applied >= 1, 'baseline applied on first run');
  const second = await runFileMigrations(fake); // idempotent
  assert.equal(second.applied, 0, 'nothing re-applied on second run');
});

// ── C2/C3: Redis seam is a no-op when REDIS_URL is unset ─────────────────────

test('redisState is disabled and safe (no-op) without REDIS_URL', async () => {
  assert.equal(redisState.isEnabled(), false);
  // all methods must be safe to call while disabled
  assert.equal(await redisState.initRedis(null), false);
  assert.equal(await redisState.attachSocketAdapter({}, null), false);
  await redisState.publishRevocation('55501234', 123); // no throw
  await redisState.subscribeRevocations(() => {}); // no throw
  assert.equal(redisState.isEnabled(), false);
});

// ── C4: payment gateway provider preserves the disabled 503 posture ──────────

test('paymentGatewayProvider mirrors the legacy posture; authorizeCharge guarded', async () => {
  const disabled = createPaymentGatewayProvider({ PAYMENT_ENABLED: false });
  assert.equal(disabled.isEnabled(), false); // ⇒ /wallet/charge stays 503
  assert.equal(disabled.listMethods().length, 5);
  const enabled = createPaymentGatewayProvider({ PAYMENT_ENABLED: true });
  assert.equal(enabled.isEnabled(), true);
  // no provider configured ⇒ authorizeCharge refuses (never silently charges)
  assert.deepEqual(await enabled.authorizeCharge({ idempotencyKey: 'k1', amount: 5 }), {
    ok: false,
    code: 'PROVIDER_UNAVAILABLE',
  });
});
