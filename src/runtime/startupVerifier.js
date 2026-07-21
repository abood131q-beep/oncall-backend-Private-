'use strict';

/**
 * Startup Verifier (Phase 16.2 / ADR-043 §4) — runs BEFORE platform.start(). It confirms
 * the composed platform is safe to start and aborts immediately if any check fails.
 *
 * Verifies: composition valid, dependency graph valid, all kernels registered, providers
 * healthy, compatibility passed, configuration loaded, event backbone operational.
 *
 * It never re-implements the platform's own checks — it delegates to `platform.verify()`
 * (ADR-042 §9) and adds the two runtime-level preconditions (configuration + backbone).
 */

const { StartupVerificationError } = require('./errors');

async function verifyStartup(platform, opts = {}) {
  const log = opts.logger || { info() {}, warn() {}, error() {} };
  const checks = {};

  // Delegate composition/graph/registration/ports/providers/compatibility to ADR-042.
  let platformVerify;
  try {
    platformVerify = await platform.verify();
  } catch (e) {
    throw new StartupVerificationError(`startup: platform.verify() threw: ${e.message}`);
  }
  const pc = platformVerify.checks || {};
  checks.compositionValid = { ok: Boolean(platformVerify.ok) };
  checks.dependencyGraphValid = { ok: Boolean(pc.dependencyGraph && pc.dependencyGraph.ok) };
  checks.noCycles = { ok: Boolean(pc.noCycles && pc.noCycles.ok) };
  checks.allKernelsRegistered = { ok: Boolean(pc.allRegistered && pc.allRegistered.ok) };
  checks.portsInjected = { ok: Boolean(pc.portsInjected && pc.portsInjected.ok) };
  checks.providersHealthy = { ok: Boolean(pc.providersHealthy && pc.providersHealthy.ok) };
  checks.compatibilityPassed = { ok: Boolean(pc.compatibility && pc.compatibility.ok) };

  // Runtime-level preconditions.
  const ctx = platform.context || {};
  checks.configurationLoaded = {
    ok: Boolean(ctx.config && typeof ctx.config.get === 'function'),
  };
  checks.eventBackboneOperational = {
    ok: Boolean(ctx.publisher && typeof ctx.publisher.publish === 'function'),
  };

  const failed = Object.entries(checks)
    .filter(([, v]) => !v.ok)
    .map(([k]) => k);
  const ok = failed.length === 0;
  if (!ok) {
    log.error('startup verification failed', { failed });
    throw new StartupVerificationError('startup verification failed', { failed, checks });
  }
  return { ok, checks, platformVerification: platformVerify };
}

module.exports = { verifyStartup };
