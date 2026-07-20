'use strict';

/**
 * Notification preference adapter — Infrastructure layer.
 * Implements the notificationPreferences port by delegating to the existing
 * NotificationRepository. Scope this phase = the Users-owned notification
 * surface exposed by legacy src/routes/users.js: list + mark-all-read.
 * Push delivery / device-token mechanics remain the Notifications context
 * (src/routes/notifications.js), untouched.
 *
 * No new SQL is introduced.
 *
 * @param {object} deps — the existing DI service container
 */
function createNotificationPreferenceAdapter(deps) {
  const { notifRepo } = deps;

  return {
    list: (phone, limit) => notifRepo.findByPhone(phone, limit),
    markAllRead: (phone) => notifRepo.markAllRead(phone),
  };
}

module.exports = { createNotificationPreferenceAdapter };
