'use strict';

/**
 * shadow.js — Identity Shadow Verifier (Phase 20.a; DB surface added 20.b-cont, ADR-046/047/049).
 *
 *   Legacy Identity → Shadow (compare) → Record Differences → RETURN LEGACY RESULT ONLY
 *
 * Hard guarantees (identical to the Config/Jobs/Scheduler shadows):
 *   • the kernel is NEVER authoritative — every shadow* method returns the LEGACY result;
 *   • the shadow NEVER throws to the caller (kernel exceptions are captured as verification
 *     failures, never propagated) — it cannot influence production;
 *   • disabled ⇒ no comparison runs (pure legacy passthrough);
 *   • sensitive values (tokens) are redacted in mismatch records (G1.0 §4).
 *
 * Categories: jwt / authz / otp / principal (pure, sync) + refresh / repository (DB-bound, async).
 * A category with ZERO comparisons reports parityPct=null (NOT a misleading 100%) — coverage is
 * explicit.
 */

const { deepEqual, createShadowMetrics, redactValue, typeOf } = require('../_shadow');

const CATEGORIES = Object.freeze([
  'jwt',
  'authz',
  'otp',
  'principal',
  'refresh',
  'repository',
  'socket',
]);

function severityFor(category) {
  if (category === 'jwt' || category === 'authz' || category === 'refresh') return 'critical';
  if (category === 'otp' || category === 'repository') return 'high';
  return 'medium';
}

