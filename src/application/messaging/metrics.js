'use strict';

/**
 * Messaging metrics (Phase 14.5 / ADR-024 §7) — observability port. Tracks
 * messages published/delivered/failed, retries, dead letters, subscriber count,
 * delivery latency, and queue depth; exposes a Prometheus exposition. Pure
 * in-process counters; injectable clock keeps latency deterministic.
 */

function createMessagingMetrics(opts = {}) {
  // Latency is passed in explicitly by the service; opts.clock is accepted for
  // signature symmetry with the other kernel metrics but not needed here.
  void opts;
  let published = 0;
  let delivered = 0;
  let failed = 0;
  let retries = 0;
  let deadLetters = 0;
  let expired = 0;
  let latTotalMs = 0;
  let latCount = 0;
  let latLastMs = 0;

  let gaugeSubscribers = () => 0;
  let gaugeQueueDepth = () => 0;
  function bindGauges({ subscribers, queueDepth }) {
    if (subscribers) gaugeSubscribers = subscribers;
    if (queueDepth) gaugeQueueDepth = queueDepth;
  }

  const recordPublished = () => (published += 1);
  const recordDelivered = (n = 1) => (delivered += n);
  const recordFailed = (n = 1) => (failed += n);
  const recordRetry = () => (retries += 1);
  const recordDeadLetter = () => (deadLetters += 1);
  const recordExpired = () => (expired += 1);
  function recordDeliveryLatency(ms) {
    if (typeof ms === 'number' && ms >= 0) {
      latTotalMs += ms;
      latCount += 1;
      latLastMs = ms;
    }
  }

  function snapshot() {
    return {
      published,
      delivered,
      failed,
      retries,
      deadLetters,
      expired,
      subscribers: gaugeSubscribers(),
      queueDepth: gaugeQueueDepth(),
      avgDeliveryLatencyMs: latCount ? latTotalMs / latCount : 0,
      lastDeliveryLatencyMs: latLastMs,
    };
  }

  function prometheus() {
    const s = snapshot();
    const g = (name, help, value) =>
      `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}`;
    return (
      [
        g('messaging_published_total', 'Messages published', s.published),
        g('messaging_delivered_total', 'Messages delivered', s.delivered),
        g('messaging_failed_total', 'Delivery failures', s.failed),
        g('messaging_retries_total', 'Delivery retries', s.retries),
        g('messaging_dead_letters_total', 'Dead-lettered messages', s.deadLetters),
        g('messaging_expired_total', 'Expired (TTL) messages', s.expired),
        g('messaging_subscribers', 'Active subscribers', s.subscribers),
        g('messaging_queue_depth', 'Pending in-flight messages', s.queueDepth),
        g('messaging_delivery_latency_ms_avg', 'Average delivery latency', s.avgDeliveryLatencyMs),
        g('messaging_delivery_latency_ms_last', 'Last delivery latency', s.lastDeliveryLatencyMs),
      ].join('\n') + '\n'
    );
  }

  return {
    bindGauges,
    recordPublished,
    recordDelivered,
    recordFailed,
    recordRetry,
    recordDeadLetter,
    recordExpired,
    recordDeliveryLatency,
    snapshot,
    prometheus,
  };
}

module.exports = { createMessagingMetrics };
