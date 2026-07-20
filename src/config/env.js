'use strict';

/**
 * env.js — OnCall Environment Configuration
 *
 * Single source of truth for ALL environment variables.
 * Must be required FIRST in server.js before any other module.
 *
 * Usage:
 *   const { JWT_SECRET, PORT, ... } = require('./src/config/env');
 *
 * Variables exported:
 *   Core:      JWT_SECRET, ADMIN_PHONES, PORT, NODE_ENV, IS_PRODUCTION
 *   Auth:      REQUIRE_OTP
 *   SMS:       SMS_PROVIDER, SMS_API_KEY, SMS_FROM, SMS_ACCOUNT_SID
 *   Maps:      GOOGLE_MAPS_API_KEY
 *   Firebase:  FIREBASE_SERVICE_ACCOUNT, FIREBASE_PROJECT_ID
 *   Payment:   PAYMENT_ENABLED
 *   Network:   SOCKET_CORS_ORIGIN, ALLOWED_ORIGINS
 *   Logging:   LOG_LEVEL
 *   System:    TZ, DB_PATH
 *
 * P6-04D: Production Safety Guards
 * P6-05B: Unified env management — single source of truth
 */

const fs = require('fs');
const path = require('path');

// ─── Load .env from project root ──────────────────────────────────────────────
const envPath = path.join(__dirname, '..', '..', '.env');
try {
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8')
      .split('\n')
      .forEach((line) => {
        const trimmed = line.trim();
        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith('#')) return;
        const [key, ...val] = trimmed.split('=');
        if (key && val.length) {
          // Strip surrounding quotes (single or double) — standard .env behaviour
          process.env[key.trim()] = val
            .join('=')
            .trim()
            .replace(/^["'](.*)["']$/, '$1');
        }
      });
  }
} catch (_) {
  /* ignore — process.env remains as-is (CI/Docker inject vars directly) */
}

// ─── Required: JWT_SECRET ─────────────────────────────────────────────────────
if (!process.env.JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET is required in .env file');
  console.error('   Run: echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env');
  process.exit(1);
}

// ─── Computed base values ─────────────────────────────────────────────────────
const IS_PRODUCTION = (process.env.NODE_ENV || 'development') === 'production';
const SMS_PROVIDER = (process.env.SMS_PROVIDER || 'console').toLowerCase().trim();
const REQUIRE_OTP = process.env.REQUIRE_OTP === 'true';
const SMS_API_KEY = process.env.SMS_API_KEY || '';

// ─── LOG_LEVEL validation ─────────────────────────────────────────────────────
// Valid values: DEBUG | INFO | WARN | ERROR
// Normalised value is written back to process.env so logger.js picks it up
// without needing to import env.js (avoids circular-dependency risk in tests).
const _VALID_LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
const _rawLogLevel = (process.env.LOG_LEVEL || 'INFO').toUpperCase();
const LOG_LEVEL = _VALID_LOG_LEVELS.includes(_rawLogLevel) ? _rawLogLevel : 'INFO';
process.env.LOG_LEVEL = LOG_LEVEL; // normalise in-place for logger.js

// ─── ALLOWED_ORIGINS (HTTP CORS) ─────────────────────────────────────────────
// Comma-separated production domains, e.g. https://admin.oncall.app
// In development: leave unset — localhost is always allowed by setup.js.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// ─── Firebase Service Account ─────────────────────────────────────────────────
// Accepts raw JSON or base64-encoded JSON (use base64 to avoid multi-line issues).
let FIREBASE_SERVICE_ACCOUNT = null;
const _rawFirebase = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (_rawFirebase) {
  try {
    const json = _rawFirebase.trimStart().startsWith('{')
      ? _rawFirebase
      : Buffer.from(_rawFirebase, 'base64').toString('utf8');
    FIREBASE_SERVICE_ACCOUNT = JSON.parse(json);
  } catch {
    console.warn(
      '⚠️  WARNING [P6-05B]: FIREBASE_SERVICE_ACCOUNT_JSON is set but could not be parsed — Push Notifications disabled'
    );
  }
}
const FIREBASE_PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID || FIREBASE_SERVICE_ACCOUNT?.project_id || '';

