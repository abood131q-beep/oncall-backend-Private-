'use strict';

/**
 * Localization application service (ADR-003 · ADR-005 §5).
 *
 * Thin bundle exposing the Localization domain to the Presentation layer
 * through dependency injection, so controllers never import the Domain
 * directly (ADR-005 §4 / compliance rule). Presentation receives `negotiate`
 * and `translate` as injected functions.
 */

const {
  negotiateLocale,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
} = require('../../domain/localization/localePolicy');
const { translate } = require('../../domain/localization/messageCatalog');

function createLocalizationService() {
  return {
    /** Accept-Language → supported locale (default 'ar'). */
    negotiate: (acceptLanguage) => negotiateLocale(acceptLanguage),
    /** (code, locale) → localized string. */
    translate: (code, locale) => translate(code, locale),
    supportedLocales: SUPPORTED_LOCALES,
    defaultLocale: DEFAULT_LOCALE,
  };
}

module.exports = { createLocalizationService };
