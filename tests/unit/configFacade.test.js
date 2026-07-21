'use strict';

/**
 * configFacade.test.js — Phase 18.3
 * Proves the Runtime Configuration Read Facade is behavior-identical to env.js:
 * every value returned by the facade is the exact (===) typed value env.js exports,
 * presence/keys agree, and fail-fast semantics hold. sqlite-free (pure module test).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Ensure env.js can load in the test sandbox (it fail-fasts on a missing JWT_SECRET).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-config-facade';

const env = require('../../src/config/env');
const config = require('../../src/config');

test('get() returns the exact typed value env.js exports, for every key', () => {
  for (const key of Object.keys(env)) {
    assert.equal(config.get(key), env[key], `mismatch for key ${key}`);
  }
});

test('get() preserves value TYPES (no stringification/coercion)', () => {
  for (const key of Object.keys(env)) {
    assert.equal(typeof config.get(key), typeof env[key], `type drift for ${key}`);
  }
  // arrays/objects returned by reference-identity (no copying in the hot path)
  for (const key of Object.keys(env)) {
    if (env[key] && typeof env[key] === 'object') {
      assert.equal(config.get(key), env[key], `reference drift for ${key}`);
    }
  }
});

test('get() returns the fallback (default undefined) for absent keys', () => {
  const absent = '__DEFINITELY_NOT_A_CONFIG_KEY__';
  assert.equal(config.has(absent), false);
  assert.equal(config.get(absent), undefined);
  assert.equal(config.get(absent, 'fb'), 'fb');
});

test('require() returns present values and THROWS for absent (fail-fast)', () => {
  const present = Object.keys(env)[0];
  assert.equal(config.require(present), env[present]);
  assert.throws(() => config.require('__NOPE__'), /required key "__NOPE__" is missing/);
});

test('keys()/has() agree with env.js surface exactly', () => {
  assert.deepEqual(new Set(config.keys()), new Set(Object.keys(env)));
  for (const key of Object.keys(env)) assert.equal(config.has(key), true);
});

test('all() is a shallow copy equal to env.js (not the same object)', () => {
  const snap = config.all();
  assert.deepEqual(snap, { ...env });
  assert.notEqual(snap, env);
});

test('backing source is env.js when CONFIG_AUTHORITATIVE is off (default)', () => {
  // With the flag unset (default in this test process), the facade is the legacy passthrough.
  assert.equal(config._source(), 'env.js');
  assert.equal(config.mode(), 'legacy');
});
