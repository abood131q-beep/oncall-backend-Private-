'use strict';

/**
 * legacySource.js — Phase 17.5.
 *
 * A read-only inventory of the LEGACY background jobs — the single Source of Truth and the ONLY
 * producer of actual work. It returns static descriptors (metadata only); it does NOT schedule,
 * execute, or touch any timer, so building the inventory cannot change scheduling or runtime.
 *
 * The descriptors mirror the real legacy timers, unchanged:
 *   • backup            — src/services/backup.js         setInterval 6h
 *   • cache-sweep       — src/services/cache.js          setInterval 30s
 *   • wal-checkpoint    — src/app/onCallApplication.js   setInterval 5m (sqlite engine only)
 *   • taxi-autofix      — src/socket.js                  setInterval 1h
 *   • ghost-trip-cleanup— src/app/onCallApplication.js   startup one-shot
 *
 * Each descriptor is a plain, serializable object. The inventory is injectable for tests.
 */

const DEFAULT_JOBS = Object.freeze([
  {
    id: 'backup',
    kind: 'interval',
    intervalMs: 6 * 60 * 60 * 1000, // 21_600_000
    idempotent: true,
    owner: 'src/services/backup.js',
    enabled: true,
  },
  {
    id: 'cache-sweep',
    kind: 'interval',
    intervalMs: 30 * 1000, // 30_000
    idempotent: true,
    owner: 'src/services/cache.js',
    enabled: true,
  },
  {
    id: 'wal-checkpoint',
    kind: 'interval',
    intervalMs: 5 * 60 * 1000, // 300_000
    idempotent: true,
    owner: 'src/app/onCallApplication.js',
    enabled: true,
  },
  {
    id: 'taxi-autofix',
    kind: 'interval',
    intervalMs: 60 * 60 * 1000, // 3_600_000
    idempotent: true,
    owner: 'src/socket.js',
    enabled: true,
  },
  {
    id: 'ghost-trip-cleanup',
    kind: 'startup',
    intervalMs: 0,
    idempotent: true,
    owner: 'src/app/onCallApplication.js',
    enabled: true,
  },
]);

/**
 * @param {object} [options]
 * @param {Array}  [options.jobs] override the descriptor list (tests).
 */
function createLegacyJobsSource({ jobs } = {}) {
  const list = Array.isArray(jobs)
    ? jobs.map((j) => ({ ...j }))
    : DEFAULT_JOBS.map((j) => ({ ...j }));
  const byId = new Map(list.map((j) => [j.id, j]));

  return Object.freeze({
    source: 'legacy:background-jobs',
    /** All legacy job descriptors (copies). */
    list: () => list.map((j) => ({ ...j })),
    /** Ids of all legacy jobs. */
    ids: () => list.map((j) => j.id),
    /** A single descriptor by id (copy), or null. */
    get: (id) => (byId.has(id) ? { ...byId.get(id) } : null),
    /** Verification categories this source declares (for coverage). */
    categories: () => ['id', 'kind', 'intervalMs', 'idempotent', 'owner', 'enabled'],
  });
}

module.exports = { createLegacyJobsSource, DEFAULT_JOBS };
