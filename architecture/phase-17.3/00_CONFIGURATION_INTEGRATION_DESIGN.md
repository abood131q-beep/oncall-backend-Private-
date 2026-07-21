# Phase 17.3 — Configuration Integration Design

**Status:** Implemented. **Scope:** integrate the Enterprise Configuration Kernel (ADR-019)
through the existing Configuration Adapter, in **Shadow Mode only**. Legacy `env.js` remains
the single Source of Truth; the kernel is never authoritative and its values are never
exposed to the application.

---

## 1. Objective

Prove that the Configuration Kernel can serve the exact same values the legacy system serves,
by reading from both systems and comparing every value — **without changing** how the
application reads configuration, and **without** the kernel ever influencing runtime behavior.

## 2. Shadow execution model

```
Legacy Configuration (env.js)        ← Source of Truth
        │
        ▼
Configuration Adapter  ──────▶  Configuration Kernel (ADR-019)   [read-only]
        │                                   │
        │                                   ▼
        │                          kernel value (never exposed)
        ▼
Parity Verification (deep compare legacy vs kernel)
        ▼
Shadow Metrics (requests / comparisons / matches / mismatches / latency / failures)
        ▼
RETURN LEGACY VALUE   ← always; kernel never authoritative
```

Implemented in `src/platform-adapters/configuration/shadow.js` (`shadowGet`, `verifyAll`).

## 3. Components (all additive)

| File | Role |
|---|---|
| `src/platform-adapters/configuration/index.js` | Configuration Adapter — the ONLY thing that talks to the kernel; pure translation (`get`, `has`→`exists`, `list`, `version`, `snapshotValues`). |
| `src/platform-adapters/configuration/legacySource.js` | Read-only view over `env.js` exports (typed values); the Source of Truth for comparison and for seeding. |
| `src/platform-adapters/configuration/metrics.js` | Shadow metrics (in-memory; never affects runtime). |
| `src/platform-adapters/configuration/shadow.js` | Shadow verifier: compare, record, **return legacy**. Deep-equal + sensitive-key redaction. |
| `src/enterprise/configShadow.js` | Flag selection, kernel seeding, shadow attachment. |
| `src/enterprise/index.js` | Wires the above into the boot behind the two flags. |

## 4. How parity reaches 100%

The Configuration Kernel has no knowledge of OnCall's env schema, defaults, or parsing. Rather
than re-implement `env.js` inside the kernel (which would risk divergence), the boot **seeds
the kernel with the exact typed values `env.js` already computed** (`kernelOptions.config.
defaults`). The seed is **deep-cloned** (`structuredClone`) so the kernel's internal
deep-freeze can never mutate the legacy config objects. The shadow then verifies that the
adapter+kernel round-trip returns those values **losslessly** — booleans stay booleans,
numbers stay numbers, arrays/objects are structurally equal, `null`/missing are preserved.

This is the correct interpretation of "read identical values from both systems": the kernel is
fed the legacy truth and must reproduce it exactly through its public port. Any type coercion,
precedence surprise, redaction on `get()`, or dropped key would surface as a mismatch.

## 5. Feature flags (only two; default OFF)

| Flag | Effect | Default |
|---|---|---|
| `PLATFORM_CONFIG` | Compose + seed the Config kernel; inject its port into the Configuration Adapter. | `0` |
| `SHADOW_CONFIG` | Additionally run parity comparisons. Requires `PLATFORM_CONFIG=1`. | `0` |

`selectConfigFlags()` enforces that `SHADOW_CONFIG` cannot activate without `PLATFORM_CONFIG`.
With both OFF the enterprise boot is **byte-identical to Phase 17.2** (no kernelOptions, no
port injected, adapter inert, no shadow) — verified by test.

## 6. Boundaries honored

- `env.js` and all application configuration reads are **unchanged**.
- Only the Configuration Adapter talks to the kernel; **no application module** imports or
  calls the kernel.
- Startup and shutdown sequences are unchanged (the parity pass runs out-of-band, after
  `host.start()`, and never gates readiness).
- No API, auth, JWT, database, route, or Flutter change. Git shows only `server.js`
  (unchanged since 17.2) and `.env.example` (flag docs) among tracked files; all changes are
  additive modules under `src/platform-adapters/` and `src/enterprise/`.
- No other kernel is consumed (Identity/Policy/Audit/Storage/… untouched).
