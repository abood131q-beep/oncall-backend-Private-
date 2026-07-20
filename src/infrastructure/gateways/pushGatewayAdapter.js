'use strict';

/**
 * Push gateway adapter — Infrastructure layer.
 * Implements the pushGateway port by delegating to the EXISTING notification
 * service (src/services/notificationService.js, FCM v1). Production delivery
 * behavior is reused, never replaced — the result object is passed through
 * unchanged so the response contract stays byte-identical.
 *
 * SMS and Email: no Notifications-context endpoint uses them today. SMS is
 * integrated via the Identity/OTP flow (otpGatewayAdapter, Phase 2); Email and
 * message Templates do not exist in the legacy platform, so no adapter is
 * created for them (scope: existing integrations only, no invention).
 *
 * @param {object} deps — the existing DI service container (notifService)
 */
function createPushGatewayAdapter(deps) {
  const { notifService } = deps;

  return {
    send: (phone, title, body, data) => notifService.send(phone, title, body, data),
    broadcast: (phones, title, body, data) => notifService.broadcast(phones, title, body, data),
  };
}

module.exports = { createPushGatewayAdapter };
