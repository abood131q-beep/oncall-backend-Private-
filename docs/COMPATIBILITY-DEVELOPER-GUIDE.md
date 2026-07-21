# Enterprise Compatibility Kernel — Developer Guide (ADR-041)

The Compatibility Kernel is the platform's unified authority for deterministic contract
compatibility, capability negotiation, version evolution, deprecation governance, and
backward/forward compatibility across all Kernel Services. It is **not semantic versioning
/ npm package management / API versioning middleware / a migration framework**. It lives
under `compatibility/`, additive to every existing kernel.

## 1. Compose

```js
const { createCompatibilityPlatform } = require('../../src/application/compatibility');
const ck = createCompatibilityPlatform({ publisher }); // EventPublisher port (ADR-016)
const C = ck.compatibility;
```

## 2. Register a contract

```js
await C.registerContract({
  contractId: 'billing-api',
  component: 'billing-api',
  version: '2.1.0',
  supportedVersions: ['1.0.0', '2.0.0', '2.1.0'],
  capabilities: ['invoices', 'refunds'],
  compatibilityLevel: 'backward', // strict | backward | forward | full | none
});
```

A contract declares the component's current `version`, the `supportedVersions` it accepts,
the `capabilities` it offers, and its `compatibilityLevel`. Every contract carries a
`checksum` over its full definition (including `deprecationStatus`) so deprecations are
tamper-evident.

## 3. Evaluate compatibility (deterministic verdict)

```js
const decision = await C.evaluate({
  contractId: 'billing-api',
  version: '2.0.0',
  capabilities: ['invoices'],
});
// → { compatible, versionOk, backward, forward, missingCapabilities, level, deprecated, ... }
```

`evaluate` is a pure decision: `versionOk` depends on the contract's level — `strict`
admits only the exact version, `backward` admits older supported versions, `forward` admits
newer supported ones, `full` admits any supported version, `none` admits only the exact
version. Missing capabilities are the requested set minus what the contract offers. A
retired contract is never compatible. Incompatible verdicts emit
`CompatibilityViolationDetected`.

## 4. Negotiate capabilities + resolve a version

```js
const n = await C.negotiate({
  contractId: 'billing-api',
  version: '>=2.0.0', // semver range
  capabilities: ['invoices', 'exports'],
});
// → { resolvedVersion: '2.1.0', agreedCapabilities: ['invoices'], missingCapabilities: ['exports'], ok }
await C.negotiate({ contractId: 'billing-api', capabilities: ['x'], strict: true }); // throws NegotiationError if unmet
```

Negotiation resolves the highest supported version satisfying the request and intersects
the requested capabilities with what the contract offers. In `strict` mode an unmet request
throws `NegotiationError`.

## 5. Deprecation governance

```js
await C.deprecate({ contractId: 'billing-api', replacementContract: 'billing-api-v3' }); // → deprecated
await C.deprecate({ contractId: 'billing-api', retire: true }); // → retired
```

Deprecation is a governed transition (`active → deprecated → retired`) that records a
replacement, recomputes the checksum, and emits `VersionDeprecated`.

## 6. Verify

```js
await C.verify({ contractId: 'billing-api', version: '2.0.0', capabilities: ['invoices'] }); // integrity + compatibility
await C.verify({ namespace }); // checksum integrity of every stored contract → { ok, issues }
```

## 7. Events (through the port only)

`ContractRegistered`, `CompatibilityVerified`, `CapabilityNegotiated`, `VersionDeprecated`,
`CompatibilityViolationDetected` — all via the Event Backbone, producer `compatibility`.

## 8. Observability

```js
ck.metrics.snapshot(); // registeredContracts (gauge), evaluations, incompatibleResults,
// verifications, negotiations, deprecations, violationsDetected, provider/event/integrity
// failures, evaluation latency, uptime
ck.metrics.prometheus();
```

## 9. SDK integration (ADR-018)

```js
const { toCompatibilityPort } = require('../../src/application/compatibility/sdkAdapter');
const portFactories = {
  'compatibility:read': () => toCompatibilityPort(ck.compatibility, { owner: extId }),
  'compatibility:verify': () =>
    toCompatibilityPort(ck.compatibility, { owner: extId, canVerify: true }),
};
// Inside the extension: this.compatibility().evaluate({ contractId, version })
```

Every call is forced into the extension's namespace (`ext.<owner>`). `evaluate`/`negotiate`/
`get`/`list`/`resolve` require `compatibility:read`; `verify` requires
`compatibility:verify`. Contract registration and deprecation are administrative and not
exposed to extensions.

## Determinism & integrity

- **Deterministic** — the same contract + request always yields the same verdict; version
  comparison reuses the platform semver kernel; the injected clock drives timestamps +
  latency.
- **Integrity** — every contract carries a checksum; `evaluate`/`negotiate`/`verify` detect
  tampering (`IntegrityError`), and namespace-wide `verify` flags checksum mismatches.
- **Atomic** — registration and deprecation are serialized per namespace via a mutex, so
  concurrent duplicate registrations yield exactly one success.

## Out of scope (future work behind the provider port)

Real stores (PostgreSQL/Storage/Redis/MongoDB/cloud), cross-namespace contract federation,
and automated deprecation-window enforcement are declared extension points, not implemented
in this phase. The memory provider is single-process.
