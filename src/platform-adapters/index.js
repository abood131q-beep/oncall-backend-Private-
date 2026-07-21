'use strict';

/**
 * src/platform-adapters/index.js — Enterprise Platform Adapter Layer (Phase 17.2).
 *
 * This layer is the ONLY sanctioned boundary between the OnCall application and the
 * Enterprise Platform. Its rules:
 *   • Adapters are TRANSLATION LAYERS ONLY — no business logic.
 *   • Adapters NEVER access repositories, the database, or application services directly.
 *   • Adapters communicate ONLY through an injected Enterprise public port.
 *   • NO application module (routes, services, repositories, middleware, the app factory)
 *     may import an Enterprise kernel directly — they go through these adapters.
 *
 * Phase 17.2 status: every adapter is constructed WITHOUT a port and is therefore INERT.
 * No Enterprise kernel is consumed yet. The seam exists, is uniform, and is unit-tested,
 * so later phases can inject a kernel's public service as `port` for exactly one concern
 * at a time — with zero change to application behavior in the meantime.
 */

const { createConfigurationAdapter } = require('./configuration');
const { createLifecycleAdapter } = require('./lifecycle');
const { createObservabilityAdapter } = require('./observability');
const { createHealthAdapter } = require('./health');
const { createJobsAdapter } = require('./jobs');
const { createSchedulerAdapter } = require('./scheduler');
const { createIdentityAdapter } = require('./identity');
const { createPolicyAdapter } = require('./policy');
const { createAuditAdapter } = require('./audit');
const { createNotificationAdapter } = require('./notification');
const { createRateLimitAdapter } = require('./ratelimit');
const { createMessagingAdapter } = require('./messaging');
const { createLegacyConfigSource } = require('./configuration/legacySource');
const { createConfigShadowMetrics } = require('./configuration/metrics');
const { createConfigShadow, deepEqual } = require('./configuration/shadow');
const { createLegacyObservabilitySource } = require('./observability/legacySource');
const { createObservabilityShadowMetrics } = require('./observability/metrics');
const { createObservabilityShadow } = require('./observability/shadow');
const { createLegacyJobsSource } = require('./jobs/legacySource');
const { createJobsShadow } = require('./jobs/shadow');
const { createLegacySchedulerSource } = require('./scheduler/legacySource');
const { createSchedulerShadow } = require('./scheduler/shadow');
const sharedShadow = require('./_shadow');
const { AdapterNotWiredError, requirePort } = require('./_base');

/**
 * Construct the full adapter layer.
 *
 * @param {object} [options]
 * @param {object} [options.ports] map of kernel-name → kernel public service. In Phase 17.2
 *   this is empty ({}), so every adapter is inert. A later phase passes exactly the ports it
 *   adopts, e.g. { config: platform.getKernel('config') }.
 * @returns {object} adapters keyed by name + introspection helpers.
 */
function createPlatformAdapters({ ports = {} } = {}) {
  const adapters = {
    configuration: createConfigurationAdapter({ port: ports.config || null }),
    lifecycle: createLifecycleAdapter({ port: ports.lifecycle || null }),
    observability: createObservabilityAdapter({ port: ports.observability || null }),
    health: createHealthAdapter(),
    jobs: createJobsAdapter({ port: ports.jobs || null }),
    scheduler: createSchedulerAdapter({ port: ports.scheduler || null }),
    identity: createIdentityAdapter({ port: ports.identity || null }),
    policy: createPolicyAdapter({ port: ports.policy || null }),
    audit: createAuditAdapter({ port: ports.audit || null }),
    notification: createNotificationAdapter({ port: ports.notifications || null }),
    ratelimit: createRateLimitAdapter({ port: ports.ratelimit || null }),
    messaging: createMessagingAdapter({ port: ports.messaging || null }),
  };

  const names = Object.keys(adapters);

  return Object.freeze({
    ...adapters,
    /** All adapter instances. */
    list: () => names.map((n) => adapters[n]),
    /** Names of adapters currently consuming a kernel (empty in Phase 17.2). */
    consumed: () => names.filter((n) => adapters[n].consumed()),
    /**
     * Aggregate, side-effect-free health of the adapter layer.
     * Named `layerHealth` (not `health`) to avoid colliding with the `health` adapter that
     * is spread above — `adapters.health` must remain the Health Adapter instance.
     */
    layerHealth: () => ({
      ok: true,
      total: names.length,
      consumed: names.filter((n) => adapters[n].consumed()).length,
      adapters: names.reduce((acc, n) => {
        acc[n] = adapters[n].health();
        return acc;
      }, {}),
    }),
    /** Static description for metadata/reporting. */
    describe: () =>
      names.map((n) => ({
        adapter: n,
        kernel: adapters[n].kernel,
        consumed: adapters[n].consumed(),
      })),
  });
}

module.exports = {
  createPlatformAdapters,
  // individual factories (exported for targeted testing / future single-concern wiring)
  createConfigurationAdapter,
  createLifecycleAdapter,
  createObservabilityAdapter,
  createHealthAdapter,
  createJobsAdapter,
  createSchedulerAdapter,
  createIdentityAdapter,
  createPolicyAdapter,
  createAuditAdapter,
  createNotificationAdapter,
  createRateLimitAdapter,
  createMessagingAdapter,
  // Phase 17.3 — Configuration shadow building blocks
  createLegacyConfigSource,
  createConfigShadowMetrics,
  createConfigShadow,
  deepEqual,
  // Phase 17.4 — Observability shadow building blocks
  createLegacyObservabilitySource,
  createObservabilityShadowMetrics,
  createObservabilityShadow,
  // Phase 17.5 — Jobs shadow building blocks + shared shadow framework
  createLegacyJobsSource,
  createJobsShadow,
  // Phase 17.6 — Scheduler shadow building blocks
  createLegacySchedulerSource,
  createSchedulerShadow,
  sharedShadow,
  createShadowMetrics: sharedShadow.createShadowMetrics,
  createRoundTripShadow: sharedShadow.createRoundTripShadow,
  AdapterNotWiredError,
  requirePort,
};
