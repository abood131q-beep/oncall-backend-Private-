'use strict';

/**
 * Identity Service (Phase 14.8 / ADR-027) — the Identity Kernel. A unified
 * abstraction for identities, authentication, sessions, credentials, principals,
 * and authorization context. NOT an authentication framework, NOT OAuth/OIDC/
 * Keycloak/Firebase/Cognito/Auth0.
 *
 * The provider handles persistence/protocol; identity behavior (lifecycle,
 * authentication, session management, claims + deterministic principal
 * resolution) lives here. Credentials are stored only as salted hashes and never
 * appear in events, the SDK, or API responses. Lifecycle events flow ONLY
 * through the EventPublisher port. Fully dependency-injected and deterministic.
 */

const {
  createIdentity,
  fromModel: identityFromModel,
} = require('../../domain/identity-kernel/identity');
const {
  createSession,
  fromModel: sessionFromModel,
} = require('../../domain/identity-kernel/session');
const { buildContext } = require('../../domain/identity-kernel/principal');
const { IDENTITY_EVENTS, createIdentityEvent } = require('../../domain/identity-kernel/events');
const {
  IdentityValidationError,
  AuthenticationError,
  SessionError,
} = require('../../domain/identity-kernel/errors');
const { assertProvider } = require('./providerPort');
const { createNullPublisher } = require('../shared/eventPublisher');

