'use strict';

/**
 * Messaging Service (Phase 14.5 / ADR-024) — the Messaging Kernel. A
 * platform-wide messaging abstraction over any transport (NOT Kafka/Rabbit/NATS,
 * NOT a queue library). In-process by default; no broker dependency.
 *
 * Delivery models: point-to-point (consumer group), publish/subscribe (distinct
 * groups), broadcast (all subscribers), request/reply (correlation), with retry,
 * TTL expiration, dead-letter, and an acknowledgement abstraction (a handler that
 * resolves = ack, throws = nack → retry/DLQ). Lifecycle events flow ONLY through
 * the EventPublisher port. Fully dependency-injected and deterministic.
 */

const { createMessage, isExpired, toModel } = require('../../domain/messaging/message');
const { NoSubscriberError, RequestTimeoutError } = require('../../domain/messaging/errors');
const { MESSAGING_EVENTS, createMessagingEvent } = require('../../domain/messaging/events');
const { assertProvider } = require('./providerPort');
const { createNullPublisher } = require('../shared/eventPublisher');

function createMessagingService(deps = {}) {
  const provider = assertProvider(deps.provider);
  const publisher = deps.publisher || createNullPublisher();
  const metrics = deps.metrics || null;
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { warn() {}, error() {}, info() {} };
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const setTimeoutImpl = deps.setTimeoutImpl || setTimeout;
  const clearTimeoutImpl = deps.clearTimeoutImpl || clearTimeout;
  const defaultRetry = deps.retryPolicy || { maxAttempts: 0, delayMs: 0 };

  const _dlq = [];
  const _pending = new Map(); // correlationId -> { resolve, reject, timer }
  let _inFlight = 0;

  if (metrics && metrics.bindGauges) {
    metrics.bindGauges({
      subscribers: () => provider.subscriberCount(),
      queueDepth: () => _inFlight,
    });
  }

  function _policy(opts) {
    const p = (opts && opts.retryPolicy) || defaultRetry;
    return {
      maxAttempts: Number.isInteger(p.maxAttempts) ? p.maxAttempts : 0,
      delayMs: typeof p.delayMs === 'number' ? p.delayMs : 0,
    };
  }

  function _emit(type, message, extra = {}) {
    try {
      const event = createMessagingEvent(
        type,
        {
          messageId: message.messageId,
          topic: message.topic,
          channel: message.channel,
          correlationId: message.correlationId,
          ...extra,
        },
        { clock: () => new Date(clock()) }
      );
      Promise.resolve(publisher.publish(event)).catch((e) =>
        log.error('messaging: event publish failed', e.message)
      );
    } catch (e) {
      log.error('messaging: could not build event', e.message);
    }
  }

  function _deadLetter(message, target, reason) {
    _dlq.push({ message: toModel(message), subscriber: target && target.id, reason, at: clock() });
    if (metrics) metrics.recordDeadLetter();
    _emit(MESSAGING_EVENTS.DEAD_LETTERED, message, { subscriber: target && target.id, reason });
  }

  /** Invoke one target handler with retry; returns true on ack, false on DLQ. */
  async function _invokeWithRetry(target, message, opts) {
    const policy = _policy(opts);
    let attempt = 0;
    for (;;) {
      const start = clock();
      try {
        await target.handler(message);
        if (metrics) {
          metrics.recordDelivered(1);
          metrics.recordDeliveryLatency(clock() - start);
        }
        _emit(MESSAGING_EVENTS.DELIVERED, message, { subscriber: target.id });
        return true;
      } catch (err) {
        if (metrics) metrics.recordFailed(1);
        if (attempt < policy.maxAttempts) {
          attempt += 1;
          if (metrics) metrics.recordRetry();
          _emit(MESSAGING_EVENTS.RETRIED, message, { subscriber: target.id, attempt });
          if (policy.delayMs > 0) await sleep(policy.delayMs);
          continue;
        }
        _deadLetter(message, target, err && err.message);
        return false;
      }
    }
  }

  async function _deliver(targets, message, opts) {
    if (isExpired(message, clock())) {
      if (metrics) metrics.recordExpired();
      _emit(MESSAGING_EVENTS.EXPIRED, message);
      return { messageId: message.messageId, delivered: 0, expired: true };
    }
    _inFlight += 1;
    try {
      let delivered = 0;
      let failed = 0;
      for (const t of targets) {
        // Re-check TTL before each delivery (a slow retry may have crossed it).
        if (isExpired(message, clock())) {
          if (metrics) metrics.recordExpired();
          _emit(MESSAGING_EVENTS.EXPIRED, message);
          break;
        }
        const ok = await _invokeWithRetry(t, message, opts);
        if (ok) delivered += 1;
        else failed += 1;
      }
      return { messageId: message.messageId, delivered, failed };
    } finally {
      _inFlight -= 1;
    }
  }

  // ── §1 Messaging port ────────────────────────────────────────────────────
  function _build(spec, opts) {
    return createMessage(spec, { clock, idFactory: opts && opts.idFactory });
  }

  async function publish(spec = {}, opts = {}) {
    const msg = _build(spec, opts);
    if (metrics) metrics.recordPublished();
    _emit(MESSAGING_EVENTS.PUBLISHED, msg);
    const targets = provider.select(msg.topic);
    return _deliver(targets, msg, { retryPolicy: spec.retryPolicy || opts.retryPolicy });
  }

  async function broadcast(spec = {}, opts = {}) {
    const msg = _build(spec, opts);
    if (metrics) metrics.recordPublished();
    _emit(MESSAGING_EVENTS.PUBLISHED, msg, { broadcast: true });
    const targets = provider.selectAll(msg.topic);
    return _deliver(targets, msg, { retryPolicy: spec.retryPolicy || opts.retryPolicy });
  }

  function subscribe(spec = {}) {
    const { topic, handler, group } = spec;
    if (!topic) throw new Error('messaging: "topic" required');
    if (typeof handler !== 'function') throw new Error('messaging: "handler" must be a function');
    const sub = provider.subscribe(topic, handler, { group, id: spec.id });
    _emit(
      MESSAGING_EVENTS.SUBSCRIBER_REGISTERED,
      { messageId: null, topic, correlationId: null },
      {
        subscriber: sub.id,
        group: sub.group,
      }
    );
    return {
      id: sub.id,
      topic: sub.topic,
      group: sub.group,
      unsubscribe: () => unsubscribe(sub.id),
    };
  }

  function unsubscribe(id) {
    const removed = provider.unsubscribe(id);
    if (removed) {
      _emit(
        MESSAGING_EVENTS.SUBSCRIBER_REMOVED,
        { messageId: null, topic: null, correlationId: null },
        { subscriber: id }
      );
    }
    return removed;
  }

  /**
   * Request/reply: publishes to `topic` with a reply correlation, resolving when
   * a subscriber calls `reply(requestMessage, payload)`. Rejects on timeout.
   */
  function request(spec = {}, opts = {}) {
    const { topic } = spec;
    if (!topic) throw new Error('messaging: "topic" required');
    const timeoutMs = typeof spec.timeoutMs === 'number' ? spec.timeoutMs : 5000;
    const msg = _build(
      { ...spec, headers: { ...(spec.headers || {}), replyExpected: true } },
      opts
    );
    const targets = provider.select(topic);
    if (targets.length === 0) {
      return Promise.reject(
        new NoSubscriberError(`messaging: no subscriber for request topic "${topic}"`)
      );
    }
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeoutImpl(() => {
        _pending.delete(msg.correlationId);
        reject(new RequestTimeoutError(`messaging: request "${msg.correlationId}" timed out`));
      }, timeoutMs);
      _pending.set(msg.correlationId, { resolve, reject, timer });
    });
    if (metrics) metrics.recordPublished();
    _emit(MESSAGING_EVENTS.PUBLISHED, msg, { request: true });
    // Deliver the request (fire-and-forget on delivery; the reply resolves it).
    _deliver(targets, msg, { retryPolicy: spec.retryPolicy || opts.retryPolicy }).catch((e) =>
      log.error('messaging: request delivery failed', e.message)
    );
    return promise;
  }

  /** Resolve a pending request with a reply payload (called by a subscriber). */
  function reply(requestMessage, payload) {
    const corr = requestMessage && requestMessage.correlationId;
    const p = corr && _pending.get(corr);
    if (!p) return false;
    clearTimeoutImpl(p.timer);
    _pending.delete(corr);
    p.resolve(payload);
    return true;
  }

  async function health() {
    const providerHealth = await provider.health();
    return {
      ok: Boolean(providerHealth && providerHealth.ok),
      provider: providerHealth,
      deadLetters: _dlq.length,
      pendingRequests: _pending.size,
      metrics: metrics ? metrics.snapshot() : null,
    };
  }

  return {
    publish,
    subscribe,
    unsubscribe,
    request,
    reply,
    broadcast,
    health,
    deadLetters: () => _dlq.map((d) => ({ ...d })),
    metrics: () => (metrics ? metrics.snapshot() : null),
  };
}

module.exports = { createMessagingService };
