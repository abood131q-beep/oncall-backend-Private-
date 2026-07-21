'use strict';

/**
 * metrics.js — Consolidated Identity Kernel metrics hooks (Phase 19.4 skeleton, ADR-049).
 *
 * A dependency-injected metrics surface for the kernel. SKELETON: counters are wired structurally
 * and are safe no-ops; nothing increments them yet (the legacy path keeps its own logging). Same
 * shape as the other Enterprise kernels' metrics so the kernel is observability-ready.
 */

function createIdentityKernelMetrics({ clock } = {}) {
  const now = clock || (() => Date.now());
  const counters = {
    authAttempts: 0,
    authSuccess: 0,
    authFailure: 0,
    tokensIssued: 0,
    tokensRefreshed: 0,
    sessionsRevoked: 0,
  };
  let gauges = { activeSessions: () => 0 };

  return {
    recordAuthAttempt: () => (counters.authAttempts += 1),
    recordAuthSuccess: () => (counters.authSuccess += 1),
    recordAuthFailure: () => (counters.authFailure += 1),
    recordTokenIssued: () => (counters.tokensIssued += 1),
    recordTokenRefreshed: () => (counters.tokensRefreshed += 1),
    recordSessionRevoked: () => (counters.sessionsRevoked += 1),
    bindGauges: (g) => (gauges = { ...gauges, ...g }),
    snapshot: () => ({
      ...counters,
      activeSessions: gauges.activeSessions(),
      at: now(),
    }),
  };
}

module.exports = { createIdentityKernelMetrics };
