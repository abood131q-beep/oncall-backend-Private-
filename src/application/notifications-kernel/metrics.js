'use strict';

/**
 * Notification metrics (Phase 15.1 / ADR-030 §8) — observability port. Tracks
 * notifications created, sent, deliveries, failures, retries, scheduled (gauge),
 * provider failures, delivery latency, and engine uptime; exposes a Prometheus
 * exposition. Pure in-process counters; an injectable clock keeps latency + uptime
 * deterministic.
 */

function createNotificationMetrics(opts = {}) {
  const clock = opts.clock || (() => Date.now());
  const startedAt = clock();
  let created = 0;
  let sent = 0;
  let deliveries = 0;
  let failures = 0;
  let retries = 0;
  let cancellations = 0;
  let expirations = 0;
  let duplicates = 0;
  let providerFailures = 0;
  let eventFailures = 0;
  let latTotalMs = 0;
  let latCount = 0;
  let latLastMs = 0;

  let gaugeScheduled = () => 0;
  function bindGauges({ scheduled }) {
    if (scheduled) gaugeScheduled = scheduled;
  }

  const recordCreated = () => (created += 1);
  const recordSent = () => (sent += 1);
  const recordDelivery = () => (deliveries += 1);
  const recordFailure = () => (failures += 1);
  const recordRetry = () => (retries += 1);
  const recordCancellation = () => (cancellations += 1);
  const recordExpiration = () => (expirations += 1);
  const recordDuplicate = () => (duplicates += 1);
  const recordProviderFailure = () => (providerFailures += 1);
  const recordEventFailure = () => (eventFailures += 1);
  function recordLatency(ms) {
    if (typeof ms === 'number' && ms >= 0) {
      latTotalMs += ms;
      latCount += 1;
      latLastMs = ms;
    }
  }

  function snapshot() {
    return {
      created,
      sent,
      deliveries,
      failures,
      retries,
      cancellations,
      expirations,
      duplicates,
      scheduled: gaugeScheduled(),
      providerFailures,
      eventFailures,
      avgDeliveryLatencyMs: latCount ? latTotalMs / latCount : 0,
      lastDeliveryLatencyMs: latLastMs,
      uptimeMs: clock() - startedAt,
    };
  }

  function prometheus() {
    const s = snapshot();
    const g = (name, help, value) =>
      `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}`;
    return (
      [
        g('notifications_created_total', 'Notifications created', s.created),
        g('notifications_sent_total', 'Notifications sent', s.sent),
        g('notifications_deliveries_total', 'Successful deliveries', s.deliveries),
        g('notifications_failures_total', 'Delivery failures', s.failures),
        g('notifications_retries_total', 'Delivery retries', s.retries),
        g('notifications_cancellations_total', 'Cancellations', s.cancellations),
        g('notifications_expirations_total', 'Expirations', s.expirations),
        g('notifications_duplicates_total', 'Deduplicated notifications', s.duplicates),
        g('notifications_scheduled', 'Currently scheduled notifications', s.scheduled),
        g('notifications_provider_failures_total', 'Provider failures', s.providerFailures),
        g('notifications_event_failures_total', 'Event publication failures', s.eventFailures),
        g(
          'notifications_delivery_latency_ms_avg',
          'Average delivery latency',
          s.avgDeliveryLatencyMs
        ),
        g(
          'notifications_delivery_latency_ms_last',
          'Last delivery latency',
          s.lastDeliveryLatencyMs
        ),
        g('notifications_uptime_ms', 'Engine uptime', s.uptimeMs),
      ].join('\n') + '\n'
    );
  }

  return {
    bindGauges,
    recordCreated,
    recordSent,
    recordDelivery,
    recordFailure,
    recordRetry,
    recordCancellation,
    recordExpiration,
    recordDuplicate,
    recordProviderFailure,
    recordEventFailure,
    recordLatency,
    snapshot,
    prometheus,
  };
}

module.exports = { createNotificationMetrics };
