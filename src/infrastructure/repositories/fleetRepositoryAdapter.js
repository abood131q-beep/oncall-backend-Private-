'use strict';

/**
 * Fleet repository adapter — Infrastructure layer.
 * Implements the fleetRepository port over the existing `taxis` table and the
 * existing read cache. Every statement and the cache key/TTL are byte-for-byte
 * the legacy ones (`GET /taxis` list + admin INSERT/DELETE), so behavior is
 * preserved while the layering is corrected (ADR-005/ADR-004). The sanitized
 * projection is the Domain's FleetValidationPolicy — no extra column leaks.
 *
 * NOTE: registration/removal do NOT invalidate the 'taxis' cache — this matches
 * legacy exactly (the 10s TTL is the only invalidation path). Adding a clear
 * here would be a behavior change and is therefore intentionally omitted.
 *
 * @param {object} deps — the existing DI service container
 */

const { fleetValidationPolicy } = require('../../domain/fleet/fleetPolicies');
const { REGISTERED_STATUS } = require('../../domain/fleet/fleetValues');

function createFleetRepositoryAdapter(deps) {
  const { dbAll, dbRun, getCache, setCache, CACHE_TTL } = deps;

  return {
    async listAll() {
      const cached = getCache('taxis');
      if (cached) return cached;
      const rows = await dbAll('SELECT * FROM taxis');
      const safe = rows.map((r) => fleetValidationPolicy(r));
      setCache('taxis', safe, CACHE_TTL.taxis);
      return safe;
    },

    async register(name, lat, lng) {
      const result = await dbRun('INSERT INTO taxis (name, lat, lng, status) VALUES (?,?,?,?)', [
        name,
        lat,
        lng,
        REGISTERED_STATUS,
      ]);
      return result.lastID;
    },

    remove: (id) => dbRun('DELETE FROM taxis WHERE id = ?', [id]),
  };
}

module.exports = { createFleetRepositoryAdapter };
