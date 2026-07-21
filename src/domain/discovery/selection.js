'use strict';

/**
 * Discovery selection (Phase 15.5 / ADR-034 §3) — PURE domain, deterministic. The
 * matching + ordering + endpoint-selection logic the engine composes. Given the
 * SAME services + query (+ optional key), it ALWAYS returns the SAME result — no
 * randomness, no clock. Version matching reuses the platform semver kernel; weighted
 * selection uses content hashing so a stable key always lands on the same instance.
 */

const semver = require('../extensions/semver');
const { checksum } = require('../extensions/integrity');
const { HEALTH } = require('./service');

/** Version-aware match: a semver range (or exact) against the instance version. */
function matchVersion(serviceVersion, constraint) {
  if (constraint == null) return true;
  if (semver.isValid(serviceVersion)) return semver.satisfies(serviceVersion, String(constraint));
  return String(serviceVersion) === String(constraint);
}

function subsetOf(required, present) {
  if (!required || required.length === 0) return true;
  const set = new Set(present || []);
  return required.every((x) => set.has(x));
}

function metadataMatch(required, present) {
  if (!required) return true;
  return Object.entries(required).every(([k, v]) => (present || {})[k] === v);
}

/** Whether one service matches a discovery query. */
function matchService(service, query = {}) {
  if (query.serviceName && service.serviceName !== query.serviceName) return false;
  if (!matchVersion(service.version, query.version)) return false;
  if (!subsetOf(query.capabilities, service.capabilities)) return false;
  if (!subsetOf(query.tags, service.tags)) return false;
  if (!metadataMatch(query.metadata, service.metadata)) return false;
  if (query.healthyOnly && service.healthStatus !== HEALTH.HEALTHY) return false;
  if (query.excludeFailed && service.healthStatus === HEALTH.FAILED) return false;
  return true;
}

/** Deterministic order: priority desc, then weight desc, then instanceId asc. */
function order(candidates) {
  return [...candidates].sort(
    (a, b) =>
      b.priority - a.priority ||
      b.weight - a.weight ||
      (a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0)
  );
}

/** Filter + order the candidate set for a query. */
function filter(services, query = {}) {
  return order(services.filter((s) => matchService(s, query)));
}

function hashBucket(str, mod) {
  const n = parseInt(checksum(String(str)).slice(0, 8), 16);
  return mod > 0 ? n % mod : 0;
}

/**
 * Select one instance from ORDERED candidates. Within the highest-priority tier,
 * a stable `key` picks weighted-deterministically; without a key, the first
 * (highest weight, then instanceId) wins. Returns an explanation.
 */
function selectOne(orderedCandidates, opts = {}) {
  if (!orderedCandidates.length) {
    return { selected: null, reason: 'no_candidates', tierSize: 0, candidateCount: 0 };
  }
  const topPriority = orderedCandidates[0].priority;
  const tier = orderedCandidates.filter((s) => s.priority === topPriority);
  if (opts.key != null) {
    const totalWeight = tier.reduce((sum, s) => sum + (s.weight > 0 ? s.weight : 0), 0);
    if (totalWeight > 0) {
      const bucket = hashBucket(`${opts.serviceName || ''}:${opts.key}`, totalWeight);
      let acc = 0;
      for (const s of tier) {
        acc += s.weight > 0 ? s.weight : 0;
        if (bucket < acc) {
          return {
            selected: s,
            reason: 'weighted',
            tierSize: tier.length,
            candidateCount: orderedCandidates.length,
            priority: topPriority,
            bucket,
            totalWeight,
          };
        }
      }
    }
  }
  return {
    selected: tier[0],
    reason: opts.key != null ? 'weighted_fallback_first' : 'priority_first',
    tierSize: tier.length,
    candidateCount: orderedCandidates.length,
    priority: topPriority,
  };
}

module.exports = { matchService, matchVersion, order, filter, selectOne, hashBucket };
