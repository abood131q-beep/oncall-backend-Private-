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
  // P6-06: Driver Approval Workflow — approval_status هو مصدر الحقيقة الوحيد
  // القيم: pending | approved | rejected | suspended
  // is_active يبقى للتوافق مع الكود القديم ويُحدَّث معه دائماً — مخطط إزالته لاحقاً
  "ALTER TABLE drivers ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'pending'",
  'ALTER TABLE drivers ADD COLUMN rejection_reason TEXT',
  'ALTER TABLE drivers ADD COLUMN suspended_reason TEXT',
  'ALTER TABLE drivers ADD COLUMN approved_by TEXT',
  'ALTER TABLE drivers ADD COLUMN approved_at DATETIME',
  'ALTER TABLE drivers ADD COLUMN approval_updated_at DATETIME',
];

// P6-05A: جدول revoked_tokens — لحفظ حالة الإلغاء عبر إعادة التشغيل
// P6-04B: جدول otp_codes — رموز التحقق بصلاحية 5 دقائق
const TABLES = [
  `CREATE TABLE IF NOT EXISTS revoked_tokens (
    phone     TEXT PRIMARY KEY,
    revoked_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS otp_codes (
    phone      TEXT PRIMARY KEY,
    code_hash  TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts   INTEGER DEFAULT 0
  )`,
  // P6-05B: قفل هاتف — يبقى فعّالاً بعد إعادة تشغيل السيرفر
  `CREATE TABLE IF NOT EXISTS rate_limit_locks (
    phone        TEXT PRIMARY KEY,
    locked_until INTEGER NOT NULL
  )`,
  // P6-06: سجل تدقيق عمليات الاعتماد — يُحفظ مَن وافق/رفض/علّق وكيف ومتى
  `CREATE TABLE IF NOT EXISTS driver_approval_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    driver_phone TEXT NOT NULL,
    admin_phone  TEXT NOT NULL,
    action       TEXT NOT NULL,
    reason       TEXT,
    ip           TEXT,
    created_at   DATETIME DEFAULT (DATETIME('now'))
  )`,
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

// P6-06: Indexes that depend on migrated columns/tables — يُنشَأن بعد COLUMNS + TABLES
// لا يمكن وضعهم في database.js لأنهم يعتمدون على approval_status وdriver_approval_logs
// اللذين يُضافان هنا — وليس عند تحميل الـ module.
const INDEXES = [
  // يُسرِّع driverMatcher.js + auth.js + socket.js (WHERE approval_status='approved')
  'CREATE INDEX IF NOT EXISTS idx_drivers_approval ON drivers(approval_status)',
  // يُسرِّع GET /admin/drivers/:phone/approval-history
  'CREATE INDEX IF NOT EXISTS idx_approval_logs_driver ON driver_approval_logs(driver_phone)',
];

// P6-06: Data migrations — تُنفَّذ بعد إضافة الأعمدة
// آمنة للتشغيل المتكرر: تُحدِّث فقط الصفوف التي approval_status لا يزال 'pending' مع is_active=1
const DATA_MIGRATIONS = [
  // السائقون الذين كانوا مفعَّلين يدوياً قبل P6-06 → approved
  // نستخدم approval_status='pending' كفلتر لضمان عدم تعديل صفوف سبق معالجتها
  `UPDATE drivers
   SET approval_status = 'approved',
       is_active       = 1,
       approved_at     = DATETIME('now'),
       approved_by     = 'system:migration_p6-06',
       approval_updated_at = DATETIME('now')
   WHERE is_active = 1 AND approval_status = 'pending'`,
  // السائقون المحظورون يدوياً قبل P6-06 يبقون pending (لا نعرف السبب الأصلي)
  // is_active=0 + approval_status='pending' = يحتاج مراجعة يدوية من المشرف

  // P6-06: Retroactive audit logs للسائقين المُدرَجين قبل P6-06
  // يُنشئ سجل APPROVED لكل سائق معتمد لا يملك أي سجل تدقيق بعد
  // آمن للتشغيل المتكرر: WHERE NOT IN (SELECT DISTINCT driver_phone ...) يمنع التكرار
  `INSERT INTO driver_approval_logs (driver_phone, admin_phone, action, reason, ip)
   SELECT phone, 'system:migration_p6-06', 'APPROVED',
          'اعتماد تلقائي عند ترقية النظام إلى P6-06', 'migration'
   FROM drivers
   WHERE approval_status = 'approved'
     AND phone NOT IN (
       SELECT DISTINCT driver_phone FROM driver_approval_logs WHERE action = 'APPROVED'
     )`,
];

/**
 * @param {Function} dbRun  - Promise wrapper لـ db.run
 * @param {object}   logger - OnCall logger
 */
async function runMigrations(dbRun, logger) {
  for (const sql of TABLES) {
    try {
      await dbRun(sql);
    } catch (e) {
      logger.error('Table migration:', e.message);
    }
  }
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
  // P6-06: Indexes التي تعتمد على أعمدة/جداول مُضافة أعلاه
  for (const sql of INDEXES) {
    try {
      await dbRun(sql);
    } catch (e) {
      logger.error('Index migration:', e.message);
    }
  }
  // P6-06: تطبيق Data Migrations بعد تأكيد وجود الأعمدة
  for (const sql of DATA_MIGRATIONS) {
    try {
      await dbRun(sql);
    } catch (e) {
      logger.error('Data migration:', e.message);
    }
  }
  logger.success('DB columns + triggers + indexes verified');
}

module.exports = { runMigrations };
