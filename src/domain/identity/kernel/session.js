'use strict';

/**
 * session.js — Consolidated Identity Kernel domain (Phase 19.4 skeleton, ADR-049 §5).
 *
 * PURE domain value object for an authenticated session (session + device identity ownership).
 * Deterministic, no I/O. SKELETON: shape + lifecycle predicate only; token issuance/persistence
 * live behind the Token/SessionStore ports (infrastructure), NOT here. Absorbs the shape of the
 * current `domain/identity-kernel/session.js` without moving behavior.
 */

const STATE = Object.freeze({ ACTIVE: 'active', EXPIRED: 'expired', REVOKED: 'revoked' });

/**
 * Build a frozen session descriptor. Shape-only skeleton.
 * @param {object} spec { sessionId, identityId, principal?, device?, createdAt?, expiresAt?, state? }
 */
function createSession(spec = {}) {
  return Object.freeze({
    sessionId: spec.sessionId != null ? String(spec.sessionId) : null,
    identityId: spec.identityId != null ? String(spec.identityId) : null,
    principal: spec.principal || null,
    device: spec.device || null, // device identity (owner: Identity kernel, ADR-049)
    createdAt: spec.createdAt || null,
    expiresAt: spec.expiresAt || null,
    state: spec.state || STATE.ACTIVE,
  });
}

/** Whether a session is live at time `nowMs` (pure predicate). */
function isLive(session, nowMs) {
  return Boolean(
    session &&
    session.state === STATE.ACTIVE &&
    typeof session.expiresAt === 'number' &&
    session.expiresAt > nowMs
  );
}

module.exports = { createSession, isLive, STATE };
