'use strict';

/**
 * Retry policy (Phase 14.3.3 §3) — PURE domain, deterministic.
 *
 * Decides whether a failed job should be retried and, if so, after how long.
 * Supports: No Retry, Fixed delay, Exponential backoff, a Maximum-Attempts cap,
 * and (via the engine) Dead-Letter handling once retries are exhausted.
 *
 * Policy shape:
 *   { type: 'none'|'fixed'|'exponential',
 *     maxAttempts?: number,   // max RETRIES (not counting the first run); default 0
 *     delayMs?: number,       // base delay; default 0
 *     factor?: number,        // exponential multiplier; default 2
 *     maxDelayMs?: number }   // clamp for exponential; default Infinity
 */

const RETRY_TYPES = Object.freeze({ NONE: 'none', FIXED: 'fixed', EXPONENTIAL: 'exponential' });

function normalize(policy = {}) {
  const type = policy.type || RETRY_TYPES.NONE;
  if (!Object.values(RETRY_TYPES).includes(type)) {
    throw new Error(`retryPolicy: unknown type "${type}"`);
  }
  return Object.freeze({
    type,
    maxAttempts: Number.isInteger(policy.maxAttempts) ? policy.maxAttempts : 0,
    delayMs: typeof policy.delayMs === 'number' ? policy.delayMs : 0,
    factor: typeof policy.factor === 'number' ? policy.factor : 2,
    maxDelayMs: typeof policy.maxDelayMs === 'number' ? policy.maxDelayMs : Infinity,
  });
}

/**
 * Decide the next action after a failure.
 * @param {object} policy normalized policy
 * @param {number} retriesDone how many retries have ALREADY happened (0 on first failure)
 * @returns {{ retry: boolean, delayMs: number }}
 */
function decide(policy, retriesDone) {
  const p = policy && policy.type ? policy : normalize(policy);
  if (p.type === RETRY_TYPES.NONE || retriesDone >= p.maxAttempts) {
    return { retry: false, delayMs: 0 };
  }
  let delayMs;
  if (p.type === RETRY_TYPES.FIXED) {
    delayMs = p.delayMs;
  } else {
    // exponential: base * factor^retriesDone, clamped
    delayMs = Math.min(p.delayMs * Math.pow(p.factor, retriesDone), p.maxDelayMs);
  }
  return { retry: true, delayMs };
}

module.exports = { RETRY_TYPES, normalize, decide };
