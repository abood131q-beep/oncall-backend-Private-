# Enterprise Rate Limiting Kernel — Developer Guide (ADR-031)

The Rate Limiting Kernel is the platform's unified abstraction for deterministic request
admission, quota management, and abuse protection. It is **not Express Rate Limit / NGINX /
Redis middleware** — those are provider/persistence details. It lives under `ratelimit/`,
additive to every existing kernel.

## 1. Compose

```js
const { createRateLimitPlatform } = require('../../src/application/ratelimit');
const rl = createRateLimitPlatform({
  publisher, // EventPublisher port (ADR-016); omit for a null publisher
  cacheMaxSize: 10000, // optional usage-cache bound
});
const R = rl.ratelimit;
```

## 2. Register a policy

```js
const policy = await R.registerPolicy({
  name: 'api-requests',
  subjectType: 'user', // what the subject represents (user/ip/tenant/apiKey…)
  limit: 100, // sustained units per window
  window: 60000, // window in ms
  algorithm: 'token_bucket', // fixed_window | sliding_window | token_bucket | leaky_bucket
  burstLimit: 120, // optional ceiling above the sustained limit (buckets)
  priority: 10, // used when resolving by subjectType
  metadata: { tier: 'gold' },
});
// → public policy model (includes version + checksum)
```

## 3. Evaluate (dry run) vs consume (mutates)

```js
// evaluate: check WITHOUT spending quota — no counter mutation.
const check = await R.evaluate({ policyId, subject: 'user-123', cost: 1 });

// consume: the admission decision that spends quota when allowed.
const r = await R.consume({ policyId, subject: 'user-123', cost: 1 });
if (!r.allowed) return respond(429, { retryAfter: r.resetTime });
// r → { policyId, namespace, subject, algorithm, allowed, limit, burstLimit,
//       usage, remaining, resetTime, cost, priority }
```

`remaining` reflects capacity left **after** the evaluated request; `resetTime` is the
epoch-ms at which the subject regains full capacity. Both `evaluate` and `consume` are
deterministic — the same (policy, subject, now, cost) always yields the same result.

## 4. Priority resolution (select by subjectType)

```js
// omit policyId → the engine picks the highest-priority policy matching subjectType
await R.consume({ subjectType: 'ip', subject: '1.2.3.4' });
```

## 5. Reset + verify + health

```js
await R.reset({ policyId, subject: 'user-123' }); // clear a subject's quota → QuotaReset
await R.verify({ namespace }); // → { ok, issues } — policy integrity (checksum) + presence
await R.health(); // provider health + counts + cache stats + metrics
```

## 6. Algorithms

- **fixed_window** — a counter per aligned `window`; resets at the window boundary. Simple,
  bursty at edges.
- **sliding_window** — a timestamped log evicted by age; smooth, no edge bursts.
- **token_bucket** — tokens refill at `limit/window`; `burstLimit` is the bucket capacity.
  Allows bursts up to capacity, then steady rate.
- **leaky_bucket** — a level that leaks at `limit/window`; smooths output, caps at
  `burstLimit`.

## 7. Events (through the port only)

`RatePolicyRegistered`, `RateLimitEvaluated`, `QuotaConsumed`, `QuotaExceeded`, `QuotaReset`
— all via the Event Backbone, producer `ratelimit`. High-volume evaluation/consume events
can be sampled by the publisher adapter.

## 8. Observability

```js
rl.metrics.snapshot(); // registeredPolicies (gauge), evaluations, allowed, blocked,
// consumption, resets, cacheHits/Misses, providerFailures, latency, uptime
rl.metrics.prometheus();
```

## 9. SDK integration (ADR-018)

```js
const { toRateLimitPort } = require('../../src/application/ratelimit/sdkAdapter');
const portFactories = {
  'rate:read': () => toRateLimitPort(rl.ratelimit, { owner: extId, canEvaluate: false }),
  'rate:evaluate': () => toRateLimitPort(rl.ratelimit, { owner: extId }),
};
// Inside the extension: this.ratelimit().consume({ policyId, subject })
```

Every call is forced into the extension's namespace (`ext.<owner>`). `evaluate`/`consume`
require `rate:evaluate`; `verify`/`list` require `rate:read`. Policy authoring
(`registerPolicy`) and `reset` are administrative and not exposed to extensions.

## Determinism, burst & integrity

- **Deterministic** — an injected clock drives every decay/refill; no wall-clock or
  randomness. Concurrent `consume` calls on one subject serialize via a per-(policy,subject)
  mutex, so the limit is never over-admitted in-process.
- **Burst** — `burstLimit` raises the ceiling above the sustained `limit` (bucket capacity
  for token/leaky; the hard cap for windows).
- **Integrity** — every policy carries a checksum; `consume`/`evaluate` verify it on
  resolve and `verify()` checks a whole namespace.

## Out of scope (future work behind the provider port)

Real counter stores (Redis/Storage/PostgreSQL/MongoDB), distributed atomic counters, and
cross-node coordination are declared extension points, not implemented in this phase. The
memory provider + cache are single-process.
