'use strict';

/**
 * Localization slice tests (ADR-003) — pure domain: locale negotiation +
 * message catalog. Proves the default-locale byte-fidelity rule and the
 * additive English path.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { negotiateLocale, DEFAULT_LOCALE } = require('../../src/domain/localization/localePolicy');
const { translate } = require('../../src/domain/localization/messageCatalog');

test('negotiateLocale: no header → default ar', () => {
  assert.equal(negotiateLocale(undefined), 'ar');
  assert.equal(negotiateLocale(''), 'ar');
  assert.equal(DEFAULT_LOCALE, 'ar');
});

test('negotiateLocale: en and quality ordering', () => {
  assert.equal(negotiateLocale('en'), 'en');
  assert.equal(negotiateLocale('en-US,en;q=0.9'), 'en');
  assert.equal(negotiateLocale('fr-FR,fr;q=0.9,en;q=0.5'), 'en'); // fr unsupported → en
  assert.equal(negotiateLocale('fr'), 'ar'); // unsupported → default
});

test('translate: ar values are the exact legacy strings', () => {
  assert.equal(translate('FORBIDDEN_OTHER_USER', 'ar'), 'غير مصرح');
  assert.equal(translate('USER_NOT_FOUND', 'ar'), 'المستخدم غير موجود');
  assert.equal(translate('REPORT_SUBMITTED', 'ar'), 'تم إرسال البلاغ');
});

test('translate: en localized; unknown locale falls back to ar; unknown code returns code', () => {
  assert.equal(translate('FORBIDDEN_OTHER_USER', 'en'), 'Not authorized');
  assert.equal(translate('USER_NOT_FOUND', 'fr'), 'المستخدم غير موجود'); // fallback ar
  assert.equal(translate('NO_SUCH_CODE', 'en'), 'NO_SUCH_CODE'); // fail-visible
});
