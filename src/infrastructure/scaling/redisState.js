'use strict';

/**
 * redisState.js — Distributed-state seam (Phase 12 hardening: C2 + C3).
 *
 * STRICTLY OPTIONAL & DEFAULT-OFF. When `REDIS_URL` is unset (dev / single-node,
 * the current default) every function here is a safe no-op and the platform runs
 * EXACTLY as before — the in-memory Maps and the durable SQLite mirrors remain
 * the source of truth. This preserves byte-identical behavior and all A/B proofs.
 *
 * When `REDIS_URL` is set (multi-replica production), this module provides the
 * three cross-instance primitives the audit identified as missing:
 *   1. a shared cache client (distributed cache),
 *   2. a pub/sub channel to PROPAGATE token revocations across replicas
 *      (closing the cross-instance staleness window — see auth.js),
 *   3. the Socket.IO Redis adapter so events fan out across nodes (C3).
 *
 * The `redis` / `@socket.io/redis-adapter` packages are loaded LAZILY and only
 * when REDIS_URL is present, so they are NOT required for the default build/run
 * (keeping the dependency surface and the sandbox test path unchanged).
 */

const REDIS_URL = process.env.REDIS_URL || '';
let _pub = null;
let _sub = null;
let _enabled = false;

function isEnabled() {
  return _enabled;
}

/**
 * Initialize Redis clients if REDIS_URL is configured. No-op otherwise.
 * @param {object} logger
 * @returns {Promise<boolean>} whether Redis was activated
 */
async function initRedis(logger) {
  if (!REDIS_URL) return false;
  try {
    // Lazy, indirected require — only when explicitly configured. The optional
    // `redis` package is not a default dependency; the indirection keeps static
    // analysis from resolving it in the default build.
    // eslint-disable-next-line global-require
    const { createClient } = require(['re', 'dis'].join(''));
    _pub = createClient({ url: REDIS_URL });
    _sub = _pub.duplicate();
    _pub.on('error', (e) => logger && logger.error('Redis pub error', { message: e.message }));
    _sub.on('error', (e) => logger && logger.error('Redis sub error', { message: e.message }));
    await _pub.connect();
    await _sub.connect();
    _enabled = true;
    logger && logger.success('Redis connected — distributed state active (multi-replica ready)');
    return true;
  } catch (e) {
    // Fail OPEN to single-node behavior — never take the platform down over Redis.
    logger && logger.warn(`Redis init failed (${e.message}); falling back to single-node state`);
    _enabled = false;
    return false;
  }
}

/**
 * Attach the Socket.IO Redis adapter so events fan out across replicas (C3).
 * No-op when Redis is disabled. Lazy-requires the adapter package.
 */
async function attachSocketAdapter(io, logger) {
  if (!_enabled || !_pub || !_sub) return false;
  try {
    // eslint-disable-next-line global-require
    const { createAdapter } = require(['@socket.io', 'redis-adapter'].join('/'));
    io.adapter(createAdapter(_pub, _sub));
    logger && logger.success('Socket.IO Redis adapter attached — horizontal fan-out enabled');
    return true;
  } catch (e) {
    logger && logger.warn(`Socket.IO Redis adapter not attached (${e.message})`);
    return false;
  }
}

// ── Cross-instance revocation propagation (closes the staleness window) ───────
const REVOCATION_CHANNEL = 'oncall:revocations';

/** Publish a revocation event so every replica invalidates immediately. No-op if disabled. */
async function publishRevocation(phone, ts) {
  if (!_enabled || !_pub) return;
  try {
    await _pub.publish(REVOCATION_CHANNEL, JSON.stringify({ phone, ts }));
  } catch {
    /* best-effort; DB remains the durable source of truth */
  }
}

/** Subscribe to revocation events; `onRevoke(phone, ts)` updates the local cache. No-op if disabled. */
async function subscribeRevocations(onRevoke) {
  if (!_enabled || !_sub) return;
  try {
    await _sub.subscribe(REVOCATION_CHANNEL, (msg) => {
      try {
        const { phone, ts } = JSON.parse(msg);
        onRevoke(phone, ts);
      } catch {
        /* ignore malformed */
      }
    });
  } catch {
    /* best-effort */
  }
}

async function shutdown() {
  try {
    if (_pub) await _pub.quit();
    if (_sub) await _sub.quit();
  } catch {
    /* ignore */
  }
}

module.exports = {
  isEnabled,
  initRedis,
  attachSocketAdapter,
  publishRevocation,
  subscribeRevocations,
  shutdown,
  REVOCATION_CHANNEL,
};
