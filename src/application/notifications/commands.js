'use strict';

/**
 * Notifications commands — immutable intent messages (ADR-005 §7). Thin: the
 * legacy route reads phone from the JWT and lightly uses bodies; business
 * legality is decided by the Domain policies, never here.
 */

/** RegisterDeviceToken { actorPhone, device_token, platform, app_version? } */
function registerDeviceTokenCommand({ actorPhone, device_token, platform, app_version }) {
  return {
    ok: true,
    command: Object.freeze({
      actorPhone,
      deviceToken: device_token,
      platform,
      appVersion: app_version,
    }),
  };
}

/** RemoveDeviceToken { actorPhone, device_token } */
function removeDeviceTokenCommand({ actorPhone, device_token }) {
  return { ok: true, command: Object.freeze({ actorPhone, deviceToken: device_token }) };
}

/** SendPush { phone, title, body, data? } */
function sendPushCommand({ phone, title, body, data }) {
  return { ok: true, command: Object.freeze({ phone, title, body, data: data || {} }) };
}

/** BroadcastPush { phones, title, body, data? } */
function broadcastPushCommand({ phones, title, body, data }) {
  return { ok: true, command: Object.freeze({ phones, title, body, data: data || {} }) };
}

/** ListDeviceTokens { phone } */
function listDeviceTokensCommand({ phone }) {
  return { ok: true, command: Object.freeze({ phone }) };
}

module.exports = {
  registerDeviceTokenCommand,
  removeDeviceTokenCommand,
  sendPushCommand,
  broadcastPushCommand,
  listDeviceTokensCommand,
};
