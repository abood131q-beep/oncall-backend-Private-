'use strict';

/**
 * Admin controller — Presentation layer.
 * HTTP translation only; ZERO business logic (ADR-005 §4). Every outcome is a
 * typed result from the application; this file maps it to the frozen response
 * contract (status, JSON shape, key order, Arabic messages must remain
 * byte-identical to src/routes/admin.js). Proven by the live A/B harness.
 *
 * GLOBALIZATION (ADR-003, non-breaking): Arabic is the frozen default; English
 * is additive via `Accept-Language: en` and never alters Arabic output.
 */

const { AdminError } = require('../../application/admin/useCases');

const ar = Object.freeze({
  [AdminError.USER_NOT_FOUND]: 'المستخدم غير موجود',
  [AdminError.TAXI_NAME_REQUIRED]: 'اسم التاكسي مطلوب',
  [AdminError.BAD_COORDS]: 'إحداثيات غير صحيحة',
  [AdminError.RESTORE_NOT_CONFIRMED]:
    'أضف "confirm": "RESTORE_CONFIRMED" في الـ body لتأكيد الاستعادة',
  [AdminError.BAD_BACKUP_NAME]: 'اسم ملف النسخة الاحتياطية غير صالح',
  [AdminError.SHUTDOWN_NOT_CONFIRMED]:
    'أضف "confirm": "SHUTDOWN_CONFIRMED" في الـ body لتأكيد الإيقاف',
  SERVER_ERROR: 'خطأ في السيرفر',
  BACKUP_DONE: 'تم إنشاء نسخة احتياطية',
  VACUUM_DONE: 'VACUUM completed — database compacted and defragmented',
  REINDEX_DONE: 'REINDEX completed — all indexes rebuilt',
  SHUTDOWN_OK: 'الخادم سيُوقَف بشكل سلس خلال ثانية...',
  RESTORE_WARNING: 'يجب إعادة تشغيل الخادم لتفعيل الاستعادة بشكل آمن',
});
const en = Object.freeze({
  [AdminError.USER_NOT_FOUND]: 'User not found',
  [AdminError.TAXI_NAME_REQUIRED]: 'Taxi name is required',
  [AdminError.BAD_COORDS]: 'Invalid coordinates',
  [AdminError.RESTORE_NOT_CONFIRMED]:
    'Add "confirm": "RESTORE_CONFIRMED" to the body to confirm the restore',
  [AdminError.BAD_BACKUP_NAME]: 'Invalid backup filename',
  [AdminError.SHUTDOWN_NOT_CONFIRMED]:
    'Add "confirm": "SHUTDOWN_CONFIRMED" to the body to confirm shutdown',
  SERVER_ERROR: 'Server error',
  BACKUP_DONE: 'Backup created',
  VACUUM_DONE: 'VACUUM completed — database compacted and defragmented',
  REINDEX_DONE: 'REINDEX completed — all indexes rebuilt',
  SHUTDOWN_OK: 'The server will shut down gracefully within a second...',
  RESTORE_WARNING: 'The server must be restarted for the restore to take effect safely',
});
function msg(req, code) {
  return String(req.headers['accept-language'] || '')
    .toLowerCase()
    .startsWith('en')
    ? en[code] || code
    : ar[code] || code;
}
const BARE = { success: false };

