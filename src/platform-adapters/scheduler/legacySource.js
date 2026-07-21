'use strict';

/**
 * legacySource.js — Phase 17.6.
 *
 * A read-only inventory of the LEGACY *schedules* — the cadence/next-run view of the same
 * background timers the Jobs source (17.5) describes as job definitions. Reusing the single
 * canonical timer inventory (`DEFAULT_JOBS`) avoids duplicating interval values; this source
 * simply projects each timer onto its SCHEDULING concern (id, owner, kind, cadence, cron,
 * enabled), keeping a strict separation between "what runs" (Jobs) and "when it runs"
 * (Scheduler).
 *
 * The legacy scheduler (the app's real setInterval timers) remains the ONLY owner of timing and
 * the ONLY producer of work. This source is metadata only — it schedules and executes nothing.
 */

const { DEFAULT_JOBS } = require('../jobs/legacySource');

/** Project a canonical timer onto its scheduling descriptor. */
function toSchedule(job) {
  return {
    id: job.id,
    owner: job.owner,
    kind: job.kind, // 'interval' | 'startup'
    intervalMs: job.intervalMs,
    cron: null, // the legacy timers are interval-based, not cron
    enabled: job.enabled,
  };
}

/**
 * @param {object} [options]
 * @param {Array}  [options.schedules] override the descriptor list (tests).
 */
function createLegacySchedulerSource({ schedules } = {}) {
  const list = Array.isArray(schedules)
    ? schedules.map((s) => ({ ...s }))
    : DEFAULT_JOBS.map(toSchedule);
  const byId = new Map(list.map((s) => [s.id, s]));

  return Object.freeze({
    source: 'legacy:scheduler',
    /** All legacy schedule descriptors (copies). */
    list: () => list.map((s) => ({ ...s })),
    /** Ids of all legacy schedules. */
    ids: () => list.map((s) => s.id),
    /** A single descriptor by id (copy), or null. */
    get: (id) => (byId.has(id) ? { ...byId.get(id) } : null),
    /** Verification categories this source declares (for coverage). */
    categories: () => ['id', 'owner', 'kind', 'intervalMs', 'cron', 'enabled'],
  });
}

module.exports = { createLegacySchedulerSource, toSchedule };
