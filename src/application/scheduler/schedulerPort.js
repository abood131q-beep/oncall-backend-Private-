'use strict';

/**
 * Scheduler PORT (Phase 14.3.3 §1) — the abstraction every Platform Service and
 * Extension depends on. Consumers NEVER touch the engine internals (queue, pool,
 * timers); they see only this contract:
 *
 *   schedule(job)                       enqueue with the job's own timing
 *   scheduleAt(job, date)               one-time at an absolute instant
 *   scheduleAfter(job, durationMs)      one-time after a delay
 *   scheduleRecurring(job, expression)  cron string or { intervalMs }
 *   cancel(jobId) / pause(jobId) / resume(jobId)
 *   exists(jobId) / list() / status(jobId) / runNow(jobId)
 *
 * A `job` is `{ name, owner, handler, priority?, retryPolicy?, timeout?,
 * metadata?, tags?, scheduledAt?, interval?, cron? }`. `handler(ctx)` is the
 * unit of work; `ctx` carries `{ jobId, attempt, metadata, signal, logger }`.
 */

const METHODS = Object.freeze([
  'schedule',
  'scheduleAt',
  'scheduleAfter',
  'scheduleRecurring',
  'cancel',
  'pause',
  'resume',
  'exists',
  'list',
  'status',
  'runNow',
]);

function assertScheduler(s) {
  if (!s || typeof s !== 'object') throw new Error('Scheduler: adapter required');
  for (const m of METHODS) {
    if (typeof s[m] !== 'function') throw new Error(`Scheduler: adapter must implement ${m}()`);
  }
  return s;
}

module.exports = { assertScheduler, METHODS };
