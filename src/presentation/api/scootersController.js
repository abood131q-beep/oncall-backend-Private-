'use strict';

/**
 * Scooters controller — Presentation layer.
 * HTTP translation only; ZERO business logic (ADR-005 §4). Every outcome is a
 * typed result from the application; this file maps it to the frozen response
 * contract (status, JSON shape, key order, Arabic messages must remain
 * byte-identical to src/routes/scooters.js). Proven by the live A/B harness.
 *
 * GLOBALIZATION (ADR-003, non-breaking): Arabic is the frozen default; English
 * is additive via `Accept-Language: en` and never alters Arabic output.
 */

const { ScootersError } = require('../../application/scooters/useCases');

// Arabic = frozen legacy strings. English = additive.
const ar = Object.freeze({
  [ScootersError.SCOOTER_NOT_FOUND]: 'السكوتر غير موجود',
  [ScootersError.USER_NOT_FOUND]: 'المستخدم غير موجود',
  [ScootersError.NOT_AVAILABLE]: 'السكوتر غير متاح حالياً',
  [ScootersError.INSUFFICIENT_BALANCE]: 'رصيد غير كافٍ - الحد الأدنى 0.500 د.ك',
  [ScootersError.LOW_BATTERY]: 'بطارية السكوتر منخفضة جداً',
  [ScootersError.UNLOCK_RACE_LOST]: 'السكوتر غير متاح — تم فتحه للتو من مستخدم آخر',
  [ScootersError.NOT_YOUR_SCOOTER]: 'هذا ليس سكوترك',
  [ScootersError.INVALID_COORDS]: 'إحداثيات غير صالحة',
  UNLOCK_OK: 'تم فتح قفل السكوتر',
  UNLOCK_FAIL: 'خطأ في فتح القفل',
  END_OK: 'تم إنهاء الرحلة',
  END_FAIL: 'خطأ في إنهاء الرحلة',
  RENT_DEPRECATED: 'هذه النقطة معطّلة. استخدم POST /scooter/unlock',
  RETURN_DEPRECATED: 'هذه النقطة معطّلة. استخدم POST /scooter/end-ride',
});
const en = Object.freeze({
  [ScootersError.SCOOTER_NOT_FOUND]: 'Scooter not found',
  [ScootersError.USER_NOT_FOUND]: 'User not found',
  [ScootersError.NOT_AVAILABLE]: 'Scooter is not available right now',
  [ScootersError.INSUFFICIENT_BALANCE]: 'Insufficient balance — minimum 0.500 KD',
  [ScootersError.LOW_BATTERY]: 'Scooter battery is too low',
  [ScootersError.UNLOCK_RACE_LOST]: 'Scooter unavailable — it was just unlocked by another user',
  [ScootersError.NOT_YOUR_SCOOTER]: 'This is not your scooter',
  [ScootersError.INVALID_COORDS]: 'Invalid coordinates',
  UNLOCK_OK: 'Scooter unlocked',
  UNLOCK_FAIL: 'Failed to unlock',
  END_OK: 'Ride ended',
  END_FAIL: 'Failed to end the ride',
  RENT_DEPRECATED: 'This endpoint is disabled. Use POST /scooter/unlock',
  RETURN_DEPRECATED: 'This endpoint is disabled. Use POST /scooter/end-ride',
});

function msg(req, code) {
  return String(req.headers['accept-language'] || '')
    .toLowerCase()
    .startsWith('en')
    ? en[code] || code
    : ar[code] || code;
}

const SERVER_ERROR = { success: false };

