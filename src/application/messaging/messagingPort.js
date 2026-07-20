'use strict';

/**
 * Messaging PORT (Phase 14.5 / ADR-024 §1) — the platform-wide messaging
 * abstraction every Platform Service and Extension depends on. Consumers see
 * only this contract, never the provider or engine internals:
 *
 *   publish(spec)      point-to-point / pub-sub delivery to a topic
 *   subscribe(spec)    register a handler (→ { id, unsubscribe() })
 *   unsubscribe(id)    remove a subscription
 *   request(spec)      request/reply — resolves with the reply payload
 *   reply(reqMsg, x)   resolve a pending request (called by a subscriber)
 *   broadcast(spec)    deliver to every subscriber of a topic
 *   health()           provider + metrics health
 *
 * `spec` is `{ topic, payload?, channel?, headers?, metadata?, priority?, ttlMs?,
 * group?, correlationId?, retryPolicy?, timeoutMs? }`.
 */

const METHODS = Object.freeze([
  'publish',
  'subscribe',
  'unsubscribe',
  'request',
  'reply',
  'broadcast',
  'health',
]);

function assertMessaging(m) {
  if (!m || typeof m !== 'object') throw new Error('Messaging: adapter required');
  for (const method of METHODS) {
    if (typeof m[method] !== 'function')
      throw new Error(`Messaging: adapter must implement ${method}()`);
  }
  return m;
}

module.exports = { assertMessaging, METHODS };
