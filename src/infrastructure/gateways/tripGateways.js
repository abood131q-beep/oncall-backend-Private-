'use strict';

/**
 * Trip gateways — Infrastructure layer.
 * Adapters over EXISTING legacy integrations (reused, never replaced):
 *  - driverGateway      → DriverRepository + taxi status
 *  - matchingGateway    → driverMatcher service (assignment + 30s timers)
 *  - completionGateway  → payment service + notifications inside the serialized
 *                         dbTransaction (Wallet/Payments NOT migrated — reused)
 *  - eventGateway       → Socket.IO emissions + push-if-offline (trip events)
 *  - fareGateway        → fareCalculator + geo helpers
 *  - locationGateway    → taxis location/status writes
 *
 * @param {object} deps — the existing DI service container (server.js `services`)
 */

const { createDriverMatcher } = require('../../services/driverMatcher');
const { createPaymentService } = require('../../services/payment');

function createDriverGateway(deps) {
  const { driverRepo, dbRun } = deps;
  return {
    findByPhone: (phone) => driverRepo.findByPhone(phone),
    findById: (id) => driverRepo.findById(id),
    findTaxi: (driverId) => driverRepo.findTaxi(driverId),
    setTaxiBusy: (taxiId) => dbRun("UPDATE taxis SET status = 'busy' WHERE id = ?", [taxiId]),
    resetTaxiOnline: (driverId) => driverRepo.setTaxiStatus(driverId, 'online'),
    updateRating: (driverId, avg, count) => driverRepo.updateRating(driverId, avg, count),
  };
}

function createMatchingGateway(deps) {
  const { tripTimers } = deps;
  const { findNearestDriver, sendRequestToDriver } = createDriverMatcher(deps);
  return {
    findNearestDriver: (lat, lng, excluded) => findNearestDriver(lat, lng, excluded),
    sendRequestToDriver: (tripId, driver) => sendRequestToDriver(tripId, driver),
    clearTimer: (tripId) => {
      const timer = tripTimers.get(`${tripId}`);
      if (timer) {
        clearTimeout(timer);
        tripTimers.delete(`${tripId}`);
      }
    },
  };
}

function createCompletionGateway(deps) {
  const { dbTransaction, dbRun, notifRepo, logger } = deps;
  const { processPayment } = createPaymentService(deps);
  return {
    // C-1 fix: serialized transaction; payment + status + notification (reused).
    async settle(tripId, trip, finalFare) {
      try {
        await dbTransaction(async () => {
          const paymentMethod = trip.payment_method || 'cash';
          const payResult = await processPayment(tripId, trip.user_phone, finalFare, paymentMethod);
          logger.success(
            `Payment #${tripId}: ${paymentMethod} = ${finalFare} KD - ${payResult.success ? 'OK' : 'FAILED'}`
          );
          await dbRun('UPDATE trips SET payment_status = ? WHERE id = ?', [
            payResult.success ? 'completed' : 'failed',
            tripId,
          ]);
          await notifRepo.sendForTrip(
            trip.user_phone,
            '🏁 وصلت بسلامة',
            `الأجرة: ${finalFare.toFixed(3)} د.ك (${paymentMethod === 'wallet' ? 'محفظة' : 'نقداً'})`,
            'trip_completed',
            tripId
          );
        });
      } catch (payErr) {
        logger.error('Payment transaction failed:', payErr.message);
      }
    },
  };
}

function createEventGateway(deps) {
  const { io, notifService, notifRepo, logger } = deps;
  return {
    statusUpdated(formatted, tripId, status) {
      const room = `trip:${tripId}`;
      const roomClients = io.sockets.adapter.rooms.get(room);
      logger.info(
        `Emitting trip:updated → room ${room} (${roomClients ? roomClients.size : 0} clients) status:${status}`
      );
      io.to(room).emit('trip:updated', formatted);
    },
    noDriver(formatted, tripId) {
      io.to(`trip:${tripId}`).emit('trip:updated', {
        ...formatted,
        status: 'no_driver',
        message: 'لا يوجد سائقون متاحون',
      });
    },
    accepted(formatted, tripId, userPhone) {
      logger.info(`Emitting trip:accepted → passenger:${String(userPhone).slice(0, 3)}***`);
      io.to(`passenger:${userPhone}`).emit('trip:accepted', formatted);
      io.to(`trip:${tripId}`).emit('trip:accepted', formatted);
    },
    driverMoved(tripId, lat, lng, liveStats, status) {
      io.to(`trip:${tripId}`).emit('driver:moved', { tripId, lat, lng, liveStats, status });
    },
    pushStatusChange(updated, status, tripId) {
      if (!(updated.user_phone && notifService?.isConfigured)) return;
      const passengerRoom = `passenger:${updated.user_phone}`;
      const clients = io.sockets.adapter.rooms.get(passengerRoom);
      if (clients && clients.size > 0) return; // online → socket already delivered
      let title = null;
      let body = null;
      if (status === 'accepted') {
        title = '✅ تم قبول رحلتك';
        body = `السائق ${updated.driver_name || ''} في الطريق إليك`;
      } else if (status === 'arrived') {
        title = '📍 السائق وصل';
        body = 'السائق في انتظارك — انزل الآن';
      } else if (status === 'completed') {
        const fare = updated.final_fare != null ? Number(updated.final_fare).toFixed(3) : '—';
        title = '🏁 وصلت بسلامة';
        body = `الأجرة: ${fare} د.ك — شكراً لاستخدام On Call`;
      } else if (status === 'cancelled') {
        title = '❌ تم إلغاء الرحلة';
        body = 'يمكنك طلب سيارة جديدة في أي وقت';
      }
      if (title) {
        notifService
          .send(updated.user_phone, title, body, { tripId: String(tripId), status })
          .catch((e) => logger.error('FCM passenger push error:', { message: e.message }));
      }
    },
    tripNotify: (phone, title, body, type, tripId) =>
      notifRepo.sendForTrip(phone, title, body, type, tripId),
  };
}

function createFareGateway(deps) {
  const { getFareBreakdown, calculateFare, getDistanceKm, validateCoords } = deps;
  return {
    estimate: (distKm, estMin) => getFareBreakdown(distKm, estMin).total,
    calculate: (distKm, min) => calculateFare(distKm, min),
    distanceKm: (a, b, c, d) => getDistanceKm(a, b, c, d),
    validateCoords: (lat, lng) => validateCoords(lat, lng),
  };
}

function createLocationGateway(deps) {
  const { dbRun } = deps;
  return {
    updateTaxiLocation: (lat, lng, driverId) =>
      dbRun('UPDATE taxis SET lat = ?, lng = ? WHERE driver_id = ?', [lat, lng, driverId]),
    resetTaxis: () => dbRun("UPDATE taxis SET status = 'online'"),
  };
}

module.exports = {
  createDriverGateway,
  createMatchingGateway,
  createCompletionGateway,
  createEventGateway,
  createFareGateway,
  createLocationGateway,
};
