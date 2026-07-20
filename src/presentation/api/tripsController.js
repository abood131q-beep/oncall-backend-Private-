'use strict';

/**
 * Trips controller — Presentation layer.
 * HTTP translation only; ZERO business logic (ADR-005 §4). Every outcome is a
 * typed result from the application; this file maps it to the frozen response
 * contract (status, JSON shape, key order, Arabic messages must remain
 * byte-identical to src/routes/taxi.js). Proven by the live A/B harness.
 *
 * GLOBALIZATION (ADR-003, non-breaking): Arabic is the frozen default; English
 * is additive via `Accept-Language: en` and never alters Arabic output.
 */

const { TripsError } = require('../../application/trips/useCases');

const ar = Object.freeze({
  [TripsError.MISSING_FIELDS]: 'بيانات الرحلة ناقصة',
  [TripsError.BAD_PICKUP_COORDS]: 'إحداثيات نقطة الانطلاق غير صحيحة',
  [TripsError.BAD_DEST_COORDS]: 'إحداثيات الوجهة غير صحيحة',
  [TripsError.INVALID_STATUS]: 'الحالة غير صحيحة',
  [TripsError.DRIVER_ONLY]: 'هذا الإجراء مخصص للسائقين فقط',
  [TripsError.TRIP_NOT_FOUND]: 'الرحلة غير موجودة',
  [TripsError.ALREADY_ACCEPTED]: 'تم قبول هذه الرحلة من سائق آخر',
  [TripsError.DRIVER_NOT_FOUND]: 'السائق غير موجود في النظام',
  [TripsError.NOT_TRIP_DRIVER_START]: 'فقط سائق الرحلة يستطيع بدء الرحلة',
  [TripsError.NOT_TRIP_DRIVER_COMPLETE]: 'فقط سائق الرحلة يستطيع إنهاء الرحلة',
  [TripsError.NOT_CANCELLABLE]: 'لا يمكن إلغاء هذه الرحلة في حالتها الحالية',
  [TripsError.NOT_OWNER_CANCEL]: 'فقط الراكب أو سائق الرحلة يستطيع الإلغاء',
  [TripsError.NOT_TRIP_DRIVER_MISC]: 'غير مصرح لك بتغيير حالة هذه الرحلة',
  [TripsError.RATING_RANGE]: 'التقييم يجب أن يكون بين 1 و 5',
  [TripsError.NOT_PASSENGER_RATER]: 'يمكن للراكب الأصلي فقط تقييم السائق',
  [TripsError.NOT_DRIVER_RATER]: 'يمكن للسائق الأصلي فقط تقييم الراكب',
  [TripsError.ALREADY_RATED]: 'لقد قيّمت هذه الرحلة مسبقاً',
  [TripsError.NOT_COMPLETED_FOR_RATING]: 'يمكن تقييم الرحلات المكتملة فقط',
  [TripsError.LOCATION_FORBIDDEN]: 'غير مصرح لك بتحديث موقع هذه الرحلة',
  [TripsError.ACCESS_FORBIDDEN]: 'غير مصرح',
  SERVER_ERROR: 'خطأ في السيرفر',
  NO_DRIVERS: 'لا يوجد سائقون متاحون',
  REASSIGNING: 'جاري إرسال الطلب لسائق آخر',
  RATE_THANKS: 'شكراً على تقييمك! ⭐',
  RATE_DONE: 'تم تسجيل التقييم',
  ALREADY_RATED_PASSENGER: 'لقد قيّمت هذا الراكب مسبقاً',
});
const en = Object.freeze({
  [TripsError.MISSING_FIELDS]: 'Trip details are incomplete',
  [TripsError.BAD_PICKUP_COORDS]: 'Invalid pickup coordinates',
  [TripsError.BAD_DEST_COORDS]: 'Invalid destination coordinates',
  [TripsError.INVALID_STATUS]: 'Invalid status',
  [TripsError.DRIVER_ONLY]: 'This action is for drivers only',
  [TripsError.TRIP_NOT_FOUND]: 'Trip not found',
  [TripsError.ALREADY_ACCEPTED]: 'This trip was accepted by another driver',
  [TripsError.DRIVER_NOT_FOUND]: 'Driver not found in the system',
  [TripsError.NOT_TRIP_DRIVER_START]: 'Only the trip driver can start the trip',
  [TripsError.NOT_TRIP_DRIVER_COMPLETE]: 'Only the trip driver can end the trip',
  [TripsError.NOT_CANCELLABLE]: 'This trip cannot be cancelled in its current state',
  [TripsError.NOT_OWNER_CANCEL]: 'Only the passenger or the trip driver can cancel',
  [TripsError.NOT_TRIP_DRIVER_MISC]: 'You are not authorized to change this trip status',
  [TripsError.RATING_RANGE]: 'Rating must be between 1 and 5',
  [TripsError.NOT_PASSENGER_RATER]: 'Only the original passenger can rate the driver',
  [TripsError.NOT_DRIVER_RATER]: 'Only the original driver can rate the passenger',
  [TripsError.ALREADY_RATED]: 'You have already rated this trip',
  [TripsError.NOT_COMPLETED_FOR_RATING]: 'Only completed trips can be rated',
  [TripsError.LOCATION_FORBIDDEN]: 'You are not authorized to update this trip location',
  [TripsError.ACCESS_FORBIDDEN]: 'Not authorized',
  SERVER_ERROR: 'Server error',
  NO_DRIVERS: 'No drivers available',
  REASSIGNING: 'Reassigning the request to another driver',
  RATE_THANKS: 'Thank you for your rating! ⭐',
  RATE_DONE: 'Rating recorded',
  ALREADY_RATED_PASSENGER: 'You have already rated this passenger',
});

