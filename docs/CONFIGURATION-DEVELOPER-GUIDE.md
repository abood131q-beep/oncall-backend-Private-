# Configuration Platform — Developer Guide (Phase 14.3.2)

The Configuration Platform is the **single source of truth** for runtime configuration.
Every extension, platform service, and mobility module obtains configuration **only** through
it — never by reading `process.env`, files, or constants directly.

## 1. Compose the platform

```js
const { createConfigurationPlatform, providers } = require('../../src/application/config');

const cfg = createConfigurationPlatform({
  defaults: { 'http.port': 3000, 'http.host': 'localhost' }, // lowest priority
  providers: [
    providers.createJsonFileProvider({ path: './config/app.json' }), // file layer
    providers.createEnvProvider({ prefix: 'APP_' }), // environment layer
    providers.createMemoryProvider({ layer: 'provider', initial: {} }), // provider layer
  ],
  schema: {
    required: ['http.port'],
    properties: {
      'http.port': { type: 'integer', min: 1, max: 65535 },
      'http.host': { type: 'string' },
    },
  },
  publisher, // EventPublisher port (ADR-016); omit for a null publisher
});

await cfg.init(); // builds + validates the first snapshot
```

After `init()`, the read API is synchronous.

## 2. Read API

```js
cfg.service.get('http.port'); // value or undefined (optional fallback arg)
cfg.service.require('http.port'); // throws if missing
cfg.service.exists('http.host'); // boolean
cfg.service.list('http.'); // sorted keys under a prefix
cfg.service.snapshot(); // frozen, secrets redacted
cfg.service.version(); // integer; bumps only on real change
cfg.service.validate(candidate?); // { ok, value, errors }
```

## 3. Precedence (deterministic)

Highest priority first:

```
runtime → tenant → organization → environment → provider → file → default
```

The same layer inputs always resolve to the same result. `snapshot().origins` tells you
which layer won each key.

## 4. Runtime reload + rollback

```js
await cfg.service.reload(); // re-read all providers, re-validate, activate
```

If the new configuration fails schema validation, the platform **keeps the previous good
snapshot** (automatic rollback) and emits `ConfigurationValidationFailed` + `ConfigurationRollback`.
An invalid *initial* configuration cannot activate and `init()` throws. Providers that
support push (e.g. the memory provider's `set/setAll/delete`) trigger reload automatically —
no restart.

## 5. Watch / subscribe

```js
const unsubscribe = cfg.service.watch('http.port', (change) => {
  // { key, oldValue, newValue, timestamp, version, origin }
});
unsubscribe();
```

## 6. Runtime overrides

```js
await cfg.service.setOverride('runtime', 'http.port', 9090); // beats every lower layer
await cfg.service.clearOverride('runtime', 'http.port');
```

Scopes: `runtime`, `tenant`, `organization`, `environment`.

## 7. Events (through the port only)

`ConfigurationChanged`, `ConfigurationReloaded`, `ConfigurationValidationFailed`,
`ConfigurationRollback`, `ConfigurationProviderChanged` — all published via the injected
EventPublisher port with producer `config`. The platform never touches an EventBus directly.

## 8. Security

Configuration never surfaces secrets. Any key matching a sensitive pattern (password, token,
private key, credential, API secret, …) is redacted to `«redacted»` in `snapshot()`, in
`ConfigurationChanged` event payloads, and in logs. Secrets themselves belong to the Secret
Provider (a future phase) — this platform only redacts.

## 9. Observability

```js
cfg.metrics.snapshot(); // provider latency, reload count/duration, validation failures,
// cache hit/miss ratio, subscriber count, watch notifications
cfg.metrics.prometheus(); // Prometheus exposition text
```

## 9a. Production hardening (added in the completion pass)

Reloads are serialized and coalesced, so concurrent triggers can't race. Each provider load
is bounded by `providerTimeoutMs` (default 5000); on timeout or error the platform reuses that
provider's last-known-good values (graceful degradation) rather than hanging or wiping config.
Activated snapshots are deep-frozen and swapped atomically.

```js
cfg.service.history(); // [{ version, at, keys }] — bounded ring buffer
cfg.service.snapshotAt(version); // a retained snapshot (redacted), or null if evicted
cfg.service.isStale(myVersion); // true if myVersion !== active version
cfg.service.verifyCache(); // { ok, cacheVersion, currentVersion }
cfg.service.diagnostics(); // structured health for dashboards / health checks
```

Extra optional composition deps: `providerTimeoutMs`, `historyLimit`. New metric:
`config_provider_errors_total`.

## 10. SDK integration (ADR-018)

```js
const { toReadConfigPort } = require('../../src/application/config/sdkAdapter');

// Grant an extension config through the platform (prefix-scoped, prefix stripped):
const portFactories = {
  'read:config': () => toReadConfigPort(cfg.service, { prefix: 'ext.surge-pricing.' }),
};
// Inside the extension: this.config(), this.reloadConfig(), this.validateConfig()
// work unchanged — provider internals never leak.
```
