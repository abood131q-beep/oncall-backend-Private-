'use strict';

/**
 * Notifications slice tests — proves the migrated Application + Domain layers
 * reproduce the legacy src/routes/notifications.js behavior with pure fakes (no
 * transport, no storage, no framework — the layering promise, verified).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deviceTokenPolicy,
  pushDeliveryPolicy,
  broadcastDeliveryPolicy,
  retryPolicy,
  readPolicy,
  visibilityPolicy,
  NotificationRejection,
} = require('../../src/domain/notifications/notificationPolicies');
const { tryCreateChannel } = require('../../src/domain/notifications/notificationValues');
const {
  createNotificationsApplication,
  NotificationsError,
} = require('../../src/application/notifications');

// ── Domain ───────────────────────────────────────────────────────────────────

test('DeliveryChannel VO: only android/ios valid', () => {
  assert.deepEqual(tryCreateChannel('android'), { valid: true, value: 'android' });
  assert.deepEqual(tryCreateChannel('ios'), { valid: true, value: 'ios' });
  assert.equal(tryCreateChannel('windows').valid, false);
});

test('deviceTokenPolicy: ordered token → length → platform', () => {
  assert.equal(deviceTokenPolicy('', 'android').code, NotificationRejection.TOKEN_REQUIRED);
  assert.equal(
    deviceTokenPolicy('x'.repeat(513), 'android').code,
    NotificationRejection.TOKEN_TOO_LONG
  );
  assert.equal(deviceTokenPolicy('tok', 'windows').code, NotificationRejection.INVALID_PLATFORM);
  assert.deepEqual(deviceTokenPolicy('tok', 'ios'), { allowed: true });
});

test('push + broadcast delivery policies', () => {
  assert.equal(pushDeliveryPolicy('', 't', 'b').code, NotificationRejection.PUSH_FIELDS_REQUIRED);
  assert.deepEqual(pushDeliveryPolicy('p', 't', 'b'), { allowed: true });
  assert.equal(
    broadcastDeliveryPolicy([], 't', 'b').code,
    NotificationRejection.BROADCAST_FIELDS_REQUIRED
  );
  assert.equal(
    broadcastDeliveryPolicy(new Array(1001).fill('x'), 't', 'b').code,
    NotificationRejection.BROADCAST_TOO_LARGE
  );
  assert.deepEqual(broadcastDeliveryPolicy(['a'], 't', 'b'), { allowed: true });
});

test('retryPolicy prunes only invalid-token FCM codes', () => {
  assert.equal(retryPolicy('messaging/registration-token-not-registered').pruneToken, true);
  assert.equal(retryPolicy('messaging/internal-error').pruneToken, false);
});

test('read + visibility policies are owner-scoped', () => {
  assert.equal(readPolicy('a', 'a').allowed, true);
  assert.equal(readPolicy('a', 'b').allowed, false);
  assert.equal(visibilityPolicy('a', 'a').visible, true);
  assert.equal(visibilityPolicy('a', 'b').visible, false);
});

// ── Application ──────────────────────────────────────────────────────────────

function makeApp() {
  const tokens = new Map(); // `${phone}|${token}` → row
  const pushes = [];
  const ports = {
    deviceTokenRepository: {
      upsert: async (phone, token, platform, ver) =>
        tokens.set(`${phone}|${token}`, { phone, token, platform, ver }),
      findOne: async (phone, token) => tokens.get(`${phone}|${token}`),
      remove: async (phone, token) => tokens.delete(`${phone}|${token}`),
      listForPhone: async (phone) =>
        [...tokens.values()]
          .filter((t) => t.phone === phone)
          .map((t) => ({ platform: t.platform })),
    },
    pushGateway: {
      send: async (phone, title, body, data) => {
        pushes.push({ kind: 'send', phone, title, body, data });
        return { success: false, reason: 'not_configured' };
      },
      broadcast: async (phones, title, body) => {
        pushes.push({ kind: 'broadcast', phones, title, body });
        return { success: false, reason: 'not_configured', total: phones.length };
      },
    },
    auditLog: { info() {}, warn() {}, error() {} },
  };
  return { app: createNotificationsApplication(ports), tokens, pushes };
}

test('registerDeviceToken: valid upsert; invalid platform rejected', async () => {
  const { app, tokens } = makeApp();
  const ok = await app.useCases.registerDeviceToken(
    app.commands.registerDeviceTokenCommand({
      actorPhone: 'p',
      device_token: ' tok ',
      platform: 'android',
      app_version: '1.0',
    }).command
  );
  assert.equal(ok.ok, true);
  assert.equal(tokens.has('p|tok'), true); // trimmed
  const bad = await app.useCases.registerDeviceToken(
    app.commands.registerDeviceTokenCommand({ actorPhone: 'p', device_token: 't', platform: 'x' })
      .command
  );
  assert.equal(bad.code, NotificationsError.INVALID_PLATFORM);
});

test('removeDeviceToken: IDOR-safe, missing → silent success', async () => {
  const { app } = makeApp();
  await app.useCases.registerDeviceToken(
    app.commands.registerDeviceTokenCommand({
      actorPhone: 'p',
      device_token: 'tok',
      platform: 'ios',
    }).command
  );
  const removed = await app.useCases.removeDeviceToken({ actorPhone: 'p', deviceToken: 'tok' });
  assert.equal(removed.value.removed, true);
  const noop = await app.useCases.removeDeviceToken({ actorPhone: 'p', deviceToken: 'ghost' });
  assert.equal(noop.ok, true);
  assert.equal(noop.value.removed, false);
});

test('sendPush + broadcastPush: field validation then dispatch', async () => {
  const { app, pushes } = makeApp();
  const miss = await app.useCases.sendPush(
    app.commands.sendPushCommand({ phone: 'p', title: 't' }).command
  );
  assert.equal(miss.code, NotificationsError.PUSH_FIELDS_REQUIRED);
  const sent = await app.useCases.sendPush(
    app.commands.sendPushCommand({ phone: 'p', title: 't', body: 'b' }).command
  );
  assert.equal(sent.ok, true);
  assert.equal(sent.value.result.reason, 'not_configured');
  assert.equal(pushes.length, 1);
});

test('ports: composition fails fast when a port method is missing', () => {
  assert.throws(() => createNotificationsApplication({ deviceTokenRepository: {} }));
});