function createIdentityService(deps = {}) {
  const provider = assertProvider(deps.provider);
  const publisher = deps.publisher || createNullPublisher();
  const metrics = deps.metrics || null;
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { warn() {}, error() {}, info() {} };
  const defaultTtlMs = deps.sessionTtlMs || 3600000;
  const idOpts = { idFactory: deps.idFactory, tokenFactory: deps.tokenFactory };

  const _active = new Set(); // sessionIds believed active (gauge source)
  if (metrics && metrics.bindGauges) metrics.bindGauges({ activeSessions: () => _active.size });

  // Production hardening (A-001) — all additive.
  const historyLimit = deps.historyLimit || 500;
  const _lifecycle = []; // ring: { type, namespace, at }
  const _idIndex = new Map(); // namespace -> Set(identityId) — enables verification scans
  const _CREDENTIAL_HASH_RE = /^[a-f0-9]{64}$/;
  function _recordLifecycle(type, namespace) {
    _lifecycle.push({ type, namespace, at: clock() });
    if (_lifecycle.length > historyLimit) _lifecycle.shift();
  }
  function _indexIdentity(namespace, identityId) {
    if (!_idIndex.has(namespace)) _idIndex.set(namespace, new Set());
    _idIndex.get(namespace).add(identityId);
  }
  function _deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      for (const k of Object.keys(o)) _deepFreeze(o[k]);
      Object.freeze(o);
    }
    return o;
  }

  function _emit(type, payload) {
    try {
      const event = createIdentityEvent(type, payload, { clock: () => new Date(clock()) });
      Promise.resolve(publisher.publish(event)).catch((e) => {
        if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
        log.error('identity: event publish failed', e.message);
      });
    } catch (e) {
      if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
      log.error('identity: could not build event', e.message);
    }
  }

  async function _safe(fn) {
    try {
      return await fn();
    } catch (e) {
      if (metrics && metrics.recordProviderFailure) metrics.recordProviderFailure();
      throw e;
    }
  }
  async function _timed(fn) {
    const start = clock();
    try {
      return await fn();
    } finally {
      if (metrics) metrics.recordLatency(clock() - start);
    }
  }

  // ── §1 register ──────────────────────────────────────────────────────────
  function register(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return _timed(async () => {
      const existing = await _safe(() =>
        provider.getIdentityByPrincipal(namespace, spec.principal)
      );
      if (existing) {
        throw new IdentityValidationError(
          `identity: principal "${spec.principal}" already registered`
        );
      }
      const identity = createIdentity(spec, { idFactory: idOpts.idFactory });
      await _safe(() => provider.putIdentity(namespace, identity.toModel()));
      _indexIdentity(namespace, identity.identityId);
      if (metrics) metrics.recordIdentity();
      _recordLifecycle('registered', namespace);
      _emit(IDENTITY_EVENTS.REGISTERED, {
        identityId: identity.identityId,
        namespace,
        principal: identity.principal,
        tenant: identity.tenant,
      });
      return identity.toPublic();
    });
  }

  // ── §1 authenticate ─────────────────────────────────────────────────────────
  function authenticate(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const { principal, credentials } = spec;
    return _timed(async () => {
      if (metrics) metrics.recordAuthAttempt();
      const model = await _safe(() => provider.getIdentityByPrincipal(namespace, principal));
      const identity = model ? identityFromModel(model) : null;
      const ok =
        identity && identity.isActive() && identity.verifySecret(credentials && credentials.secret);
      if (!ok) {
        if (metrics) metrics.recordAuthFailure();
        _emit(IDENTITY_EVENTS.AUTH_FAILED, { namespace, principal });
        throw new AuthenticationError('identity: authentication failed');
      }
      const session = createSession(
        {
          identityId: identity.identityId,
          principal: identity.principal,
          tenant: identity.tenant,
          ttlMs: spec.ttlMs || defaultTtlMs,
        },
        { clock, idFactory: idOpts.idFactory, tokenFactory: idOpts.tokenFactory }
      );
      await _safe(() => provider.putSession(namespace, session.toModel()));
      _active.add(session.sessionId);
      _recordLifecycle('authenticated', namespace);
      _emit(IDENTITY_EVENTS.AUTHENTICATED, {
        namespace,
        identityId: identity.identityId,
        principal,
      });
      _emit(IDENTITY_EVENTS.SESSION_CREATED, {
        namespace,
        sessionId: session.sessionId,
        identityId: identity.identityId,
      });
      return {
        session: session.toModel(),
        context: buildContext(identity, session, { now: clock() }),
      };
    });
  }

  // ── §1 refresh ────────────────────────────────────────────────────────────
  function refresh(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const { sessionId, token } = spec;
    return _timed(async () => {
      const model = await _safe(() => provider.getSession(namespace, sessionId));
      if (!model) throw new SessionError(`identity: session "${sessionId}" not found`);
      const session = sessionFromModel(model);
      if (session.settleExpiry(clock())) {
        if (metrics && metrics.recordExpired) metrics.recordExpired();
        await _safe(() => provider.putSession(namespace, session.toModel()));
      }
      if (!session.isLive(clock())) {
        _active.delete(sessionId);
        throw new SessionError(`identity: session "${sessionId}" is ${session.state}`);
      }
      if (token != null && session.token !== token) {
        throw new SessionError('identity: session token mismatch');
      }
      session.refresh(clock(), spec.ttlMs || defaultTtlMs);
      await _safe(() => provider.putSession(namespace, session.toModel()));
      _active.add(session.sessionId);
      if (metrics) metrics.recordRefresh();
      _emit(IDENTITY_EVENTS.SESSION_REFRESHED, {
        namespace,
        sessionId,
        expiresAt: session.expiresAt,
      });
      return session.toModel();
    });
  }

  // ── §1 revoke ──────────────────────────────────────────────────────────────
  function revoke(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const sessionId = typeof spec === 'string' ? spec : spec.sessionId;
    return _timed(async () => {
      const model = await _safe(() => provider.getSession(namespace, sessionId));
      if (!model) return false;
      const session = sessionFromModel(model);
      session.revoke();
      await _safe(() => provider.putSession(namespace, session.toModel()));
      _active.delete(sessionId);
      if (metrics) metrics.recordRevocation();
      _recordLifecycle('revoked', namespace);
      _emit(IDENTITY_EVENTS.SESSION_REVOKED, { namespace, sessionId });
      return true;
    });
  }

  // ── §1 resolve (deterministic principal / authorization context) ────────────
  function resolve(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return _timed(async () => {
      if (spec.sessionId) {
        const sm = await _safe(() => provider.getSession(namespace, spec.sessionId));
        if (!sm) return { ok: false, context: null };
        const session = sessionFromModel(sm);
        const live = session.isLive(clock());
        if (!live) _active.delete(spec.sessionId);
        const im = await _safe(() => provider.getIdentity(namespace, session.identityId));
        if (!im) return { ok: false, context: null };
        return {
          ok: live,
          context: buildContext(identityFromModel(im), session, { now: clock() }),
        };
      }
      if (spec.principal) {
        const im = await _safe(() => provider.getIdentityByPrincipal(namespace, spec.principal));
        if (!im) return { ok: false, context: null };
        return { ok: true, context: buildContext(identityFromModel(im), null, { now: clock() }) };
      }
      throw new IdentityValidationError('identity: resolve requires sessionId or principal');
    });
  }

  async function health() {
    const providerHealth = await provider.health();
    return {
      ok: Boolean(providerHealth && providerHealth.ok),
      provider: providerHealth,
      activeSessions: _active.size,
      metrics: metrics ? metrics.snapshot() : null,
    };
  }

  // ── production hardening: snapshots, verification, reconciliation, diag ──────

  /** Immutable, deep-frozen public snapshot of an identity (no credential hash). */
  async function snapshotIdentity(namespace, identityId) {
    const m = await _safe(() => provider.getIdentity(namespace, identityId));
    if (!m) return null;
    const pub = m;
    delete pub.credentialHash; // never expose the hash in a snapshot
    return _deepFreeze(pub);
  }

  /** Immutable, deep-frozen snapshot of a session. */
  async function snapshotSession(namespace, sessionId) {
    const m = await _safe(() => provider.getSession(namespace, sessionId));
    return m ? _deepFreeze(m) : null;
  }

  /** Startup verification: sane wiring before the engine is trusted. */
  function verifyStartup() {
    const problems = [];
    if (!provider) problems.push('identity provider is required');
    if (typeof clock !== 'function' || typeof clock() !== 'number') {
      problems.push('clock must return a numeric ms epoch');
    }
    return { ok: problems.length === 0, problems };
  }

  /**
   * Provider / namespace-consistency verification: every indexed identity must be
   * resolvable by id AND by principal (matching id), and every session must
   * reference an existing identity in the namespace.
   */
  async function verifyProvider(namespace = 'default') {
    const issues = [];
    const ids = _idIndex.get(namespace) || new Set();
    for (const identityId of ids) {
      const byId = await _safe(() => provider.getIdentity(namespace, identityId));
      if (!byId) {
        issues.push({ identityId, reason: 'missing in provider' });
        continue;
      }
      const byPrincipal = await _safe(() =>
        provider.getIdentityByPrincipal(namespace, byId.principal)
      );
      if (!byPrincipal || byPrincipal.identityId !== identityId) {
        issues.push({ identityId, reason: 'principal index inconsistent' });
      }
    }
    const sessions = await _safe(() => provider.listSessions(namespace));
    for (const s of sessions) {
      const owner = await _safe(() => provider.getIdentity(namespace, s.identityId));
      if (!owner)
        issues.push({ sessionId: s.sessionId, reason: 'session references unknown identity' });
    }
    return { ok: issues.length === 0, issues };
  }

  /** Credential-integrity verification: every stored credentialHash is well-formed. */
  async function verifyCredentialIntegrity(namespace = 'default') {
    const issues = [];
    const ids = _idIndex.get(namespace) || new Set();
    for (const identityId of ids) {
      const m = await _safe(() => provider.getIdentity(namespace, identityId));
      if (m && m.credentialHash != null && !_CREDENTIAL_HASH_RE.test(m.credentialHash)) {
        issues.push({ identityId, reason: 'malformed credential hash' });
      }
    }
    return { ok: issues.length === 0, issues };
  }

  /**
   * Session reconciliation / stale cleanup: settle every expired-but-active
   * session (persist the expired state, drop from the active set). Deterministic.
   */
  async function reconcileSessions(opts2 = {}) {
    const namespace = opts2.namespace || 'default';
    const now = typeof opts2.now === 'number' ? opts2.now : clock();
    const sessions = await _safe(() => provider.listSessions(namespace));
    let expired = 0;
    let active = 0;
    for (const model of sessions) {
      const session = sessionFromModel(model);
      if (session.settleExpiry(now)) {
        expired += 1;
        _active.delete(session.sessionId);
        if (metrics && metrics.recordExpired) metrics.recordExpired();
        await _safe(() => provider.putSession(namespace, session.toModel()));
      } else if (session.isLive(now)) {
        active += 1;
      }
    }
    return { expired, active };
  }

  /**
   * Recovery after a provider failure/restart: rebuild the in-memory active-session
   * set from the provider (source of truth), so the gauge and cleanup stay correct.
   */
  async function recover(opts2 = {}) {
    const namespace = opts2.namespace || 'default';
    const now = typeof opts2.now === 'number' ? opts2.now : clock();
    const sessions = await _safe(() => provider.listSessions(namespace));
    let recovered = 0;
    for (const model of sessions) {
      const session = sessionFromModel(model);
      if (session.isLive(now)) {
        _active.add(session.sessionId);
        recovered += 1;
      } else {
        _active.delete(session.sessionId);
      }
    }
    _recordLifecycle('recovered', namespace);
    return { ok: true, recovered, active: _active.size };
  }

  /** Structured diagnostics for dashboards / health checks. */
  function diagnostics(namespace = 'default') {
    return {
      identities: (_idIndex.get(namespace) || new Set()).size,
      activeSessions: _active.size,
      namespaces: _idIndex.size,
      lifecycleDepth: _lifecycle.length,
      startup: verifyStartup(),
      metrics: metrics ? metrics.snapshot() : null,
    };
  }

  const history = () => _lifecycle.map((h) => ({ ...h }));

  return {
    register,
    authenticate,
    refresh,
    revoke,
    resolve,
    health,
    // production hardening (additive)
    snapshotIdentity,
    snapshotSession,
    verifyStartup,
    verifyProvider,
    verifyCredentialIntegrity,
    reconcileSessions,
    recover,
    diagnostics,
    history,
    metrics: () => (metrics ? metrics.snapshot() : null),
  };
}

module.exports = { createIdentityService };
