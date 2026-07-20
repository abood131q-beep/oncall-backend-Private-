'use strict';

/**
 * Authorization context (Phase 14.8 / ADR-027 §3) — PURE domain. Deterministic
 * principal resolution: given an identity (+ optional live session), produce the
 * frozen authorization context other kernels (e.g. the Policy engine) consume.
 * Carries NO credential material.
 */

function buildContext(identity, session, opts = {}) {
  const authenticated = Boolean(session && opts.now != null && session.isLive(opts.now));
  return Object.freeze({
    identityId: identity.identityId,
    principal: identity.principal,
    subject: identity.subject,
    tenant: identity.tenant,
    roles: Object.freeze([...identity.roles]),
    permissions: Object.freeze([...identity.permissions]),
    claims: Object.freeze({ ...identity.claims }),
    sessionId: session ? session.sessionId : null,
    authenticated,
  });
}

module.exports = { buildContext };
