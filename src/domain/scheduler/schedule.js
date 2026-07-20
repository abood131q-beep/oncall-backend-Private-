'use strict';

/**
 * Schedule computation (Phase 14.3.3 §5) — PURE domain. Computes the next run
 * instant for each scheduling type, deterministically given a `nowMs`:
 *   once      → runs at a fixed instant (default now)
 *   delayed   → now + duration
 *   interval  → every N ms (strictly future)
 *   cron      → next cron match strictly after now
 */

const { SCHEDULE_TYPE } = require('./job');
const cron = require('./cron');

/** Build the scheduling spec fields (scheduleType/nextRun/interval/cron) for createJob. */
function planOnce(nowMs, atMs) {
  return { scheduleType: SCHEDULE_TYPE.ONCE, nextRun: typeof atMs === 'number' ? atMs : nowMs };
}

function planDelayed(nowMs, durationMs) {
  if (typeof durationMs !== 'number' || durationMs < 0) throw new Error('schedule: bad duration');
  return { scheduleType: SCHEDULE_TYPE.DELAYED, nextRun: nowMs + durationMs };
}

function planInterval(nowMs, intervalMs) {
  if (typeof intervalMs !== 'number' || intervalMs <= 0) throw new Error('schedule: bad interval');
  return {
    scheduleType: SCHEDULE_TYPE.INTERVAL,
    interval: intervalMs,
    nextRun: nowMs + intervalMs,
  };
}

function planCron(nowMs, expr) {
  const next = cron.nextAfter(expr, nowMs);
  if (next == null) throw new Error(`schedule: cron "${expr}" yields no next run`);
  return { scheduleType: SCHEDULE_TYPE.CRON, cron: expr, nextRun: next };
}

/**
 * Given a recurring job that just ran, compute its next run (strictly future).
 * Returns null for non-recurring jobs (they do not reschedule).
 */
function nextRecurrence(job, nowMs) {
  if (job.scheduleType === SCHEDULE_TYPE.INTERVAL) {
    return nowMs + job.interval;
  }
  if (job.scheduleType === SCHEDULE_TYPE.CRON) {
    return cron.nextAfter(job.cron, nowMs);
  }
  return null;
}

module.exports = { planOnce, planDelayed, planInterval, planCron, nextRecurrence };
