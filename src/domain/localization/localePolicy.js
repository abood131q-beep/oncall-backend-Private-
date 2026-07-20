'use strict';

/**
 * Localization domain — Locale negotiation policy (ADR-003 Globalization).
 *
 * Pure: no I/O, no framework (ADR-005 §18). Decides which supported locale a
 * request maps to, from an HTTP `Accept-Language` header value.
 *
 * GLOBAL-READINESS, NON-BREAKING: the default is `ar` (the current single
 * language). A request with no header — or any unsupported language — resolves
 * to `ar`, so existing clients (the mobile fleet sends no Accept-Language) get
 * byte-identical Arabic responses. New locales are additive.
 */

const SUPPORTED_LOCALES = Object.freeze(['ar', 'en']);
const DEFAULT_LOCALE = 'ar';

/**
 * Negotiate a supported locale from an Accept-Language header.
 * Minimal RFC-7231 handling: first matching primary subtag by q-order wins;
 * anything unrecognized falls back to the platform default.
 *
 * @param {string|undefined} acceptLanguage
 * @returns {'ar'|'en'}
 */
function negotiateLocale(acceptLanguage) {
  if (!acceptLanguage || typeof acceptLanguage !== 'string') return DEFAULT_LOCALE;

  const ranked = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const qParam = params.find((p) => p.trim().startsWith('q='));
      const q = qParam ? parseFloat(qParam.split('=')[1]) : 1;
      const primary = tag.trim().toLowerCase().split('-')[0];
      return { primary, q: Number.isFinite(q) ? q : 0 };
    })
    .filter((r) => r.primary)
    .sort((a, b) => b.q - a.q);

  for (const { primary } of ranked) {
    if (SUPPORTED_LOCALES.includes(primary)) return primary;
  }
  return DEFAULT_LOCALE;
}

module.exports = { negotiateLocale, SUPPORTED_LOCALES, DEFAULT_LOCALE };
