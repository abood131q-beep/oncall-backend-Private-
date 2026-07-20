'use strict';

/**
 * semver — minimal, dependency-free Semantic Versioning for the Extension
 * Platform (Phase 14.2). Pure Domain kernel: parse, compare, and range
 * satisfaction for `^`, `~`, `>=`, `>`, `<=`, `<`, exact, and `*`/`x`.
 * Enough for dependency resolution + platform/apiVersion gates without a
 * third-party package (keeps the extension trust surface minimal).
 */

const CORE = /^(\d+)\.(\d+)\.(\d+)$/;

function parse(v) {
  const m = CORE.exec(String(v).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function isValid(v) {
  return parse(v) !== null;
}

/** -1 if a<b, 0 if equal, 1 if a>b. Throws on invalid. */
function compare(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) throw new Error(`semver.compare: invalid version(s) "${a}" / "${b}"`);
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  return 0;
}

/**
 * satisfies(version, range) — supports:
 *   *  / x / ""      → any
 *   ^1.2.3           → >=1.2.3 <2.0.0 (or <0.(minor+1) when major=0)
 *   ~1.2.3           → >=1.2.3 <1.3.0
 *   >=1.2.3 / >1.2.3 / <=1.2.3 / <1.2.3
 *   1.2.3 / =1.2.3   → exact
 */
function satisfies(version, range) {
  if (!isValid(version)) return false;
  const r = String(range || '*').trim();
  if (r === '*' || r === 'x' || r === '') return true;

  const opMatch = /^(>=|<=|>|<|=|\^|~)?\s*(\d+\.\d+\.\d+)$/.exec(r);
  if (!opMatch) return false;
  const op = opMatch[1] || '=';
  const base = opMatch[2];
  const c = compare(version, base);

  switch (op) {
    case '=':
      return c === 0;
    case '>':
      return c > 0;
    case '>=':
      return c >= 0;
    case '<':
      return c < 0;
    case '<=':
      return c <= 0;
    case '~': {
      // >= base AND < next-minor
      const p = parse(base);
      const upper = `${p.major}.${p.minor + 1}.0`;
      return c >= 0 && compare(version, upper) < 0;
    }
    case '^': {
      const p = parse(base);
      let upper;
      if (p.major > 0) upper = `${p.major + 1}.0.0`;
      else if (p.minor > 0) upper = `0.${p.minor + 1}.0`;
      else upper = `0.0.${p.patch + 1}`;
      return c >= 0 && compare(version, upper) < 0;
    }
    default:
      return false;
  }
}

module.exports = { parse, isValid, compare, satisfies };
