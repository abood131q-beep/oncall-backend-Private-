'use strict';

/**
 * events.js — Consolidated Identity Kernel domain (Phase 19.4 skeleton, ADR-049).
 *
 * Identity lifecycle event vocabulary + a pure event factory. Events flow through the
 * EventPublisher port ONLY (never a direct bus). SKELETON: the vocabulary is defined; no producer
 * emits these yet (the legacy path emits its own logs/security events unchanged).
 */

const IDENTITY_KERNEL_EVENTS = Object.freeze({
  AUTHENTICATED: 'identity.authenticated',
  AUTHENTICATION_FAILED: 'identity.authentication_failed',
  SESSION_ISSUED: 'identity.session_issued',
  SESSION_REFRESHED: 'identity.session_refreshed',
  SESSION_REVOKED: 'identity.session_revoked',
  LOGGED_OUT: 'identity.logged_out',
});

/**
 * Build a frozen identity event (pure; deterministic given the injected clock).
 * @param {string} type one of IDENTITY_KERNEL_EVENTS
 * @param {object} payload
 * @param {object} [opts] { clock: () => Date }
 */
function createIdentityKernelEvent(type, payload = {}, opts = {}) {
  const clock = opts.clock || (() => new Date());
  return Object.freeze({
    type,
    payload: Object.freeze({ ...payload }),
    at: clock().toISOString(),
  });
}

module.exports = { IDENTITY_KERNEL_EVENTS, createIdentityKernelEvent };
