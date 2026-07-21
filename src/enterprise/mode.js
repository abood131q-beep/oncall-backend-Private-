'use strict';

/**
 * mode.js — Phase 17.2 boot-mode selection.
 *
 * The OnCall backend runs in exactly one of two modes, chosen ONLY by two env flags. Both
 * must be strictly '1' to select Enterprise mode; anything else (unset, '0', 'true', etc.)
 * keeps the legacy standalone path. Kept as a pure function so both server.js and the tests
 * share one source of truth.
 *
 *   Enterprise: PLATFORM_ENABLED === '1' AND PLATFORM_HOST === '1'
 *   Legacy:     otherwise
 */

function selectBootMode(env = process.env) {
  const enterprise = env.PLATFORM_ENABLED === '1' && env.PLATFORM_HOST === '1';
  return enterprise ? 'enterprise' : 'legacy';
}

module.exports = { selectBootMode };
