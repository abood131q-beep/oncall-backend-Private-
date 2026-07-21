'use strict';

/**
 * Route matching (Phase 15.6 / ADR-035 §3) — PURE domain, deterministic. Matches a
 * request (method + path + version) against route definitions and orders the matches
 * so resolution is stable: highest priority first, then most-specific path (more
 * static segments), then routeId. Path patterns support `:param` captures and a
 * single-segment `*` wildcard. Version matching reuses the platform semver kernel.
 */

const semver = require('../extensions/semver');

function segments(path) {
  return String(path)
    .split('/')
    .filter((s) => s.length > 0);
}

/** Match a path pattern against a concrete path → { matched, params }. */
function matchPath(pattern, path) {
  const ps = segments(pattern);
  const cs = segments(path);
  if (ps.length !== cs.length) return { matched: false, params: {} };
  const params = {};
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (p[0] === ':') params[p.slice(1)] = cs[i];
    else if (p === '*') continue;
    else if (p !== cs[i]) return { matched: false, params: {} };
  }
  return { matched: true, params };
}

function matchMethod(routeMethod, requestMethod) {
  return routeMethod === '*' || routeMethod === String(requestMethod || '').toUpperCase();
}

/**
 * Version-aware match — bidirectional so either side may be the concrete version
 * and the other a semver range: a route that declares `>=1.0.0` matches a request
 * for `1.5.0`, and a route that serves `1.4.0` matches a request constrained to
 * `>=1.2.0`. `*` or an absent request version matches anything; otherwise falls back
 * to exact string equality.
 */
function matchVersion(routeVersion, requestVersion) {
  if (routeVersion === '*' || requestVersion == null) return true;
  const rv = String(routeVersion);
  const qv = String(requestVersion);
  if (semver.isValid(rv) && semver.satisfies(rv, qv)) return true;
  if (semver.isValid(qv) && semver.satisfies(qv, rv)) return true;
  return rv === qv;
}

/** Full route match → { matched, params }. */
function matchRoute(route, request = {}) {
  if (!matchMethod(route.method, request.method)) return { matched: false, params: {} };
  if (!matchVersion(route.version, request.version)) return { matched: false, params: {} };
  return matchPath(route.path, request.path || '');
}

/** Specificity: count of static (non-param, non-wildcard) path segments. */
function specificity(route) {
  return segments(route.path).filter((s) => s[0] !== ':' && s !== '*').length;
}

/**
 * Resolve matching routes for a request, ordered deterministically:
 * priority desc, specificity desc, then routeId asc. Returns [{ route, params }].
 */
function resolveRoutes(routes, request = {}) {
  const matches = [];
  for (const route of routes) {
    const m = matchRoute(route, request);
    if (m.matched) matches.push({ route, params: m.params });
  }
  matches.sort(
    (a, b) =>
      b.route.priority - a.route.priority ||
      specificity(b.route) - specificity(a.route) ||
      (a.route.routeId < b.route.routeId ? -1 : a.route.routeId > b.route.routeId ? 1 : 0)
  );
  return matches;
}

module.exports = {
  segments,
  matchPath,
  matchMethod,
  matchVersion,
  matchRoute,
  specificity,
  resolveRoutes,
};
