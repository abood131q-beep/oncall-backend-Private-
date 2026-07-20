'use strict';

/**
 * Users controller — Presentation layer.
 * Translates transport requests ⇄ application commands/results. Contains ZERO
 * business logic (ADR-005 §4): every decision comes back from the application
 * as a typed result; this file only maps results to the frozen response
 * contract (status codes, JSON shapes, key order, and messages must remain
 * byte-identical to src/routes/users.js for the default locale — the mobile
 * fleet depends on them). Proven by the live A/B harness
 * (tests/integration/users-ab.mjs).
 *
 * GLOBALIZATION (ADR-003, non-breaking): user-facing messages are resolved via
 * the injected Localization service against the request's negotiated locale.
 * With no `Accept-Language` header (the mobile fleet today) the locale is `ar`
 * and every string is byte-identical to before. `Accept-Language: en` (and any
 * future locale) returns the localized string — additive, never altering `ar`.
 */

const { UsersError } = require('../../application/users/useCases');

// Rejection codes (from Application) → HTTP status. The code strings double as
// localization catalog keys (shared message vocabulary).
const REJECTION_STATUS = Object.freeze({
  [UsersError.FORBIDDEN_OTHER_USER]: 403,
  [UsersError.USER_NOT_FOUND]: 404,
});

// Presentation-owned message codes (not domain rejections) — catalog keys.
const MSG = Object.freeze({
  BALANCE_ADD_DEPRECATED: 'BALANCE_ADD_DEPRECATED',
  REPORT_SUBMITTED: 'REPORT_SUBMITTED',
});

// Legacy 500 shape for these routes is the bare `{ success: false }` object.
const SERVER_ERROR = { success: false };

function createUsersController(usersApp, logger, localization) {
  const { useCases, commands } = usersApp;

  /** Resolve the request locale (default 'ar' → byte-identical legacy path). */
  const localeOf = (req) => localization.negotiate(req.headers['accept-language']);
  const t = (code, req) => localization.translate(code, localeOf(req));

  /** Map a rejection code → { status, body } with a localized message. */
  function sendRejection(req, res, code) {
    return res.status(REJECTION_STATUS[code]).json({ success: false, message: t(code, req) });
  }

  return {
    // POST /user/update → { success: true, user }
    async updateProfile(req, res) {
      try {
        const parsed = commands.updateProfileCommand({
          actorPhone: req.user.phone,
          name: (req.body || {}).name,
        });
        const result = await useCases.updateProfile(parsed.command);
        res.json({ success: true, user: result.value.user });
      } catch (err) {
        logger.error('User update error:', { message: err.message });
        res.status(500).json(SERVER_ERROR);
      }
    },

    // GET /balance/:phone → { success: true, balance } | 403 | 404
    async getBalance(req, res) {
      try {
        const parsed = commands.getBalanceCommand({
          actorPhone: req.user.phone,
          targetPhone: req.params.phone,
        });
        const result = await useCases.getBalance(parsed.command);
        if (!result.ok) return sendRejection(req, res, result.code);
        res.json({ success: true, balance: result.value.balance });
      } catch (err) {
        logger.error('User balance error:', { message: err.message });
        res.status(500).json(SERVER_ERROR);
      }
    },

    // POST /balance/add → 410 (deprecated; unchanged legacy contract)
    balanceAddDeprecated(req, res) {
      return res.status(410).json({
        success: false,
        message: t(MSG.BALANCE_ADD_DEPRECATED, req),
        code: 'ENDPOINT_DEPRECATED',
      });
    },

    // GET /transactions/:phone → raw array (legacy ignores path phone)
    async getActivity(req, res) {
      try {
        const parsed = commands.getActivityCommand({ actorPhone: req.user.phone });
        const result = await useCases.getActivity(parsed.command);
        res.json(result.value.activity);
      } catch (err) {
        logger.error('User activity error:', { message: err.message });
        res.status(500).json(SERVER_ERROR);
      }
    },

    // GET /notifications/:phone → raw array (legacy ignores path phone)
    async listNotifications(req, res) {
      try {
        const parsed = commands.listNotificationsCommand({ actorPhone: req.user.phone });
        const result = await useCases.listNotifications(parsed.command);
        res.json(result.value.notifications);
      } catch (err) {
        logger.error('User notifications error:', { message: err.message });
        res.status(500).json(SERVER_ERROR);
      }
    },

    // PUT /notifications/:phone/read → { success: true }
    async markNotificationsRead(req, res) {
      try {
        const parsed = commands.markNotificationsReadCommand({ actorPhone: req.user.phone });
        await useCases.markNotificationsRead(parsed.command);
        res.json({ success: true });
      } catch (err) {
        logger.error('User notifications read error:', { message: err.message });
        res.status(500).json(SERVER_ERROR);
      }
    },

    // POST /report → { success: true, message }
    async submitReport(req, res) {
      try {
        const body = req.body || {};
        const parsed = commands.submitReportCommand({
          actorPhone: req.user.phone,
          type: body.type,
          description: body.description,
          tripId: body.trip_id,
        });
        await useCases.submitReport(parsed.command);
        res.json({ success: true, message: t(MSG.REPORT_SUBMITTED, req) });
      } catch (err) {
        logger.error('User report error:', { message: err.message });
        res.status(500).json(SERVER_ERROR);
      }
    },
  };
}

module.exports = { createUsersController };
