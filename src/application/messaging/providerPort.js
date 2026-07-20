'use strict';

/**
 * MessagingProvider PORT (Phase 14.5 / ADR-024 §4) — the transport contract the
 * Messaging Kernel depends on. Business logic NEVER knows which provider is
 * active; it depends only on the Messaging service, which depends only on this
 * port. Providers own subscriber registration + fan-out/group selection (as a
 * broker would); delivery-model policy, retry, TTL, DLQ, events, and metrics
 * live in the SERVICE. NOT tied to any broker.
 *
 * Contract:
 *   name
 *   subscribe(topic, handler, { group?, id? }) → { id, topic, group }
 *   unsubscribe(id) → boolean
 *   select(topic) → [{ id, group, handler }]
 *       // ONE member per group (competing consumers); each distinct group is
 *       // represented (pub/sub across groups). Round-robin within a group.
 *   selectAll(topic) → [{ id, group, handler }]   // EVERY subscriber (broadcast)
 *   subscriberCount(topic?) → number
 *   health() → { ok, ... }
 *
 * The provider owns the subscriber registry + selection; the SERVICE invokes the
 * returned handlers and layers delivery policy (retry, TTL, DLQ, events).
 */

const METHODS = Object.freeze([
  'subscribe',
  'unsubscribe',
  'select',
  'selectAll',
  'subscriberCount',
  'health',
]);

function assertProvider(p) {
  if (!p || typeof p.name !== 'string' || !p.name) {
    throw new Error('MessagingProvider: adapter must expose a name');
  }
  for (const m of METHODS) {
    if (typeof p[m] !== 'function')
      throw new Error(`MessagingProvider: adapter must implement ${m}()`);
  }
  return p;
}

/** Extension points for FUTURE providers (§4). Declared, not implemented. */
const FUTURE_PROVIDERS = Object.freeze([
  'kafka',
  'rabbitmq',
  'nats',
  'redis-streams',
  'azure-service-bus',
  'google-pubsub',
  'amazon-sqs-sns',
]);

function futureProvider(name) {
  if (!FUTURE_PROVIDERS.includes(name)) {
    throw new Error(`messaging: "${name}" is not a recognized future provider`);
  }
  const notImpl = () => {
    throw new Error(
      `messaging provider "${name}" is an extension point — not implemented in Phase 14.5`
    );
  };
  return {
    name,
    planned: true,
    subscribe: notImpl,
    unsubscribe: () => false,
    select: notImpl,
    selectAll: notImpl,
    subscriberCount: () => 0,
    health: () => ({ ok: false, reason: 'not-implemented' }),
  };
}

module.exports = { assertProvider, METHODS, FUTURE_PROVIDERS, futureProvider };
