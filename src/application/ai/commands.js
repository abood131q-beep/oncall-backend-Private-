'use strict';

/**
 * AI / Automation commands — immutable intent messages (ADR-005 §7) with light
 * input validation (§10). Business legality is decided by the Domain policies.
 */

function classifyCommand({ kind }) {
  return { ok: true, command: Object.freeze({ kind }) };
}

function routeCommand({ kind, input, confidenceFloor }) {
  return { ok: true, command: Object.freeze({ kind, input, confidenceFloor }) };
}

function promptCommand({ name }) {
  return { ok: true, command: Object.freeze({ name }) };
}

module.exports = { classifyCommand, routeCommand, promptCommand };
