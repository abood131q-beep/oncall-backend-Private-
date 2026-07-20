'use strict';

/**
 * Fleet commands — immutable intent messages (ADR-005 §7) with light input
 * validation (§10). Thin: the admin-gated endpoints are protected by middleware;
 * business legality is decided by the Domain policies.
 */

function registerCommand({ name, lat, lng }) {
  return { ok: true, command: Object.freeze({ name, lat, lng }) };
}

function idCommand({ id }) {
  return { ok: true, command: Object.freeze({ id }) };
}

module.exports = { registerCommand, idCommand };
