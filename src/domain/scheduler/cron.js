'use strict';

/**
 * Minimal, dependency-free, deterministic 5-field cron parser (Phase 14.3.3 §5).
 *
 * Fields: minute hour day-of-month month day-of-week
 *   minute 0-59, hour 0-23, dom 1-31, month 1-12, dow 0-6 (0 = Sunday)
 * Each field supports: star, a, a-b, a,b, step syntax (star-slash-n and a-b/n),
 * and comma lists of those. When BOTH day-of-month and day-of-week are
 * restricted, a match on
 * EITHER qualifies (standard cron semantics).
 *
 * `nextAfter(expr, fromMs)` returns the next matching instant strictly after
 * `fromMs` (ms epoch), computed against UTC for determinism, or null if none
 * within the search bound (366 days).
 */

const BOUNDS = { minute: [0, 59], hour: [0, 23], dom: [1, 31], month: [1, 12], dow: [0, 6] };

function parseField(field, [min, max]) {
  const allowed = new Set();
  for (const part of String(field).split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? parseInt(stepPart, 10) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron: bad step in "${part}"`);
    let lo;
    let hi;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map((n) => parseInt(n, 10));
      lo = a;
      hi = b;
    } else {
      lo = hi = parseInt(rangePart, 10);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`cron: field value out of range in "${part}"`);
    }
    for (let v = lo; v <= hi; v += step) allowed.add(v);
  }
  return allowed;
}

function parse(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron: expected 5 fields, got ${parts.length}`);
  return {
    minute: parseField(parts[0], BOUNDS.minute),
    hour: parseField(parts[1], BOUNDS.hour),
    dom: parseField(parts[2], BOUNDS.dom),
    month: parseField(parts[3], BOUNDS.month),
    dow: parseField(parts[4], BOUNDS.dow),
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  };
}

function isValid(expr) {
  try {
    parse(expr);
    return true;
  } catch {
    return false;
  }
}

function matches(spec, d) {
  if (!spec.minute.has(d.getUTCMinutes())) return false;
  if (!spec.hour.has(d.getUTCHours())) return false;
  if (!spec.month.has(d.getUTCMonth() + 1)) return false;
  const domOk = spec.dom.has(d.getUTCDate());
  const dowOk = spec.dow.has(d.getUTCDay());
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  if (spec.domRestricted) return domOk;
  if (spec.dowRestricted) return dowOk;
  return true; // both '*'
}

const MINUTE_MS = 60 * 1000;
const SEARCH_BOUND_MINUTES = 366 * 24 * 60;

function nextAfter(expr, fromMs) {
  const spec = parse(expr);
  // Start at the next whole minute strictly after `fromMs`.
  const start = new Date(fromMs);
  start.setUTCSeconds(0, 0);
  let t = start.getTime() + MINUTE_MS;
  for (let i = 0; i < SEARCH_BOUND_MINUTES; i++) {
    const d = new Date(t);
    if (matches(spec, d)) return t;
    t += MINUTE_MS;
  }
  return null;
}

module.exports = { parse, isValid, nextAfter, matches };
