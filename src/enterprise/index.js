'use strict';

/**
 * src/enterprise/index.js — Phase 17.2 Enterprise boot entry.
 *
 * Runs the OnCall backend as a Hosted Service on top of the Enterprise Platform:
 *
 *   bootstrap()              // ADR-043 — compose + verify + start the Platform (25 kernels)
 *     → createHost()         // ADR-044 — one Runtime, one Host
 *       → register(service)  // register the single OnCallAppService
 *         → host.start()     // runtime.ready() → service.start() (app listens)
 *
 * This is the ONLY application-side module (besides src/platform-adapters) permitted to
 * import Enterprise layers. It is reached exclusively from server.js when both
 * PLATFORM_ENABLED=1 and PLATFORM_HOST=1. It changes NO application behavior: the same
 * OnCall application object starts, listens, and serves exactly as in legacy mode.
 */

const { bootstrap } = require('../runtime');
const { createHost } = require('../host');
const { createPlatformAdapters } = require('../platform-adapters');
const { createOnCallAppService } = require('../hosted-service/onCallAppService');
const { selectConfigFlags, buildConfigSeed, attachConfigShadow } = require('./configShadow');
const { selectObservabilityFlags, attachObservabilityShadow } = require('./observabilityShadow');
const { selectJobsFlags, attachJobsShadow } = require('./jobsShadow');
const { selectSchedulerFlags, attachSchedulerShadow } = require('./schedulerShadow');

/**
 * Boot the OnCall backend inside the Enterprise Host.
 *
 * Phase 17.3 additive: when PLATFORM_CONFIG=1 the Configuration Kernel is composed, seeded
 * with the SAME values env.js computed, and its port is injected into the Configuration
 * Adapter. When SHADOW_CONFIG=1 a read-only parity pass runs. Legacy configuration remains
 * authoritative; with both flags OFF this is byte-identical to Phase 17.2.
 *
 * @param {object} [opts]
 * @param {object} [opts.logger]
 * @param {Function} [opts.createApplication] injectable app factory (tests)
 * @param {boolean} [opts.installSignalHandlers=true]
 * @param {boolean} [opts.platformConfig] override PLATFORM_CONFIG (tests)
 * @param {boolean} [opts.shadowConfig] override SHADOW_CONFIG (tests)
 * @param {object}  [opts.envExports] override env.js exports for the legacy source (tests)
 * @returns {Promise<{ host, runtime, service, adapters, configShadow, parity, flags }>}
 */
