'use strict';

/**
 * Platform Health (Phase 16.1 / ADR-042 §8) — aggregates health across every composed
 * Kernel WITHOUT knowing any kernel's internals: it calls each kernel service's own
 * `health()` port (if present) and folds the results into one platform verdict.
 *
 * Returns: overall status, per-kernel status, startup readiness, shutdown readiness,
 * and the verification state.
 */

/** Call a single kernel's health() port defensively. */
async function kernelHealth(name, service) {
  if (!service || typeof service.health !== 'function') {
    return { ok: true, note: 'no health endpoint' };
  }
  try {
    const h = await service.health();
    if (h && typeof h.ok === 'boolean') return h;
    return { ok: Boolean(h), raw: h };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * @param {Array<{name,service}>} kernels composed kernels (in startup order)
 * @param {object} [opts] { order, shutdownOrder, verification, started, environment, version }
 */
async function aggregateHealth(kernels, opts = {}) {
  const perKernel = {};
  let healthy = 0;
  await Promise.all(
    kernels.map(async ({ name, service }) => {
      const h = await kernelHealth(name, service);
      perKernel[name] = h;
      if (h.ok) healthy += 1;
    })
  );

  const total = kernels.length;
  const overall = healthy === total;
  const started = opts.started !== false; // default: consider started unless told otherwise

  return {
    status: overall ? 'healthy' : healthy === 0 ? 'unhealthy' : 'degraded',
    overall,
    healthyKernels: healthy,
    totalKernels: total,
    kernels: perKernel,
    startupReadiness: {
      ready: overall && started,
      order: opts.order || [],
      composed: total,
    },
    shutdownReadiness: {
      ready: started,
      order: opts.shutdownOrder || [],
    },
    verification: opts.verification || null,
    environment: opts.environment || null,
    version: opts.version || null,
  };
}

module.exports = { aggregateHealth, kernelHealth };
