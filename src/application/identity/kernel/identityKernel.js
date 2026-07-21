'use strict';

/**
 * identityKernel.js — Consolidated Enterprise Identity Kernel service (Phase 19.4 skeleton, ADR-049).
 *
 * The single future owner of identity behavior (authenticate / refresh / logout / resolve /
 * authorize). Dependency-injected: it composes the outbound ports + domain + metrics + events and
 * exposes the kernel API. Depends ONLY on the domain and its own ports — never on infrastructure or
 * presentation (ADR-005 dependency rule).
 *
 * SKELETON PHASE (ADR-049 §6): the structure is complete and the ports are asserted, but NO
 * behavior is implemented — every use case throws `IdentityKernelNotWired`. The legacy identity
 * path (middleware/auth.js, otpService, token gateway, identity repository) remains the SOLE
 * authoritative implementation. Nothing here is on a production request path this phase.
 */

const { assertPorts } = require('./ports');
const { createIdentityKernelMetrics } = require('./metrics');
const domain = require('../../../domain/identity/kernel');

const { IdentityKernelNotWired } = domain;

/**
 * Compose the consolidated Identity Kernel.
 * @param {object} deps
 * @param {object} deps.ports  { tokenPort, otpPort, identityRepositoryPort, sessionStorePort, ... }
 * @param {object} [deps.metrics]
 * @param {object} [deps.eventPublisher]
 * @param {object} [deps.logger]
 * @param {Function} [deps.clock]
 * @param {object} [deps.providers]  provider registry (application/identity/kernel/providers)
 */
function createIdentityKernel(deps = {}) {
  const ports = assertPorts(deps.ports || {});
  const metrics = deps.metrics || createIdentityKernelMetrics({ clock: deps.clock });
  const publisher = deps.eventPublisher || { publish() {} };
  const providers = deps.providers || null;

  // Kernel API — SKELETON: shapes present, behavior not yet migrated (ADR-049 §7 sequence).
  function authenticate(/* command */) {
    throw new IdentityKernelNotWired('authenticate');
  }
  function refresh(/* command */) {
    throw new IdentityKernelNotWired('refresh');
  }
  function logout(/* command */) {
    throw new IdentityKernelNotWired('logout');
  }
  function resolve(/* sessionRef */) {
    throw new IdentityKernelNotWired('resolve');
  }
  function authorize(/* principal, action */) {
    throw new IdentityKernelNotWired('authorize');
  }

  return Object.freeze({
    name: 'identity',
    kernel: 'identity (ADR-027 / ADR-049)',
    phase: 'skeleton', // 19.4 — structure only, non-authoritative
    // Kernel API (inert this phase)
    authenticate,
    refresh,
    logout,
    resolve,
    authorize,
    // Introspection / observability
    metrics: () => metrics.snapshot(),
    diagnostics: () => ({
      phase: 'skeleton',
      wired: false,
      authoritative: false,
      ports: Object.keys(ports),
      providers: providers ? providers.list() : [],
    }),
    // Internal handles (not authoritative)
    _ports: ports,
    _publisher: publisher,
  });
}

module.exports = { createIdentityKernel };
