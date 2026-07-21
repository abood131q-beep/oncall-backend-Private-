'use strict';

/**
 * index.js — Consolidated Identity Kernel application barrel (Phase 19.4 skeleton, ADR-049).
 *
 * Composition entry for the consolidated Identity Kernel. Re-exports the kernel factory, ports
 * (with assertPorts fail-fast), metrics, and the provider registry. Imports domain (downward) only;
 * never infrastructure or presentation (ADR-005). SKELETON: composing the kernel changes NO
 * production behavior — it is not wired into server.js / platformBuilder this phase.
 */

const { createIdentityKernel } = require('./identityKernel');
const { assertPorts, REQUIRED_PORTS, OPTIONAL_PORTS } = require('./ports');
const { createIdentityKernelMetrics } = require('./metrics');
const { createProviderRegistry } = require('./providers');

module.exports = {
  createIdentityKernel,
  assertPorts,
  REQUIRED_PORTS,
  OPTIONAL_PORTS,
  createIdentityKernelMetrics,
  createProviderRegistry,
};
