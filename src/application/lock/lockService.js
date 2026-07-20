'use strict';

/**
 * Lock Service (Phase 14.3.5 §1/§3/§5/§6/§9) — the Lock Kernel. A platform-wide
 * locking abstraction over any lock backend (NOT a mutex library, NOT tied to
 * Redis or a database). In-process only — NOT distributed coordination.
 *
 * Provides acquire/tryAcquire/renew/release/isHeld/owner/health with lease
 * expiration, automatic expiry settlement, ownership validation, and conflict
 * detection. Lifecycle events flow ONLY through the EventPublisher port. Fully
 * dependency-injected and deterministic (injected clock).
 *
 * Mutations are serialized through an internal mutex so the read-check-write of
 * an acquire is atomic — two acquires on the same lock can never both succeed.
 */

const { createLock, STATE } = require('../../domain/lock/lock');
const { LockConflictError, OwnershipError } = require('../../domain/lock/errors');
const { LOCK_EVENTS, createLockEvent } = require('../../domain/lock/events');
const { assertProvider } = require('./providerPort');
const { createNullPublisher } = require('../shared/eventPublisher');

function createLockService(deps = {}) {
  let provider = assertProvider(deps.provider);
  const publisher = deps.publisher || createNullPublisher();
  const metrics = deps.metrics || null;
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { warn() {}, error() {}, info() {} };
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const defaultRetryMs = deps.retryIntervalMs || 25;

  let _chain = Promise.resolve();
  function _withLock(fn) {
    const run = _chain.then(fn, fn);
    _chain = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  function _emit(type, model, extra = {}) {
    try {
      const event = createLockEvent(
        type,
        { lockId: model.lockId, namespace: model.namespace, ownerId: model.ownerId, ...extra },
        { clock: () => new Date(clock()) }
      );
      Promise.resolve(publisher.publish(event)).catch((e) =>
        log.error('lock: event publish failed', e.message)
      );
    } catch (e) {
      log.error('lock: could not build event', e.message);
    }
  }

  function _require(spec, needOwner) {
    if (!spec || !spec.namespace) throw new OwnershipError('lock: "namespace" is required');
    if (!spec.lockId) throw new OwnershipError('lock: "lockId" is required');
    if (needOwner && !spec.ownerId) throw new OwnershipError('lock: "ownerId" is required');
  }

  function _hydrate(model) {
    const l = createLock(
      { lockId: model.lockId, namespace: model.namespace, leaseMs: model.leaseMs },
      { clock }
    );
    l.ownerId = model.ownerId;
    l.acquiredAt = model.acquiredAt;
    l.expiresAt = model.expiresAt;
    l.renewedAt = model.renewedAt;
    l.metadata = { ...model.metadata };
    l.version = model.version;
    l.state = model.state;
    return l;
  }

  /** Load the lock (or a fresh available one), folding expiry deterministically. */
  async function _load(namespace, lockId, leaseMs) {
    const model = await provider.read(namespace, lockId);
    const l = model ? _hydrate(model) : createLock({ lockId, namespace, leaseMs }, { clock });
    if (l.settleExpiry(clock())) {
      // A live lease lapsed → emit expiry once and persist the freed state.
      if (metrics) {
        metrics.recordExpiration();
        if (l.acquiredAt != null) metrics.recordHeldDuration(clock() - l.acquiredAt);
      }
      await provider.write(namespace, lockId, l.toModel());
      _emit(LOCK_EVENTS.EXPIRED, l.toModel());
    }
    return l;
  }

  async function _attempt({ namespace, lockId, ownerId, leaseMs, metadata }) {
    const now = clock();
    const l = await _load(namespace, lockId, leaseMs);
    if (l.isLive(now) && l.ownerId !== ownerId) {
      return { ok: false, model: l.toModel() }; // conflict — held by another owner
    }
    l.acquire(ownerId, now, leaseMs, metadata);
    await provider.write(namespace, lockId, l.toModel());
    return { ok: true, model: l.toModel() };
  }

  // ── §1 Lock port ────────────────────────────────────────────────────────────
  function tryAcquire(spec) {
    _require(spec, true);
    return _withLock(() =>
      metricsTime(async () => {
        const r = await _attempt(spec);
        if (r.ok) {
          if (metrics) metrics.recordAcquire();
          _emit(LOCK_EVENTS.ACQUIRED, r.model, {
            leaseMs: r.model.leaseMs,
            expiresAt: r.model.expiresAt,
          });
          return r.model;
        }
        if (metrics) metrics.recordConflict();
        _emit(LOCK_EVENTS.CONFLICT, r.model, { attemptedBy: spec.ownerId });
        return null;
      })
    );
  }

  async function acquire(spec) {
    _require(spec, true);
    const waitMs = typeof spec.waitMs === 'number' && spec.waitMs > 0 ? spec.waitMs : 0;
    const deadline = clock() + waitMs;
    // First attempt (and retries) go through the serialized tryAcquire.
    // Retries poll until the deadline; the clock/lease math stays deterministic.

    let model = await tryAcquire(spec);
    if (model) return model;
    while (waitMs > 0 && clock() < deadline) {
      await sleep(spec.retryIntervalMs || defaultRetryMs);
      model = await tryAcquire(spec);
      if (model) return model;
    }
    throw new LockConflictError(`lock: "${spec.lockId}" is held by another owner`, {
      namespace: spec.namespace,
      lockId: spec.lockId,
    });
  }

  function renew(spec) {
    _require(spec, true);
    const { namespace, lockId, ownerId, leaseMs } = spec;
    return _withLock(() =>
      metricsTime(async () => {
        const l = await _load(namespace, lockId, leaseMs);
        if (!l.isLive(clock()) || l.ownerId !== ownerId) {
          throw new OwnershipError(`lock: cannot renew "${lockId}" — not the live owner`, {
            ownerId,
            currentOwner: l.ownerId,
            state: l.state,
          });
        }
        l.renew(clock(), leaseMs);
        await provider.write(namespace, lockId, l.toModel());
        if (metrics) metrics.recordRenew();
        _emit(LOCK_EVENTS.RENEWED, l.toModel(), { expiresAt: l.expiresAt });
        return l.toModel();
      })
    );
  }

  function release(spec) {
    _require(spec, true);
    const { namespace, lockId, ownerId } = spec;
    return _withLock(() =>
      metricsTime(async () => {
        const l = await _load(namespace, lockId, undefined);
        if (
          l.state === STATE.AVAILABLE ||
          l.state === STATE.RELEASED ||
          l.state === STATE.EXPIRED
        ) {
          return false; // already free — idempotent
        }
        if (l.ownerId !== ownerId) {
          throw new OwnershipError(`lock: cannot release "${lockId}" — not the owner`, {
            ownerId,
            currentOwner: l.ownerId,
          });
        }
        if (metrics && l.acquiredAt != null) metrics.recordHeldDuration(clock() - l.acquiredAt);
        const released = l.release();
        await provider.write(namespace, lockId, released.toModel());
        if (metrics) metrics.recordRelease();
        _emit(LOCK_EVENTS.RELEASED, released.toModel());
        return true;
      })
    );
  }

  async function isHeld(spec) {
    _require(spec, false);
    return metricsTime(async () => {
      const l = await _load(spec.namespace, spec.lockId, undefined);
      return l.isLive(clock());
    });
  }

  async function owner(spec) {
    _require(spec, false);
    return metricsTime(async () => {
      const l = await _load(spec.namespace, spec.lockId, undefined);
      return l.isLive(clock()) ? l.ownerId : null;
    });
  }

  async function health() {
    const providerHealth = await provider.health();
    return {
      ok: Boolean(providerHealth && providerHealth.ok),
      provider: providerHealth,
      metrics: metrics ? metrics.snapshot() : null,
    };
  }

  function useProvider(p) {
    provider = assertProvider(p);
    return provider;
  }

  function metricsTime(fn) {
    return metrics && metrics.timeOp ? metrics.timeOp(fn) : fn();
  }

  return {
    acquire,
    tryAcquire,
    renew,
    release,
    isHeld,
    owner,
    health,
    useProvider,
    metrics: () => (metrics ? metrics.snapshot() : null),
    STATE,
  };
}

module.exports = { createLockService };