function createIdentityShadow(deps = {}) {
  const legacy = deps.legacy;
  const kernel = deps.kernel;
  const metrics = deps.metrics || createShadowMetrics();
  const enabledFn = typeof deps.enabled === 'function' ? deps.enabled : () => Boolean(deps.enabled);
  const log = deps.logger || { warn() {} };

  if (!legacy || !kernel) {
    throw new Error('identityShadow: both a legacy source and a kernel source are required');
  }

  const perCategory = Object.fromEntries(
    CATEGORIES.map((c) => [c, { comparisons: 0, matches: 0, mismatches: 0, failures: 0 }])
  );
  const cat = (c) =>
    perCategory[c] || (perCategory[c] = { comparisons: 0, matches: 0, mismatches: 0, failures: 0 });

  function redact(operation, value) {
    if (/token|jwt|issue|refresh/i.test(operation) && typeof value === 'string')
      return redactValue('token', value);
    return value;
  }

  /** Record a captured kernel exception (legacy stays authoritative). Never throws. */
  function evaluateFailure(operation, category, legacyValue, error, ctx) {
    cat(category).failures += 1;
    metrics.recordVerificationFailure({
      requestId: ctx.requestId || null,
      operation,
      category,
      differenceCategory: 'kernel-exception',
      rootCauseHypothesis: `kernel path threw: ${error.message}`,
      severity: severityFor(category),
      legacy: redact(operation, legacyValue),
      kernel: `«error:${error.message}»`,
    });
  }

  /** Compare + record a resolved (legacyValue, kernelValue) pair. Never throws. */
  function evaluate(operation, category, legacyValue, kernelValue, latencyMs, ctx) {
    const c = cat(category);
    const matched = deepEqual(legacyValue, kernelValue);
    c.comparisons += 1;
    metrics.recordComparison(matched, latencyMs, `${category}.${operation}`);
    if (matched) {
      c.matches += 1;
    } else {
      c.mismatches += 1;
      metrics.recordMismatch({
        requestId: ctx.requestId || null,
        operation,
        category,
        legacy: redact(operation, legacyValue),
        kernel: redact(operation, kernelValue),
        legacyType: typeOf(legacyValue),
        kernelType: typeOf(kernelValue),
        differenceCategory: 'value-mismatch',
        rootCauseHypothesis: 'kernel seam/translation or reimplementation diverges from legacy',
        severity: severityFor(category),
      });
      (log.warn || (() => {}))(`identity shadow mismatch: ${category}.${operation}`);
    }
  }

  /** SYNC comparison (pure ops). Returns the LEGACY value. Never throws. */
  function record(operation, category, legacyValue, kernelThunk, ctx = {}) {
    if (!enabledFn()) return legacyValue;
    metrics.recordRequest();
    const t0 = Date.now();
    let kernelValue;
    try {
      kernelValue = kernelThunk();
    } catch (e) {
      evaluateFailure(operation, category, legacyValue, e, ctx);
      return legacyValue;
    }
    evaluate(operation, category, legacyValue, kernelValue, Date.now() - t0, ctx);
    return legacyValue;
  }

  /** ASYNC comparison (DB ops). Awaits both sides. Returns the LEGACY value. Never throws/rejects. */
  async function recordAsync(operation, category, legacyPromise, kernelThunk, ctx = {}) {
    let legacyValue;
    try {
      legacyValue = await legacyPromise;
    } catch (e) {
      // Legacy itself threw — surface nothing new; return the rejection's absence as null.
      legacyValue = null;
      void e;
    }
    if (!enabledFn()) return legacyValue;
    metrics.recordRequest();
    const t0 = Date.now();
    let kernelValue;
    try {
      kernelValue = await kernelThunk();
    } catch (e) {
      evaluateFailure(operation, category, legacyValue, e, ctx);
      return legacyValue;
    }
    evaluate(operation, category, legacyValue, kernelValue, Date.now() - t0, ctx);
    return legacyValue;
  }

  // ── shadow* operations — each returns LEGACY only ────────────────────────────────────────────
  const api = {
    // pure / sync
    shadowVerify: (token, ctx) =>
      record('verify', 'jwt', legacy.verify(token), () => kernel.verify(token), ctx),
    shadowIssueClaims: (p, ctx) =>
      record('issueClaims', 'jwt', legacy.issueClaims(p), () => kernel.issueClaims(p), ctx),
    shadowIssueHeader: (p, ctx) =>
      record('issueHeader', 'jwt', legacy.issueHeader(p), () => kernel.issueHeader(p), ctx),
    shadowIsAdmin: (p, ctx) =>
      record('isAdmin', 'authz', legacy.isAdmin(p), () => kernel.isAdmin(p), ctx),
    shadowOtpRequired: (ctx) =>
      record('otpRequired', 'otp', legacy.otpRequired(), () => kernel.otpRequired(), ctx),
    shadowResolvePrincipal: (p, ctx) =>
      record(
        'resolvePrincipal',
        'principal',
        legacy.resolvePrincipal(p),
        () => kernel.resolvePrincipal(p),
        ctx
      ),
    // DB-bound / async (refresh + repository)
    shadowVerifyRefresh: (token, ctx) =>
      recordAsync(
        'verifyRefresh',
        'refresh',
        Promise.resolve(legacy.verifyRefresh(token)),
        () => kernel.verifyRefresh(token),
        ctx
      ),
    shadowFindUser: (phone, ctx) =>
      recordAsync(
        'findUserByPhone',
        'repository',
        Promise.resolve(legacy.findUserByPhone(phone)),
        () => kernel.findUserByPhone(phone),
        ctx
      ),
    shadowFindDriver: (phone, ctx) =>
      recordAsync(
        'findDriverByPhone',
        'repository',
        Promise.resolve(legacy.findDriverByPhone(phone)),
        () => kernel.findDriverByPhone(phone),
        ctx
      ),
  };

  function report() {
    const snap = metrics.snapshot();
    const categories = {};
    for (const [c, s] of Object.entries(perCategory)) {
      categories[c] = {
        ...s,
        // Honest: null (not 100) when a category was never exercised.
        parityPct:
          s.comparisons > 0 ? Math.round((s.matches / s.comparisons) * 100 * 1000) / 1000 : null,
      };
    }
    return {
      overallParityPct: snap.parityPct,
      comparisons: snap.comparisons,
      matches: snap.matches,
      mismatches: snap.mismatches,
      verificationFailures: snap.verificationFailures,
      confidenceLevel: snap.confidenceLevel,
      coveragePct: snap.coveragePct,
      latency: snap.latency,
      categories,
      jwtParityPct: categories.jwt.parityPct,
      authorizationParityPct: categories.authz.parityPct,
      otpParityPct: categories.otp.parityPct,
      refreshParityPct: categories.refresh.parityPct,
      repositoryParityPct: categories.repository.parityPct,
      socketParityPct: categories.socket.parityPct,
      mismatches_log: snap.mismatches_log,
    };
  }

  /** Pure batch pass (sync surface). */
  function verifyAll(data = {}) {
    const tokens = data.tokens || [];
    const payloads = data.payloads || [];
    let i = 0;
    for (const token of tokens) api.shadowVerify(token, { requestId: `verify-${i++}` });
    for (const payload of payloads) {
      const rid = `p-${i++}`;
      api.shadowIssueClaims(payload, { requestId: rid });
      api.shadowIssueHeader(payload, { requestId: rid });
      api.shadowIsAdmin(payload, { requestId: rid });
      api.shadowResolvePrincipal(payload, { requestId: rid });
    }
    api.shadowOtpRequired({ requestId: `otp-${i++}` });
    return report();
  }

  /** DB batch pass (async surface) — refresh + repository comparisons. */
  async function verifyDbSurface(data = {}) {
    const refreshTokens = data.refreshTokens || [];
    const userPhones = data.userPhones || [];
    const driverPhones = data.driverPhones || [];
    let i = 0;
    for (const t of refreshTokens) await api.shadowVerifyRefresh(t, { requestId: `rt-${i++}` });
    for (const p of userPhones) await api.shadowFindUser(p, { requestId: `u-${i++}` });
    for (const p of driverPhones) await api.shadowFindDriver(p, { requestId: `d-${i++}` });
    return report();
  }

  return Object.freeze({
    name: 'identity-shadow',
    enabled: () => enabledFn(),
    ...api,
    report,
    verifyAll,
    verifyDbSurface,
    metrics: () => metrics.snapshot(),
    CATEGORIES,
  });
}

module.exports = { createIdentityShadow, CATEGORIES };
