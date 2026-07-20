'use strict';

/**
 * Secrets Service (Phase 14.9 / ADR-028) — the Secrets Kernel. Platform-wide,
 * provider-agnostic management of sensitive configuration and credentials. This
 * is NOT a password manager and NOT Vault/AWS Secrets Manager/Azure Key Vault/
 * GCP Secret Manager — those are provider extension points.
 *
 * The provider STORES secret + version models; all behavior lives here: versioned
 * secrets, deterministic resolution, rotation (with validation), integrity
 * verification, secure redaction, and lifecycle. Values NEVER appear in events,
 * the SDK, listings, or diagnostics — only an explicit `resolve()` reveals a
 * value. Lifecycle events flow ONLY through the EventPublisher port. Fully
 * dependency-injected and deterministic; atomic per-secret via a serialization
 * mutex so concurrent store/rotate/delete never interleave.
 */

const { createSecret, fromModel, valueChecksum } = require('../../domain/secrets/secret');
const { SECRET_EVENTS, createSecretEvent } = require('../../domain/secrets/events');
const {
  SecretValidationError,
  SecretNotFoundError,
  RotationError,
  IntegrityError,
} = require('../../domain/secrets/errors');
const { assertProvider } = require('./providerPort');
const { createNullPublisher } = require('../shared/eventPublisher');

