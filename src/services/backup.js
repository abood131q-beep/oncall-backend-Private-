'use strict';

/**
 * BackupService — نسخ احتياطي تلقائي لقاعدة البيانات
 *
 * المسؤوليات:
 *  - WAL checkpoint قبل النسخ لضمان اتساق البيانات (C4 fix)
 *  - إنشاء نسخة من oncall.db في مجلد backups/
 *  - الاحتفاظ بآخر 7 نسخ فقط (حذف الأقدم تلقائياً)
 *  - جدولة النسخ كل 6 ساعات + نسخة فور بدء التشغيل
 *
 * إصلاح C4: WAL mode يخزن آخر الكتابات في .db-wal.
 * نسخ oncall.db وحده ينتج بيانات قديمة/ناقصة.
 * الحل: PRAGMA wal_checkpoint(FULL) يدمج WAL في الملف الرئيسي قبل النسخ.
 */

const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', '..', 'oncall.db');
const BACKUP_DIR = path.join(__dirname, '..', '..', 'backups');
const MAX_BACKUPS = 7;
const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 ساعات
const STARTUP_MS = 5000; // 5 ثوانٍ بعد البدء

// يُحفَظ عند startBackupSchedule ويُستخدم في createBackup
let _dbRun = null;
let _logger = null;

/**
 * ينشئ نسخة احتياطية فورية من قاعدة البيانات.
 * آمن للاستدعاء في أي وقت — يتجاهل الأخطاء بهدوء.
 * @returns {Promise<void>}
 */
async function createBackup() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

    // دمج WAL في ملف DB قبل النسخ — يضمن اتساق البيانات
    if (_dbRun) {
      try {
        await _dbRun('PRAGMA wal_checkpoint(FULL)');
      } catch (cpErr) {
        const msg = `WAL checkpoint warning: ${cpErr.message}`;
        _logger ? _logger.warn(msg) : console.warn(msg);
      }
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFile = path.join(BACKUP_DIR, `oncall_${timestamp}.db`);

    fs.copyFileSync(DB_FILE, backupFile);

    const msg = `Backup created: oncall_${timestamp}.db`;
    _logger ? _logger.success(msg) : console.log(`✅ ${msg}`);

    // احتفظ بآخر MAX_BACKUPS نسخ فقط
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.db'))
      .sort();

    if (files.length > MAX_BACKUPS) {
      for (const f of files.slice(0, files.length - MAX_BACKUPS)) {
        fs.unlinkSync(path.join(BACKUP_DIR, f));
        const delMsg = `Old backup deleted: ${f}`;
        _logger ? _logger.info(delMsg) : console.log(`🗑️  ${delMsg}`);
      }
    }
  } catch (err) {
    const msg = `Backup error: ${err.message}`;
    _logger ? _logger.error(msg) : console.error(msg);
  }
}

/**
 * يبدأ جدولة النسخ الاحتياطي التلقائي.
 * يُستدعى مرة واحدة فقط عند بدء تشغيل السيرفر.
 * @param {Function} dbRun  - Promise wrapper لـ db.run (لـ WAL checkpoint)
 * @param {object}  [logger] - OnCall logger
 */
function startBackupSchedule(dbRun, logger) {
  _dbRun = dbRun || null;
  _logger = logger || null;

  setTimeout(createBackup, STARTUP_MS).unref();
  setInterval(createBackup, INTERVAL_MS).unref();
}

module.exports = { createBackup, startBackupSchedule };
