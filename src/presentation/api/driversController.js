'use strict';

const { DriversError } = require('../../application/drivers/useCases');

const SERVER_ERROR = { success: false };
const ar = Object.freeze({
  [DriversError.DRIVER_NOT_FOUND]: 'السائق غير موجود',
  [DriversError.ALREADY_APPROVED]: 'السائق معتمد بالفعل',
  [DriversError.ALREADY_REJECTED]: 'السائق مرفوض بالفعل',
  [DriversError.ALREADY_SUSPENDED]: 'الحساب موقوف بالفعل',
  [DriversError.IS_PENDING]: 'السائق قيد المراجعة — استخدم Approve لاعتماده',
  [DriversError.REASON_TOO_SHORT]: 'سبب الرفض مطلوب (5 أحرف على الأقل)',
  [DriversError.REASON_TOO_LONG]: 'سبب الرفض لا يتجاوز 500 حرف',
});
const en = Object.freeze({
  [DriversError.DRIVER_NOT_FOUND]: 'Driver not found',
  [DriversError.ALREADY_APPROVED]: 'Driver is already approved',
  [DriversError.ALREADY_REJECTED]: 'Driver is already rejected',
  [DriversError.ALREADY_SUSPENDED]: 'Account is already suspended',
  [DriversError.IS_PENDING]: 'Driver is pending review — use Approve',
  [DriversError.REASON_TOO_SHORT]: 'A rejection reason of at least 5 characters is required',
  [DriversError.REASON_TOO_LONG]: 'Rejection reason must not exceed 500 characters',
});
function localized(req, code) {
  return String(req.headers['accept-language'] || '')
    .toLowerCase()
    .startsWith('en')
    ? en[code] || code
    : ar[code] || code;
}

