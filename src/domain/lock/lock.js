'use strict';

/**
 * Lock entity (Phase 14.3.5 §2/§3) — the locking aggregate. Identity =
 * `${namespace}/${lockId}`. Encapsulates its own DETERMINISTIC lifecycle so no
 * business logic leaks into providers or the service.
 *
 * Data: lockId, ownerId, namespace, leaseMs, acquiredAt, expiresAt, renewedAt,
 * metadata, version, state.
 *
 * States: available → acquired ⇄ renewing → released | expired | failed.
 * A lock that has never been held (or was released/expired) is `available`.
 */

const { LeaseError } = require('./errors');

const STATE = Object.freeze({
  AVAILABLE: 'available',
  ACQUIRED: 'acquired',
  RENEWING: 'renewing',
  RELEASED: 'released',
  EXPIRED: 'expired',
  FAILED: 'failed',
});

/**
 * @param {object} spec { lockId, namespace, leaseMs? }
 * @param {object} [opts] { clock }
 */
function createLock(spec = {}, opts = {}) {
  // Transitions receive `now` explicitly (deterministic); opts.clock is accepted
  // for signature symmetry with the other kernel entities but not needed here.
  void opts;
  if (!spec.lockId || typeof spec.lockId !== 'string')
    throw new LeaseError('lock: "lockId" required');
  if (!spec.namespace || typeof spec.namespace !== 'string') {
    throw new LeaseError('lock: "namespace" required');
  }
  return {
    lockId: spec.lockId,
    namespace: spec.namespace,
    ownerId: null,
    leaseMs: typeof spec.leaseMs === 'number' && spec.leaseMs > 0 ? spec.leaseMs : 30000,
    acquiredAt: null,
    expiresAt: null,
    renewedAt: null,
    metadata: { ...(spec.metadata || {}) },
    version: 0,
    state: STATE.AVAILABLE,

    /** A lease is live if held and not past expiry at `now`. */
    isLive(now) {
      return (
        (this.state === STATE.ACQUIRED || this.state === STATE.RENEWING) &&
        this.expiresAt != null &&
        this.expiresAt > now
      );
    },
    /** Deterministically fold an expired live lease into the EXPIRED state. */
    settleExpiry(now) {
      if (
        (this.state === STATE.ACQUIRED || this.state === STATE.RENEWING) &&
        this.expiresAt != null &&
        this.expiresAt <= now
      ) {
        this.state = STATE.EXPIRED;
        return true;
      }
      return false;
    },
    acquire(ownerId, now, leaseMs, metadata) {
      this.ownerId = ownerId;
      this.leaseMs = typeof leaseMs === 'number' && leaseMs > 0 ? leaseMs : this.leaseMs;
      this.acquiredAt = now;
      this.renewedAt = now;
      this.expiresAt = now + this.leaseMs;
      if (metadata) this.metadata = { ...this.metadata, ...metadata };
      this.version += 1;
      this.state = STATE.ACQUIRED;
      return this;
    },
    renew(now, leaseMs) {
      this.state = STATE.RENEWING;
      this.leaseMs = typeof leaseMs === 'number' && leaseMs > 0 ? leaseMs : this.leaseMs;
      this.renewedAt = now;
      this.expiresAt = now + this.leaseMs;
      this.version += 1;
      this.state = STATE.ACQUIRED;
      return this;
    },
    release() {
      this.state = STATE.RELEASED;
      this.ownerId = null;
      this.expiresAt = null;
      this.version += 1;
      return this;
    },
    fail() {
      this.state = STATE.FAILED;
      this.version += 1;
      return this;
    },
    toModel() {
      return {
        lockId: this.lockId,
        namespace: this.namespace,
        ownerId: this.ownerId,
        leaseMs: this.leaseMs,
        acquiredAt: this.acquiredAt,
        expiresAt: this.expiresAt,
        renewedAt: this.renewedAt,
        metadata: { ...this.metadata },
        version: this.version,
        state: this.state,
      };
    },
  };
}

module.exports = { createLock, STATE };