// ─── P6-04D: Production Safety Guards (process.exit) ─────────────────────────
if (IS_PRODUCTION) {
  if (SMS_PROVIDER === 'console') {
    console.error('');
    console.error('❌ FATAL [P6-04]: SMS_PROVIDER=console is not allowed in production.');
    console.error('   OTP codes would never reach users — all logins would fail silently.');
    console.error('   Action: Set SMS_PROVIDER=unifonic or SMS_PROVIDER=twilio in .env');
    console.error('');
    process.exit(1);
  }
  if (!REQUIRE_OTP) {
    console.error('');
    console.error('❌ FATAL [P6-04]: REQUIRE_OTP must be "true" in production.');
    console.error('   Running without OTP in production bypasses phone verification entirely.');
    console.error('   Action: Set REQUIRE_OTP=true in .env');
    console.error('');
    process.exit(1);
  }
  // P6-05B: SMS credentials check — catches mis-configured providers at startup
  if (!SMS_API_KEY) {
    console.error('');
    console.error(`❌ FATAL [P6-05B]: SMS_PROVIDER=${SMS_PROVIDER} requires SMS_API_KEY in .env`);
    console.error('   Without it, all OTP sends will fail at runtime.');
    console.error('');
    process.exit(1);
  }
}

// ─── P6-05B: Non-fatal startup warnings ──────────────────────────────────────
if (IS_PRODUCTION) {
  if ((process.env.SOCKET_CORS_ORIGIN || '*') === '*') {
    console.warn(
      '⚠️  WARNING [P6-05B]: SOCKET_CORS_ORIGIN=* allows all WebSocket origins in production.'
    );
    console.warn('   For admin web dashboards: set SOCKET_CORS_ORIGIN=https://your-domain.com');
  }
  if (ALLOWED_ORIGINS.length === 0) {
    console.warn(
      '⚠️  WARNING [P6-05B]: ALLOWED_ORIGINS not set — HTTP CORS limited to localhost only.'
    );
    console.warn('   Flutter mobile apps are unaffected. Admin web dashboards may be blocked.');
    console.warn('   Action: Set ALLOWED_ORIGINS=https://your-domain.com in .env');
  }
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.warn(
      '⚠️  WARNING [P6-05B]: GOOGLE_MAPS_API_KEY not set — Places autocomplete disabled.'
    );
  }
  if (!FIREBASE_SERVICE_ACCOUNT) {
    console.warn(
      '⚠️  WARNING [P6-05B]: FIREBASE_SERVICE_ACCOUNT_JSON not set — Push Notifications disabled.'
    );
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  // Core
  JWT_SECRET: process.env.JWT_SECRET,
  ADMIN_PHONES: (process.env.ADMIN_PHONES || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean),
  PORT: parseInt(process.env.PORT, 10) || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  IS_PRODUCTION,

  // Auth
  REQUIRE_OTP,

  // SMS
  SMS_PROVIDER,
  SMS_API_KEY,
  SMS_FROM: process.env.SMS_FROM || 'OnCall',
  SMS_ACCOUNT_SID: process.env.SMS_ACCOUNT_SID || '',

  // Maps
  GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY || '',

  // Firebase
  FIREBASE_SERVICE_ACCOUNT, // parsed JSON object or null
  FIREBASE_PROJECT_ID,

  // Payment
  PAYMENT_ENABLED: process.env.PAYMENT_ENABLED === 'true',

  // Network
  SOCKET_CORS_ORIGIN: process.env.SOCKET_CORS_ORIGIN || '*',
  ALLOWED_ORIGINS, // string[] for HTTP CORS allow-list

  // Logging
  LOG_LEVEL,

  // System
  TZ: process.env.TZ || '',
  DB_PATH: process.env.DB_PATH || './oncall.db',

  // Phase 12 hardening (all OPTIONAL; defaults preserve single-node behavior)
  DB_ENGINE: process.env.DB_ENGINE || 'sqlite', // 'sqlite' (default) | 'postgres'
  REDIS_URL: process.env.REDIS_URL || '', // unset ⇒ single-node in-memory state
  METRICS_TOKEN: process.env.METRICS_TOKEN || '', // bearer to guard /metrics in prod
  PAYMENT_PROVIDER: process.env.PAYMENT_PROVIDER || '', // named gateway provider, if any
  WAL_CHECKPOINT_MS: Number(process.env.WAL_CHECKPOINT_MS) || 300000,
};
