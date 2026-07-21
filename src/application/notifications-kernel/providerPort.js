'use strict';

/**
 * NotificationProvider PORT (Phase 15.1 / ADR-030 §4) — DELIVERY ONLY. A provider
 * hands a rendered notification to a transport and reports the outcome; it never
 * routes, schedules, retries, deduplicates, expires, or tracks lifecycle — all of
 * that lives in the engine, so engine behavior is identical regardless of provider.
 * NOT FCM/APNs/Twilio/SendGrid — those are declared extension points behind this
 * same contract.
 *
 * Contract:
 *   name
 *   supports(channel) → boolean            // which channels this provider delivers
 *   deliver(model) → { ok, providerId?, reason? }   // async; the sole delivery call
 *   health() → { ok, ... }
 */

const METHODS = Object.freeze(['supports', 'deliver', 'health']);

function assertProvider(p) {
  if (!p || typeof p.name !== 'string' || !p.name) {
    throw new Error('NotificationProvider: adapter must expose a name');
  }
  for (const m of METHODS) {
    if (typeof p[m] !== 'function')
      throw new Error(`NotificationProvider: adapter must implement ${m}()`);
  }
  return p;
}

/** Extension points for FUTURE providers (§4). Declared, not implemented. */
const FUTURE_PROVIDERS = Object.freeze([
  'fcm', // Firebase Cloud Messaging
  'apns', // Apple Push Notification Service
  'twilio', // Twilio SMS
  'email', // Email providers (SendGrid, SES, SMTP, …)
  'webhook', // Outbound webhooks
  'custom', // Bring-your-own transport
]);

function futureProvider(name) {
  if (!FUTURE_PROVIDERS.includes(name)) {
    throw new Error(`notifications: "${name}" is not a recognized future provider`);
  }
  const notImpl = () => {
    throw new Error(
      `notification provider "${name}" is an extension point — not implemented in Phase 15.1`
    );
  };
  return {
    name,
    planned: true,
    supports: () => false,
    deliver: notImpl,
    health: () => ({ ok: false, reason: 'not-implemented' }),
  };
}

module.exports = { assertProvider, METHODS, FUTURE_PROVIDERS, futureProvider };
