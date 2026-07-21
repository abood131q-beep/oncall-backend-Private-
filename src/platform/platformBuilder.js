'use strict';

/**
 * Enterprise Platform Builder (Phase 16.1 / ADR-042 §1, §5, §6, §7) — the ONE layer
 * allowed to know every Kernel. It composes ADR-016 … ADR-041 into a single
 * production-ready runtime through dependency injection, in a deterministic dependency
 * order, WITHOUT modifying any kernel, touching any kernel public API, or bypassing any
 * kernel port. No kernel imports or instantiates another kernel: the builder injects a
 * dependency kernel's public service as another kernel's `ports`.
 *
 * Exposes ONLY `createPlatform(options)`. The returned platform exposes ONLY:
 *   start(), shutdown(), health(), verify(), getKernel(name), listKernels(), version().
 *
 * Startup and shutdown are DELEGATED to the Lifecycle Kernel (ADR-040) — the builder
 * never re-implements lifecycle logic; it registers each kernel as a lifecycle component
 * (dependencies = its composition edges) and calls the kernel's start()/stop().
 */

const { createPlatformContext } = require('./platformContext');
const { createKernelRegistry } = require('./kernelRegistry');
const { buildDependencyGraph, edgesOf } = require('./dependencyGraph');
const { aggregateHealth } = require('./platformHealth');
const { CompositionError, MissingDependencyError, DependencyCycleError } = require('./errors');

const { createEventBus } = require('../application/shared/eventBus');

