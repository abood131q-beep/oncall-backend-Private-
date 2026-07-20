# Configuration Platform — Provider Guide (Phase 14.3.2)

A **provider** is a data source that feeds one precedence layer. Business logic never knows
which providers are active; the composition root wires them. This guide covers the implemented
adapters and how to add a new one (e.g. one of the declared extension points).

## The provider port

Every provider implements this contract (`src/application/config/providerPort.js`):

```js
{
  name,                    // string id, e.g. 'env' or 'file:app.json'
  layer,                   // precedence layer this feeds (see below)
  load() -> Promise<obj>,  // read the full { key: value } bag
  get?(key) -> Promise,    // optional fast path
  watch?(cb) -> unsub,     // optional; call cb() when the source changes → live reload
}
```

`assertProvider(p)` fails fast at composition time if `name`, `layer`, or `load` is missing.

Precedence layers (high→low): `runtime`, `tenant`, `organization`, `environment`,
`provider`, `file`, `default`.

## Implemented adapters

### Environment Variables — `createEnvProvider({ source?, prefix?, transformKey?, layer? })`

Reads from an injected `source` (defaults to a snapshot of `process.env`). With `prefix: 'APP_'`,
`APP_HTTP_PORT` becomes `http.port` (lowercased, `_`→`.`). Feeds the `environment` layer.

### JSON File — `createJsonFileProvider({ path, readFile?, layer? })`

Reads and parses a JSON document, flattening nested objects into dotted keys
(`{db:{host}}` → `db.host`). `readFile` is injectable (defaults to `fs.readFileSync` UTF-8),
so it is testable without disk and re-reads on every `load()` for reload support. Feeds the
`file` layer.

### Memory — `createMemoryProvider({ initial?, layer?, name? })`

In-process source backing any layer. Its `set/setAll/delete` mutators notify watchers, which
drives live reload in tests and runtime overrides. This is the seam a future distributed
provider slots behind.

## Extension points (declared, not implemented in this phase)

`FUTURE_PROVIDERS`: `redis`, `postgres`, `consul`, `etcd`, `vault`, `aws-appconfig`,
`azure-app-configuration`, `google-runtime-config`. `futureProvider(name)` returns a guard
whose `load()` rejects with a clear "extension point — not implemented" error, so intent is
explicit and a half-wired provider fails loudly rather than returning empty config.

## Writing a new provider

```js
function createRedisProvider({ client, keyspace, layer = 'provider' }) {
  return {
    name: `redis:${keyspace}`,
    layer,
    async load() {
      const entries = await client.hgetall(keyspace); // your source
      return entries || {};
    },
    watch(cb) {
      const handler = () => cb();
      client.on('message', handler); // push → live reload
      return () => client.off('message', handler);
    },
  };
}
```

Then add it to `providers` in `createConfigurationPlatform({ providers: [...] })`. No business
logic changes — the service resolves it by its declared `layer`. When multiple providers feed
the same layer, later entries in the array win within that layer.

## Guarantees

- Providers are pure data sources — no validation, no precedence, no events. Those are the
  service's job, so providers stay simple and swappable.
- A provider throwing in `load()` surfaces as a reload error; if a previous good snapshot
  exists it stays active (rollback), so a flaky source can't take down configuration.
