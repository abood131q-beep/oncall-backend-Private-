'use strict';

const http = require('http');
const { Server } = require('socket.io');
const express = require('express');

// ─── Config & Utils ──────────────────────────────────────────────────────────
const { ADMIN_PHONES, PORT } = require('./src/config/env');
const logger = require('./src/utils/logger');
const {
  safeJSON,
  getDistanceKm,
  sanitizeBody,
  validateCoords,
  validatePhone,
} = require('./src/utils/helpers');

// ─── Middleware ───────────────────────────────────────────────────────────────
const {
  generateJWT,
  verifyJWT,
  authenticate,
  authenticateDriver,
  authenticatePassenger,
  authenticateAdmin,
  getSession,
  revokeTokens,
} = require('./src/middleware/auth');
const { normalLimit, loginLimit, phoneLoginLimit } = require('./src/middleware/rateLimiter');
const { metricsMiddleware, getMetrics } = require('./src/middleware/metrics');
const { setupMiddleware } = require('./src/middleware/setup');

// ─── Database ─────────────────────────────────────────────────────────────────
const { dbGet, dbAll, dbRun } = require('./src/config/database');
const { runMigrations } = require('./src/config/migrate');

// ─── Services ─────────────────────────────────────────────────────────────────
const { createBackup, startBackupSchedule } = require('./src/services/backup');
const { cache, CACHE_TTL, getCache, setCache, clearCache } = require('./src/services/cache');
const {
  FARE_CONFIG,
  getPriceMultiplier,
  calculateFare,
  getFareBreakdown,
  formatTrip,
} = require('./src/services/fareCalculator');

// ─── Socket ───────────────────────────────────────────────────────────────────
const { setupSocket } = require('./src/socket');

// ─── Repositories ─────────────────────────────────────────────────────────────
const { createUserRepository } = require('./src/repositories/UserRepository');
const { createDriverRepository } = require('./src/repositories/DriverRepository');
const { createScooterRepository } = require('./src/repositories/ScooterRepository');
const { createTripRepository } = require('./src/repositories/TripRepository');
const { createWalletRepository } = require('./src/repositories/WalletRepository');
const { createNotificationRepository } = require('./src/repositories/NotificationRepository');
const { createReportRepository } = require('./src/repositories/ReportRepository');

// ─────────────────────────────────────────────────────────────────────────────

logger.success('Environment loaded — JWT_SECRET ready');

const app = express();
const server = http.createServer(app);

// Socket.IO CORS: '*' مقبول لتطبيق Flutter Mobile (لا origin في mobile clients).
// JWT auth middleware على Socket.IO يوفر الحماية الأساسية.
// لتقييد المتصفحات في الإنتاج: SOCKET_CORS_ORIGIN=https://your-dashboard.com
const io = new Server(server, {
  pingTimeout: 30000,
  pingInterval: 10000,
  connectTimeout: 20000,
  cors: {
    origin: process.env.SOCKET_CORS_ORIGIN || '*',
    methods: ['GET', 'POST'],
  },
});

setupMiddleware(app, { sanitizeBody, normalLimit, metricsMiddleware, logger });

// ─── Dependency Injection ─────────────────────────────────────────────────────
const tripTimers = new Map();
const userRepo = createUserRepository({ dbGet, dbAll, dbRun });
const driverRepo = createDriverRepository({ dbGet, dbAll, dbRun });
const scooterRepo = createScooterRepository({ dbGet, dbAll, dbRun });
const tripRepo = createTripRepository({ dbGet, dbAll, dbRun });
const walletRepo = createWalletRepository({ dbGet, dbAll, dbRun });
const notifRepo = createNotificationRepository({ dbGet, dbAll, dbRun });
const reportRepo = createReportRepository({ dbGet, dbAll, dbRun });

const services = {
  dbGet,
  dbAll,
  dbRun,
  logger,
  authenticate,
  authenticateDriver,
  authenticatePassenger,
  authenticateAdmin,
  generateJWT,
  verifyJWT,
  getSession,
  revokeTokens,
  loginLimit,
  phoneLoginLimit,
  cache,
  CACHE_TTL,
  getCache,
  setCache,
  clearCache,
  ADMIN_PHONES,
  FARE_CONFIG,
  calculateFare,
  getFareBreakdown,
  getPriceMultiplier,
  formatTrip,
  safeJSON,
  getDistanceKm,
  validateCoords,
  validatePhone,
  io,
  tripTimers,
  createBackup,
  getMetrics,
  // ── Repositories ──
  userRepo,
  driverRepo,
  scooterRepo,
  tripRepo,
  walletRepo,
  notifRepo,
  reportRepo,
};

setupSocket(io, services);

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/', require('./src/routes/health')(services));
app.use('/', require('./src/routes/auth')(services));
app.use('/', require('./src/routes/users')(services));
app.use('/', require('./src/routes/drivers')(services));
app.use('/', require('./src/routes/scooters')(services));
app.use('/', require('./src/routes/taxi')(services));
app.use('/', require('./src/routes/payment')(services));
app.use('/', require('./src/routes/admin')(services));

app.use((_req, res) => res.status(404).json({ success: false, message: 'الصفحة غير موجودة' }));

// ─── Global Error Handler ─────────────────────────────────────────────────────
// Catches Express errors including PayloadTooLargeError (413), SyntaxError (400), etc.
// Must have 4 parameters for Express to treat it as an error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.status === 413 || err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: 'الطلب كبير جداً (الحد الأقصى 1MB)' });
  }
  if (err.status === 400 && err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'صيغة JSON غير صحيحة' });
  }
  logger.error('Unhandled Express error:', {
    message: err.message,
    stack: err.stack,
    status: err.status,
  });
  res.status(err.status || 500).json({ success: false, message: 'خطأ في السيرفر' });
});

// ─── Start (Async) ────────────────────────────────────────────────────────────
// إصلاح C6: Migrations تعمل قبل server.listen() — يمنع أخطاء "no such column"
// خلال أول ثانيتين من التشغيل.
(async () => {
  await runMigrations(dbRun, logger);
  server.listen(PORT, () => logger.success(`Server + Socket.IO running on port ${PORT}`));
  startBackupSchedule(dbRun, logger); // C4 fix: pass dbRun for WAL checkpoint
})().catch((err) => {
  logger.error('Fatal startup error:', { message: err.message, stack: err.stack });
  process.exit(1);
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);
  // إغلاق Socket.IO أولاً لمنع upgrade requests جديدة (L3 fix)
  io.close(() => {
    server.close((err) => {
      if (err) {
        logger.error('Error during shutdown:', { message: err.message });
        process.exit(1);
      }
      logger.success('Server closed — process exiting');
      process.exit(0);
    });
  });

  setTimeout(() => {
    logger.warn('Forced shutdown after 10s timeout');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
