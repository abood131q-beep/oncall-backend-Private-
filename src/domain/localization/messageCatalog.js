'use strict';

/**
 * Localization domain — Message Catalog (ADR-003 Globalization).
 *
 * Single source of truth for user-facing response messages, keyed by a stable
 * message code and locale. Pure: no I/O, no framework (ADR-005 §18).
 *
 * BYTE-FIDELITY RULE: every `ar` value here is the EXACT string the legacy /
 * pre-localization controller returned. The default-locale path must remain
 * byte-identical (proven by the A/B harness). English (`en`) is the first
 * added global language; more locales are additive and never alter `ar`.
 *
 * Unknown code → returns the code itself (fail-visible, never throws).
 * Unknown locale for a known code → falls back to the default locale.
 */

const DEFAULT_LOCALE = 'ar';

/** code → { ar, en }. `ar` values are frozen contract strings. */
const MESSAGES = Object.freeze({
  // Users context
  FORBIDDEN_OTHER_USER: {
    ar: 'غير مصرح',
    en: 'Not authorized',
  },
  USER_NOT_FOUND: {
    ar: 'المستخدم غير موجود',
    en: 'User not found',
  },
  BALANCE_ADD_DEPRECATED: {
    ar: 'هذه النقطة معطّلة. استخدم POST /wallet/charge لشحن رصيدك.',
    en: 'This endpoint is disabled. Use POST /wallet/charge to top up your balance.',
  },
  REPORT_SUBMITTED: {
    ar: 'تم إرسال البلاغ',
    en: 'Your report has been submitted',
  },
});

/**
 * Translate a message code into a supported locale.
 * @param {string} code
 * @param {string} [locale='ar']
 * @returns {string}
 */
function translate(code, locale = DEFAULT_LOCALE) {
  const entry = MESSAGES[code];
  if (!entry) return code; // fail-visible, never throw
  return entry[locale] || entry[DEFAULT_LOCALE];
}

module.exports = { translate, MESSAGES, DEFAULT_LOCALE };
