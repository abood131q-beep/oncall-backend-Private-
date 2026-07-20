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

/**
 * dbTransaction — ينفّذ مجموعة عمليات داخل BEGIN IMMEDIATE / COMMIT / ROLLBACK.
 *
 * يضمن:
 *  - Atomicity: إما جميع العمليات أو لا شيء.
 *  - Isolation: BEGIN IMMEDIATE يمنع أي كاتب آخر من البدء أثناء التنفيذ.
 *  - No Lost Updates: أي فحص + تحديث داخل fn() لن يُعارض طلباً متزامناً.
 *
 * P6-06 FIX — JS-level retry لـ SQLITE_BUSY:
 * ─────────────────────────────────────────────
 * sqlite3 (Node.js) يستخدم background thread واحد لكل connection.
 * إذا استخدمنا `busyTimeout` (C level):
 *   - Thread B تنتظر داخل busy-sleep → يُحجب الـ background thread
 *   - Thread A لا تستطيع تشغيل db.get/COMMIT لأن الـ thread محجوب
 *   - نتيجة: deadlock → timeout → 500
 *
 * الحل: busyTimeout=0 في database.js → SQLITE_BUSY يُعاد فوراً (لا blocking).
 * هنا نمسك الخطأ ونُعيد المحاولة بـ setTimeout (JS — non-blocking):
 *   - الـ DB thread يتحرر فوراً
 *   - Thread A تُكمل db.get + COMMIT في الخلفية
 *   - بعد الـ delay تُعيد Thread B المحاولة → تنجح
 *
 * @param {() => Promise<any>} fn - الدالة التي تحتوي على عمليات DB
 * @returns {Promise<any>}
 */
async function _runTransaction(fn) {
  const MAX_RETRIES = 10;
  const BASE_DELAY_MS = 20; // delays: 20, 30, 40 ... 120ms — total max ~770ms

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await dbRun('BEGIN IMMEDIATE');
    } catch (beginErr) {
      lastErr = beginErr;
      const isBusy =
        beginErr.code === 'SQLITE_BUSY' ||
        (beginErr.message && beginErr.message.includes('SQLITE_BUSY'));
      if (isBusy && attempt < MAX_RETRIES) {
        // non-blocking wait — الـ event loop يستمر وعمليات DB الأخرى تكتمل
        await new Promise((r) => setTimeout(r, BASE_DELAY_MS + attempt * 10));
        continue; // retry BEGIN IMMEDIATE
      }
      throw beginErr; // خطأ غير BUSY أو نفدت المحاولات
    }

    // BEGIN IMMEDIATE نجح — نُنفّذ جسم الـ transaction
    try {
      const result = await fn();
      await dbRun('COMMIT');
      return result;
    } catch (innerErr) {
      try {
        await dbRun('ROLLBACK');
      } catch (_) {
        // ROLLBACK فشل — الـ connection مغلق أو مكسور
      }
      throw innerErr; // لا نُعيد المحاولة — fn() نُفِّذ جزئياً
    }
  }

  // نصل هنا فقط إذا نفدت المحاولات (MAX_RETRIES+1 مرة بدون نجاح)
  throw lastErr || new Error('dbTransaction: failed to acquire write lock after retries');
}

// ───── In-process transaction serialization (C-1 fix) ─────────────────────────
// sqlite3 (Node.js) يستخدم اتصالاً واحداً مشتركاً. عند بدء معاملتين متزامنتين،
// الثانية ترمي "cannot start a transaction within a transaction" (SQLITE_ERROR،
// وليس SQLITE_BUSY — لذا آلية إعادة المحاولة أعلاه لا تلتقطه). هذا الطابور يضمن
// أن معاملة واحدة فقط مفتوحة في كل لحظة: المتصل المتزامن ينتظر بدل أن يتصادم.
// السلوك محفوظ تماماً (تسلسل فقط)، والتوقيع لم يتغيّر.
let _txChain = Promise.resolve();

/**
 * dbTransaction — نفس عقد _runTransaction لكن مُسلسَل عبر العملية.
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
function dbTransaction(fn) {
  const exclusive = () => _runTransaction(fn);
  // نُسلسِل بغضّ النظر عن نجاح/فشل المعاملة السابقة (كلاهما يُحرِّر القفل).
  const result = _txChain.then(exclusive, exclusive);
  // نمنع أي رفض من كسر السلسلة للمتصلين اللاحقين.
  _txChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

// ───── Engine selection (Phase 13: SQLite → PostgreSQL) ──────────────────────
// DEFAULT is SQLite (local dev + the byte-identical test suite). Setting
// DB_ENGINE=postgres swaps in the pooled PG adapter, which implements the EXACT
// same { dbGet, dbAll, dbRun, dbTransaction } contract — so no repository, use
// case, route, or Socket.IO handler changes. Under Postgres the in-process
// serialization mutex above is unnecessary (MVCC provides cross-process
// isolation); the PG adapter uses real BEGIN/COMMIT with an AsyncLocalStorage
// transaction context, preserving the no-arg dbTransaction(fn) call pattern.
if ((process.env.DB_ENGINE || 'sqlite').toLowerCase() === 'postgres') {
  const { createPostgresAdapter } = require('../infrastructure/db/postgresAdapter');
  let _logger = null;
  try {
    _logger = require('../utils/logger');
  } catch {
    /* logger optional at this layer */
  }
  const pg = createPostgresAdapter(_logger);
  module.exports = {
    dbGet: pg.dbGet,
    dbAll: pg.dbAll,
    dbRun: pg.dbRun,
    dbTransaction: pg.dbTransaction,
    _engine: 'postgres',
    _pool: pg.pool,
  };
} else {
  module.exports = { dbGet, dbAll, dbRun, dbTransaction, _engine: 'sqlite' };
}
