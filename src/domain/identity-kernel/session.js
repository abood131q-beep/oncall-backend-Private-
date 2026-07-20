'use strict';

/**
 * Session (Phase 14.8 / ADR-027 §2) — PURE domain value object. Represents an
 * authenticated session with a bearer token, a lease (expiry), and a lifecycle
 * state. Deterministic transitions; `isLive(now)` gates validity.
 */

let _seq = 0;
function defaultId() {
  _seq = (_seq + 1) % 1e6;
  return `ses_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

const STATE = Object.freeze({ ACTIVE: 'active', EXPIRED: 'expired', REVOKED: 'revoked' });

/**
 * @param {object} spec { identityId, principal, tenant?, ttlMs?, token?, sessionId? }
 * @param {object} [opts] { clock, idFactory, tokenFactory }
 */
function createSession(spec = {}, opts = {}) {
  const clock = opts.clock || (() => Date.now());
  const idFactory = opts.idFactory || defaultId;
  const now = clock();
  const sessionId = spec.sessionId || idFactory();
  const ttlMs = typeof spec.ttlMs === 'number' && spec.ttlMs > 0 ? spec.ttlMs : 3600000;
  const tokenFactory = opts.tokenFactory || (() => `tok_${sessionId}`);
  return {
    sessionId,
    identityId: spec.identityId,
    principal: spec.principal,
    tenant: spec.tenant || 'default',
    token: spec.token || tokenFactory(sessionId, spec.identityId, now),
    createdAt: now,
    expiresAt: now + ttlMs,
    refreshedAt: now,
    ttlMs,
    version: 1,
    state: STATE.ACTIVE,

    isLive(nowMs) {
      return this.state === STATE.ACTIVE && this.expiresAt > nowMs;
    },
    settleExpiry(nowMs) {
      if (this.state === STATE.ACTIVE && this.expiresAt <= nowMs) {
        this.state = STATE.EXPIRED;
        return true;
      }
      return false;
    },
    refresh(nowMs, ttl) {
      this.refreshedAt = nowMs;
      this.ttlMs = typeof ttl === 'number' && ttl > 0 ? ttl : this.ttlMs;
      this.expiresAt = nowMs + this.ttlMs;
      this.version += 1;
      return this;
    },
    revoke() {
      this.state = STATE.REVOKED;
      this.version += 1;
      return this;
    },
    toModel() {
      return {
        sessionId: this.sessionId,
        identityId: this.identityId,
        principal: this.principal,
        tenant: this.tenant,
        token: this.token,
        createdAt: this.createdAt,
        expiresAt: this.expiresAt,
        refreshedAt: this.refreshedAt,
        ttlMs: this.ttlMs,
        version: this.version,
        state: this.state,
      };
    },
  };
}

function fromModel(model, opts = {}) {
  const s = createSession({ ...model }, opts);
  s.createdAt = model.createdAt;
  s.expiresAt = model.expiresAt;
  s.refreshedAt = model.refreshedAt;
  s.version = model.version;
  s.state = model.state;
  return s;
}

module.exports = { createSession, fromModel, STATE };
