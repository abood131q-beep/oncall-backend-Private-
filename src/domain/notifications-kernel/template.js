'use strict';

/**
 * Template resolution (Phase 15.1 / ADR-030 §3) — PURE domain. Deterministic
 * `{{placeholder}}` substitution against a flat data object. No I/O, no clock: the
 * same template + data always renders the same string. Unknown placeholders render
 * as empty (never throw) so a delivery is never blocked by a missing variable.
 */

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Look up a dotted path (`a.b.c`) in a data object; undefined if absent. */
function lookup(data, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), data);
}

/** Render a template string against data. Non-string templates pass through. */
function render(template, data = {}) {
  if (typeof template !== 'string') return template;
  return template.replace(PLACEHOLDER, (_, path) => {
    const v = lookup(data, path);
    return v == null ? '' : String(v);
  });
}

/** Render the recipient-facing fields (subject/title/body) of a spec against data. */
function resolveContent(spec = {}, data = {}) {
  return {
    subject: render(spec.subject, data),
    title: render(spec.title, data),
    body: render(spec.body != null ? spec.body : spec.template, data),
  };
}

module.exports = { render, resolveContent, lookup };
