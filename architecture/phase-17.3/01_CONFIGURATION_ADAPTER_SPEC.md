# Phase 17.3 — Configuration Adapter Specification

`src/platform-adapters/configuration/index.js` — the single, sanctioned boundary between the
OnCall application and the Configuration Kernel (ADR-019).

---

## 1. Contract

`createConfigurationAdapter({ port })` returns a frozen object:

| Member | Kind | Maps to kernel | Notes |
|---|---|---|---|
| `name` | value | — | `'configuration'` |
| `kernel` | value | — | `'config (ADR-019)'` |
| `consumed()` | pure | — | `true` iff a port is injected |
| `toKey(key)` | pure translator | — | `String(key)` |
| `fromEntry(entry)` | pure translator | — | unwraps `{ value }` |
| `get(key)` | active read | `service.get(key)` | raw value |
| `has(key)` | active read | `service.exists(key)` | **name mapping** |
| `list(prefix)` | active read | `service.list(prefix)` | key listing |
| `version()` | active read | `service.version()` | snapshot version |
| `snapshotValues()` | active read | `service.snapshot({ redact:false }).values` | comparator use only |
| `health()` | pure | — | `{ ok:true, consumed }` |

## 2. Rules

1. **Translation only** — no business logic, no repository/DB/service access.
2. **Kernel-only through the port** — every active method calls `requirePort('configuration',
   port)` and throws `AdapterNotWiredError` when inert (no port). Verified by test.
3. **Read-only / non-authoritative** — there is no write/set method. Even when a port is
   injected, values are consumed **only** by the shadow verifier and never returned to the
   application.
4. **Method-name translation** — the application-facing `has()` maps to the kernel's
   `exists()`; this is the adapter's core reason to exist (shape/name translation).

## 3. Injection

The port is injected exclusively by `src/enterprise/index.js` via
`createPlatformAdapters({ ports: { config: runtime.platform().getKernel('config') } })`, and
only when `PLATFORM_CONFIG=1`. No other injection path exists; no application module can reach
the kernel.

## 4. Inert vs consumed

| State | Condition | Behavior |
|---|---|---|
| Inert (default) | no port | `consumed() === false`; active reads throw `AdapterNotWiredError` |
| Consumed (shadow) | port injected (`PLATFORM_CONFIG=1`) | `consumed() === true`; active reads delegate to the kernel service; still non-authoritative |

## 5. Test coverage (`tests/unit/config-shadow.test.js`)
- inert adapter throws on `get`/`has`;
- consumed adapter maps `get→get`, `has→exists` (incl. false for absent key), `version→version`;
- no repository/DB surface (asserted across the whole adapter layer in
  `platform-adapters.test.js`).
