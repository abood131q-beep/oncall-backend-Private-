'use strict';

/**
 * _shadow/index.js — Shared Shadow Framework (G1.0 reference).
 *
 * Generalizes the pieces every shadow integration needs, so kernels do not re-implement them
 * (G1.0 §7 "reuse / generalize; do not increase architectural debt"). It provides:
 *   • deepEqual  — deterministic structural equality (primitives, arrays, plain objects, NaN)
 *   • flatten    — object → dotted leaf map, for field-by-field comparison
 *   • typeOf     — stable type label (incl. 'null' / 'array')
 *   • redactValue— redact sensitive values by key (G1.0 §4)
 *   • createShadowMetrics — the FULL G1.0 §5 metric set, including confidenceLevel and
 *     coveragePct.
 *
 * This module is pure and side-effect-free. It is the go-forward canonical implementation;
 * the pre-G1.0 Configuration (17.3) and Observability (17.4) shadows carry their own local
 * copies and MAY adopt this module when next touched (per the Phase 17 Completion Report).
 */

const SENSITIVE = /secret|token|api[_-]?key|apikey|password|account|firebase|credential/i;

/** Deterministic deep equality across primitives, arrays, and plain objects; NaN === NaN. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/** Flatten an object into dotted leaf entries (arrays are treated as leaves). */
function flatten(obj, prefix = '', out = {}) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    out[prefix] = obj;
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** True if a key path names a sensitive value that must be redacted in records. */
function isSensitiveKey(key) {
  return SENSITIVE.test(String(key));
}

/** Return the value, or a redacted marker for sensitive keys. */
function redactValue(key, value) {
  return isSensitiveKey(key) ? '«redacted»' : value;
}

/**
 * Full G1.0 §5 shadow metrics (in-memory, isolated). Recording NEVER affects runtime.
 *
 * @param {object} [opts]
 * @param {Function} [opts.clock]
 * @param {number}   [opts.mismatchLogLimit=100]
 * @param {number}   [opts.confidenceN=20]     comparisons for full confidence weight
 * @param {number}   [opts.declaredSurface=0]  size of the declared verification surface
 *                                             (distinct leaf keys) used for coveragePct
 */
function createShadowMetrics(opts = {}) {
  const clock = opts.clock || (() => Date.now());
  const mismatchLogLimit = opts.mismatchLogLimit || 100;
  const confidenceN = opts.confidenceN || 20;
  let declaredSurface = opts.declaredSurface || 0;

  const counters = {
    requests: 0,
    comparisons: 0,
    matches: 0,
    mismatches: 0,
    verificationFailures: 0,
  };
  const latency = { count: 0, totalMs: 0, maxMs: 0 };
  const mismatchLog = [];
  const coveredKeys = new Set(); // distinct leaf keys actually compared → coveragePct

  function confidence() {
    if (counters.comparisons === 0) return 0;
    const ratio = counters.matches / counters.comparisons;
    const volume = Math.min(1, counters.comparisons / confidenceN);
    return Math.round(ratio * volume * 1000) / 1000;
  }

  function coverage() {
    if (declaredSurface > 0) {
      return Math.round(Math.min(1, coveredKeys.size / declaredSurface) * 100 * 1000) / 1000;
    }
    return coveredKeys.size > 0 ? 100 : 0;
  }

  return Object.freeze({
    recordRequest() {
      counters.requests++;
    },
    /** Record one field comparison. Pass `key` to count it toward coverage. */
    recordComparison(matched, latencyMs, key) {
      counters.comparisons++;
      if (matched) counters.matches++;
      else counters.mismatches++;
      if (key != null) coveredKeys.add(String(key));
      if (typeof latencyMs === 'number' && latencyMs >= 0) {
        latency.count++;
        latency.totalMs += latencyMs;
        if (latencyMs > latency.maxMs) latency.maxMs = latencyMs;
      }
    },
    recordMismatch(descriptor) {
      if (mismatchLog.length >= mismatchLogLimit) mismatchLog.shift();
      mismatchLog.push({ ...descriptor, at: clock() });
    },
    recordVerificationFailure(descriptor) {
      counters.verificationFailures++;
      if (descriptor) {
        if (mismatchLog.length >= mismatchLogLimit) mismatchLog.shift();
        mismatchLog.push({ ...descriptor, failure: true, at: clock() });
      }
    },
    setDeclaredSurface(n) {
      declaredSurface = Number(n) || 0;
    },
    snapshot() {
      const avgMs = latency.count ? latency.totalMs / latency.count : 0;
      const parityPct =
        counters.comparisons > 0 ? (counters.matches / counters.comparisons) * 100 : 100;
      return {
        ...counters,
        parityPct: Math.round(parityPct * 1000) / 1000,
        confidenceLevel: confidence(),
        coveragePct: coverage(),
        declaredSurface,
        coveredKeys: coveredKeys.size,
        latency: {
          samples: latency.count,
          avgMs: Math.round(avgMs * 1000) / 1000,
          maxMs: Math.round(latency.maxMs * 1000) / 1000,
        },
        mismatches_log: mismatchLog.slice(),
      };
    },
    reset() {
      counters.requests = 0;
      counters.comparisons = 0;
      counters.matches = 0;
      counters.mismatches = 0;
      counters.verificationFailures = 0;
      latency.count = 0;
      latency.totalMs = 0;
      latency.maxMs = 0;
      mismatchLog.length = 0;
      coveredKeys.clear();
    },
  });
}

module.exports = {
  /* core primitives */
  deepEqual,
  flatten,
  typeOf,
  isSensitiveKey,
  redactValue,
  createShadowMetrics,
  SENSITIVE,
};
