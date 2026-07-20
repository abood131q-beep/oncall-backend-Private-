'use strict';

/**
 * Admin commands — immutable intent messages (ADR-005 §7) with input
 * validation (§10). Thin: legacy admin routes are admin-gated (middleware) and
 * lightly validated; business legality is decided by the Domain policies.
 */

function paginationCommand({ page, limit, status }) {
  return { ok: true, command: Object.freeze({ page, limit, status: status || null }) };
}

function idCommand({ id }) {
  return { ok: true, command: Object.freeze({ id }) };
}

function phoneCommand({ phone }) {
  return { ok: true, command: Object.freeze({ phone }) };
}

function addTaxiCommand({ name, lat, lng }) {
  return { ok: true, command: Object.freeze({ name, lat, lng }) };
}

function restoreCommand({ filename, confirm }) {
  return { ok: true, command: Object.freeze({ filename, confirm }) };
}

function shutdownCommand({ confirm }) {
  return { ok: true, command: Object.freeze({ confirm }) };
}

function nQueryCommand({ n, level, period }) {
  return { ok: true, command: Object.freeze({ n, level: level || null, period }) };
}

module.exports = {
  paginationCommand,
  idCommand,
  phoneCommand,
  addTaxiCommand,
  restoreCommand,
  shutdownCommand,
  nQueryCommand,
};