function createSecretsService(deps = {}) {
  const provider = assertProvider(deps.provider);
  const publisher = deps.publisher || createNullPublisher();
  const metrics = deps.metrics || null;
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { warn() {}, error() {}, info() {} };
  const idOpts = { idFactory: deps.idFactory };
  const valueFactory = typeof deps.valueFactory === 'function' ? deps.valueFactory : null;

  // Per-secret index (namespace -> Set(name)) — powers the gauge + verification scans.
  const _index = new Map();
  const _countNames = () => {
    let n = 0;
    for (const set of _index.values()) n += set.size;
    return n;
  };
  if (metrics && metrics.bindGauges) metrics.bindGauges({ storedSecrets: () => _countNames() });

  function _indexAdd(namespace, name) {
    if (!_index.has(namespace)) _index.set(namespace, new Set());
    _index.get(namespace).add(name);
  }
  function _indexRemove(namespace, name) {
    const set = _index.get(namespace);
    if (set) set.delete(name);
  }

  // Lifecycle history (bounded ring) + structured diagnostics.
  const historyLimit = deps.historyLimit || 500;
  const _lifecycle = [];
  function _recordLifecycle(type, namespace, name) {
    _lifecycle.push({ type, namespace, name, at: clock() });
    if (_lifecycle.length > historyLimit) _lifecycle.shift();
  }

  function _deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      for (const k of Object.keys(o)) _deepFreeze(o[k]);
      Object.freeze(o);
    }
    return o;
  }

  // Per-key serialization mutex (promise chaining) — atomic read-modify-write.
  const _locks = new Map();
  function _withLock(key, fn) {
    const prev = _locks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    _locks.set(
      key,
      next.then(
        () => {},
        () => {}
      )
    );
    return next;
  }

  function _emit(type, payload) {
    try {
      const event = createSecretEvent(type, payload, { clock: () => new Date(clock()) });
      Promise.resolve(publisher.publish(event)).catch((e) => {
        if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
        log.error('secrets: event publish failed', e.message);
      });
    } catch (e) {
      if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
      log.error('secrets: could not build event', e.message);
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

  // ── §1 store ─────────────────────────────────────────────────────────────────
  function store(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const key = `${namespace}::${spec.name}`;
    return _withLock(key, async () => {
      if (!spec.name || typeof spec.name !== 'string') {
        throw new SecretValidationError('secrets: "name" is required');
      }
      const existing = await _safe(() => provider.getSecret(namespace, spec.name));
      if (existing) {
        throw new SecretValidationError(
          `secrets: "${spec.name}" already exists in "${namespace}" (use rotate)`
        );
      }
      const secret = createSecret(
        {
          name: spec.name,
          namespace,
          value: spec.value,
          metadata: spec.metadata,
          tags: spec.tags,
          rotationPolicy: spec.rotationPolicy,
        },
        { clock, idFactory: idOpts.idFactory }
      );
      await _safe(() => provider.putSecret(namespace, secret.toModel()));
      _indexAdd(namespace, secret.name);
      if (metrics) metrics.recordStored();
      _recordLifecycle('stored', namespace, secret.name);
      _emit(SECRET_EVENTS.STORED, {
        secretId: secret.secretId,
        namespace,
        name: secret.name,
        version: secret.version,
      });
      return secret.toPublic();
    });
  }

  // ── §1 resolve (deterministic; the ONLY value-revealing call) ──────────────────
  function resolve(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const name = spec.name;
    return (async () => {
      if (!name) throw new SecretValidationError('secrets: resolve requires a name');
      const model =
        spec.version != null
          ? await _safe(() => provider.getSecretVersion(namespace, name, spec.version))
          : await _safe(() => provider.getSecret(namespace, name));
      if (!model || model.state === 'deleted') {
        throw new SecretNotFoundError(
          `secrets: "${name}"${spec.version != null ? ` v${spec.version}` : ''} not found in "${namespace}"`
        );
      }
      const secret = fromModel(model, { clock });
      if (!secret.verifyIntegrity()) {
        if (metrics && metrics.recordIntegrityFailure) metrics.recordIntegrityFailure();
        throw new IntegrityError(`secrets: integrity check failed for "${name}"`);
      }
      if (metrics) metrics.recordResolution();
      _emit(SECRET_EVENTS.RESOLVED, {
        secretId: secret.secretId,
        namespace,
        name: secret.name,
        version: secret.version,
      });
      return {
        secretId: secret.secretId,
        name: secret.name,
        namespace,
        version: secret.version,
        value: secret.reveal(),
        metadata: { ...secret.metadata },
        tags: [...secret.tags],
        state: secret.state,
        createdAt: secret.createdAt,
        updatedAt: secret.updatedAt,
      };
    })();
  }

  // ── §1 rotate ──────────────────────────────────────────────────────────────────
  function rotate(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const name = spec.name;
    const key = `${namespace}::${name}`;
    return _withLock(key, async () => {
      if (!name) throw new RotationError('secrets: rotate requires a name');
      const model = await _safe(() => provider.getSecret(namespace, name));
      // Rotation validation: the secret must exist and not be deleted.
      if (!model || model.state === 'deleted') {
        throw new SecretNotFoundError(`secrets: "${name}" not found in "${namespace}"`);
      }
      const newValue = spec.value != null ? spec.value : valueFactory ? valueFactory(spec) : null;
      if (newValue == null) {
        throw new RotationError(
          'secrets: rotation requires a value (or a configured valueFactory)'
        );
      }
      if (typeof newValue !== 'string') {
        throw new RotationError('secrets: rotation value must be a string');
      }
      const secret = fromModel(model, { clock });
      // Rotation validation: reject a no-op rotation to the identical value.
      if (secret.valueChecksum === valueChecksum(newValue)) {
        throw new RotationError('secrets: rotation value must differ from the current value');
      }
      const start = clock();
      secret.rotate(newValue, clock());
      await _safe(() => provider.putSecret(namespace, secret.toModel()));
      if (metrics) {
        metrics.recordRotation();
        metrics.recordRotationLatency(clock() - start);
      }
      _recordLifecycle('rotated', namespace, name);
      _emit(SECRET_EVENTS.ROTATED, {
        secretId: secret.secretId,
        namespace,
        name: secret.name,
        version: secret.version,
      });
      return secret.toPublic();
    });
  }

  // ── §1 delete ──────────────────────────────────────────────────────────────────
  function del(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const name = typeof spec === 'string' ? spec : spec.name;
    const key = `${namespace}::${name}`;
    return _withLock(key, async () => {
      const model = await _safe(() => provider.getSecret(namespace, name));
      if (!model) return false;
      await _safe(() => provider.removeSecret(namespace, name));
      _indexRemove(namespace, name);
      if (metrics) metrics.recordDeletion();
      _recordLifecycle('deleted', namespace, name);
      _emit(SECRET_EVENTS.DELETED, {
        secretId: model.secretId,
        namespace,
        name,
        version: model.version,
      });
      return true;
    });
  }

  // ── §1 list (redacted) ──────────────────────────────────────────────────────────
  function list(opts = {}) {
    const namespace = opts.namespace || 'default';
    return (async () => {
      const models = await _safe(() => provider.listSecrets(namespace));
      return models
        .filter((m) => m.state !== 'deleted')
        .map((m) => fromModel(m, { clock }).toPublic());
    })();
  }

  async function health() {
    const providerHealth = await provider.health();
    return {
      ok: Boolean(providerHealth && providerHealth.ok),
      provider: providerHealth,
      storedSecrets: _countNames(),
      metrics: metrics ? metrics.snapshot() : null,
    };
  }

  // ── §3/§9 integrity, verification, diagnostics (all additive) ────────────────────

  /** Immutable, deep-frozen redacted snapshot of a secret (NO value). */
  async function snapshotSecret(namespace, name) {
    const m = await _safe(() => provider.getSecret(namespace, name));
    if (!m) return null;
    return _deepFreeze(fromModel(m, { clock }).toPublic());
  }

  /** Startup verification: sane wiring before the engine is trusted. */
  function verifyStartup() {
    const problems = [];
    if (!provider) problems.push('secrets provider is required');
    if (typeof clock !== 'function' || typeof clock() !== 'number') {
      problems.push('clock must return a numeric ms epoch');
    }
    return { ok: problems.length === 0, problems };
  }

  /** Provider / namespace-consistency: every indexed secret resolves to a model. */
  async function verifyProvider(namespace = 'default') {
    const issues = [];
    const names = _index.get(namespace) || new Set();
    for (const name of names) {
      const m = await _safe(() => provider.getSecret(namespace, name));
      if (!m) issues.push({ name, reason: 'missing in provider' });
      else if (m.name !== name) issues.push({ name, reason: 'name index inconsistent' });
    }
    return { ok: issues.length === 0, issues };
  }

  /** Integrity verification: every stored value matches its checksum. */
  async function verifyIntegrity(namespace = 'default') {
    const issues = [];
    const names = _index.get(namespace) || new Set();
    for (const name of names) {
      const m = await _safe(() => provider.getSecret(namespace, name));
      if (m && !fromModel(m, { clock }).verifyIntegrity()) {
        if (metrics && metrics.recordIntegrityFailure) metrics.recordIntegrityFailure();
        issues.push({ name, reason: 'checksum mismatch' });
      }
    }
    return { ok: issues.length === 0, issues };
  }

  /** Structured diagnostics for dashboards / health checks. */
  function diagnostics(namespace = 'default') {
    return {
      secrets: (_index.get(namespace) || new Set()).size,
      totalSecrets: _countNames(),
      namespaces: _index.size,
      lifecycleDepth: _lifecycle.length,
      startup: verifyStartup(),
      metrics: metrics ? metrics.snapshot() : null,
    };
  }

  const history = () => _lifecycle.map((h) => ({ ...h }));

  return {
    store,
    resolve,
    rotate,
    delete: del,
    list,
    health,
    // integrity / verification / diagnostics (additive)
    snapshotSecret,
    verifyStartup,
    verifyProvider,
    verifyIntegrity,
    diagnostics,
    history,
    metrics: () => (metrics ? metrics.snapshot() : null),
  };
}

module.exports = { createSecretsService };
