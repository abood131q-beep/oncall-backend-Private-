'use strict';

/**
 * kernelSource.js — Identity Shadow (Phase 20.a, ADR-049).
 *
 * The KERNEL-path view of the identity operations, produced by the Consolidated Enterprise Identity
 * Kernel (domain policies/principal + infrastructure adapters). It is the candidate the shadow
 * compares against the legacy authority. For token operations it delegates to the SAME certified
 * primitives through the kernel's `tokenAdapter` (pass-through) — so any divergence would be a
 * kernel seam/translation defect, not a crypto difference. For authorization/principal it uses the
 * kernel's OWN domain reimplementation (`domain/identity/kernel/policies` + `principal`), which the
 * shadow verifies matches legacy exactly.
 *
 * NON-AUTHORITATIVE: nothing here is on the production request path; it exists only for comparison.
 */

const domain = require('../../domain/identity/kernel');

/**
 * @param {object} deps
 * @param {object} deps.tokenPort   kernel token adapter (pass-through to legacy primitives)
 * @param {object} deps.otpPort     kernel otp adapter
 * @param {Array}  [deps.adminPhones]
 */
function createKernelIdentitySource(deps = {}) {
  const { tokenPort, otpPort, identityRepositoryPort, adminPhones = [] } = deps;

  /** Build a kernel principal from a JWT payload (domain value object). */
  function toPrincipal(payload) {
    if (!payload) return null;
    return domain.createPrincipal({
      subject: payload.phone,
      roles: payload.role ? [payload.role] : [],
      claims: { role: payload.role || null, phone: payload.phone, type: payload.type || null },
    });
  }

  return Object.freeze({
    source: 'kernel:consolidated-identity',

    verify: (token) => tokenPort.verifyAccessToken(token),

    issueClaims: (payload) => {
      const token = tokenPort.issueAccessToken(payload);
      if (!token || typeof token !== 'string') return null;
      try {
        const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
        // eslint-disable-next-line no-unused-vars
        const { iat, exp, ...stable } = claims;
        return stable;
      } catch {
        return null;
      }
    },

    issueHeader: (payload) => {
      const token = tokenPort.issueAccessToken(payload);
      try {
        return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
      } catch {
        return null;
      }
    },

    // Authorization via the kernel's OWN domain policy (mirrors legacy; shadow-verified).
    isAdmin: (payload) => domain.isAdmin(toPrincipal(payload), adminPhones),

    otpRequired: () => Boolean(otpPort.isRequired()),

    // ── DB-bound operations (via the kernel's infrastructure ports — pass-through) ──
    verifyRefresh: (rawToken) => tokenPort.verifyRefreshToken(rawToken),
    findUserByPhone: (phone) => identityRepositoryPort.findUserByPhone(phone),
    findDriverByPhone: (phone) => identityRepositoryPort.findDriverByPhone(phone),

    resolvePrincipal: (payload) => {
      const p = toPrincipal(payload);
      if (!p) return null;
      return {
        subject: p.subject,
        type: p.claims.type,
        role: p.claims.role,
        driverId: payload && payload.driverId != null ? payload.driverId : null,
      };
    },
  });
}

module.exports = { createKernelIdentitySource };
