# Enterprise Feature Flag Kernel — Developer Guide (ADR-029)

The Feature Flag Kernel is the platform's unified abstraction for deterministic feature
evaluation, gradual rollout, targeting, and controlled activation. It is **not
LaunchDarkly/Unleash/Firebase Remote Config** and **not an experimentation framework** —
those stores are provider extension points. It lives under `features/`, additive to every
existing kernel.

## 1. Compose

```js
const { createFeaturePlatform } = require('../../src/application/features');
const ff = createFeaturePlatform({
  publisher, // EventPublisher port (ADR-016); omit for a null publisher
  cacheMaxSize: 5000, // optional evaluation-cache bound
});
const F = ff.features;
```

## 2. Register a flag

```js
const flag = await F.register({
  name: 'new-checkout', // unique per namespace
  description: 'Rolls out the new checkout',
  defaultValue: true, // value served when ON and matched (any JSON value)
  offValue: false, // value served when OFF / not targeted / excluded
  enabled: false, // start disabled (default: enabled)
  // flag-level targeting constraints (each optional; null = any):
  platform: ['ios', 'android'],
  appVersion: '>=2.1.0', // semver range
  country: ['US', 'CA'],
  region: null,
  tenant: null,
  environment: 'production',
  // ordered rules (priority desc, then declared order):
  rules: [
    { id: 'beta', priority: 10, when: { segment: 'beta' }, value: true },
    { id: 'canary', priority: 5, when: { platform: 'ios' }, value: true, rollout: { percentage: 20 } },
  ],
  // flag-level gradual rollout:
  rollout: { percentage: 25, salt: 'v1', attribute: 'key' },
  priority: 0,
  metadata: { team: 'growth' },
});
// → public flag model (includes version + checksum)
```

## 3. Evaluate — deterministic + explained

```js
const r = await F.evaluate({
  name: 'new-checkout',
  context: { key: 'user-123', platform: 'ios', appVersion: '2.3.0', country: 'US', segment: 'beta' },
});
// → { flag, flagId, namespace, version, checksum, value, reason, served, targeted, ruleId?, rollout? }
```

`reason` is one of: `disabled`, `archived`, `not_targeted` (with `failed`), `rule_match`
(with `ruleId`), `rollout_included`, `rollout_excluded`, `default`. Evaluation is
deterministic — the same definition + context always returns the same result — and cached
by definition checksum, so repeat evaluations are cache hits until the flag changes.

## 4. Activate / change

```js
await F.enable({ name: 'new-checkout' }); // state → enabled (new version + checksum)
await F.disable({ name: 'new-checkout' }); // state → disabled
await F.update({ name: 'new-checkout', patch: { rollout: { percentage: 50 } } }); // new version
```

Each mutation bumps the version + checksum, which invalidates the flag's cached
evaluations automatically.

## 5. List + verify + health

```js
await F.list(); // → public flag models in the namespace
await F.verify({ namespace }); // → { ok, issues } — definition integrity (checksum) + provider consistency
await F.health(); // → provider health + counts + cache stats + metrics
```

## 6. Events (through the port only)

`FeatureRegistered`, `FeatureUpdated`, `FeatureEnabled`, `FeatureDisabled`,
`FeatureEvaluated`, `FeatureRejected` — all via the Event Backbone, producer `features`.
`FeatureEvaluated` fires when a value is served; `FeatureRejected` when the off value is
returned (disabled / not targeted / excluded / not found / integrity). High-volume
evaluation events can be sampled by the publisher adapter.

## 7. Observability

```js
ff.metrics.snapshot(); // registered/enabled/disabled (gauges), evaluations, cacheHits,
// cacheMisses, evaluation latency, providerFailures, eventFailures, uptime
ff.metrics.prometheus();
```

## 8. SDK integration (ADR-018)

```js
const { toFeaturePort } = require('../../src/application/features/sdkAdapter');
const portFactories = {
  'feature:read': () => toFeaturePort(ff.features, { owner: extId, canEvaluate: false }),
  'feature:evaluate': () => toFeaturePort(ff.features, { owner: extId }),
};
// Inside the extension: this.features().evaluate({ name, context })
```

Every call is forced into the extension's namespace (`ext.<owner>`). `evaluate` requires
`feature:evaluate`; `list`/`verify` require `feature:read`. Flag authoring
(register/enable/disable/update) is **not** exposed to extensions — it is administrative.

## 9. Determinism, rollout & conflict resolution

- **Deterministic hashing** — rollout buckets a stable subject id (`context.key`, or a
  rule/flag `attribute`) with the flag name + salt; the same key always lands in the same
  bucket, and raising a percentage only ever adds keys (monotonic ramps).
- **Conflict resolution** — rules evaluate highest `priority` first, ties broken by
  declared order; the first matching (and, if it has a rollout, included) rule wins.
- **Integrity** — every stored definition carries a checksum; evaluation verifies it on a
  cache miss and `verify()` checks a whole namespace.

## Out of scope (future work behind the provider port)

Real definition stores (Storage/PostgreSQL/Redis/MongoDB/cloud config), scheduled rollout
ramps, and streaming change propagation are declared extension points, not implemented in
this phase. A/B experimentation is explicitly out of scope. The memory provider is
single-process.