function msg(req, code) {
  return String(req.headers['accept-language'] || '')
    .toLowerCase()
    .startsWith('en')
    ? en[code] || code
    : ar[code] || code;
}
const BARE = { success: false };

function actor(req) {
  return {
    actorPhone: req.user.phone,
    actorType: req.user.type,
    actorRole: req.user.role,
    actorDriverId: req.user.driverId,
  };
}

function createTripsController(tripsApp, logger, coLocated) {
  const { useCases, commands } = tripsApp;

  return {
    // POST /taxi/request
    async createTrip(req, res) {
      try {
        const b = req.body || {};
        const p = commands.createTripCommand({ actorPhone: req.user.phone, ...b });
        const r = await useCases.createTrip(p.command);
        if (!r.ok) return res.status(400).json({ success: false, message: msg(req, r.code) });
        res.json({ success: true, trip: r.value.trip });
        // Legacy ordering: response first, then dispatch matching (fire-and-forget).
        useCases
          .dispatchMatching({
            tripId: r.value.tripId,
            pickupLat: r.value.pickupLat,
            pickupLng: r.value.pickupLng,
            formatted: r.value.trip,
          })
          .catch((e) => logger.error('dispatchMatching error:', { message: e.message }));
      } catch (err) {
        logger.error('taxi/request error:', err.message);
        res.status(500).json({ success: false, message: msg(req, 'SERVER_ERROR') });
      }
    },

    // POST /taxi/trips/:id/reject
    async reject(req, res) {
      try {
        const p = commands.tripIdActorCommand({ ...actor(req), id: req.params.id });
        const r = await useCases.rejectTrip(p.command);
        if (!r.ok) return res.status(r.code === 'REJECT_NO_DRIVER' ? 403 : 400).json(BARE);
        res.json({
          success: true,
          message: msg(req, r.value.reassigned ? 'REASSIGNING' : 'NO_DRIVERS'),
        });
      } catch (err) {
        res.status(500).json(BARE);
      }
    },

    // GET /taxi/trips
    async listDriverTrips(req, res) {
      try {
        const r = await useCases.listDriverTrips(
          commands.actorOnlyCommand({ actorPhone: req.user.phone }).command
        );
        res.json(r.value.trips);
      } catch (err) {
        res.status(500).json(BARE);
      }
    },

    // GET /taxi/requests
    async listRequests(req, res) {
      try {
        const r = await useCases.listRequests();
        res.json(r.value.trips);
      } catch (err) {
        res.status(500).json([]);
      }
    },

    // GET /taxi/trips/passenger/:phone
    async listPassengerTrips(req, res) {
      try {
        const r = await useCases.listPassengerTrips(
          commands.actorOnlyCommand({ actorPhone: req.user.phone }).command
        );
        res.json(r.value.trips);
      } catch (err) {
        res.status(500).json(BARE);
      }
    },

    // PUT /taxi/trips/:id/status
    async updateStatus(req, res) {
      try {
        const p = commands.updateStatusCommand({
          actorPhone: req.user.phone,
          actorType: req.user.type,
          id: req.params.id,
          status: (req.body || {}).status,
        });
        const r = await useCases.updateTripStatus(p.command);
        if (!r.ok) {
          const map = {
            [TripsError.INVALID_STATUS]: 400,
            [TripsError.DRIVER_ONLY]: 403,
            [TripsError.TRIP_NOT_FOUND]: 404,
            [TripsError.ALREADY_ACCEPTED]: 400,
            [TripsError.DRIVER_NOT_FOUND]: 403,
            [TripsError.NOT_TRIP_DRIVER_START]: 403,
            [TripsError.NOT_TRIP_DRIVER_COMPLETE]: 403,
            [TripsError.NOT_CANCELLABLE]: 400,
            [TripsError.NOT_OWNER_CANCEL]: 403,
            [TripsError.NOT_TRIP_DRIVER_MISC]: 403,
          };
          return res.status(map[r.code] || 500).json({ success: false, message: msg(req, r.code) });
        }
        res.json({ success: true, trip: r.value.trip });
      } catch (err) {
        logger.error('trip status update error:', err.message);
        res.status(500).json(BARE);
      }
    },

    // POST /taxi/trips/:id/rate
    async rate(req, res) {
      try {
        const b = req.body || {};
        const p = commands.rateCommand({
          actorPhone: req.user.phone,
          id: req.params.id,
          rating: b.rating,
          comment: b.comment,
        });
        const r = await useCases.rateTrip(p.command);
        if (!r.ok) {
          if (r.code === TripsError.RATING_RANGE)
            return res.status(400).json({ success: false, message: msg(req, r.code) });
          if (r.code === TripsError.TRIP_NOT_FOUND) return res.status(404).json(BARE);
          if (r.code === TripsError.NOT_PASSENGER_RATER)
            return res.status(403).json({ success: false, message: msg(req, r.code) });
          if (r.code === TripsError.ALREADY_RATED)
            return res.status(409).json({ success: false, message: msg(req, r.code) });
          if (r.code === TripsError.NOT_COMPLETED_FOR_RATING)
            return res.status(400).json({ success: false, message: msg(req, r.code) });
          return res.status(500).json(BARE);
        }
        res.json({ success: true, message: msg(req, 'RATE_THANKS') });
      } catch (err) {
        logger.error('rate error:', err.message);
        res.status(500).json(BARE);
      }
    },

    // POST /taxi/trips/:id/rate-passenger
    async ratePassenger(req, res) {
      try {
        const b = req.body || {};
        const p = commands.rateCommand({
          actorPhone: req.user.phone,
          id: req.params.id,
          rating: b.rating,
          comment: b.comment,
        });
        const r = await useCases.ratePassenger(p.command);
        if (!r.ok) {
          if (r.code === 'RATING_BARE') return res.status(400).json(BARE);
          if (r.code === TripsError.TRIP_NOT_FOUND) return res.status(404).json(BARE);
          if (r.code === TripsError.NOT_DRIVER_RATER)
            return res.status(403).json({ success: false, message: msg(req, r.code) });
          if (r.code === TripsError.ALREADY_RATED)
            return res
              .status(409)
              .json({ success: false, message: msg(req, 'ALREADY_RATED_PASSENGER') });
          if (r.code === TripsError.NOT_COMPLETED_FOR_RATING)
            return res.status(400).json({ success: false, message: msg(req, r.code) });
          return res.status(500).json(BARE);
        }
        res.json({ success: true, message: msg(req, 'RATE_DONE') });
      } catch (err) {
        res.status(500).json(BARE);
      }
    },

    // POST /taxi/update-location
    async updateLocation(req, res) {
      try {
        const b = req.body || {};
        const p = commands.updateLocationCommand({
          actorPhone: req.user.phone,
          tripId: b.tripId,
          lat: b.lat,
          lng: b.lng,
        });
        const r = await useCases.updateLocation(p.command);
        if (!r.ok) {
          if (r.code === TripsError.TRIP_NOT_FOUND) return res.status(404).json(BARE);
          if (r.code === TripsError.LOCATION_FORBIDDEN)
            return res.status(403).json({ success: false, message: msg(req, r.code) });
          return res.status(500).json(BARE);
        }
        res.json({ success: true, liveStats: r.value.liveStats });
      } catch (err) {
        res.status(500).json(BARE);
      }
    },

    // GET /taxi/trips/:id/location
    async getLocation(req, res) {
      try {
        const p = commands.tripIdActorCommand({ ...actor(req), id: req.params.id });
        const r = await useCases.getTripLocation(p.command);
        if (!r.ok) {
          if (r.code === TripsError.TRIP_NOT_FOUND) return res.status(404).json(BARE);
          return res.status(403).json({ success: false, message: msg(req, r.code) });
        }
        const t = r.value.trip;
        res.json({
          success: true,
          driverLat: t.driver_lat,
          driverLng: t.driver_lng,
          driverName: t.driver_name,
          pickupLat: t.pickup_lat,
          pickupLng: t.pickup_lng,
          destLat: t.dest_lat,
          destLng: t.dest_lng,
          status: t.status,
          route: r.value.route,
          estimatedFare: t.estimated_fare,
          finalFare: t.final_fare,
          liveStats: r.value.liveStats,
        });
      } catch (err) {
        res.status(500).json(BARE);
      }
    },

    // GET /taxi/trips/:id
    async getTrip(req, res) {
      try {
        const p = commands.tripIdActorCommand({ ...actor(req), id: req.params.id });
        const r = await useCases.getTrip(p.command);
        if (!r.ok) {
          if (r.code === TripsError.TRIP_NOT_FOUND) return res.status(404).json(BARE);
          return res.status(403).json({ success: false, message: msg(req, r.code) });
        }
        res.json({ success: true, trip: r.value.trip });
      } catch (err) {
        res.status(500).json(BARE);
      }
    },

    // DELETE /taxi/trips (admin)
    async deleteAll(req, res) {
      try {
        await useCases.deleteAllTrips();
        res.json({ success: true });
      } catch (err) {
        res.status(500).json(BARE);
      }
    },

    // ── Co-located non-Trips passthroughs (byte-identical, pending Fleet/Maps) ──
    async listTaxis(req, res) {
      try {
        res.json(await coLocated.fleet.listTaxis());
      } catch (err) {
        res.status(500).json(BARE);
      }
    },
    async placesAutocomplete(req, res) {
      const { input, lat, lng } = req.query;
      res.json(await coLocated.places.autocomplete(input, lat, lng));
    },
    async placesDetails(req, res) {
      res.json(await coLocated.places.details(req.query.place_id));
    },
  };
}

module.exports = { createTripsController };
