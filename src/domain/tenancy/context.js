'use strict';

/**
 * Tenant context (Phase 15.9 / ADR-038 §3) — PURE domain, deterministic. Builds the
 * frozen tenant context other kernels propagate, applying configuration + policy +
 * capability INHERITANCE from platform defaults (or a parent tenant) beneath the
 * tenant's own values. No I/O, no clock beyond the injected `now`.
 */

/** Deterministically merge platform/parent defaults under a tenant's own values. */
function inherit(defaults = {}, tenant) {
  const caps = new Set([...(defaults.capabilities || []), ...(tenant.capabilities || [])]);
  return {
    capabilities: [...caps].sort(),
    labels: { ...(defaults.labels || {}), ...(tenant.labels || {}) },
    configRef: tenant.configRef != null ? tenant.configRef : defaults.configRef || null,
    policyRef: tenant.policyRef != null ? tenant.policyRef : defaults.policyRef || null,
    metadata: { ...(defaults.metadata || {}), ...(tenant.metadata || {}) },
  };
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    for (const k of Object.keys(o)) deepFreeze(o[k]);
    Object.freeze(o);
  }
  return o;
}

/**
 * Build the frozen, deterministic tenant context. `active` reflects lifecycle status;
 * inheritance is applied for capabilities/labels/config/policy/metadata.
 */
function buildContext(tenant, opts = {}) {
  const merged = inherit(opts.defaults || {}, tenant);
  return deepFreeze({
    tenantId: tenant.tenantId,
    namespace: tenant.namespace,
    tenantName: tenant.tenantName,
    status: tenant.tenantStatus,
    active: tenant.tenantStatus === 'active',
    isolationLevel: tenant.isolationLevel,
    ownerRef: tenant.ownerRef,
    configRef: merged.configRef,
    policyRef: merged.policyRef,
    capabilities: merged.capabilities,
    labels: merged.labels,
    metadata: merged.metadata,
    resolvedAt: opts.now != null ? opts.now : null,
  });
}

/** Capability evaluation against a built context. */
function hasCapability(context, capability) {
  return Boolean(
    context && Array.isArray(context.capabilities) && context.capabilities.includes(capability)
  );
}

module.exports = { buildContext, inherit, hasCapability };