async function bootEnterprise(opts = {}) {
  const logger = opts.logger || console;
  const environment = process.env.NODE_ENV || 'development';
  // eslint-disable-next-line global-require
  const version = require('../../package.json').version || '1.0.0';

  // ── Phase 17.3 config flags (default OFF ⇒ identical to Phase 17.2) ─────────────
  const { platformConfig, shadowConfig } = selectConfigFlags(process.env, opts);
  // ── Phase 17.4 observability flags (default OFF ⇒ identical to Phase 17.3) ──────
  const { platformObservability, shadowObservability } = selectObservabilityFlags(
    process.env,
    opts
  );
  // ── Phase 17.5 jobs flags (default OFF ⇒ identical to Phase 17.4) ───────────────
  const { platformJobs, shadowJobs } = selectJobsFlags(process.env, opts);
  // ── Phase 17.6 scheduler flags (default OFF ⇒ identical to Phase 17.5) ──────────
  const { platformScheduler, shadowScheduler } = selectSchedulerFlags(process.env, opts);

  // Seed the Config kernel from legacy env.js so parity can reach 100% (only if enabled).
  let legacy = null;
  let bootstrapOptions = { logger, environment, version };
  if (platformConfig) {
    const seed = buildConfigSeed({ envExports: opts.envExports });
    legacy = seed.legacy;
    bootstrapOptions = { ...bootstrapOptions, kernelOptions: seed.kernelOptions };
  }

  // 1. ADR-043 — bootstrap the Platform/Runtime (compose → verify → start → ready).
  const runtime = await bootstrap(bootstrapOptions);
  logger.info && logger.info('Enterprise Platform bootstrapped and ready');

  // 2. ADR-044 — create the Host over the Runtime.
  const host = await createHost({ runtime, logger, environment, version });

  // 3. Platform Adapter Layer. Inject ONLY the enabled kernel ports (shadow-only).
  const ports = {};
  if (platformConfig) ports.config = runtime.platform().getKernel('config');
  if (platformObservability) ports.observability = runtime.platform().getKernel('observability');
  if (platformJobs) ports.jobs = runtime.platform().getKernel('jobs');
  if (platformScheduler) ports.scheduler = runtime.platform().getKernel('scheduler');
  const adapters = createPlatformAdapters({ ports });

  // 3b. Configuration shadow verifier (read-only; never authoritative).
  const configShadow = platformConfig
    ? attachConfigShadow({ adapters, legacy, shadowConfig, logger })
    : null;

  // 3c. Observability shadow verifier (read-only; never authoritative).
  const observabilityShadow = platformObservability
    ? attachObservabilityShadow({ adapters, shadowObservability, logger })
    : null;

  // 3d. Jobs shadow verifier (read-only; never authoritative; never executes a job).
  const jobsShadow = platformJobs ? attachJobsShadow({ adapters, shadowJobs, logger }) : null;

  // 3e. Scheduler shadow verifier (read-only; never owns a timer; never executes).
  const schedulerShadow = platformScheduler
    ? attachSchedulerShadow({ adapters, shadowScheduler, logger })
    : null;

  // 4. Register the single OnCall Hosted Service.
  const service = createOnCallAppService({
    adapters,
    logger,
    version,
    phase: platformScheduler
      ? '17.6'
      : platformJobs
        ? '17.5'
        : platformObservability
          ? '17.4'
          : platformConfig
            ? '17.3'
            : '17.2',
    createApplication: opts.createApplication, // undefined ⇒ real DB-backed application
  });
  await host.register(service);

  // 5. Start: Runtime first (already ready), then the hosted service (app starts + listens).
  await host.start();
  logger.success && logger.success('OnCall backend running as Enterprise Hosted Service');

  // 5b. Run the configuration parity pass out-of-band (never affects the running app).
  let parity = null;
  if (configShadow && shadowConfig) {
    parity = configShadow.verifyAll();
    (logger.info || (() => {}))(
      `Config shadow parity: ${parity.parityPct}% ` +
        `(${parity.matches}/${parity.comparisons} matched, ${parity.mismatches} mismatch, ` +
        `${parity.verificationFailures} failures)`
    );
  }

  // 5c. Run the observability parity pass out-of-band (async; never affects the running app).
  let observabilityParity = null;
  if (observabilityShadow && shadowObservability) {
    observabilityParity = await observabilityShadow.verify();
    (logger.info || (() => {}))(
      `Observability shadow parity: ${observabilityParity.parityPct}% ` +
        `(${observabilityParity.matched}/${observabilityParity.fields} fields, ` +
        `${observabilityParity.mismatched} mismatch)`
    );
  }

  // 5d. Run the jobs parity pass out-of-band (async; never executes a job, never affects runtime).
  let jobsParity = null;
  if (jobsShadow && shadowJobs) {
    jobsParity = await jobsShadow.verify();
    (logger.info || (() => {}))(
      `Jobs shadow parity: ${jobsParity.parityPct}% ` +
        `(${jobsParity.matched}/${jobsParity.fields} fields across ${jobsParity.jobs} jobs, ` +
        `coverage ${jobsParity.coveragePct}%, ${jobsParity.mismatched} mismatch)`
    );
  }

  // 5e. Run the scheduler parity pass out-of-band (never owns a timer, never executes).
  let schedulerParity = null;
  if (schedulerShadow && shadowScheduler) {
    schedulerParity = await schedulerShadow.verify();
    (logger.info || (() => {}))(
      `Scheduler shadow parity: ${schedulerParity.parityPct}% ` +
        `(${schedulerParity.matched}/${schedulerParity.fields} fields across ` +
        `${schedulerParity.schedules} schedules, coverage ${schedulerParity.coveragePct}%, ` +
        `${schedulerParity.mismatched} mismatch)`
    );
  }

  // 6. Graceful shutdown — Host stops the service (reverse order) then the Runtime.
  if (opts.installSignalHandlers !== false) {
    installSignalHandlers(host, logger);
  }

  return {
    host,
    runtime,
    service,
    adapters,
    configShadow,
    parity,
    observabilityShadow,
    observabilityParity,
    jobsShadow,
    jobsParity,
    schedulerShadow,
    schedulerParity,
    flags: {
      platformConfig,
      shadowConfig,
      platformObservability,
      shadowObservability,
      platformJobs,
      shadowJobs,
      platformScheduler,
      shadowScheduler,
    },
  };
}

/** SIGTERM/SIGINT → host.stop() → process.exit; mirrors legacy timing (10s force cap). */
function installSignalHandlers(host, logger) {
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    (logger.info || console.log)(`${signal} received — shutting down gracefully (Enterprise)`);
    host
      .stop()
      .then((result) => {
        (logger.success || console.log)('Host stopped — process exiting');
        process.exit(result && result.ok === false ? 1 : 0);
      })
      .catch((err) => {
        (logger.error || console.error)('Error during enterprise shutdown:', {
          message: err.message,
        });
        process.exit(1);
      });
    setTimeout(() => {
      (logger.warn || console.warn)('Forced shutdown after 10s timeout');
      process.exit(1);
    }, 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { bootEnterprise, installSignalHandlers };
