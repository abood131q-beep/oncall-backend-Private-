'use strict';

/**
 * Notification — the Notifications bounded-context Aggregate Root (ADR-002 §4).
 *
 * Models a dispatchable push message (recipient, title, body, type, data). Pure:
 * no I/O, no framework, no SQL (ADR-005 §18). A stored notification *record*
 * (read/unread history) is served by the migrated Users surface; this aggregate
 * governs the dispatch/device-token side that the Notifications context owns.
 */

const { notificationType } = require('./notificationValues');

function reconstituteNotification(snapshot) {
  return new Notification(snapshot || {});
}

class Notification {
  constructor({ phone, title, body, type, data } = {}) {
    this._phone = phone;
    this._title = title;
    this._body = body;
    this._type = notificationType(type);
    this._data = data || {};
  }

  get phone() {
    return this._phone;
  }
  get type() {
    return this._type;
  }

  /** A push is dispatchable only with a recipient, a title, and a body. */
  isDispatchable() {
    return Boolean(this._phone && this._title && this._body);
  }
}

module.exports = { Notification, reconstituteNotification };
