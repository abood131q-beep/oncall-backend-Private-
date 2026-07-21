'use strict';

/**
 * onCallApplication.js — Phase 17.2
 *
 * Behavior-IDENTICAL extraction of the OnCall backend wiring + startup + shutdown that
 * previously lived inline in server.js. It exposes the exact same runtime as a factory so
 * the process can be launched by EITHER:
 *   • the legacy launcher (server.js, unchanged behavior), OR
 *   • the Enterprise Hosted Service (OnCallAppService, ADR-044).
 *
 * NOTHING about application behavior changes. This module:
 *   • builds Express + Socket.IO + middleware + DI services + routes exactly as before,
 *   • runs the identical async startup sequence in start(),
 *   • performs the identical graceful close in stop().
 *
 * IMPORTANT (Phase 17.2 boundary): this is an APPLICATION module. It imports NO Enterprise
 * kernel, platform, runtime, host, or platform-adapter. The Enterprise integration wraps
 * this object from the outside; it never reaches inside it.
 *
 * Startup order (identical to legacy server.js):
 *   Environment → Database → Migrations → Revocation Store → Rate Limit Store → Redis →
 *   Socket.IO → Routes → HTTP Listen → Background Jobs
 * (Socket.IO handlers and Routes are wired synchronously at construction — exactly as the
 *  legacy module-level code did — then the async steps run in start().)
 */

const http = require('http');
const { Server } = require('socket.io');
const express = require('express');

// ─── Config & Utils ──────────────────────────────────────────────────────────
// Phase 18.4: config read via the runtime facade (single approved config-read seam).
const config = require('../config');
const ADMIN_PHONES = config.get('ADMIN_PHONES');
const PORT = config.get('PORT');
const SOCKET_CORS_ORIGIN = config.get('SOCKET_CORS_ORIGIN');
const logger = require('../utils/logger');
const {
  safeJSON,
  getDistanceKm,
  sanitizeBody,
  validateCoords,
  validatePhone,
} = require('../utils/helpers');

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
  // P6-01
  generateRefreshToken,
  verifyRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokens,
  initRevocationStore,
} = require('../middleware/auth');
const {
  normalLimit,
  loginLimit,
  phoneLoginLimit,
  initRateLimitStore,
} = require('../middleware/rateLimiter');
const { metricsMiddleware, getMetrics } = require('../middleware/metrics');
const { setupMiddleware } = require('../middleware/setup');

// ─── Database ─────────────────────────────────────────────────────────────────
const { dbGet, dbAll, dbRun, dbTransaction } = require('../config/database');
const { runMigrations } = require('../config/migrate');

// ─── Services ─────────────────────────────────────────────────────────────────
const { createBackup, startBackupSchedule } = require('../services/backup');
const { cache, CACHE_TTL, getCache, setCache, clearCache } = require('../services/cache');
const { createNotificationService } = require('../services/notificationService');
const {
  FARE_CONFIG,
  getPriceMultiplier,
  calculateFare,
  getFareBreakdown,
  formatTrip,
} = require('../services/fareCalculator');

// ─── Socket ───────────────────────────────────────────────────────────────────
const { setupSocket } = require('../socket');

// ─── Repositories ─────────────────────────────────────────────────────────────
const { createUserRepository } = require('../repositories/UserRepository');
const { createDriverRepository } = require('../repositories/DriverRepository');
const { createScooterRepository } = require('../repositories/ScooterRepository');
const { createTripRepository } = require('../repositories/TripRepository');
const { createWalletRepository } = require('../repositories/WalletRepository');
const { createNotificationRepository } = require('../repositories/NotificationRepository');
const { createReportRepository } = require('../repositories/ReportRepository');

/**
 * Build the complete OnCall application (Express app + HTTP server + Socket.IO + DI +
 * routes), wired exactly as the legacy server.js module body. Construction has the same
 * side effects and ordering as before; the async lifecycle runs in start()/stop().
 *
 * @returns {{ app, server, io, services, start: Function, stop: Function,
 *             listening: Function, port: number }}
 */