function createAdminController(adminApp, logger) {
  const { useCases, commands } = adminApp;

  // Plain data reads: send value; 500 → { success:false }
  const dataGet = (name) => async (req, res) => {
    try {
      const r = await useCases[name]();
      res.json(r.value);
    } catch (err) {
      res.status(500).json(BARE);
    }
  };
  // Data reads that take a query arg but still fail bare (legacy analytics).
  const dataGetArg = (name, arg) => async (req, res) => {
    try {
      const r = await useCases[name](arg(req));
      res.json(r.value);
    } catch (err) {
      res.status(500).json(BARE);
    }
  };
  // Ops reads: send value; 500 → { success:false, message: err.message }
  const opsGet = (name, arg) => async (req, res) => {
    try {
      const r = arg ? await useCases[name](arg(req)) : await useCases[name]();
      res.json(r.value);
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  };

  return {
    stats: dataGet('stats'),
    listUsers: dataGet('listUsers'),
    listReports: dataGet('listReports'),
    revenue: dataGet('revenue'),
    analytics: dataGetArg(
      'analytics',
      (req) => commands.nQueryCommand({ period: req.query.period }).command
    ),
    backups: dataGet('backups'),
    dashboard: opsGet('dashboard'),
    systemInfo: opsGet('systemInfo'),
    dbHealth: opsGet('dbHealth'),
    metrics: opsGet('metrics'),
    securityEvents: opsGet(
      'securityEvents',
      (req) => commands.nQueryCommand({ n: req.query.n }).command
    ),
    errors: opsGet('errors', (req) => commands.nQueryCommand({ n: req.query.n }).command),
    crashes: opsGet('crashes', (req) => commands.nQueryCommand({ n: req.query.n }).command),
    notificationStats: opsGet('notificationStats'),
    logs: opsGet(
      'logs',
      (req) => commands.nQueryCommand({ n: req.query.n, level: req.query.level }).command
    ),

    async listTrips(req, res) {
      try {
        const r = await useCases.listTrips(
          commands.paginationCommand({
            page: req.query.page,
            limit: req.query.limit,
            status: req.query.status,
          }).command
        );
        res.json(r.value);
      } catch (err) {
        res.status(500).json(BARE);
      }
    },

    async cancelTrip(req, res) {
      try {
        const r = await useCases.cancelTrip(commands.idCommand({ id: req.params.id }).command);
        if (!r.ok) return res.status(404).json(BARE);
        res.json({ success: true });
      } catch (err) {
        res.status(500).json(BARE);
      }
    },

    async getUser(req, res) {
      try {
        const r = await useCases.getUser(
          commands.phoneCommand({ phone: req.params.phone }).command
        );
        if (!r.ok) return res.status(404).json({ success: false, message: msg(req, r.code) });
        res.json({ success: true, user: r.value.user });
      } catch (err) {
        res.status(500).json({ success: false, message: msg(req, 'SERVER_ERROR') });
      }
    },

    async toggleUser(req, res) {
      try {
        const r = await useCases.toggleUser(
          commands.phoneCommand({ phone: req.params.phone }).command
        );
        if (!r.ok) return res.status(404).json(BARE);
        res.json({ success: true, is_active: r.value.is_active });
      } catch (err) {
        res.status(500).json(BARE);
      }
    },

    async addTaxi(req, res) {
      try {
        const b = req.body || {};
        const r = await useCases.addTaxi(
          commands.addTaxiCommand({ name: b.name, lat: b.lat, lng: b.lng }).command
        );
        if (!r.ok) return res.status(400).json({ success: false, message: msg(req, r.code) });
        res.json({ success: true, id: r.value.id });
      } catch (err) {
        res.status(500).json(BARE);
      }
    },

    async deleteTaxi(req, res) {
      try {
        await useCases.deleteTaxi(commands.idCommand({ id: req.params.id }).command);
        res.json({ success: true });
      } catch (err) {
        res.status(500).json(BARE);
      }
    },

    async resolveReport(req, res) {
      try {
        await useCases.resolveReport(commands.idCommand({ id: req.params.id }).command);
        res.json({ success: true });
      } catch (err) {
        res.status(500).json(BARE);
      }
    },

    async createBackup(req, res) {
      try {
        await useCases.createBackup();
        res.json({ success: true, message: msg(req, 'BACKUP_DONE') });
      } catch (err) {
        res.status(500).json(BARE);
      }
    },

    async vacuum(req, res) {
      try {
        await useCases.vacuum();
        res.json({ success: true, message: msg(req, 'VACUUM_DONE') });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    },

    async reindex(req, res) {
      try {
        await useCases.reindex();
        res.json({ success: true, message: msg(req, 'REINDEX_DONE') });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    },

    async clearLogs(req, res) {
      try {
        const r = await useCases.clearLogs();
        res.json(r.value);
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    },

    async restore(req, res) {
      try {
        const b = req.body || {};
        const r = await useCases.restore(
          commands.restoreCommand({ filename: b.filename, confirm: b.confirm }).command,
          require('path').basename
        );
        if (!r.ok) {
          if (r.code === AdminError.BACKUP_NOT_FOUND) {
            const safe = require('path').basename(String(b.filename || ''));
            return res.status(404).json({ success: false, message: `النسخة غير موجودة: ${safe}` });
          }
          return res.status(400).json({ success: false, message: msg(req, r.code) });
        }
        res.json({
          success: true,
          message: `تمت الاستعادة من ${b.filename}. نسخة أمان: ${r.value.safetyBackup}. الخادم سيُعاد تشغيله...`,
          safetyBackup: r.value.safetyBackup,
          warning: msg(req, 'RESTORE_WARNING'),
        });
      } catch (err) {
        logger.error('DB restore error:', err.message);
        res.status(500).json({ success: false, message: err.message });
      }
    },

    async shutdown(req, res) {
      const r = await useCases.shutdown(
        commands.shutdownCommand({ confirm: (req.body || {}).confirm }).command
      );
      if (!r.ok) return res.status(400).json({ success: false, message: msg(req, r.code) });
      res.json({ success: true, message: msg(req, 'SHUTDOWN_OK') });
    },
  };
}

module.exports = { createAdminController };
