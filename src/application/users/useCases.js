'use strict';

/**
 * Users use cases — Application layer (ADR-005 §5/§6).
 *
 * Each use case runs the canonical lifecycle for its command: authorization
 * (§11, before any domain work) → domain decision → side effects via ports →
 * typed result. Behavior is a 1:1 migration of src/routes/users.js: identical
 * outcomes, identical ordering.
 *
 * Results: { ok: true, value } | { ok: false, code, ...details }.
 * No transport, storage, or vendor knowledge exists here (ADR-005 §4).
 */

const { reconstituteUser } = require('../../domain/users/User');
const {
  UsersRejection,
  balanceReadAuthorization,
  normalizeReportType,
} = require('../../domain/users/userPolicies');

const UsersError = Object.freeze({ ...UsersRejection });

function createUsersUseCases(ports) {
  const { userRepository, readModel, notificationPreferences, auditLog } = ports;

  /**
   * UpdateProfile — rename the authenticated passenger; returns the updated
   * user row (frozen contract: `{ success, user }`).
   */
  async function updateProfile(command) {
    const row = await userRepository.updateName(command.actorPhone, command.name);
    // Aggregate models the change; the row is the persistence truth returned
    // to the mobile fleet unchanged (byte-fidelity with legacy).
    reconstituteUser(row).rename(command.name);
    return { ok: true, value: { user: row } };
  }

  /**
   * GetBalance — read-only projection. Authorization first (may read only
   * one's own balance), then 404 when the subject has no record.
   */
  async function getBalance(command) {
    const auth = balanceReadAuthorization(command.actorPhone, command.targetPhone);
    if (!auth.allowed) return { ok: false, code: auth.code };

    const row = await readModel.getBalance(command.actorPhone);
    if (!row) return { ok: false, code: UsersError.USER_NOT_FOUND };
    return { ok: true, value: { balance: row.balance } };
  }

  /**
   * GetActivity — read-only transaction projection (User Activity). Legacy
   * ignores the path phone and always uses the authenticated phone; no
   * authorization branch exists here by design.
   */
  async function getActivity(command) {
    const activity = await readModel.getActivity(command.actorPhone, 50);
    return { ok: true, value: { activity } };
  }

  /** ListNotifications — authenticated phone only (legacy ignores path phone). */
  async function listNotifications(command) {
    const notifications = await notificationPreferences.list(command.actorPhone, 20);
    return { ok: true, value: { notifications } };
  }

  /** MarkNotificationsRead — authenticated phone only. */
  async function markNotificationsRead(command) {
    await notificationPreferences.markAllRead(command.actorPhone);
    return { ok: true, value: {} };
  }

  /** SubmitReport — user-authored report; type defaulted by domain policy. */
  async function submitReport(command) {
    const type = normalizeReportType(command.type);
    await userRepository.submitReport(
      command.actorPhone,
      type,
      command.description,
      command.tripId
    );
    auditLog.info('User report submitted');
    return { ok: true, value: {} };
  }

  return {
    updateProfile,
    getBalance,
    getActivity,
    listNotifications,
    markNotificationsRead,
    submitReport,
  };
}

module.exports = { createUsersUseCases, UsersError };
