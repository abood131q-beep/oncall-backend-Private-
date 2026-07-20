'use strict';

/**
 * SDK ↔ Scheduler adapter (Phase 14.3.3 §8/§9). Gives an Extension a granted,
 * owner-scoped Scheduler port via `this.scheduler()` WITHOUT leaking engine
 * internals. Security:
 *   • Ownership — the extension id is forced as `owner`; an extension can only
 *     see/cancel/pause/resume/inspect its OWN jobs.
 *   • Permission — scheduling requires the `schedule:jobs` capability to be
 *     granted; otherwise every mutating call throws.
 *   • Isolation — engine control surfaces (tick/start/stop/shutdown/deadLetter)
 *     are never exposed to extensions.
 */

const { PermissionError } = require('../../sdk/extensions/errors');

function toSchedulerPort(scheduler, { owner, canSchedule = true } = {}) {
  if (!owner) throw new Error('toSchedulerPort: owner required');

  const requirePermission = () => {
    if (!canSchedule) {
      throw new PermissionError(`extension "${owner}" lacks capability "schedule:jobs"`);
    }
  };

  const withOwner = (jobSpec) => ({ ...jobSpec, owner });

  // Only jobs owned by this extension are visible/controllable.
  const ownsJob = (jobId) => {
    const found = scheduler.list().find((j) => j.jobId === jobId);
    return Boolean(found && found.owner === owner);
  };
  const guardOwned = (jobId) => {
    if (!ownsJob(jobId)) {
      throw new PermissionError(`extension "${owner}" does not own job "${jobId}"`);
    }
  };

  return {
    schedule(job) {
      requirePermission();
      return scheduler.schedule(withOwner(job));
    },
    scheduleAt(job, date) {
      requirePermission();
      return scheduler.scheduleAt(withOwner(job), date);
    },
    scheduleAfter(job, durationMs) {
      requirePermission();
      return scheduler.scheduleAfter(withOwner(job), durationMs);
    },
    scheduleRecurring(job, expression) {
      requirePermission();
      return scheduler.scheduleRecurring(withOwner(job), expression);
    },
    cancel(jobId) {
      guardOwned(jobId);
      return scheduler.cancel(jobId);
    },
    pause(jobId) {
      guardOwned(jobId);
      return scheduler.pause(jobId);
    },
    resume(jobId) {
      guardOwned(jobId);
      return scheduler.resume(jobId);
    },
    exists(jobId) {
      return ownsJob(jobId);
    },
    list() {
      return scheduler.list().filter((j) => j.owner === owner);
    },
    status(jobId) {
      return ownsJob(jobId) ? scheduler.status(jobId) : null;
    },
    runNow(jobId) {
      guardOwned(jobId);
      return scheduler.runNow(jobId);
    },
  };
}

module.exports = { toSchedulerPort };