function createScootersController(scootersApp, logger) {
  const { useCases, commands } = scootersApp;

  return {
    // GET /scooters → array (cached), 500 { success:false }
    async list(req, res) {
      try {
        const r = await useCases.listScooters();
        res.json(r.value.scooters);
      } catch (err) {
        logger.error('scooters list error:', { message: err.message });
        res.status(500).json(SERVER_ERROR);
      }
    },

    // GET /scooters/:id → sanitized scooter | 404 { success:false } | 500
    async details(req, res) {
      try {
        const p = commands.getScooterCommand({ scooterId: req.params.id });
        const r = await useCases.getScooter(p.command);
        if (!r.ok) return res.status(404).json(SERVER_ERROR);
        res.json(r.value.scooter);
      } catch (err) {
        res.status(500).json(SERVER_ERROR);
      }
    },

    // POST /scooter/unlock
    async unlock(req, res) {
      try {
        const p = commands.unlockScooterCommand({
          actorPhone: req.user.phone,
          scooterId: (req.body || {}).scooterId,
        });
        const r = await useCases.unlockScooter(p.command);
        if (!r.ok) {
          const map = {
            [ScootersError.SCOOTER_NOT_FOUND]: 404,
            [ScootersError.USER_NOT_FOUND]: 404,
            [ScootersError.NOT_AVAILABLE]: 400,
            [ScootersError.INSUFFICIENT_BALANCE]: 400,
            [ScootersError.LOW_BATTERY]: 400,
            [ScootersError.UNLOCK_RACE_LOST]: 409,
          };
          return res.status(map[r.code] || 500).json({ success: false, message: msg(req, r.code) });
        }
        res.json({
          success: true,
          message: msg(req, 'UNLOCK_OK'),
          scooter: r.value.scooter,
          rideId: r.value.rideId,
          startTime: r.value.startTime,
        });
      } catch (err) {
        logger.error('unlock error:', { message: err.message });
        res.status(500).json({ success: false, message: msg(req, 'UNLOCK_FAIL') });
      }
    },

    // POST /scooter/rent → 410 (deprecated; unchanged legacy contract)
    rentDeprecated(req, res) {
      return res.status(410).json({
        success: false,
        message: msg(req, 'RENT_DEPRECATED'),
        code: 'ENDPOINT_DEPRECATED',
      });
    },

    // POST /scooter/end-ride
    async endRide(req, res) {
      try {
        const body = req.body || {};
        const p = commands.endRideCommand({
          actorPhone: req.user.phone,
          scooterId: body.scooterId,
          endLat: body.endLat,
          endLng: body.endLng,
        });
        const r = await useCases.endRide(p.command);
        if (!r.ok) {
          if (r.code === ScootersError.SCOOTER_NOT_FOUND)
            return res.status(404).json({ success: false, message: msg(req, r.code) });
          if (r.code === ScootersError.NOT_YOUR_SCOOTER)
            return res.status(403).json({ success: false, message: msg(req, r.code) });
          return res.status(500).json({ success: false, message: msg(req, 'END_FAIL') });
        }
        res.json({
          success: true,
          message: msg(req, 'END_OK'),
          duration: r.value.duration,
          fare: r.value.fare,
          newBalance: r.value.newBalance,
        });
      } catch (err) {
        logger.error('end-ride error:', { message: err.message });
        res.status(500).json({ success: false, message: msg(req, 'END_FAIL') });
      }
    },

    // POST /scooter/return → 410 (deprecated)
    returnDeprecated(req, res) {
      return res.status(410).json({
        success: false,
        message: msg(req, 'RETURN_DEPRECATED'),
        code: 'ENDPOINT_DEPRECATED',
      });
    },

    // GET /scooter/history/:phone → rides array
    async history(req, res) {
      try {
        const p = commands.actorOnlyCommand({ actorPhone: req.user.phone });
        const r = await useCases.getHistory(p.command);
        res.json(r.value.rides);
      } catch (err) {
        res.status(500).json(SERVER_ERROR);
      }
    },

    // GET /scooter/active/:phone → { active:false } | { active:true, scooter, durationMinutes, currentFare }
    async active(req, res) {
      try {
        const p = commands.actorOnlyCommand({ actorPhone: req.user.phone });
        const r = await useCases.getActive(p.command);
        if (!r.value.active) return res.json({ active: false });
        res.json({
          active: true,
          scooter: r.value.scooter,
          durationMinutes: r.value.durationMinutes,
          currentFare: r.value.currentFare,
        });
      } catch (err) {
        res.status(500).json(SERVER_ERROR);
      }
    },

    // POST /admin/scooters → { success:true, id } | 400 | 500
    async addScooter(req, res) {
      try {
        const b = req.body || {};
        const p = commands.addScooterCommand({
          name: b.name,
          scooter_code: b.scooter_code,
          lat: b.lat,
          lng: b.lng,
          battery: b.battery,
        });
        const r = await useCases.addScooter(p.command);
        if (!r.ok) return res.status(400).json({ success: false, message: msg(req, r.code) });
        res.json({ success: true, id: r.value.id });
      } catch (err) {
        res.status(500).json(SERVER_ERROR);
      }
    },

    // DELETE /admin/scooters/:id → { success:true }
    async deleteScooter(req, res) {
      try {
        const p = commands.deleteScooterCommand({ scooterId: req.params.id });
        await useCases.deleteScooter(p.command);
        res.json({ success: true });
      } catch (err) {
        res.status(500).json(SERVER_ERROR);
      }
    },

    // POST /scooters/reset → { success:true }
    async reset(req, res) {
      try {
        await useCases.resetScooters();
        res.json({ success: true });
      } catch (err) {
        res.status(500).json(SERVER_ERROR);
      }
    },
  };
}

module.exports = { createScootersController };
