'use strict';

/**
 * hookBus (Phase 14.2 §6 + §8) — safe lifecycle-hook execution with per-handler
 * ISOLATION, TIMEOUT, and a CIRCUIT BREAKER. A misbehaving extension hook can
 * NEVER crash the platform, block other handlers, or corrupt a transaction:
 *   • Observational hooks (After-hooks and events) run best-effort; failures are
 *     recorded, never thrown to the caller.
 *   • Blocking hooks (Before*) may return `{ cancel, reason }`; a handler
 *     TIMEOUT/THROW is treated as "no opinion" (fail-open) so the platform flow
 *     proceeds — an extension defect must not deny service.
 * Hooks never receive repositories/tx; they operate on a frozen, cloned context.
 */

const { isKnownHook, isBlockingHook } = require('../../domain/extensions/hooksCatalog');

const DEFAULT_TIMEOUT_MS = 200;
const DEFAULT_BREAKER_THRESHOLD = 5; // consecutive failures → open
const DEFAULT_BREAKER_COOLDOWN_MS = 30000;

function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(onTimeout());
      }
    }, ms);
    Promise.resolve(promise).then(
      (v) => {
        if (!settled) {
          settled = true;
          clearTimeout(t);
          resolve({ ok: true, value: v });
        }
      },
      (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(t);
          resolve({ ok: false, error: err });
        }
      }
    );
  });
}

function createHookBus(deps = {}) {
  const timeoutMs = deps.timeoutMs || DEFAULT_TIMEOUT_MS;
  const threshold = deps.breakerThreshold || DEFAULT_BREAKER_THRESHOLD;
  const cooldownMs = deps.breakerCooldownMs || DEFAULT_BREAKER_COOLDOWN_MS;
  const now = deps.clock || (() => Date.now());
  const metrics = deps.metrics || null; // optional { record(extId,{hook,latency,ok}) }
  const log = deps.logger || { warn() {}, error() {} };

  // hook -> [ { extId, fn } ]
  const registrations = new Map();
  // extId -> { failures, openUntil }
  const breaker = new Map();

  function register(hook, fn, { extId } = {}) {
    if (!isKnownHook(hook)) throw new Error(`hookBus: unknown hook "${hook}"`);
    if (typeof fn !== 'function') throw new Error('hookBus: handler must be a function');
    if (!extId) throw new Error('hookBus: extId required');
    if (!registrations.has(hook)) registrations.set(hook, []);
    const entry = { extId, fn };
    registrations.get(hook).push(entry);
    return () => {
      const arr = registrations.get(hook) || [];
      const i = arr.indexOf(entry);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  function removeExtension(extId) {
    for (const arr of registrations.values()) {
      for (let i = arr.length - 1; i >= 0; i--) if (arr[i].extId === extId) arr.splice(i, 1);
    }
    breaker.delete(extId);
  }

  function breakerOpen(extId) {
    const b = breaker.get(extId);
    return b && b.openUntil && now() < b.openUntil;
  }

  function recordOutcome(extId, ok) {
    const b = breaker.get(extId) || { failures: 0, openUntil: 0 };
    if (ok) {
      b.failures = 0;
      b.openUntil = 0;
    } else {
      b.failures += 1;
      if (b.failures >= threshold) b.openUntil = now() + cooldownMs;
    }
    breaker.set(extId, b);
  }

  /**
   * Run all handlers of a hook. Returns { cancelled, reason, results[] }.
   * `cancelled` is only ever true for Before* hooks whose handler explicitly
   * returned { cancel:true }. Timeouts/throws never cancel (fail-open).
   */
  async function run(hook, context) {
    const handlers = (registrations.get(hook) || []).slice();
    const blocking = isBlockingHook(hook);
    const frozenCtx = Object.freeze({ ...(context || {}) });
    const results = [];
    let cancelled = false;
    let reason = null;

    for (const { extId, fn } of handlers) {
      if (breakerOpen(extId)) {
        results.push({ extId, skipped: 'circuit-open' });
        continue;
      }
      const start = now();
      const outcome = await withTimeout(
        Promise.resolve().then(() => fn(frozenCtx)),
        timeoutMs,
        () => ({ ok: false, timeout: true })
      );
      const latency = now() - start;
      if (metrics) metrics.record(extId, { hook, latency, ok: outcome.ok });

      if (outcome.ok) {
        recordOutcome(extId, true);
        results.push({ extId, ok: true, value: outcome.value });
        if (blocking && outcome.value && outcome.value.cancel === true) {
          cancelled = true;
          reason = outcome.value.reason || `cancelled by ${extId}`;
          break; // a Before* veto short-circuits remaining handlers
        }
      } else {
        recordOutcome(extId, false);
        const err = outcome.timeout ? 'timeout' : outcome.error && outcome.error.message;
        log.warn && log.warn('hookBus: handler failed (isolated, fail-open)', { hook, extId, err });
        results.push({ extId, ok: false, error: err });
        // fail-open: platform proceeds regardless
      }
    }
    return { hook, cancelled, reason, results };
  }

  return { register, removeExtension, run, breakerOpen };
}

module.exports = { createHookBus };
