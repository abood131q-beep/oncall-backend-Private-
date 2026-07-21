'use strict';

/**
 * Compatibility Kernel Service (Phase 15.12 / ADR-041) — the platform-wide Compatibility
 * Kernel. Deterministic contract compatibility, capability negotiation, version
 * evolution, deprecation governance, and backward/forward compatibility across all
 * Kernel Services. This is NOT semantic versioning, NOT npm package management, NOT API
 * versioning middleware, NOT a migration framework.
 *
 * Providers persist contract METADATA only; ALL compatibility behavior lives here + in
 * the pure domain: deterministic evaluation against a compatibility level, capability
 * negotiation (intersection), version resolution, deprecation governance, checksum
 * integrity verification, and violation detection. Events flow ONLY through the
 * EventPublisher port. Deterministic: injected clock. Writes are atomic per namespace
 * via a serialization mutex.
 */

const { createContract, fromModel, DEPRECATION } = require('../../domain/compatibility/contract');
const compat = require('../../domain/compatibility/compatibility');
const {
  COMPATIBILITY_EVENTS,
  createCompatibilityEvent,
} = require('../../domain/compatibility/events');
const {
  CompatibilityValidationError,
  ContractNotFoundError,
  NegotiationError,
  IntegrityError,
} = require('../../domain/compatibility/errors');
const { assertProvider } = require('./providerPort');
const { createNullPublisher } = require('../shared/eventPublisher');