function createOnCallApplication() {
  logger.success('Environment loaded — JWT_SECRET ready');

  const app = express();
  const server = http.createServer(app);

  // Socket.IO CORS: P6-05B — origin controlled via SOCKET_CORS_ORIGIN env var (env.js).
  // Default '*' is acceptable for Flutter Mobile (no Origin header in mobile clients).
  // JWT auth middleware on Socket.IO provides the real security boundary.
  // For web dashboards in production: SOCKET_CORS_ORIGIN=https://your-dashboard.com
  const io = new Server(server, {
    pingTimeout: 30000,
    pingInterval: 10000,
    connectTimeout: 20000,
    cors: {
      origin: SOCKET_CORS_ORIGIN,
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

  // P6-02 — Push Notification Service
  const notifService = createNotificationService({ dbAll, dbRun, logger });

  const services = {
    dbGet,
    dbAll,
    dbRun,
    dbTransaction,
    logger,
    authenticate,
    authenticateDriver,
    authenticatePassenger,
    authenticateAdmin,
    generateJWT,
    verifyJWT,
    getSession,
    revokeTokens,
    // P6-01 — Refresh Token
    generateRefreshToken,
    verifyRefreshToken,
    revokeRefreshToken,
    revokeAllRefreshTokens,
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
    // P6-02 — Push Notification Service
    notifService,
  };

  setupSocket(io, services);

  // ─── AI / Automation context (Enterprise Architecture — Migration Phase 10) ──
  // Establishes the AI/Automation bounded context as the OFFICIAL architectural
  // owner of the platform's existing deterministic automations (dispatch matching,
  // rule-based fare, auto-rollback — ADR-011 §1/§4) under the ADR-005 layers.
  // DORMANT BY DESIGN: it composes the context + asserts its ports, but mounts NO
  // HTTP route and calls NO inference provider (none is configured — ADR-011 §8,
  // the deterministic fallback is the tested default). It is exposed on the DI
  // container (`services.ai`) as forward-provisioning for future consumers.
  // AI_LEGACY=1 skips registration entirely — an immediate, no-op rollback.
  // Establishing ownership changes ZERO runtime behavior (proven by the A/B harness).
  if (process.env.AI_LEGACY === '1') {
    logger.warn('AI: context registration skipped (AI_LEGACY=1 rollback mode)');
  } else {
    const { createAIApplication } = require('../application/ai');
    const { createAIProviderAdapter } = require('../infrastructure/ai/aiProviderAdapter');
    const {
      createPromptRepository,
      createAIConfigurationRepository,
      createAIAuditRepository,
    } = require('../infrastructure/ai/aiGateways');
    services.ai = createAIApplication({
      aiProvider: createAIProviderAdapter(services),
      promptRepository: createPromptRepository(services),
      aiConfigurationRepository: createAIConfigurationRepository(services),
      aiAuditRepository: createAIAuditRepository(services),
    });
  }

  // ─── Identity Shadow (Phase 20.b) — observational only; mounted ONLY when both flags are ON.
  // Default OFF ⇒ not required, not mounted ⇒ byte-identical production. It compares legacy vs the
  // consolidated Identity Kernel for each request and returns NOTHING to the request (legacy stays
  // authoritative). It also exposes `services.identityShadow` for the socket handshake to reuse.
  if (process.env.PLATFORM_IDENTITY === '1' && process.env.SHADOW_IDENTITY === '1') {
    // eslint-disable-next-line global-require
    require('../middleware/identityShadowMiddleware').mountIdentityShadow(app, services);
  }

  // ─── Routes ───────────────────────────────────────────────────────────────────
  app.use('/', require('../routes/health')(services));
  // ─── Observability (Phase 12) — additive: /metrics, /health/live, /health/ready ─
  app.use('/', require('../routes/observability').createObservabilityRouter(services));
  // ─── Identity (Enterprise Architecture cutover — Migration Phase 2) ──────────
  // New ADR-005 layered implementation is the default. Instant rollback without
  // code change: set IDENTITY_LEGACY=1 to restore the legacy router.
  if (process.env.IDENTITY_LEGACY === '1') {
    logger.warn('Identity: LEGACY router active (IDENTITY_LEGACY=1 rollback mode)');
    app.use('/', require('../routes/auth')(services));
  } else {
    const { createIdentityRouter } = require('../presentation/api/identityRoutes');
    app.use('/', createIdentityRouter(services, config.all()));
  }
  // ─── Users (Enterprise Architecture cutover — Migration Phase 3) ─────────────
  // New ADR-005 layered implementation is the default. Instant rollback without
  // code change: set USERS_LEGACY=1 to restore the legacy router. Legacy remains
  // the proven rollback target until Phase 4 (byte-compat proven by A/B harness).
  if (process.env.USERS_LEGACY === '1') {
    logger.warn('Users: LEGACY router active (USERS_LEGACY=1 rollback mode)');
    app.use('/', require('../routes/users')(services));
  } else {
    const { createUsersRouter } = require('../presentation/api/usersRoutes');
    app.use('/', createUsersRouter(services));
  }
  // ─── Drivers (Enterprise Architecture cutover — Migration Phase 4) ───────────
  // New layered implementation is default. DRIVERS_LEGACY=1 restores the exact
  // legacy router and legacy admin driver endpoints for immediate rollback.
  if (process.env.DRIVERS_LEGACY === '1') {
    logger.warn('Drivers: LEGACY router active (DRIVERS_LEGACY=1 rollback mode)');
    app.use('/', require('../routes/drivers')(services));
  } else {
    const { createDriversRouter } = require('../presentation/api/driversRoutes');
    app.use('/', createDriversRouter(services));
  }
  // ─── Scooters (Enterprise Architecture cutover — Migration Phase 5) ──────────
  // New layered implementation is default. SCOOTERS_LEGACY=1 restores the exact
  // legacy router for immediate rollback (legacy remains the rollback target).
  if (process.env.SCOOTERS_LEGACY === '1') {
    logger.warn('Scooters: LEGACY router active (SCOOTERS_LEGACY=1 rollback mode)');
    app.use('/', require('../routes/scooters')(services));
  } else {
    const { createScootersRouter } = require('../presentation/api/scootersRoutes');
    app.use('/', createScootersRouter(services));
  }
  // ─── Fleet (Enterprise Architecture cutover — Migration Phase 9) ─────────────
  // New layered Fleet router OWNS the three vehicle-inventory endpoints that were
  // co-located in Trips (`GET /taxis`) and Admin (`POST/DELETE /admin/taxis`).
  // It is mounted BEFORE Trips and Admin so first-match makes it the sole active
  // owner. FLEET_LEGACY=1 removes it, and the still-mounted co-located handlers in
  // the Trips/Admin routers resume serving those paths — immediate rollback. The
  // vehicle-status/location lifecycle writes stay reused-in-place; Wallet/Payments/
  // AI are NOT migrated; no new Fleet capability is introduced.
  if (process.env.FLEET_LEGACY === '1') {
    logger.warn('Fleet: LEGACY co-located handlers active (FLEET_LEGACY=1 rollback mode)');
  } else {
    const { createFleetRouter } = require('../presentation/api/fleetRoutes');
    app.use('/', createFleetRouter(services));
  }
  // ─── Trips (Enterprise Architecture cutover — Migration Phase 7) ─────────────
  // New layered implementation is default. TRIPS_LEGACY=1 restores the exact
  // legacy taxi router for immediate rollback (legacy remains the rollback target).
  // Heavy integrations (matcher, payment, Socket.IO, push) are reused, not migrated.
  if (process.env.TRIPS_LEGACY === '1') {
    logger.warn('Trips: LEGACY router active (TRIPS_LEGACY=1 rollback mode)');
    app.use('/', require('../routes/taxi')(services));
  } else {
    const { createTripsRouter } = require('../presentation/api/tripsRoutes');
    app.use('/', createTripsRouter(services));
  }
  // ─── Commerce (Enterprise Architecture cutover — Migration Phase 11) ─────────
  // New layered Commerce router OWNS the four Wallet/Payment endpoints previously
  // co-located in the legacy payment router (`GET /payment/methods`,
  // `POST /wallet/charge`, `GET /wallet/transactions/:phone`,
  // `GET /wallet/balance/:phone`). Mounted BEFORE the legacy payment router so
  // first-match makes it the sole active owner. COMMERCE_LEGACY=1 removes it and
  // the legacy payment handlers resume serving those paths — immediate rollback.
  // Authorized by ADR-001 (ratified 2026-07-20). The trip-settlement path
  // (`PaymentService.processPayment`) stays reused-in-place inside the ADR-001
  // serialized completion transaction; `/fare/*` (pricing) stays in the legacy
  // router. No new financial capability is introduced.
  if (process.env.COMMERCE_LEGACY === '1') {
    logger.warn('Commerce: LEGACY payment router active (COMMERCE_LEGACY=1 rollback mode)');
  } else {
    const { createCommerceRouter } = require('../presentation/api/commerceRoutes');
    app.use('/', createCommerceRouter(services));
  }
  // Legacy payment router stays mounted AFTER the Commerce router. First-match
  // means Commerce owns the four wallet/payment paths when active; the legacy
  // router then serves only the co-located `/fare/*` pricing endpoints (and owns
  // everything when COMMERCE_LEGACY=1). Behavior is unchanged either way.
  app.use('/', require('../routes/payment')(services));
  // ─── Admin (Enterprise Architecture cutover — Migration Phase 8) ─────────────
  // New layered router is default and owns every GENERAL admin endpoint
  // (dashboard/stats/reports, user & trip & taxi administration, audit /
  // maintenance / configuration / observability). ADMIN_LEGACY=1 removes it so the
  // legacy router below owns those endpoints again — immediate rollback.
  // SCOPE: only pre-existing Admin capability is migrated; the driver-approval
  // workflow was migrated with Drivers (Phase 4); Wallet/Payments/Fleet/AI are NOT
  // migrated; no new administrative capability is introduced.
  if (process.env.ADMIN_LEGACY === '1') {
    logger.warn('Admin: LEGACY router active (ADMIN_LEGACY=1 rollback mode)');
  } else {
    const { createAdminRouter } = require('../presentation/api/adminRoutes');
    app.use('/', createAdminRouter(services));
  }
  // Legacy admin router stays mounted AFTER the new one. First-match means the new
  // router owns all general endpoints when active; legacy then only serves the
  // co-located /admin/drivers* endpoints in the DRIVERS_LEGACY rollback path (and
  // owns everything when ADMIN_LEGACY=1). Behavior is unchanged either way.
  app.use('/', require('../routes/admin')(services));
  // ─── Notifications (Enterprise Architecture cutover — Migration Phase 6) ─────
  // New layered implementation is default. NOTIFICATIONS_LEGACY=1 restores the
  // exact legacy router for immediate rollback (legacy remains the rollback target).
  if (process.env.NOTIFICATIONS_LEGACY === '1') {
    logger.warn('Notifications: LEGACY router active (NOTIFICATIONS_LEGACY=1 rollback mode)');
    app.use('/', require('../routes/notifications')(services));
  } else {
    const { createNotificationsRouter } = require('../presentation/api/notificationsRoutes');
    app.use('/', createNotificationsRouter(services));
  }

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

  let walTimer = null;
  let listening = false;

  // ─── Start (Async) ────────────────────────────────────────────────────────────
  // إصلاح C6: Migrations تعمل قبل server.listen() — يمنع أخطاء "no such column"
  // خلال أول ثانيتين من التشغيل.
  // Identical to the legacy server.js async IIFE — resolves once the HTTP server is
  // listening and the background backup schedule has been armed. It NEVER calls
  // process.exit(): the caller (legacy launcher or Enterprise Host) owns the process.
  async function start() {
    await runMigrations(dbRun, logger);
    await initRevocationStore(dbRun, dbAll); // P6-05A: load persisted revocations
    await initRateLimitStore(dbRun, dbAll); // P6-05B: load persisted phone locks

    // ── Phase 12 (C2/C3): optional distributed state — default-off no-op ────────
    // When REDIS_URL is set, activate cross-replica revocation propagation and the
    // Socket.IO Redis adapter. When unset, everything below is an immediate no-op
    // and the platform runs exactly as the single-node default (A/B unaffected).
    const redisState = require('../infrastructure/scaling/redisState');
    const { setRevocationPublisher, applyRemoteRevocation } = require('../middleware/auth');
    if (await redisState.initRedis(logger)) {
      await redisState.attachSocketAdapter(io, logger);
      setRevocationPublisher((phone, ts) => redisState.publishRevocation(phone, ts));
      await redisState.subscribeRevocations(applyRemoteRevocation);
    }

    // ── Phase 12 (perf): periodic WAL checkpoint to bound WAL growth (SQLite) ────
    // The audit found oncall.db-wal growing unbounded. Truncate-checkpoint on a
    // timer keeps it bounded. Guarded to the sqlite engine; harmless if it errors.
    if ((process.env.DB_ENGINE || 'sqlite') === 'sqlite') {
      walTimer = setInterval(
        () => {
          dbRun('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => {});
        },
        Number(process.env.WAL_CHECKPOINT_MS) || 300000 // every 5 min
      );
      if (walTimer.unref) walTimer.unref(); // never keep the process alive for this
    }

    // إلغاء رحلات waiting_driver القديمة من جلسات سيرفر سابقة
    // tripTimers يُخزَّن في الذاكرة فقط — يُفقَد عند إعادة التشغيل
    // أي رحلة waiting_driver عمرها > 10 دقائق لن يُستكمل تعيين سائق لها
    try {
      const { changes } = await dbRun(
        "UPDATE trips SET status = 'no_driver' WHERE status = 'waiting_driver' AND created_at < datetime('now', '-10 minutes')"
      );
      if (changes > 0)
        logger.warn(`Startup cleanup: cancelled ${changes} ghost waiting_driver trip(s)`);
    } catch (e) {
      logger.error('Startup trip cleanup error:', { message: e.message });
    }

    await new Promise((resolve) => {
      server.listen(PORT, () => {
        listening = true;
        logger.success(`Server + Socket.IO running on port ${PORT}`);
        resolve();
      });
    });
    startBackupSchedule(dbRun, logger); // C4 fix: pass dbRun for WAL checkpoint
    return { listening: true, port: PORT };
  }

  // ─── Graceful close ─────────────────────────────────────────────────────────
  // Identical close ordering to the legacy shutdown(): close Socket.IO first to stop
  // new upgrade requests (L3 fix), then close the HTTP server. Resolves on clean close;
  // rejects on error. Process-exit / forced-timeout policy is owned by the caller so this
  // works uniformly under the legacy launcher AND the Enterprise Host (which stops the
  // service, then the Runtime, then exits).
  function stop() {
    return new Promise((resolve, reject) => {
      if (walTimer) {
        clearInterval(walTimer);
        walTimer = null;
      }
      io.close(() => {
        server.close((err) => {
          if (err) return reject(err);
          listening = false;
          resolve({ stopped: true });
        });
      });
    });
  }

  return {
    app,
    server,
    io,
    services,
    start,
    stop,
    listening: () => listening,
    port: PORT,
  };
}

module.exports = { createOnCallApplication };
