'use strict';

/**
 * Identity controller — Presentation layer.
 * Translates transport requests ⇄ application commands/results. Contains
 * ZERO business logic (ADR-005 §4): every decision comes back from the
 * application as a typed result; this file only maps results to the frozen
 * response contract (status codes, JSON shapes, and messages must remain
 * byte-identical to src/routes/auth.js — the mobile fleet depends on them).
 */

const { AuthRejection } = require('../../application/identity/useCases');
const { InputRejection } = require('../../application/identity/commands');

/** Frozen response contract (Arabic messages identical to the legacy routes). */
const RESPONSES = Object.freeze({
  [InputRejection.PHONE_REQUIRED]: {
    status: 400,
    body: { success: false, message: 'رقم الهاتف مطلوب' },
  },
  [InputRejection.PHONE_INVALID]: {
    status: 400,
    body: { success: false, message: 'رقم الهاتف غير صحيح' },
  },
  [InputRejection.OTP_REQUIRED]: {
    status: 400,
    body: { success: false, message: 'رمز التحقق مطلوب' },
  },
  [InputRejection.REFRESH_TOKEN_REQUIRED]: {
    status: 400,
    body: { success: false, message: 'refresh token مطلوب' },
  },
  [AuthRejection.OTP_INVALID]: {
    status: 401,
    body: { success: false, message: 'رمز التحقق غير صحيح أو منتهي الصلاحية' },
  },
  [AuthRejection.ACCOUNT_SUSPENDED]: {
    status: 403,
    body: { success: false, message: 'الحساب موقوف — تواصل مع الدعم' },
  },
  [AuthRejection.REFRESH_INVALID]: {
    status: 401,
    body: { success: false, message: 'refresh token غير صالح أو منتهي الصلاحية' },
  },
});

const SERVER_ERROR = { success: false, message: 'خطأ في السيرفر' };

function send(res, rejectionCode) {
  const r = RESPONSES[rejectionCode];
  return res.status(r.status).json(r.body);
}

function driverBlockedBody(result) {
  const messages = {
    pending: 'حسابك قيد المراجعة — سيتم إخطارك عند اعتماد حسابك.',
    rejected: 'تم رفض طلب التسجيل.',
    suspended: 'تم إيقاف حسابك.',
  };
  // Key order mirrors the legacy serializer exactly (byte-fidelity):
  // rejected/suspended → { success, status, reason, message }; pending → no reason.
  if (result.status === 'rejected' || result.status === 'suspended') {
    return {
      success: false,
      status: result.status,
      reason: result.reason,
      message: messages[result.status],
    };
  }
  return { success: false, status: result.status, message: messages[result.status] };
}

function bearerToken(req) {
  return req.headers['authorization']?.replace('Bearer ', '') || req.headers['x-session-token'];
}

function createIdentityController(identityApp, logger) {
  const { useCases, commands } = identityApp;
  const otpRequired = () => identityApp.otpRequired;

  return {
    async sendOtp(req, res) {
      try {
        const parsed = commands.sendOtpCommand(req.body || {});
        if (!parsed.ok) return send(res, parsed.code);
        await useCases.sendOtp(parsed.command, { requestId: req.id });
        res.json({ success: true, message: 'تم إرسال رمز التحقق' });
      } catch (err) {
        logger.error('OTP send error:', { message: err.message });
        res.status(500).json(SERVER_ERROR);
      }
    },

    async loginPassenger(req, res) {
      try {
        const parsed = commands.loginPassengerCommand(
          { ...(req.body || {}), ip: req.ip },
          otpRequired()
        );
        if (!parsed.ok) return send(res, parsed.code);
        const result = await useCases.loginPassenger(parsed.command, { requestId: req.id });
        if (!result.ok) return send(res, result.code);
        const { user, token, refreshToken } = result.value;
        res.json({ success: true, user, token, refreshToken });
      } catch (err) {
        logger.error('Passenger login error:', { message: err.message });
        res.status(500).json(SERVER_ERROR);
      }
    },

    async loginDriver(req, res) {
      try {
        const parsed = commands.loginDriverCommand(
          { ...(req.body || {}), ip: req.ip },
          otpRequired()
        );
        if (!parsed.ok) return send(res, parsed.code);
        const result = await useCases.loginDriver(parsed.command, { requestId: req.id });
        if (!result.ok) {
          if (result.status) return res.status(403).json(driverBlockedBody(result));
          return send(res, result.code);
        }
        const { driver, token, refreshToken } = result.value;
        res.json({ success: true, driver, token, refreshToken });
      } catch (err) {
        logger.error('Driver login error:', { message: err.message });
        res.status(500).json(SERVER_ERROR);
      }
    },

    async refreshSession(req, res) {
      try {
        const parsed = commands.refreshSessionCommand(req.body || {});
        if (!parsed.ok) return send(res, parsed.code);
        const result = await useCases.refreshSession(parsed.command);
        if (!result.ok) {
          if (result.code === AuthRejection.DRIVER_REFRESH_BLOCKED) {
            return res.status(403).json({
              success: false,
              status: result.status,
              message:
                result.status === 'suspended'
                  ? 'تم إيقاف حسابك — لا يمكن تجديد الجلسة.'
                  : 'حسابك غير معتمد — لا يمكن تجديد الجلسة.',
            });
          }
          return send(res, result.code);
        }
        res.json({ success: true, ...result.value });
      } catch (err) {
        logger.error('Token refresh error:', { message: err.message });
        res.status(500).json(SERVER_ERROR);
      }
    },

    async logout(req, res) {
      const parsed = commands.logoutCommand({
        accessToken: bearerToken(req),
        refreshToken: (req.body || {}).refreshToken,
      });
      await useCases.logout(parsed.command);
      // Frozen contract: logout never fails from the user's perspective.
      res.json({ success: true, message: 'تم تسجيل الخروج' });
    },

    verifySession(req, res) {
      const result = useCases.verifySession(bearerToken(req));
      if (!result.ok) {
        return res.status(401).json({ success: false, message: 'الجلسة منتهية' });
      }
      res.json({ success: true, session: result.value.session });
    },

    isAdmin(req, res) {
      const result = useCases.checkAdmin(bearerToken(req));
      if (!result.ok) {
        return res.status(401).json({ success: false, message: 'غير مصرح - سجّل دخولك أولاً' });
      }
      res.json({ success: true, isAdmin: result.value.isAdmin });
    },

    async logoutAll(req, res) {
      try {
        const result = await useCases.logoutAll(req.user);
        if (!result.ok) {
          return res.status(401).json({ success: false, message: 'غير مصرح - سجّل دخولك أولاً' });
        }
        res.json({ success: true, message: 'تم تسجيل الخروج من جميع الأجهزة' });
      } catch (err) {
        logger.error('Logout-all error:', { message: err.message });
        res.status(500).json(SERVER_ERROR);
      }
    },
  };
}

module.exports = { createIdentityController };
