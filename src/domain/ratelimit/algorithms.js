'use strict';

/**
 * Rate-limiting algorithms (Phase 15.2 / ADR-031 §3) — PURE domain, deterministic.
 * Each algorithm is a side-effect-free function of (policy, counter state, now,
 * cost). It returns the admission decision plus BOTH the next state to persist if
 * the request is consumed AND the time-decayed state (no cost added), so the engine
 * can persist deterministically whether the request was allowed or blocked. No
 * randomness, no wall clock — `now` is injected.
 *
 * Result: { allowed, usage, remaining, resetTime, stateIfConsumed, stateDecayed }
 *   usage     — consumption counted BEFORE this request
 *   remaining — capacity left AFTER the decision (>= 0 integer)
 *   resetTime — epoch ms when the subject regains full capacity
 */

const { ALGORITHMS } = require('./policy');

const clamp0 = (n) => (n < 0 ? 0 : n);

function fixedWindow(policy, state, now, cost) {
  const cap = policy.capacity != null ? policy.capacity() : policy.burstLimit || policy.limit;
  const win = policy.window;
  const currentStart = Math.floor(now / win) * win;
  const count = state && state.windowStart === currentStart ? state.count : 0;
  const allowed = count + cost <= cap;
  const after = allowed ? count + cost : count;
  return {
    allowed,
    usage: count,
    remaining: clamp0(cap - after),
    resetTime: currentStart + win,
    stateIfConsumed: { windowStart: currentStart, count: count + cost },
    stateDecayed: { windowStart: currentStart, count },
  };
}

function slidingWindow(policy, state, now, cost) {
  const cap = policy.capacity != null ? policy.capacity() : policy.burstLimit || policy.limit;
  const win = policy.window;
  const cutoff = now - win;
  const entries = (state && Array.isArray(state.entries) ? state.entries : []).filter(
    (e) => e.t > cutoff
  );
  const usage = entries.reduce((s, e) => s + e.cost, 0);
  const allowed = usage + cost <= cap;
  const after = allowed ? usage + cost : usage;
  return {
    allowed,
    usage,
    remaining: clamp0(cap - after),
    resetTime: entries.length ? entries[0].t + win : now + win,
    stateIfConsumed: { entries: [...entries, { t: now, cost }] },
    stateDecayed: { entries },
  };
}

function tokenBucket(policy, state, now, cost) {
  const cap = policy.capacity != null ? policy.capacity() : policy.burstLimit || policy.limit;
  const rate = policy.limit / policy.window; // tokens per ms
  const last = state && state.lastRefill != null ? state.lastRefill : now;
  let tokens = state && state.tokens != null ? state.tokens : cap;
  const elapsed = clamp0(now - last);
  tokens = Math.min(cap, tokens + elapsed * rate);
  const allowed = tokens >= cost;
  const afterTokens = allowed ? tokens - cost : tokens;
  const deficit = cap - afterTokens;
  return {
    allowed,
    usage: cap - tokens,
    remaining: Math.floor(clamp0(afterTokens)),
    resetTime: now + (rate > 0 ? Math.ceil(deficit / rate) : 0),
    stateIfConsumed: { tokens: afterTokens, lastRefill: now },
    stateDecayed: { tokens, lastRefill: now },
  };
}

function leakyBucket(policy, state, now, cost) {
  const cap = policy.capacity != null ? policy.capacity() : policy.burstLimit || policy.limit;
  const rate = policy.limit / policy.window; // leak per ms
  const last = state && state.lastLeak != null ? state.lastLeak : now;
  let level = state && state.level != null ? state.level : 0;
  const elapsed = clamp0(now - last);
  level = clamp0(level - elapsed * rate);
  const allowed = level + cost <= cap;
  const afterLevel = allowed ? level + cost : level;
  return {
    allowed,
    usage: level,
    remaining: Math.floor(clamp0(cap - afterLevel)),
    resetTime: now + (rate > 0 ? Math.ceil(afterLevel / rate) : 0),
    stateIfConsumed: { level: afterLevel, lastLeak: now },
    stateDecayed: { level, lastLeak: now },
  };
}

const IMPLEMENTATIONS = Object.freeze({
  [ALGORITHMS.FIXED_WINDOW]: fixedWindow,
  [ALGORITHMS.SLIDING_WINDOW]: slidingWindow,
  [ALGORITHMS.TOKEN_BUCKET]: tokenBucket,
  [ALGORITHMS.LEAKY_BUCKET]: leakyBucket,
});

/** Dispatch to the policy's algorithm. Deterministic. */
function evaluate(policy, state, now, cost = 1) {
  const impl = IMPLEMENTATIONS[policy.algorithm];
  if (!impl) throw new Error(`ratelimit: no implementation for algorithm "${policy.algorithm}"`);
  return impl(policy, state || null, now, cost);
}

module.exports = {
  evaluate,
  fixedWindow,
  slidingWindow,
  tokenBucket,
  leakyBucket,
  IMPLEMENTATIONS,
};
