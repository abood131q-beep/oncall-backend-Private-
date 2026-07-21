'use strict';

/**
 * Memory notification provider (Phase 15.1 / ADR-030 §4) — in-process delivery.
 * Records every delivered notification and returns a deterministic outcome. It is
 * DELIVERY ONLY — no routing, scheduling, retry, dedup, expiration, or lifecycle
 * (all owned by the engine). The seam a future FCM / APNs / Twilio / email /
 * webhook adapter slots behind. Supports injectable failure for retry / failure
 * tests: `failTimes` fails the first N attempts per notification (then succeeds);
 * `fail: true` always fails.
 */

function createMemoryProvider(opts = {}) {
  const deliveries = [];
  const supported = Array.isArray(opts.channels) ? new Set(opts.channels) : null; // null = all
  const failTimes = opts.failTimes || 0;
  const alwaysFail = Boolean(opts.fail);
  const _attempts = new Map(); // notificationId -> count

  let _seq = 0;
  const providerName = opts.name || 'memory';

  return {
    name: providerName,
    deliveries,
    supports(channel) {
      return supported ? supported.has(channel) : true;
    },
    deliver(model) {
      const seen = (_attempts.get(model.notificationId) || 0) + 1;
      _attempts.set(model.notificationId, seen);
      if (alwaysFail) {
        return Promise.resolve({ ok: false, reason: 'memory: forced failure' });
      }
      if (failTimes && seen <= failTimes) {
        return Promise.resolve({ ok: false, reason: `memory: transient failure ${seen}` });
      }
      _seq += 1;
      const providerId = `${providerName}-${_seq}`;
      deliveries.push({
        providerId,
        notificationId: model.notificationId,
        channel: model.channel,
        recipient: model.recipient,
        at: model.updatedAt,
      });
      return Promise.resolve({ ok: true, providerId });
    },
    health() {
      return { ok: true, provider: providerName, delivered: deliveries.length };
    },
  };
}

module.exports = { createMemoryProvider };
