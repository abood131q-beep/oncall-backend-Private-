'use strict';

/**
 * migrate.js — OnCall DB schema migrations
 *
 * يُضيف الأعمدة المفقودة عند بدء التشغيل (آمن للتشغيل المتكرر).
 * يتجاهل خطأ "duplicate column" تلقائياً.
 */

const COLUMNS = [
  // trips columns
  'ALTER TABLE trips ADD COLUMN rating_comment TEXT',
  'ALTER TABLE trips ADD COLUMN driver_rating INTEGER',
  'ALTER TABLE trips ADD COLUMN driver_rating_comment TEXT',
  'ALTER TABLE trips ADD COLUMN passenger_rating INTEGER',
  "ALTER TABLE trips ADD COLUMN rejected_drivers TEXT DEFAULT '[]'",
  'ALTER TABLE trips ADD COLUMN assigned_driver_id INTEGER',
  'ALTER TABLE trips ADD COLUMN assigned_driver_name TEXT',
  'ALTER TABLE trips ADD COLUMN request_sent_at INTEGER',
  // L4: updated_at — SQLite لا يقبل function() كـ DEFAULT في ALTER TABLE
  'ALTER TABLE trips ADD COLUMN updated_at DATETIME',
  'ALTER TABLE users ADD COLUMN updated_at DATETIME',
  'ALTER TABLE drivers ADD COLUMN updated_at DATETIME',
  // M12: consolidated from root database.js
  'ALTER TABLE users ADD COLUMN is_active INTEGER DEFAULT 1',
  'ALTER TABLE drivers ADD COLUMN is_active INTEGER DEFAULT 1',
  'ALTER TABLE scooters ADD COLUMN ride_start_time INTEGER',
  'ALTER TABLE scooters ADD COLUMN current_user_phone TEXT',
  'ALTER TABLE scooter_rides ADD COLUMN end_time INTEGER',
  'ALTER TABLE scooter_rides ADD COLUMN end_lat REAL',
  'ALTER TABLE scooter_rides ADD COLUMN end_lng REAL',
];

// إصلاح L4: triggers تُحدِّث updated_at تلقائياً عند كل UPDATE
// CREATE TRIGGER IF NOT EXISTS آمن للتشغيل المتكرر
const TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS trips_updated_at
   AFTER UPDATE ON trips FOR EACH ROW
   BEGIN UPDATE trips SET updated_at = DATETIME('now') WHERE id = NEW.id; END`,
  `CREATE TRIGGER IF NOT EXISTS users_updated_at
   AFTER UPDATE ON users FOR EACH ROW
   BEGIN UPDATE users SET updated_at = DATETIME('now') WHERE id = NEW.id; END`,
  `CREATE TRIGGER IF NOT EXISTS drivers_updated_at
   AFTER UPDATE ON drivers FOR EACH ROW
   BEGIN UPDATE drivers SET updated_at = DATETIME('now') WHERE id = NEW.id; END`,
];

/**
 * @param {Function} dbRun  - Promise wrapper لـ db.run
 * @param {object}   logger - OnCall logger
 */
async function runMigrations(dbRun, logger) {
  for (const sql of COLUMNS) {
    try {
      await dbRun(sql);
    } catch (e) {
      if (e && !e.message.includes('duplicate column')) {
        logger.error('Migration:', e.message);
      }
    }
  }
  for (const sql of TRIGGERS) {
    try {
      await dbRun(sql);
    } catch (e) {
      logger.error('Trigger migration:', e.message);
    }
  }
  console.log('✅ DB columns verified');
}

module.exports = { runMigrations };