function createDriversController(driversApp, logger, formatTrip) {
  const { useCases, commands } = driversApp;
  const command = (name, input) => commands[name](input);
  const failure = (req, res, result, fallback = 500, reasonSubject = 'الرفض') => {
    const code = result.code;
    if (code === DriversError.DRIVER_NOT_FOUND)
      return res.status(404).json({ success: false, message: localized(req, code) });
    if (code === DriversError.DRIVER_NOT_APPROVED)
      return res.status(403).json({
        success: false,
        status: result.status,
        message: 'حسابك لم يتم اعتماده — لا يمكنك الانتقال إلى حالة Online.',
      });
    if (code === DriversError.REASON_TOO_SHORT)
      return res
        .status(400)
        .json({ success: false, message: localized(req, code).replace('الرفض', reasonSubject) });
    if (code === DriversError.REASON_TOO_LONG)
      return res.status(400).json({ success: false, message: localized(req, code) });
    if (
      [
        DriversError.ALREADY_APPROVED,
        DriversError.ALREADY_REJECTED,
        DriversError.ALREADY_SUSPENDED,
        DriversError.IS_PENDING,
      ].includes(code)
    )
      return res.status(400).json({
        success: false,
        ...(code !== DriversError.IS_PENDING ? { code } : {}),
        message: localized(req, code),
      });
    return res.status(fallback).json(SERVER_ERROR);
  };
  const own = (name, map) => async (req, res) => {
    try {
      const result = await useCases[name](
        command(map, { actorPhone: req.user.phone, ...(req.body || {}), ...(req.params || {}) })
      );
      if (!result.ok) return failure(req, res, result);
      return result;
    } catch (err) {
      logger.error(`driver ${name} error:`, err.message);
      return res.status(500).json(SERVER_ERROR);
    }
  };
  return {
    changeAvailability: async (req, res) => {
      const result = await own('changeAvailability', 'changeAvailabilityCommand')(req, {
        ...res,
        json: (body) => res.json(body),
        status: (n) => res.status(n),
      });
      if (result && result.ok) res.json({ success: true });
    },
    getProfile: async (req, res) => {
      try {
        const r = await useCases.getProfile(
          command('getProfileCommand', { actorPhone: req.user.phone })
        );
        if (!r.ok) return res.status(404).json(SERVER_ERROR);
        res.json({ success: true, driver: r.value.driver });
      } catch (_err) {
        res.status(500).json(SERVER_ERROR);
      }
    },
    updateProfile: async (req, res) => {
      try {
        const body = req.body || {};
        const result = await useCases.updateProfile(
          command('updateProfileCommand', {
            actorPhone: req.user.phone,
            name: body.name,
            carName: body.car_name,
            plate: body.plate,
          })
        );
        res.json({ success: true, driver: result.value.driver });
      } catch (_err) {
        res.status(500).json(SERVER_ERROR);
      }
    },
    getTrips: async (req, res) => {
      const result = await own('getTrips', 'getTripsCommand')(req, res);
      if (result && result.ok) res.json(result.value.trips.map(formatTrip));
    },
    getStats: async (req, res) => {
      try {
        const r = await useCases.getStats(
          command('getStatsCommand', { actorPhone: req.user.phone })
        );
        if (!r.ok) return res.status(404).json(SERVER_ERROR);
        res.json({ success: true, stats: r.value.stats });
      } catch (err) {
        logger.error('driver stats error:', err.message);
        res.status(500).json(SERVER_ERROR);
      }
    },
    getReviews: async (req, res) => {
      try {
        const r = await useCases.getReviews(
          command('getReviewsCommand', { actorPhone: req.user.phone })
        );
        if (!r.ok) return res.status(404).json(SERVER_ERROR);
        res.json({
          success: true,
          avgRating: r.value.avgRating,
          totalRatings: r.value.totalRatings,
          reviews: r.value.reviews,
        });
      } catch (_err) {
        res.status(500).json(SERVER_ERROR);
      }
    },
    listDrivers: async (_req, res) => {
      try {
        const r = await useCases.listDrivers();
        res.json(r.value.drivers);
      } catch {
        res.status(500).json(SERVER_ERROR);
      }
    },
    listPending: async (_req, res) => {
      try {
        const r = await useCases.listPending();
        res.json({ success: true, count: r.value.drivers.length, drivers: r.value.drivers });
      } catch (err) {
        logger.error('admin pending drivers error:', err.message);
        res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
      }
    },
    getDriver: async (req, res) => {
      try {
        const r = await useCases.getDriver(
          command('getDriverCommand', { phone: req.params.phone })
        );
        if (!r.ok) return failure(req, res, r);
        res.json({ success: true, driver: r.value.driver });
      } catch {
        res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
      }
    },
    toggleDriver: async (req, res) => {
      try {
        const r = await useCases.toggleDriver(
          command('toggleDriverCommand', { phone: req.params.phone })
        );
        if (!r.ok) return res.status(404).json(SERVER_ERROR);
        res.json({ success: true, is_active: r.value.isActive });
      } catch {
        res.status(500).json(SERVER_ERROR);
      }
    },
    approvalHistory: async (req, res) => {
      try {
        const r = await useCases.approvalHistory(
          command('approvalHistoryCommand', { phone: req.params.phone })
        );
        res.json({
          success: true,
          driverPhone: req.params.phone,
          count: r.value.history.length,
          history: r.value.history,
        });
      } catch (err) {
        logger.error('admin approval-history error:', err.message);
        res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
      }
    },
    transition: (name, commandName) => async (req, res) => {
      try {
        const r = await useCases[name](
          command(commandName, {
            phone: req.params.phone,
            reason: (req.body || {}).reason,
            actorPhone: req.user.phone,
            ip: req.ip,
          })
        );
        if (!r.ok) return failure(req, res, r, 500, name === 'suspendDriver' ? 'التعليق' : 'الرفض');
        res.json({ success: true, driver: r.value.driver });
      } catch (err) {
        logger.error(`admin ${name} driver error:`, err.message);
        res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
      }
    },
  };
}
module.exports = { createDriversController };
