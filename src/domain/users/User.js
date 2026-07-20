'use strict';

/**
 * User — the Users bounded-context Aggregate Root (ADR-002 §4, ADR-004 §12).
 *
 * Reconstituted from a persistence snapshot; it is the single consistency
 * boundary for passenger profile + status. Behavior is a 1:1 model of the
 * legacy passenger record used by src/routes/users.js.
 *
 * Pure: no I/O, no framework, no SQL (ADR-005 §18). Persistence shape stays in
 * Infrastructure; this aggregate speaks only domain vocabulary.
 */

const { displayName, tryCreateLocale, DEFAULT_LOCALE } = require('./profileValues');

/**
 * Rehydrate a User aggregate from a repository snapshot (raw DB row).
 * Unknown/absent fields fall back to legacy defaults so the aggregate never
 * fabricates state the persistence layer did not assert.
 *
 * @param {object} snapshot — a `users` row (phone, name, balance, is_active, ...)
 * @returns {User}
 */
function reconstituteUser(snapshot) {
  return new User(snapshot || {});
}

class User {
  constructor(row) {
    this._phone = row.phone;
    this._name = row.name;
    this._isActive = row.is_active === undefined ? 1 : row.is_active;
    // Locale is modeled but not persisted yet (no column); default applies.
    this._locale = tryCreateLocale(row.locale).value || DEFAULT_LOCALE;
  }

  get phone() {
    return this._phone;
  }

  /** Is the account active (not suspended)? Mirrors legacy `is_active`. */
  isActive() {
    return this._isActive !== 0;
  }

  get locale() {
    return this._locale;
  }

  /**
   * Rename — the sole profile mutation exposed today (Update Profile).
   * Returns the name to persist, preserving legacy pass-through semantics
   * (absent name → undefined → SQL NULL). No validation is added here on
   * purpose (strangler fidelity — see profileValues.js).
   *
   * @param {unknown} rawName
   * @returns {{ name: string | undefined }}
   */
  rename(rawName) {
    const dn = displayName(rawName);
    this._name = dn.value;
    return { name: dn.value };
  }
}

module.exports = { User, reconstituteUser };
