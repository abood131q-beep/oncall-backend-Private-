'use strict';

/**
 * Message (Phase 14.5 / ADR-024 §2) — PURE domain value object, provider-agnostic
 * (NOT a Kafka/Rabbit record). The unit every provider transports.
 *
 * Envelope:
 *   { messageId, correlationId, conversationId, headers, payload, metadata,
 *     priority, ttlMs, expiresAt, topic, channel, timestamp, version }
 *
 * Delivery kinds are the service's concern; the message only carries data +
 * routing/ordering hints (topic, channel, priority, ttl, correlation).
 */

const { MessageValidationError } = require('./errors');

const PRIORITY = Object.freeze({ low: 10, normal: 20, high: 30, critical: 40 });

let _seq = 0;
function defaultId() {
  _seq = (_seq + 1) % 1e6;
  return `msg_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

/**
 * @param {object} spec { topic (required), payload, channel?, headers?, metadata?,
 *   priority?, ttlMs?, correlationId?, conversationId?, messageId?, version? }
 * @param {object} [opts] { clock, idFactory }
 */
function createMessage(spec = {}, opts = {}) {
  const clock = opts.clock || (() => Date.now());
  const idFactory = opts.idFactory || defaultId;
  if (!spec.topic || typeof spec.topic !== 'string') {
    throw new MessageValidationError('message: "topic" is required');
  }
  const now = clock();
  const priority =
    typeof spec.priority === 'number' ? spec.priority : PRIORITY[spec.priority] || PRIORITY.normal;
  const ttlMs = typeof spec.ttlMs === 'number' && spec.ttlMs > 0 ? spec.ttlMs : null;
  const messageId = spec.messageId || idFactory();
  return {
    messageId,
    correlationId: spec.correlationId || messageId, // root correlates to itself
    conversationId: spec.conversationId || null,
    headers: { ...(spec.headers || {}) },
    payload: spec.payload === undefined ? null : spec.payload,
    metadata: { ...(spec.metadata || {}) },
    priority,
    ttlMs,
    topic: spec.topic,
    channel: spec.channel || 'default',
    timestamp: now,
    // Explicit expiresAt overrides ttl (useful for scheduled/re-hydrated messages).
    expiresAt: typeof spec.expiresAt === 'number' ? spec.expiresAt : ttlMs ? now + ttlMs : null,
    version: spec.version || 1,
  };
}

function isExpired(message, now) {
  return Boolean(message && message.expiresAt != null && message.expiresAt <= now);
}

/** A child message that continues a conversation, propagating correlation. */
function reto(parent, spec, opts = {}) {
  return createMessage(
    {
      ...spec,
      correlationId: parent.correlationId || parent.messageId,
      conversationId: parent.conversationId || parent.messageId,
    },
    opts
  );
}

function toModel(m) {
  return {
    messageId: m.messageId,
    correlationId: m.correlationId,
    conversationId: m.conversationId,
    headers: { ...m.headers },
    payload: m.payload,
    metadata: { ...m.metadata },
    priority: m.priority,
    ttlMs: m.ttlMs,
    topic: m.topic,
    channel: m.channel,
    timestamp: m.timestamp,
    expiresAt: m.expiresAt,
    version: m.version,
  };
}

module.exports = { createMessage, isExpired, reto, toModel, PRIORITY };
