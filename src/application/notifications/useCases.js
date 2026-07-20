'use strict';

/**
 * Notifications use cases — Application layer (ADR-005 §5/§6).
 *
 * Each use case: validation (domain policy) → authorization → domain execution
 * → side effects via ports → typed result. A 1:1 migration of
 * src/routes/notifications.js: identical outcomes and ordering.
 *
 * Results: { ok: true, value } | { ok: false, code }.
 * No transport, storage, SQL, or vendor knowledge here (ADR-005 §4).
 */

const {
  NotificationRejection,
  deviceTokenPolicy,
  pushDeliveryPolicy,
  broadcastDeliveryPolicy,
} = require('../../domain/notifications/notificationPolicies');
const { MAX_APP_VERSION_LENGTH } = require('../../domain/notifications/notificationValues');

const NotificationsError = Object.freeze({ ...NotificationRejection });

function createNotificationsUseCases(ports) {
  const { deviceTokenRepository, pushGateway, auditLog } = ports;

  /** RegisterDeviceToken — validate (domain), then UPSERT. */
  async function registerDeviceToken(command) {
    const gate = deviceTokenPolicy(command.deviceToken, command.platform);
    if (!gate.allowed) return { ok: false, code: gate.code };

    const cleanToken = command.deviceToken.trim();
    const cleanVersion =
      typeof command.appVersion === 'string'
        ? command.appVersion.slice(0, MAX_APP_VERSION_LENGTH)
        : '';

    await deviceTokenRepository.upsert(
      command.actorPhone,
      cleanToken,
      command.platform,
      cleanVersion
    );
    auditLog.info(
      `Device token registered: ${String(command.actorPhone).slice(0, 3)}*** | ${command.platform}`
    );
    return { ok: true, value: { registered: true } };
  }

  /** RemoveDeviceToken — IDOR-safe (own token only); missing → silent success. */
  async function removeDeviceToken(command) {
    if (!command.deviceToken || typeof command.deviceToken !== 'string') {
      return { ok: false, code: NotificationsError.TOKEN_REQUIRED };
    }
    const token = command.deviceToken.trim();
    const existing = await deviceTokenRepository.findOne(command.actorPhone, token);
    if (!existing) {
      // Info-leak prevention: report success without disclosing existence.
      return { ok: true, value: { removed: false } };
    }
    await deviceTokenRepository.remove(command.actorPhone, token);
    auditLog.info(`Device token removed: ${String(command.actorPhone).slice(0, 3)}***`);
    return { ok: true, value: { removed: true } };
  }

  /** SendPush (admin) — required fields, then dispatch via the push gateway. */
  async function sendPush(command) {
    const gate = pushDeliveryPolicy(command.phone, command.title, command.body);
    if (!gate.allowed) return { ok: false, code: gate.code };
    const result = await pushGateway.send(command.phone, command.title, command.body, command.data);
    return { ok: true, value: { result } };
  }

  /** BroadcastPush (admin) — required fields + size limit, then dispatch. */
  async function broadcastPush(command) {
    const gate = broadcastDeliveryPolicy(command.phones, command.title, command.body);
    if (!gate.allowed) return { ok: false, code: gate.code };
    const result = await pushGateway.broadcast(
      command.phones,
      command.title,
      command.body,
      command.data
    );
    return { ok: true, value: { result } };
  }

  /** ListDeviceTokens (admin) — diagnostics projection. */
  async function listDeviceTokens(command) {
    const tokens = await deviceTokenRepository.listForPhone(command.phone);
    return { ok: true, value: { count: tokens.length, tokens } };
  }

  return {
    registerDeviceToken,
    removeDeviceToken,
    sendPush,
    broadcastPush,
    listDeviceTokens,
  };
}

module.exports = { createNotificationsUseCases, NotificationsError };
