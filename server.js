'use strict';

/**
 * server.js — OnCall backend launcher (Phase 17.2)
 *
 * This file is now a THIN launcher that selects one of two execution modes. The complete
 * application (Express + Socket.IO + middleware + DI + routes + startup + shutdown) lives,
 * UNCHANGED in behavior, in src/app/onCallApplication.js. Both modes run that exact same
 * application object, so API responses, headers, JWT behavior, Socket.IO events, database
 * access, background jobs, health endpoints and metrics are byte-identical between them.
 *
 *   LEGACY mode (default):   node server.js → createOnCallApplication().start()
 *   ENTERPRISE mode:         bootstrap() → createHost() → register(OnCallAppService) →
 *                            host.start()  (src/enterprise)
 *
 * Mode is controlled ONLY by two environment flags (both must be enabled for Enterprise):
 *   PLATFORM_ENABLED=1  — compose the Enterprise Platform/Runtime
 *   PLATFORM_HOST=1     — run the app as a Hosted Service under the Enterprise Host
 * With either flag unset/!= '1', the legacy path runs exactly as before.
 */

// Environment must load FIRST (fail-fast on missing JWT_SECRET, normalises LOG_LEVEL, and
// populates process.env with the PLATFORM_* flags used for mode selection below).
require('./src/config');
const logger = require('./src/utils/logger');
const { selectBootMode } = require('./src/enterprise/mode');

const ENTERPRISE_MODE = selectBootMode(process.env) === 'enterprise';

// ─── P6-03: Crash Reporting (identical in both modes) ─────────────────────────
process.on('uncaughtException', (err) => {
  logger.fatal('uncaughtException', { message: err.message, stack: err.stack });
  process.exit(1);
});

// P0-2 (Phase 18.x audit remediation): an unhandled promise rejection can leave the process
// in an inconsistent state (leaked connections, half-finished transactions). Fail fast and let
// the orchestrator (systemd/Docker/K8s) restart — matching the uncaughtException handler above.
// The graceful SIGTERM/SIGINT path is preserved for normal shutdown; this is the abnormal path.
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  logger.fatal('unhandledRejection — failing fast to avoid an inconsistent process', {
    message,
    stack,
  });
  process.exit(1);
});

if (ENTERPRISE_MODE) {
  // ─── ENTERPRISE MODE (ADR-043 Runtime → ADR-044 Host) ───────────────────────
  // Delegates the whole lifecycle to the Enterprise bootstrap. The OnCall backend runs as
  // the single Hosted Service; startup/shutdown ordering is enforced by the Host + Runtime.
  logger.info('Boot mode: ENTERPRISE (PLATFORM_ENABLED=1, PLATFORM_HOST=1)');
  require('./src/enterprise')
    .bootEnterprise({ logger })
    .catch((err) => {
      logger.error('Fatal enterprise startup error:', { message: err.message, stack: err.stack });
      process.exit(1);
    });
} else {
  // ─── LEGACY MODE (default) — behavior identical to pre-17.2 server.js ────────
  logger.info('Boot mode: LEGACY (standalone server.js)');
  const { createOnCallApplication } = require('./src/app/onCallApplication');
  const application = createOnCallApplication();
  const { io, server } = application;

  application.start().catch((err) => {
    logger.error('Fatal startup error:', { message: err.message, stack: err.stack });
    process.exit(1);
  });

  // ─── Graceful Shutdown ────────────────────────────────────────────────────────
  const shutdown = (signal) => {
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
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
