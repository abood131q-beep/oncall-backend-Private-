'use strict';

/**
 * Notifications controller — Presentation layer.
 * HTTP translation only; ZERO business logic (ADR-005 §4). Every outcome is a
 * typed result from the application; this file maps it to the frozen response
 * contract (status, JSON shape, key order, Arabic messages must remain
 * byte-identical to src/routes/notifications.js). Proven by the A/B harness.
 *
 * GLOBALIZATION (ADR-003, non-breaking): Arabic is the frozen default; English
 * is additive via `Accept-Language: en` and never alters Arabic output.
 */

const { NotificationsError } = require('../../application/notifications/useCases');

const ar = Object.freeze({
  [NotificationsError.TOKEN_REQUIRED]: 'device_token مطلوب',
  [NotificationsError.TOKEN_TOO_LONG]: 'device_token طويل جداً',
  [NotificationsError.INVALID_PLATFORM]: 'platform يجب أن يكون: android | ios',
  [NotificationsError.PUSH_FIELDS_REQUIRED]: 'phone + title + body مطلوبة',
  [NotificationsError.BROADCAST_FIELDS_REQUIRED]: 'phones[] + title + body مطلوبة',
  [NotificationsError.BROADCAST_TOO_LARGE]: 'الحد الأقصى 1000 مستخدم',
  REGISTERED: 'تم تسجيل الجهاز',
  REMOVED: 'تم حذف الجهاز',
  REMOVE_NOOP: 'تم',
  SERVER_ERROR: 'خطأ في السيرفر',
});
const en = Object.freeze({
  [NotificationsError.TOKEN_REQUIRED]: 'device_token is required',
  [NotificationsError.TOKEN_TOO_LONG]: 'device_token is too long',
  [NotificationsError.INVALID_PLATFORM]: 'platform must be: android | ios',
  [NotificationsError.PUSH_FIELDS_REQUIRED]: 'phone + title + body are required',
  [NotificationsError.BROADCAST_FIELDS_REQUIRED]: 'phones[] + title + body are required',
  [NotificationsError.BROADCAST_TOO_LARGE]: 'Maximum 1000 recipients',
  REGISTERED: 'Device registered',
  REMOVED: 'Device removed',
  REMOVE_NOOP: 'Done',
  SERVER_ERROR: 'Server error',
});

function msg(req, code) {
  return String(req.headers['accept-language'] || '')
    .toLowerCase()
    .startsWith('en')
    ? en[code] || code
    : ar[code] || code;
}

function createNotificationsController(notificationsApp, logger) {
  const { useCases, commands } = notificationsApp;
  const serverError = (req) => ({ success: false, message: msg(req, 'SERVER_ERROR') });

  return {
    // POST /device-tokens
    async register(req, res) {
      try {
        const b = req.body || {};
        const p = commands.registerDeviceTokenCommand({
          actorPhone: req.user.phone,
          device_token: b.device_token,
          platform: b.platform,
          app_version: b.app_version,
        });
        const r = await useCases.registerDeviceToken(p.command);
        if (!r.ok) return res.status(400).json({ success: false, message: msg(req, r.code) });
        res.json({ success: true, message: msg(req, 'REGISTERED') });
      } catch (err) {
        logger.error('device-token register error:', { message: err.message });
        res.status(500).json(serverError(req));
      }
    },

    // DELETE /device-tokens
    async remove(req, res) {
      try {
        const b = req.body || {};
        const p = commands.removeDeviceTokenCommand({
          actorPhone: req.user.phone,
          device_token: b.device_token,
        });
        const r = await useCases.removeDeviceToken(p.command);
        if (!r.ok) return res.status(400).json({ success: false, message: msg(req, r.code) });
        if (!r.value.removed) return res.json({ success: true, message: msg(req, 'REMOVE_NOOP') });
        res.json({ success: true, message: msg(req, 'REMOVED') });
      } catch (err) {
        logger.error('device-token delete error:', { message: err.message });
        res.status(500).json(serverError(req));
      }
    },

    // POST /push/send (admin)
    async pushSend(req, res) {
      try {
        const b = req.body || {};
        const p = commands.sendPushCommand({
          phone: b.phone,
          title: b.title,
          body: b.body,
          data: b.data,
        });
        const r = await useCases.sendPush(p.command);
        if (!r.ok) return res.status(400).json({ success: false, message: msg(req, r.code) });
        res.json({ success: true, result: r.value.result });
      } catch (err) {
        logger.error('push/send error:', { message: err.message });
        res.status(500).json(serverError(req));
      }
    },

    // POST /push/broadcast (admin)
    async pushBroadcast(req, res) {
      try {
        const b = req.body || {};
        const p = commands.broadcastPushCommand({
          phones: b.phones,
          title: b.title,
          body: b.body,
          data: b.data,
        });
        const r = await useCases.broadcastPush(p.command);
        if (!r.ok) return res.status(400).json({ success: false, message: msg(req, r.code) });
        res.json({ success: true, result: r.value.result });
      } catch (err) {
        logger.error('push/broadcast error:', { message: err.message });
        res.status(500).json(serverError(req));
      }
    },

    // GET /device-tokens/:phone (admin)
    async listTokens(req, res) {
      try {
        const p = commands.listDeviceTokensCommand({ phone: req.params.phone });
        const r = await useCases.listDeviceTokens(p.command);
        res.json({ success: true, count: r.value.count, tokens: r.value.tokens });
      } catch (err) {
        logger.error('device-tokens get error:', { message: err.message });
        res.status(500).json({ success: false });
      }
    },
  };
}

module.exports = { createNotificationsController };
