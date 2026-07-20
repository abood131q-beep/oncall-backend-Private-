'use strict';

/**
 * EventPublisher port (Phase 14.1 review #5) — the swappable publishing contract
 * the Application layer depends on, so the Domain/Application NEVER import a
 * concrete transport. The in-process `eventBus` is one adapter; a Kafka /
 * RabbitMQ / NATS adapter can be dropped in later WITHOUT touching domain or
 * use cases (ADR-006 §2 publisher independence).
 *
 * Contract:
 *   publish(event) → Promise<void>     // deliver/enqueue one DomainEvent
 *   subscribe(type, handler, opts?)    // optional for in-process adapters;
 *                                       // broker adapters may implement via consumers
 *
 * `assertPublisher` fails fast at composition time if an adapter is incomplete.
 */

function assertPublisher(pub, { requireSubscribe = false } = {}) {
  if (!pub || typeof pub.publish !== 'function') {
    throw new Error('EventPublisher: adapter must implement publish(event)');
  }
  if (requireSubscribe && typeof pub.subscribe !== 'function') {
    throw new Error('EventPublisher: adapter must implement subscribe(type, handler)');
  }
  return pub;
}

/**
 * A no-op publisher — the safe default when no backbone is wired (keeps the
 * platform byte-identical: publishing becomes an inert call).
 */
function createNullPublisher() {
  return {
    publish: () => Promise.resolve(),
    subscribe: () => () => {},
  };
}

module.exports = { assertPublisher, createNullPublisher };
