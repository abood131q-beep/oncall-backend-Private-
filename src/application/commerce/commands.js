'use strict';

/**
 * Commerce commands — immutable intent messages (ADR-005 §7) with light input
 * validation (§10). Ownership/authorization and money legality are decided by
 * the Domain policies; these just carry the caller's intent.
 */

function chargeCommand({ phone, amount, method }) {
  return { ok: true, command: Object.freeze({ phone, amount, method }) };
}

function walletQueryCommand({ paramPhone, authPhone }) {
  return { ok: true, command: Object.freeze({ paramPhone, authPhone }) };
}

module.exports = { chargeCommand, walletQueryCommand };