function createCompatibilityService(deps = {}) {
  const provider = assertProvider(deps.provider);
  const publisher = deps.publisher || createNullPublisher();
  const metrics = deps.metrics || null;
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { warn() {}, error() {}, info() {} };
  const idOpts = { idFactory: deps.idFactory };

  const _index = new Map(); // namespace -> Set(contractId)
  function _indexAdd(ns, id) {
    if (!_index.has(ns)) _index.set(ns, new Set());
    _index.get(ns).add(id);
  }
  function _countAll() {
    let n = 0;
    for (const s of _index.values()) n += s.size;
    return n;
  }
  if (metrics && metrics.bindGauges) {
    metrics.bindGauges({ contracts: () => _countAll() });
  }

  const historyLimit = deps.historyLimit || 500;
  const _history = [];
  function _record(type, ns, id) {
    _history.push({ type, namespace: ns, id, at: clock() });
    if (_history.length > historyLimit) _history.shift();
  }

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
      const event = createCompatibilityEvent(type, payload, { clock: () => new Date(clock()) });
      Promise.resolve(publisher.publish(event)).catch((e) => {
        if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
        log.error('compatibility: event publish failed', e.message);
      });
    } catch (e) {
      if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
      log.error('compatibility: could not build event', e.message);
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

  async function _load(namespace, contractId) {
    const model = await _safe(() => provider.getContract(namespace, contractId));
    if (!model) {
      throw new ContractNotFoundError(
        `compatibility: contract "${contractId}" not found in "${namespace}"`
      );
    }
    const contract = fromModel(model, { clock });
    if (!contract.verifyChecksum()) {
      if (metrics && metrics.recordIntegrityFailure) metrics.recordIntegrityFailure();
      throw new IntegrityError(
        `compatibility: integrity check failed for contract "${contractId}"`
      );
    }
    return contract;
  }

  // ── §1 registerContract ──────────────────────────────────────────────────────────
  function registerContract(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return (async () => {
      const contract = createContract(
        { ...spec, namespace },
        { clock, idFactory: idOpts.idFactory }
      );
      return _withLock(namespace, async () => {
        const existing = await _safe(() => provider.getContract(namespace, contract.contractId));
        if (existing) {
          throw new CompatibilityValidationError(
            `compatibility: contract "${contract.contractId}" already exists in "${namespace}"`
          );
        }
        await _safe(() => provider.putContract(namespace, contract.toModel()));
        _indexAdd(namespace, contract.contractId);
        _record('registered', namespace, contract.contractId);
        _emit(COMPATIBILITY_EVENTS.CONTRACT_REGISTERED, {
          contractId: contract.contractId,
          namespace,
          component: contract.component,
          version: contract.version,
          compatibilityLevel: contract.compatibilityLevel,
        });
        return contract.toPublic();
      });
    })();
  }

  // ── §3 evaluate (deterministic compatibility decision) ─────────────────────────────
  function evaluate(request = {}, opts = {}) {
    const namespace = opts.namespace || request.namespace || 'default';
    const contractId = request.contractId;
    if (!contractId) {
      return Promise.reject(new CompatibilityValidationError('evaluate: "contractId" is required'));
    }
    return (async () => {
      const start = clock();
      const contract = await _load(namespace, contractId);
      const result = compat.evaluate(contract, {
        version: request.version,
        capabilities: request.capabilities || [],
      });
      if (metrics) {
        metrics.recordEvaluation();
        metrics.recordEvaluationLatency(clock() - start);
        if (!result.compatible) metrics.recordIncompatible();
      }
      const decision = {
        contractId,
        namespace,
        component: contract.component,
        contractVersion: contract.version,
        requestedVersion: request.version != null ? request.version : null,
        ...result,
      };
      if (!result.compatible) {
        if (metrics) metrics.recordViolation();
        _record('violation', namespace, contractId);
        _emit(COMPATIBILITY_EVENTS.VIOLATION_DETECTED, {
          contractId,
          namespace,
          requestedVersion: decision.requestedVersion,
          missingCapabilities: result.missingCapabilities,
          versionOk: result.versionOk,
        });
      }
      return decision;
    })();
  }

  // ── §3/§9 verify (integrity + compatibility contract validity) ─────────────────────
  function verify(request = {}, opts = {}) {
    const namespace = opts.namespace || request.namespace || 'default';
    const contractId = request.contractId || (typeof request === 'string' ? request : null);
    return (async () => {
      // Single-contract verification (integrity + optional compatibility assertion).
      if (contractId) {
        const contract = await _load(namespace, contractId);
        const result =
          request.version != null || (request.capabilities && request.capabilities.length)
            ? compat.evaluate(contract, {
                version: request.version,
                capabilities: request.capabilities || [],
              })
            : { compatible: true, versionOk: true, missingCapabilities: [] };
        if (metrics) metrics.recordVerification();
        _emit(COMPATIBILITY_EVENTS.COMPATIBILITY_VERIFIED, {
          contractId,
          namespace,
          ok: result.compatible,
        });
        return { ok: result.compatible, contractId, namespace, integrity: true, ...result };
      }
      // Namespace-wide verification (checksum integrity of every stored contract).
      const models = await _safe(() => provider.listContracts(namespace));
      const issues = [];
      for (const model of models) {
        if (!fromModel(model, { clock }).verifyChecksum()) {
          if (metrics && metrics.recordIntegrityFailure) metrics.recordIntegrityFailure();
          issues.push({ contractId: model.contractId, reason: 'checksum mismatch' });
        }
      }
      if (metrics) metrics.recordVerification();
      const ok = issues.length === 0;
      _emit(COMPATIBILITY_EVENTS.COMPATIBILITY_VERIFIED, {
        namespace,
        ok,
        issueCount: issues.length,
      });
      return { ok, namespace, contracts: models.length, issues };
    })();
  }

  // ── §3 negotiate (capability negotiation + version resolution) ─────────────────────
  function negotiate(request = {}, opts = {}) {
    const namespace = opts.namespace || request.namespace || 'default';
    const contractId = request.contractId;
    if (!contractId) {
      return Promise.reject(
        new CompatibilityValidationError('negotiate: "contractId" is required')
      );
    }
    return (async () => {
      const contract = await _load(namespace, contractId);
      const requested = request.capabilities || [];
      const agreed = compat.negotiateCapabilities(contract, requested);
      const resolvedVersion = compat.resolveVersion(contract, request.version);
      const missing = requested.filter((c) => !agreed.includes(c));
      const strict = request.strict === true;
      if (strict && (missing.length > 0 || resolvedVersion === null)) {
        if (metrics) metrics.recordViolation();
        throw new NegotiationError(
          `compatibility: negotiation failed for contract "${contractId}"`,
          { missing, resolvedVersion }
        );
      }
      if (metrics) metrics.recordNegotiation();
      _record('negotiated', namespace, contractId);
      const result = {
        contractId,
        namespace,
        component: contract.component,
        requestedVersion: request.version != null ? request.version : null,
        resolvedVersion,
        requestedCapabilities: [...requested],
        agreedCapabilities: agreed,
        missingCapabilities: missing,
        ok: missing.length === 0 && resolvedVersion !== null,
      };
      _emit(COMPATIBILITY_EVENTS.CAPABILITY_NEGOTIATED, {
        contractId,
        namespace,
        resolvedVersion,
        agreedCapabilities: agreed,
        ok: result.ok,
      });
      return result;
    })();
  }

  // ── §1 deprecate (deprecation governance) ──────────────────────────────────────────
  function deprecate(request = {}, opts = {}) {
    const namespace = opts.namespace || request.namespace || 'default';
    const contractId = request.contractId || (typeof request === 'string' ? request : null);
    if (!contractId) {
      return Promise.reject(
        new CompatibilityValidationError('deprecate: "contractId" is required')
      );
    }
    return _withLock(namespace, async () => {
      const contract = await _load(namespace, contractId);
      const retired = request.retire === true || request.status === DEPRECATION.RETIRED;
      contract.deprecate(request.replacementContract, clock(), retired);
      await _safe(() => provider.putContract(namespace, contract.toModel()));
      if (metrics) metrics.recordDeprecation();
      _record(retired ? 'retired' : 'deprecated', namespace, contractId);
      _emit(COMPATIBILITY_EVENTS.VERSION_DEPRECATED, {
        contractId,
        namespace,
        component: contract.component,
        version: contract.version,
        deprecationStatus: contract.deprecationStatus,
        replacementContract: contract.replacementContract,
      });
      return contract.toPublic();
    });
  }

  async function health() {
    const providerHealth = await provider.health();
    return {
      ok: Boolean(providerHealth && providerHealth.ok),
      provider: providerHealth,
      contracts: _countAll(),
      metrics: metrics ? metrics.snapshot() : null,
    };
  }

  // ── additive helpers: get / list / resolve / diagnostics / history ──────────────────
  function get(request = {}, opts = {}) {
    const namespace = opts.namespace || request.namespace || 'default';
    const contractId = typeof request === 'string' ? request : request.contractId;
    return (async () => {
      const model = await _safe(() => provider.getContract(namespace, contractId));
      return model || null;
    })();
  }
  function list(opts = {}) {
    const namespace = opts.namespace || 'default';
    return (async () => {
      const models = await _safe(() => provider.listContracts(namespace));
      return models.map((m) => fromModel(m, { clock }).toPublic());
    })();
  }
  function resolve(request = {}, opts = {}) {
    const namespace = opts.namespace || request.namespace || 'default';
    const contractId = request.contractId;
    return (async () => {
      const contract = await _load(namespace, contractId);
      return {
        contractId,
        namespace,
        requestedVersion: request.version != null ? request.version : null,
        resolvedVersion: compat.resolveVersion(contract, request.version),
      };
    })();
  }
  function diagnostics(namespace = 'default') {
    return {
      contracts: (_index.get(namespace) || new Set()).size,
      totalContracts: _countAll(),
      namespaces: _index.size,
      metrics: metrics ? metrics.snapshot() : null,
    };
  }
  const history = () => _history.map((h) => ({ ...h }));

  return {
    // ── Compatibility Port (ADR-041 §1) ──
    registerContract,
    evaluate,
    negotiate,
    deprecate,
    verify,
    health,
    // ── additive helpers ──
    get,
    list,
    resolve,
    diagnostics,
    history,
    metrics: () => (metrics ? metrics.snapshot() : null),
  };
}

module.exports = { createCompatibilityService };
