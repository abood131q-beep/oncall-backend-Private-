'use strict';

/**
 * Bootstrap (Phase 16.2 / ADR-043 §1) — the production bootstrap entry point. It exposes
 * ONLY `bootstrap(options)`, which:
 *   1. creates the platform (ADR-042 Composition Root)
 *   2. verifies the platform (startup verifier — aborts on failure)
 *   3. starts the platform (Lifecycle-ordered startup)
 *   4. waits until ready
 *   5. returns a Runtime
 *
 * Bootstrap is a THIN layer above the Composition Root: it never modifies a kernel, never
 * modifies ADR-042, and never re-implements composition or lifecycle logic. The single
 * `assemble` path is reused by Runtime.restart(), so composition happens in exactly one
 * place.
 *
 *   const { bootstrap } = require('./src/runtime');
 *   const runtime = await bootstrap(config);
 *   await runtime.ready();
 */

const { createPlatform } = require('../platform');
const { createRuntime } = require('./runtime');
const { createRuntimeContext } = require('./runtimeContext');
const { createRuntimeSupervisor } = require('./runtimeSupervisor');
const { createShutdownManager } = require('./shutdownManager');
const { verifyStartup } = require('./startupVerifier');
const { BootstrapError } = require('./errors');

/**
 * Create → verify → start → build the operational surfaces for one running platform.
 * Reused by both initial bootstrap and restart so composition logic is never duplicated.
 */
async function assemble(options, supervisor) {
  const clock = options.clock || (() => Date.now());
  const log = options.logger || { info() {}, warn() {}, error() {} };
  const startedAt = clock();

  // 1. create platform (ADR-042)
  supervisor.transition(supervisor.STATES.VERIFYING);
  const platform = createPlatform(options.platform || options);

  // 2. verify platform BEFORE start — abort immediately on failure (§4)
  const verification = await verifyStartup(platform, { logger: log });

  // 3. start platform (delegated to Lifecycle, ADR-040)
  supervisor.transition(supervisor.STATES.STARTING);
  await platform.start();

  // operational surfaces
  const shutdownManager = createShutdownManager({
    platform,
    clock,
    logger: log,
    timeoutMs: options.shutdownTimeoutMs,
  });
  const startupDurationMs = clock() - startedAt;
  const context = createRuntimeContext({
    platform,
    configuration: platform.context && platform.context.config,
    environment: platform.context && platform.context.environment,
    startedAt,
    version: platform.version(),
    supervisor,
    shutdownManager,
    clock,
    bootstrapMetadata: {
      verification: { ok: verification.ok },
      startupDurationMs,
      startupOrder: platform.startupOrder,
      bootstrappedAt: startedAt,
    },
  });

  // 4. wait until ready
  const sample = await supervisor.sampleHealth(platform);
  context._recordHealth(sample.health || null);
  supervisor.transition(supervisor.STATES.READY);

  return { platform, shutdownManager, context, verification, startupDurationMs };
}

async function bootstrap(options = {}) {
  const clock = options.clock || (() => Date.now());
  const log = options.logger || { info() {}, warn() {}, error() {} };
  const supervisor = createRuntimeSupervisor({ clock, logger: log });

  let initial;
  try {
    initial = await assemble(options, supervisor);
  } catch (e) {
    supervisor.recordFailure('bootstrap', e);
    supervisor.transition(supervisor.STATES.FAILED);
    // Preserve typed startup-verification errors; wrap everything else.
    if (e && e.name === 'StartupVerificationError') throw e;
    throw new BootstrapError(`bootstrap failed: ${e.message}`, { cause: e.name });
  }

  // 5. return Runtime (rebuild reuses the same assemble path for restart)
  return createRuntime({
    supervisor,
    initial,
    rebuild: () => assemble(options, supervisor),
    clock,
    logger: log,
  });
}

module.exports = { bootstrap, assemble };
