'use strict';

/**
 * index.js — Consolidated Identity Kernel domain barrel (Phase 19.4 skeleton, ADR-049).
 * Pure domain surface: principal, session, policies, events, errors. No I/O, no framework.
 */

const principal = require('./principal');
const session = require('./session');
const policies = require('./policies');
const events = require('./events');
const errors = require('./errors');

module.exports = {
  ...principal,
  ...session,
  ...policies,
  ...events,
  ...errors,
  IDENTITY_KERNEL_EVENTS: events.IDENTITY_KERNEL_EVENTS,
  SESSION_STATE: session.STATE,
};
