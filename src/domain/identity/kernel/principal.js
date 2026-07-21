'use strict';

/**
 * principal.js — Consolidated Identity Kernel domain (Phase 19.4 skeleton, ADR-049 §5).
 *
 * PURE domain value object for an authorization principal. Deterministic, no I/O, no framework.
 * This is the SINGLE future home for roles / permissions / claims / principal (ADR-049 ownership
 * boundaries). SKELETON: shape only — it carries data, it does not implement authorization logic
 * (that lands in policies.js during the consolidation phase). Absorbs the shape of the current
 * `domain/identity-kernel/principal.js` and the production session payloads without moving either.
 */

const EMPTY = Object.freeze([]);

/**
 * Build a frozen principal from a plain spec. Shape-only; no validation logic beyond defaults.
 * @param {object} spec { identityId?, subject?, tenant?, roles?, permissions?, claims? }
 */
function createPrincipal(spec = {}) {
  return Object.freeze({
    identityId: spec.identityId != null ? String(spec.identityId) : null,
    subject: spec.subject != null ? String(spec.subject) : null,
    tenant: spec.tenant || 'default',
    roles: Object.freeze(Array.isArray(spec.roles) ? [...spec.roles] : []),
    permissions: Object.freeze(Array.isArray(spec.permissions) ? [...spec.permissions] : []),
    claims: Object.freeze({ ...(spec.claims || {}) }),
  });
}

/** The anonymous principal (no identity). */
const ANONYMOUS = createPrincipal({ identityId: null, subject: null });

/** Shape predicate (skeleton helper). */
function isPrincipal(p) {
  return Boolean(p && typeof p === 'object' && 'roles' in p && 'permissions' in p && 'claims' in p);
}

module.exports = { createPrincipal, isPrincipal, ANONYMOUS, EMPTY };
