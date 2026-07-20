'use strict';

const { reconstituteDriver } = require('../../domain/drivers/Driver');
const {
  DriversRejection,
  approvalDecision,
  rejectionDecision,
  suspensionDecision,
  reactivationDecision,
} = require('../../domain/drivers/driverPolicies');

function createDriversUseCases(ports) {
  const {
    driverRepository: repo,
    driverReadModel: read,
    driverSessionControl: sessions,
    auditLog,
  } = ports;
  const notFound = () => ({ ok: false, code: DriversRejection.DRIVER_NOT_FOUND });

  async function ownDriver(phone) {
    const row = await repo.findByPhone(phone);
    return row ? reconstituteDriver(row) : null;
  }

  async function changeAvailability(command) {
    const driver = await ownDriver(command.actorPhone);
    // Legacy only loads the driver for an online transition. Offline is a
    // harmless no-op for a missing record and still returns `{ success:true }`.
    if (!driver) {
      if (command.isOnline)
        return { ok: false, code: DriversRejection.DRIVER_NOT_APPROVED, status: 'pending' };
      await repo.setStatus(command.actorPhone, 'offline');
      return { ok: true, value: {} };
    }
    const decision = driver.availabilityChange(command.isOnline);
    if (!decision.allowed)
      return { ok: false, code: DriversRejection.DRIVER_NOT_APPROVED, status: decision.status };
    await repo.setStatus(driver.phone, decision.status);
    if (driver.id) await repo.setTaxiStatus(driver.id, decision.status);
    return { ok: true, value: {} };
  }

  async function getProfile(command) {
    const driver = await repo.findByPhone(command.actorPhone);
    return driver ? { ok: true, value: { driver } } : notFound();
  }

  async function updateProfile(command) {
    const driver = await ownDriver(command.actorPhone);
    if (!driver) return { ok: true, value: { driver: null } }; // legacy endpoint returns 200/null
    const patch = driver.profileChange(command);
    const updated = await repo.updateProfile(driver.phone, patch.name, patch.carName, patch.plate);
    return { ok: true, value: { driver: updated } };
  }

  async function getTrips(command) {
    const driver = await ownDriver(command.actorPhone);
    if (!driver) return { ok: true, value: { trips: [] } };
    return { ok: true, value: { trips: await read.findTrips(driver.id, driver.row.name, 100) } };
  }

  async function getStats(command) {
    const driver = await ownDriver(command.actorPhone);
    if (!driver) return notFound();
    const s = await read.getStats(driver.id);
    const totalMinutes = s.totalMinutes || 0;
    return {
      ok: true,
      value: {
        stats: {
          totalTrips: s.totalTrips || 0,
          completedTrips: s.completedTrips || 0,
          cancelledTrips: s.cancelledTrips || 0,
          totalEarnings: Math.round((s.totalEarnings || 0) * 1000) / 1000,
          todayEarnings: Math.round((s.todayEarnings || 0) * 1000) / 1000,
          weekEarnings: Math.round((s.weekEarnings || 0) * 1000) / 1000,
          totalHours: Math.round((totalMinutes / 60) * 10) / 10,
          totalMinutes,
          acceptanceRate:
            s.totalTrips > 0 ? Math.round((s.respondedTrips / s.totalTrips) * 100) : 100,
          avgRating: Math.round((s.avgRating || 5.0) * 10) / 10,
          driverName: driver.row.name,
          driverStatus: driver.row.status,
          carName: driver.row.car_name || '',
          plate: driver.row.plate || '',
        },
      },
    };
  }

  async function getReviews(command) {
    const driver = await ownDriver(command.actorPhone);
    if (!driver) return notFound();
    return {
      ok: true,
      value: {
        avgRating: driver.row.rating || 5.0,
        totalRatings: driver.row.total_ratings || 0,
        reviews: await read.getReviews(driver.id),
      },
    };
  }

  async function ensureDriver(phone) {
    const row = await repo.findByPhone(phone);
    return row || null;
  }
  async function transition(command, decide) {
    const exists = await ensureDriver(command.phone);
    if (!exists) return notFound();
    let outcome;
    await repo.withLock(command.phone, () =>
      repo.transaction(async () => {
        const fresh = await repo.findByPhone(command.phone);
        const decision = decide(fresh.approval_status, command.reason);
        if (!decision.allowed) {
          outcome = { ok: false, code: decision.code };
          return;
        }
        await repo.setApprovalStatus(command.phone, decision.next, {
          reason: decision.reason,
          adminPhone: command.actorPhone,
        });
        await repo.logApprovalAction({
          driverPhone: command.phone,
          adminPhone: command.actorPhone,
          action: decision.action,
          reason: decision.reason,
          ip: command.ip,
        });
        outcome = { ok: true, value: { event: decision.action } };
      })
    );
    if (!outcome.ok) return outcome;
    const driver = await repo.findByPhone(command.phone);
    auditLog.security(`DRIVER_${outcome.value.event}`, {
      adminPhone: command.actorPhone,
      driverPhone: command.phone,
      ip: command.ip,
    });
    if (outcome.value.event === 'SUSPENDED') {
      sessions.revokeAccess(command.phone);
      await sessions.revokeRefresh(command.phone);
      sessions.forceDisconnect(command.phone);
    }
    return { ok: true, value: { driver, event: outcome.value.event } };
  }

  async function listDrivers() {
    return { ok: true, value: { drivers: await repo.findAll() } };
  }
  async function listPending() {
    const drivers = await repo.findPending();
    return { ok: true, value: { drivers } };
  }
  async function getDriver(command) {
    const driver = await ensureDriver(command.phone);
    return driver ? { ok: true, value: { driver } } : notFound();
  }
  async function toggleDriver(command) {
    const driver = await ensureDriver(command.phone);
    if (!driver) return notFound();
    const active = driver.is_active === 0 ? 1 : 0;
    await repo.setActive(command.phone, active);
    if (!active) await repo.setStatus(command.phone, 'offline');
    return { ok: true, value: { isActive: active } };
  }
  async function approvalHistory(command) {
    return { ok: true, value: { history: await repo.getApprovalHistory(command.phone) } };
  }

  return {
    changeAvailability,
    getProfile,
    updateProfile,
    getTrips,
    getStats,
    getReviews,
    listDrivers,
    listPending,
    getDriver,
    toggleDriver,
    approveDriver: (c) => transition(c, approvalDecision),
    rejectDriver: (c) => transition(c, rejectionDecision),
    suspendDriver: (c) => transition(c, suspensionDecision),
    reactivateDriver: (c) => transition(c, reactivationDecision),
    approvalHistory,
  };
}

module.exports = { createDriversUseCases, DriversError: DriversRejection };
