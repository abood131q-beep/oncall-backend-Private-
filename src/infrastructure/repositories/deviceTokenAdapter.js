'use strict';

/**
 * Device-token adapter — Infrastructure layer.
 * Implements the deviceTokenRepository port. This is the ADR-005 correction for
 * the Notifications context: the raw SQL that lived inside the legacy route now
 * lives here, behind the port. The statements are byte-for-byte the legacy ones
 * (same UPSERT/SELECT/DELETE/ORDER), so behavior is preserved exactly.
 *
 * @param {object} deps — the existing DI service container (dbRun/dbGet/dbAll)
 */
function createDeviceTokenAdapter(deps) {
  const { dbRun, dbGet, dbAll } = deps;

  return {
    upsert: (phone, token, platform, appVersion) =>
      dbRun(
        `INSERT INTO device_tokens (phone, device_token, platform, app_version, last_seen, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(phone, device_token)
         DO UPDATE SET
           app_version = excluded.app_version,
           last_seen   = CURRENT_TIMESTAMP,
           updated_at  = CURRENT_TIMESTAMP`,
        [phone, token, platform, appVersion]
      ),

    findOne: (phone, token) =>
      dbGet('SELECT id FROM device_tokens WHERE phone = ? AND device_token = ?', [phone, token]),

    remove: (phone, token) =>
      dbRun('DELETE FROM device_tokens WHERE phone = ? AND device_token = ?', [phone, token]),

    listForPhone: (phone) =>
      dbAll(
        'SELECT platform, app_version, last_seen, created_at FROM device_tokens WHERE phone = ? ORDER BY last_seen DESC',
        [phone]
      ),
  };
}

module.exports = { createDeviceTokenAdapter };
