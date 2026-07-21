'use strict';

/**
 * Notification PORT (Phase 15.1 / ADR-030 §1) — the abstraction contract the
 * platform (and the SDK adapter) depend on, so callers never bind to the concrete
 * engine. Exposes ONLY the seven kernel operations.
 *
 *   registerChannel(spec) → channel descriptor
 *   send(spec, opts)      → notification model (delivered/sent/failed)
 *   schedule(spec, opts)  → notification model (scheduled)
 *   cancel(spec, opts)    → boolean
 *   status(spec, opts)    → notification model | null
 *   verify(opts)          → { ok, issues }  (definition integrity)
 *   health()              → { ok, ... }
 */

const METHODS = Object.freeze([
  'registerChannel',
  'send',
  'schedule',
  'cancel',
  'status',
  'verify',
  'health',
]);

function assertNotifications(s) {
  if (!s) throw new Error('NotificationsPort: implementation required');
  for (const m of METHODS) {
    if (typeof s[m] !== 'function') throw new Error(`NotificationsPort: must implement ${m}()`);
  }
  return s;
}

module.exports = { assertNotifications, METHODS };
