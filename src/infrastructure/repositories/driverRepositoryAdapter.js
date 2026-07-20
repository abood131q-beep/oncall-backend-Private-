'use strict';

/** Drivers persistence adapter. SQL required only for the approval-history read
 * model remains confined to Infrastructure; all other calls delegate to the
 * certified legacy repository during the strangler transition. */
function createDriverRepositoryAdapter(deps) {
  const { driverRepo, dbAll, dbTransaction } = deps;
  const locks = new Map();
  function withLock(phone, work) {
    const previous = locks.get(phone) || Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    const settled = next.catch(() => {});
    locks.set(phone, settled);
    settled.then(() => {
      if (locks.get(phone) === settled) locks.delete(phone);
    });
    return next;
  }
  return {
    findByPhone: (phone) => driverRepo.findByPhone(phone),
    findAll: () => driverRepo.findAll(),
    findPending: () => driverRepo.findPending(),
    updateProfile: (phone, name, carName, plate) =>
      driverRepo.updateProfile(phone, name, carName, plate),
    setStatus: (phone, status) => driverRepo.setStatus(phone, status),
    setTaxiStatus: (id, status) => driverRepo.setTaxiStatus(id, status),
    setActive: (phone, active) => driverRepo.setActive(phone, active),
    setApprovalStatus: (phone, status, options) =>
      driverRepo.setApprovalStatus(phone, status, options),
    logApprovalAction: (entry) => driverRepo.logApprovalAction(entry),
    getApprovalHistory: (phone) =>
      dbAll(
        `SELECT id, admin_phone, action, reason, ip, created_at
       FROM driver_approval_logs WHERE driver_phone = ? ORDER BY created_at DESC LIMIT 50`,
        [phone]
      ),
    withLock,
    transaction: (work) => dbTransaction(work),
  };
}
module.exports = { createDriverRepositoryAdapter };
