'use strict';

/**
 * Host Builder (Phase 16.3 / ADR-044 §1) — exposes ONLY `createHost(options)`. It manages
 * one Bootstrap Runtime (ADR-043) and any number of hosted services. It is a THIN
 * orchestration layer: it never modifies a kernel, ADR-042, or ADR-043; it wires an
 * immutable host context, a registry, a supervisor, and the host lifecycle, then returns
 * the Host object.
 *
 *   const runtime = await bootstrap(config);
 *   const host = await createHost({ runtime });
 *   await host.register(apiGatewayService);
 *   await host.start();
 */

const { createHostContext } = require('./hostContext');
const { createHostRegistry } = require('./hostRegistry');
const { createHostSupervisor } = require('./hostSupervisor');
const { createHostObject } = require('./host');
const { HostStateError } = require('./errors');

/**
 * @param {object} options
 * @param {object} options.runtime   a Bootstrap Runtime (ADR-043) — required
 * @param {object} [options.logger]
 * @param {object} [options.metrics]
 * @param {string} [options.environment]
 * @param {string} [options.version]
 * @param {object} [options.configuration]
 * @param {object} [options.sharedServices]
 * @param {Function} [options.clock]
 */
async function createHost(options = {}) {
  const runtime = options.runtime;
  if (
    !runtime ||
    typeof runtime.platform !== 'function' ||
    typeof runtime.shutdown !== 'function'
  ) {
    throw new HostStateError('createHost: a Bootstrap Runtime (ADR-043) is required');
  }
  const clock = options.clock || (() => Date.now());
  const logger = options.logger || (runtime.context && runtime.context().logger) || undefined;

  const registry = createHostRegistry();
  const supervisor = createHostSupervisor({ clock, logger });

  // The host context is re-derived on demand (e.g. after restart rebuilds the platform),
  // so it always reflects the runtime's current platform.
  const makeContext = () =>
    createHostContext({
      runtime,
      logger,
      metrics: options.metrics,
      environment: options.environment,
      version: options.version,
      configuration: options.configuration,
      sharedServices: options.sharedServices,
    });

  return createHostObject({ runtime, registry, supervisor, makeContext, clock, logger });
}

module.exports = { createHost };
