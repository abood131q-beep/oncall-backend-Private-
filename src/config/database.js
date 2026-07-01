'use strict';

/**
 * database.js — OnCall database connection + helper wrappers
 *
 * يُصدِّر:
 *  - dbGet  : تنفيذ SELECT يُعيد صفاً واحداً
 *  - dbAll  : تنفيذ SELECT يُعيد جميع الصفوف
 *  - dbRun  : تنفيذ INSERT / UPDATE / DELETE
 *
 * يُفعّل WAL mode + إعدادات الأداء عند أوّل تحميل.
 */

const db = require('../../database');

// ───── إعدادات الأداء والأمان ────────────────────────────────────────────────
db.run('PRAGMA journal_mode=WAL');
db.run('PRAGMA synchronous=NORMAL');
db.run('PRAGMA cache_size=10000');
db.run('PRAGMA temp_store=MEMORY');
// Enforce FK constraints — SQLite disables them by default (C5 fix)
db.run('PRAGMA foreign_keys = ON');

// ───── Promise wrappers ───────────────────────────────────────────────────────

const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });

const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });

const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      err ? reject(err) : resolve(this);
    });
  });

module.exports = { dbGet, dbAll, dbRun };
