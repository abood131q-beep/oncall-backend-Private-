'use strict';

/**
 * Scooters use cases — Application layer (ADR-005 §5/§6).
 *
 * Each use case runs the canonical lifecycle: validation → authorization →
 * domain decision → side effects via ports → typed result. Behavior is a 1:1
 * migration of src/routes/scooters.js: identical outcomes, identical ordering
 * of security-relevant and transactional steps.
 *
 * Results: { ok: true, value } | { ok: false, code, ...details }.
 * No transport, storage, SQL, or vendor knowledge exists here (ADR-005 §4).
 */

const { publicView } = require('../../domain/scooters/Scooter');
const {
  ScooterRejection,
  unlockPolicy,
  lockPolicy,
  settleRide,
  liveFare,
} = require('../../domain/scooters/scooterPolicies');

const ScootersError = Object.freeze({ ...ScooterRejection });
const CACHE_KEY = 'scooters';

function createScootersUseCases(ports) {
  const {
    scooterRepository,
    scooterReadModel,
    scooterCache,
    walletGateway,
    notificationGateway,
    fleetGateway,
    auditLog,
    cacheTtl,
    validateCoords,
  } = ports;

  /** ListScooters — cache-first, public projection (byte-identical to legacy). */
  async function listScooters() {
    const cached = scooterCache.get(CACHE_KEY);
    if (cached) return { ok: true, value: { scooters: cached, cached: true } };
    const rows = await scooterReadModel.findAll();
    const safe = rows.map(publicView);
    scooterCache.set(CACHE_KEY, safe, cacheTtl.scooters);
    return { ok: true, value: { scooters: safe, cached: false } };
  }

  /** GetScooter — public projection or not-found. */
  async function getScooter(command) {
    const row = await scooterReadModel.findById(command.scooterId);
    if (!row) return { ok: false, code: ScootersError.SCOOTER_NOT_FOUND };
    return { ok: true, value: { scooter: publicView(row) } };
  }

  /** UnlockScooter — availability/balance/battery gates, atomic claim, notify. */
  async function unlockScooter(command) {
    const scooter = await scooterReadModel.findByIdRaw(command.scooterId);
    const user = await scooterReadModel.findUserByPhone(command.actorPhone);
    if (!scooter) return { ok: false, code: ScootersError.SCOOTER_NOT_FOUND };
    if (!user) return { ok: false, code: ScootersError.USER_NOT_FOUND };

    const gate = unlockPolicy(scooter, user.balance);
    if (!gate.allowed) return { ok: false, code: gate.code };

    const startTime = Date.now();
    // Atomic claim (WHERE status='available') — TOCTOU-safe, mirrors legacy.
    const lock = await scooterRepository.setRiding(
      command.scooterId,
      command.actorPhone,
      startTime
    );
    if (lock.changes === 0) return { ok: false, code: ScootersError.UNLOCK_RACE_LOST };
    scooterCache.clear(CACHE_KEY);

    const ride = await scooterRepository.createRide(
      command.scooterId,
      command.actorPhone,
      startTime
    );
    auditLog.info(
      `Scooter #${command.scooterId} unlocked by ${String(command.actorPhone).slice(0, 3)}***`
    );
    await notificationGateway.send(
      command.actorPhone,
      '🛴 تم فتح قفل السكوتر',
      `استمتع برحلتك! السكوتر ${scooter.name} جاهز`,
      'scooter_unlocked'
    );

    return {
      ok: true,
      value: {
        scooter: { ...scooter, status: 'riding' },
        rideId: ride.lastID,
        startTime,
      },
    };
  }

  /** EndRide — ownership gate, atomic settlement (available + record + charge). */
  async function endRide(command) {
    const scooter = await scooterReadModel.findByIdRaw(command.scooterId);
    if (!scooter) return { ok: false, code: ScootersError.SCOOTER_NOT_FOUND };

    const gate = lockPolicy(scooter, command.actorPhone);
    if (!gate.allowed) return { ok: false, code: gate.code };

    const endTime = Date.now();
    const startTime = scooter.ride_start_time || endTime;
    const { durationMinutes, fare, newBattery } = settleRide(startTime, endTime, scooter.battery);

    try {
      // One serialized transaction boundary (C-1 safe) — mirrors legacy exactly.
      await scooterRepository.transaction(async () => {
        await scooterRepository.setAvailable(
          command.scooterId,
          newBattery,
          command.endLat,
          command.endLng,
          scooter.lat,
          scooter.lng
        );
        scooterCache.clear(CACHE_KEY);
        await scooterRepository.endRide(
          command.scooterId,
          command.actorPhone,
          endTime,
          durationMinutes,
          fare,
          command.endLat,
          command.endLng
        );
        // Reuse the existing Wallet integration (NOT migrated): best-effort charge.
        await walletGateway.charge(command.actorPhone, fare, `أجرة سكوتر ${durationMinutes} دقيقة`);
      });
    } catch (err) {
      auditLog.error('Scooter end-ride transaction failed:', { message: err.message });
      return { ok: false, code: 'END_RIDE_FAILED' };
    }

    auditLog.info(`Scooter #${command.scooterId} ride ended: ${durationMinutes}min = ${fare} KD`);
    const finalUser = await scooterReadModel.findUserByPhone(command.actorPhone);
    return {
      ok: true,
      value: {
        duration: durationMinutes,
        fare,
        newBalance: finalUser ? finalUser.balance : 0,
      },
    };
  }

  /** GetHistory — the user's own ride log (JWT phone; legacy ignores path phone). */
  async function getHistory(command) {
    const rides = await scooterReadModel.getRideHistory(command.actorPhone);
    return { ok: true, value: { rides } };
  }

  /** GetActive — the user's current ride with live fare, or inactive. */
  async function getActive(command) {
    const scooter = await scooterReadModel.findActiveByPhone(command.actorPhone);
    if (!scooter) return { ok: true, value: { active: false } };
    const now = Date.now();
    const startTime = scooter.ride_start_time || now;
    const { durationMinutes, currentFare } = liveFare(startTime, now);
    return { ok: true, value: { active: true, scooter, durationMinutes, currentFare } };
  }

  /** AddScooter (admin) — coord validation, then create. */
  async function addScooter(command) {
    if (command.lat != null || command.lng != null) {
      if (!validateCoords(command.lat, command.lng)) {
        return { ok: false, code: ScootersError.INVALID_COORDS };
      }
    }
    const result = await scooterRepository.create(
      command.name,
      command.scooterCode,
      command.lat,
      command.lng,
      command.battery
    );
    return { ok: true, value: { id: result.lastID } };
  }

  /** DeleteScooter (admin). */
  async function deleteScooter(command) {
    await scooterRepository.remove(command.scooterId);
    return { ok: true, value: {} };
  }

  /** ResetScooters (admin) — reset all + bring taxis online (legacy side-effect). */
  async function resetScooters() {
    await scooterRepository.resetAll();
    await fleetGateway.bringTaxisOnline();
    return { ok: true, value: {} };
  }

  return {
    listScooters,
    getScooter,
    unlockScooter,
    endRide,
    getHistory,
    getActive,
    addScooter,
    deleteScooter,
    resetScooters,
  };
}

module.exports = { createScootersUseCases, ScootersError };
