'use strict';

/**
 * Service Discovery PORT (Phase 15.5 / ADR-034 §1) — the abstraction contract the
 * platform (and the SDK adapter) depend on, so callers never bind to the concrete
 * engine. Exposes ONLY the six kernel operations.
 *
 *   register(spec, opts)  → public service model
 *   discover(spec, opts)  → ordered matching instances + explanation
 *   resolve(spec, opts)   → one selected instance + explanation
 *   list(opts)            → public service model[]
 *   verify(opts)          → { ok, issues } (endpoint + checksum integrity)
 *   health()              → { ok, ... }
 */

const METHODS = Object.freeze(['register', 'discover', 'resolve', 'list', 'verify', 'health']);

function assertDiscovery(s) {
  if (!s) throw new Error('DiscoveryPort: implementation required');
  for (const m of METHODS) {
    if (typeof s[m] !== 'function') throw new Error(`DiscoveryPort: must implement ${m}()`);
  }
  return s;
}

module.exports = { assertDiscovery, METHODS };
