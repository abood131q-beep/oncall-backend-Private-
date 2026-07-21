'use strict';

/**
 * Compatibility evaluation (Phase 15.12 / ADR-041 §3) — PURE domain, deterministic.
 * Evaluates whether a requested (version, capabilities) is compatible with a
 * contract given its compatibility level, resolves the best supported version, and
 * negotiates a capability set. Version comparison reuses the platform semver kernel.
 * No I/O, no clock — the same inputs always yield the same result.
 */

const semver = require('../extensions/semver');
const { LEVEL, DEPRECATION } = require('./contract');

/** Compare two versions; null if either is not valid semver. */
function cmp(a, b) {
  if (!semver.isValid(a) || !semver.isValid(b)) return null;
  return semver.compare(a, b);
}

/** Whether a requested version is one the contract lists as supported. */
function isSupported(contract, version) {
  if (version === contract.version) return true;
  return (contract.supportedVersions || []).some((sv) => {
    if (sv === version) return true;
    return semver.isValid(version) && semver.satisfies(version, String(sv));
  });
}

/**
 * Evaluate a request against a contract.
 * @returns {{ compatible, versionOk, backward, forward, missingCapabilities, level, deprecated }}
 */
function evaluate(contract, request = {}) {
  const level = contract.compatibilityLevel;
  const version = request.version;
  const requestedCaps = request.capabilities || [];

  let versionOk;
  let backward = false;
  let forward = false;
  if (version == null) {
    versionOk = true;
  } else if (version === contract.version) {
    versionOk = true;
    backward = true;
    forward = true;
  } else if (level === LEVEL.NONE || level === LEVEL.STRICT) {
    versionOk = false;
  } else {
    const supported = isSupported(contract, version);
    const c = cmp(version, contract.version);
    backward = supported && c !== null && c <= 0;
    forward = supported && c !== null && c >= 0;
    if (level === LEVEL.BACKWARD) versionOk = backward;
    else if (level === LEVEL.FORWARD) versionOk = forward;
    else versionOk = supported; // full
  }

  const caps = new Set(contract.capabilities || []);
  const missingCapabilities = requestedCaps.filter((cap) => !caps.has(cap));
  const deprecated = contract.deprecationStatus !== DEPRECATION.ACTIVE;
  const retired = contract.deprecationStatus === DEPRECATION.RETIRED;

  return {
    compatible: versionOk && missingCapabilities.length === 0 && !retired,
    versionOk,
    backward,
    forward,
    missingCapabilities,
    level,
    deprecated,
  };
}

/** Resolve the highest supported concrete version satisfying a request (or null). */
function resolveVersion(contract, requested) {
  const candidates = [...new Set([contract.version, ...(contract.supportedVersions || [])])]
    .filter((v) => semver.isValid(v))
    .sort((a, b) => semver.compare(b, a));
  if (requested == null) return contract.version;
  for (const cand of candidates) {
    if (cand === requested || semver.satisfies(cand, String(requested))) return cand;
  }
  return null;
}

/** Negotiate the agreed capability set — the intersection with what the contract offers. */
function negotiateCapabilities(contract, requested) {
  if (!requested || requested.length === 0) return [...(contract.capabilities || [])];
  const offered = new Set(contract.capabilities || []);
  return requested.filter((c) => offered.has(c));
}

module.exports = { evaluate, resolveVersion, negotiateCapabilities, isSupported };