// ── The kernel catalog — the single place that knows every Enterprise Kernel ──────────
// Each entry: name, adr, module require + factory name, serviceKey, dependsOn (ordering),
// ports (dependency services injected as `ports`), needs (context slices), optional
// start/stop hooks delegated to Lifecycle. This table is data, not behavior: the builder
// treats every kernel uniformly through its own create*Platform composition root.
const KERNELS = [
  {
    name: 'event-backbone',
    adr: 'ADR-016',
    serviceKey: 'backbone',
    dependsOn: [],
    needs: ['publisher'],
    factory: (deps) => ({ backbone: deps.publisher }),
  },
  {
    name: 'config',
    adr: 'ADR-019',
    mod: '../application/config',
    fn: 'createConfigurationPlatform',
    serviceKey: 'service',
    dependsOn: ['event-backbone'],
    start: (p) => p.init && p.init(),
  },
  {
    name: 'storage',
    adr: 'ADR-021',
    mod: '../application/storage',
    fn: 'createStoragePlatform',
    serviceKey: 'storage',
    dependsOn: ['config'],
  },
  {
    name: 'lock',
    adr: 'ADR-022',
    mod: '../application/lock',
    fn: 'createLockPlatform',
    serviceKey: 'lock',
    dependsOn: ['config'],
  },
  {
    name: 'identity',
    adr: 'ADR-027',
    mod: '../application/identity-kernel',
    fn: 'createIdentityPlatform',
    serviceKey: 'identity',
    dependsOn: ['config', 'storage'],
  },
  {
    name: 'policy',
    adr: 'ADR-025',
    mod: '../application/policy',
    fn: 'createPolicyPlatform',
    serviceKey: 'policy',
    dependsOn: ['config', 'identity'],
  },
  {
    name: 'features',
    adr: 'ADR-029',
    mod: '../application/features',
    fn: 'createFeaturePlatform',
    serviceKey: 'features',
    dependsOn: ['config', 'storage'],
  },
  {
    name: 'messaging',
    adr: 'ADR-024',
    mod: '../application/messaging',
    fn: 'createMessagingPlatform',
    serviceKey: 'messaging',
    dependsOn: ['config'],
  },
  {
    name: 'workflow',
    adr: 'ADR-023',
    mod: '../application/workflow',
    fn: 'createWorkflowPlatform',
    serviceKey: 'engine',
    dependsOn: ['config', 'messaging', 'lock', 'storage'],
    inject: { storage: 'storage', lock: 'lock' },
  },
  {
    name: 'audit',
    adr: 'ADR-026',
    mod: '../application/audit',
    fn: 'createAuditPlatform',
    serviceKey: 'audit',
    dependsOn: ['config', 'storage'],
  },
  {
    name: 'scheduler',
    adr: 'ADR-020',
    mod: '../application/scheduler',
    fn: 'createSchedulerPlatform',
    serviceKey: 'scheduler',
    dependsOn: ['config', 'lock'],
  },
  {
    name: 'secrets',
    adr: 'ADR-028',
    mod: '../application/secrets',
    fn: 'createSecretsPlatform',
    serviceKey: 'secrets',
    dependsOn: ['config', 'storage'],
  },
  {
    name: 'notifications',
    adr: 'ADR-030',
    mod: '../application/notifications-kernel',
    fn: 'createNotificationPlatform',
    serviceKey: 'notifications',
    dependsOn: ['config', 'messaging'],
  },
  {
    name: 'ratelimit',
    adr: 'ADR-031',
    mod: '../application/ratelimit',
    fn: 'createRateLimitPlatform',
    serviceKey: 'ratelimit',
    dependsOn: ['config'],
  },
  {
    name: 'jobs',
    adr: 'ADR-032',
    mod: '../application/jobs',
    fn: 'createJobsPlatform',
    serviceKey: 'jobs',
    dependsOn: ['config', 'scheduler'],
  },
  {
    name: 'observability',
    adr: 'ADR-033',
    mod: '../application/observability',
    fn: 'createObservabilityPlatform',
    serviceKey: 'observability',
    dependsOn: ['config'],
  },
  {
    name: 'discovery',
    adr: 'ADR-034',
    mod: '../application/discovery',
    fn: 'createDiscoveryPlatform',
    serviceKey: 'discovery',
    dependsOn: ['config'],
  },
  {
    name: 'gateway',
    adr: 'ADR-035',
    mod: '../application/gateway',
    fn: 'createGatewayPlatform',
    serviceKey: 'gateway',
    dependsOn: ['config'],
    ports: ['identity', 'policy', 'ratelimit', 'features', 'discovery'],
  },
  {
    name: 'resilience',
    adr: 'ADR-036',
    mod: '../application/resilience',
    fn: 'createResiliencePlatform',
    serviceKey: 'resilience',
    dependsOn: ['config'],
  },
  {
    name: 'mesh',
    adr: 'ADR-037',
    mod: '../application/mesh',
    fn: 'createMeshPlatform',
    serviceKey: 'mesh',
    dependsOn: ['config'],
    ports: ['identity', 'policy', 'resilience', 'ratelimit', 'discovery'],
  },
  {
    name: 'tenancy',
    adr: 'ADR-038',
    mod: '../application/tenancy',
    fn: 'createTenancyPlatform',
    serviceKey: 'tenancy',
    dependsOn: ['config', 'identity'],
  },
  {
    name: 'resources',
    adr: 'ADR-039',
    mod: '../application/resources',
    fn: 'createResourcePlatform',
    serviceKey: 'resources',
    dependsOn: ['config'],
  },
  {
    name: 'lifecycle',
    adr: 'ADR-040',
    mod: '../application/lifecycle',
    fn: 'createLifecyclePlatform',
    serviceKey: 'lifecycle',
    dependsOn: ['config'],
  },
  {
    name: 'compatibility',
    adr: 'ADR-041',
    mod: '../application/compatibility',
    fn: 'createCompatibilityPlatform',
    serviceKey: 'compatibility',
    dependsOn: ['config'],
  },
  {
    name: 'extensions',
    adr: 'ADR-017',
    mod: '../application/extensions',
    fn: 'createExtensionPlatform',
    serviceKey: 'registry',
    dependsOn: ['config', 'policy'],
  },
];

const DEFAULT_NEEDS = ['publisher', 'clock', 'logger'];

/** Resolve a descriptor's factory: either an inline factory or module.fn. */
function resolveFactory(entry) {
  if (typeof entry.factory === 'function') return entry.factory;
  // eslint-disable-next-line global-require
  const mod = require(entry.mod);
  const fn = mod[entry.fn];
  if (typeof fn !== 'function') {
    throw new CompositionError(`platform: factory "${entry.fn}" not found in "${entry.mod}"`);
  }
  return fn;
}

/**
 * Compose the Enterprise Platform.
 * @param {object} [options]
 * @param {Function} [options.clock]
 * @param {object}   [options.logger]
 * @param {object}   [options.publisher] EventPublisher (Event Backbone); default in-process bus
 * @param {object}   [options.config] raw configuration values for the context
 * @param {string}   [options.version]
 * @param {string}   [options.environment]
 * @param {object}   [options.kernelOptions] per-kernel extra deps: { <name>: { ... } }
 * @param {string[]} [options.only] compose only these kernels (+ their transitive deps)
 */
function createPlatform(options = {}) {
  const publisher =
    options.publisher || createEventBus({ logger: options.logger, clock: options.clock });
  const context = createPlatformContext({ ...options, publisher });
  const kernelOptions = options.kernelOptions || {};

  // ── §3 Registry (deterministic; no globals/singletons) ──────────────────────────
  const registry = createKernelRegistry();
  const selected = selectKernels(KERNELS, options.only);
  for (const entry of selected) {
    registry.register({
      name: entry.name,
      adr: entry.adr,
      dependsOn: entry.dependsOn,
      ports: entry.ports,
      needs: entry.needs || DEFAULT_NEEDS,
      serviceKey: entry.serviceKey,
      factory: resolveFactory(entry),
      start: entry.start,
      stop: entry.stop,
      metadata: { inject: entry.inject || null },
    });
  }

  const regCheck = registry.verify();
  if (!regCheck.ok) {
    throw new MissingDependencyError('platform: registry verification failed', regCheck.issues);
  }

  // ── §4 Dependency graph (missing/duplicate/circular → deterministic ordering) ─────
  const descriptors = registry.list();
  const graph = buildDependencyGraph(descriptors);
  if (!graph.ok) {
    const cyc = graph.issues.find((i) => i.reason === 'circular dependency');
    if (cyc) throw new DependencyCycleError('platform: circular dependency detected', cyc);
    throw new MissingDependencyError('platform: dependency graph invalid', graph.issues);
  }

  // ── §5 Compose in dependency order via DI ─────────────────────────────────────────
  const composed = new Map(); // name -> { descriptor, platform, service }
  for (const name of graph.order) {
    const descriptor = registry.resolve(name);
    const deps = { ...context.scopeFor(descriptor.needs), ...(kernelOptions[name] || {}) };
    if (descriptor.ports.length) {
      const ports = {};
      for (const p of descriptor.ports) {
        const dep = composed.get(p);
        if (!dep)
          throw new CompositionError(`platform: port "${p}" for "${name}" not composed yet`);
        ports[p] = dep.service;
      }
      deps.ports = ports;
    }
    // Named cross-kernel injection (e.g. workflow ← storage/lock), by public service.
    const inject = descriptor.metadata && descriptor.metadata.inject;
    if (inject) {
      for (const [depKey, kernelName] of Object.entries(inject)) {
        const dep = composed.get(kernelName);
        if (!dep) {
          throw new CompositionError(
            `platform: inject "${kernelName}" for "${name}" not composed yet`
          );
        }
        deps[depKey] = dep.service;
      }
    }
    let platform;
    try {
      platform = descriptor.factory(deps);
    } catch (e) {
      throw new CompositionError(`platform: kernel "${name}" failed to compose: ${e.message}`);
    }
    const service = descriptor.serviceKey ? platform[descriptor.serviceKey] : platform;
    if (!service) {
      throw new CompositionError(
        `platform: kernel "${name}" exposed no service at "${descriptor.serviceKey}"`
      );
    }
    composed.set(name, { descriptor, platform, service });
  }

  const kernelList = graph.order.map((n) => ({ name: n, service: composed.get(n).service }));
  const lifecycle = composed.has('lifecycle') ? composed.get('lifecycle').service : null;

  // ── §7 Lifecycle integration: register each kernel as a lifecycle component ───────
  let lifecycleRegistered = false;
  async function ensureLifecycleComponents() {
    if (lifecycleRegistered || !lifecycle) return;
    for (const name of graph.order) {
      const { descriptor, platform } = composed.get(name);
      const dependencies = edgesOf(descriptor).filter((d) => composed.has(d));
      const hooks = {};
      if (descriptor.start) hooks.start = () => descriptor.start(platform, context);
      if (descriptor.stop) hooks.stop = () => descriptor.stop(platform, context);
      await lifecycle.register({
        componentId: name,
        componentType: 'kernel',
        dependencies,
        hooks,
        metadata: { adr: descriptor.adr },
      });
    }
    lifecycleRegistered = true;
  }

  let started = false;

  // ── §6 Platform API (exactly seven methods) ───────────────────────────────────────
  async function start() {
    await ensureLifecycleComponents();
    if (lifecycle) await lifecycle.start(); // deterministic dependency-ordered startup
    started = true;
    return health();
  }

  async function shutdown() {
    if (lifecycle && lifecycleRegistered) await lifecycle.stop(); // reverse order, graceful
    started = false;
    return { ok: true, stopped: graph.shutdownOrder };
  }

  async function verify() {
    const checks = {};
    checks.allRegistered = { ok: regCheck.ok, count: regCheck.count };
    checks.dependencyGraph = { ok: graph.ok, order: graph.order };
    checks.noCycles = { ok: graph.cycle == null };

    // all required ports injected
    const portIssues = [];
    for (const name of graph.order) {
      const { descriptor } = composed.get(name);
      for (const p of descriptor.ports) {
        if (!composed.has(p) || !composed.get(p).service) {
          portIssues.push({ kernel: name, port: p });
        }
      }
    }
    checks.portsInjected = { ok: portIssues.length === 0, issues: portIssues };

    // all providers healthy
    const agg = await aggregateHealth(kernelList, {
      order: graph.order,
      shutdownOrder: graph.shutdownOrder,
      started,
      environment: context.environment,
      version: context.version,
    });
    checks.providersHealthy = {
      ok: agg.overall,
      healthy: agg.healthyKernels,
      total: agg.totalKernels,
    };

    // compatibility checks passed (delegated to the Compatibility Kernel, ADR-041)
    if (composed.has('compatibility')) {
      try {
        const v = await composed.get('compatibility').service.verify({});
        checks.compatibility = { ok: Boolean(v && v.ok) };
      } catch (e) {
        checks.compatibility = { ok: false, error: e.message };
      }
    } else {
      checks.compatibility = { ok: true, note: 'compatibility kernel not composed' };
    }

    const ok = Object.values(checks).every((c) => c.ok);
    return { ok, checks };
  }

  async function health() {
    const verification = await verify().catch((e) => ({ ok: false, error: e.message }));
    return aggregateHealth(kernelList, {
      order: graph.order,
      shutdownOrder: graph.shutdownOrder,
      started,
      environment: context.environment,
      version: context.version,
      verification,
    });
  }

  function getKernel(name) {
    const entry = composed.get(name);
    return entry ? entry.service : null;
  }

  function listKernels() {
    return graph.order.map((name) => ({
      name,
      adr: composed.get(name).descriptor.adr,
    }));
  }

  function version() {
    return context.version;
  }

  return Object.freeze({
    start,
    shutdown,
    health,
    verify,
    getKernel,
    listKernels,
    version,
    // read-only introspection (non-mutating; not part of the mandated 7-method surface)
    context,
    startupOrder: Object.freeze([...graph.order]),
    shutdownOrder: Object.freeze([...graph.shutdownOrder]),
  });
}

/** When options.only is given, include those kernels + all their transitive deps/ports. */
function selectKernels(all, only) {
  if (!only || !only.length) return all;
  const byName = new Map(all.map((k) => [k.name, k]));
  const keep = new Set();
  const visit = (n) => {
    if (keep.has(n) || !byName.has(n)) return;
    keep.add(n);
    const k = byName.get(n);
    for (const d of [...(k.dependsOn || []), ...(k.ports || [])]) visit(d);
  };
  only.forEach(visit);
  return all.filter((k) => keep.has(k.name));
}

module.exports = { createPlatform, KERNELS };
