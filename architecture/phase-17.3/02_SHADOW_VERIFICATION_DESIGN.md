# Phase 17.3 — Shadow Verification Design

`src/platform-adapters/configuration/shadow.js` implements the shadow read and parity
verification. Its defining property: **it can never change what the caller gets and can never
crash the caller.**

---

## 1. `shadowGet(key)` algorithm

```
recordRequest()
legacyValue = legacy.get(key)                     # authoritative
if (!enabled() || !adapter.consumed()) return legacyValue   # short-circuit: no comparison

t0 = now
try   kernelValue = adapter.get(key)              # ONLY kernel touch, via the adapter
catch recordVerificationFailure(); return legacyValue        # never throw; legacy wins
latencyMs = now - t0

legacyHas = legacy.has(key);  kernelHas = adapter.has(key)   # presence parity
matched = (legacyHas === kernelHas) && deepEqual(legacyValue, kernelValue)
recordComparison(matched, latencyMs)
if (!matched) recordMismatch(describe(key, ...))  # redacted if sensitive
return legacyValue                                 # ← unconditional, authoritative
```

Guarantees:
- **Return value is always the legacy value** — on match, mismatch, disabled, or failure.
- **No throw path reaches the caller** — kernel/adapter errors become recorded verification
  failures.
- **Disabled = zero comparison** — when `SHADOW_CONFIG=0`, it returns legacy immediately.

## 2. Comparison — `deepEqual`

Deterministic structural equality across primitives, arrays, and plain objects, with `NaN ===
NaN` handled and `null` vs `undefined` treated as unequal. Covers every required parity
category: booleans, numbers, strings, arrays, objects, `null`, and missing (presence parity).

## 3. Redaction

Sensitive keys (`/secret|token|api[_-]?key|apikey|password|account|firebase|credential/i`)
never have their raw values recorded. A mismatch/failure record for such a key stores only
`{ key, legacyType, kernelType, sensitive:true, ... }` — no `legacyValue`/`kernelValue`. This
keeps `JWT_SECRET`, SMS keys, Firebase credentials, etc. out of logs/metrics. Verified by test.

## 4. `verifyAll(keys?)`

Runs `shadowGet` over all legacy keys (or a supplied subset), then returns a delta report:
`{ enabled, keysChecked, comparisons, matches, mismatches, verificationFailures, parityPct,
mismatchKeys }`. Called once at boot (out-of-band) when `SHADOW_CONFIG=1`; also callable
on demand.

## 5. Observability — shadow metrics

`src/platform-adapters/configuration/metrics.js` (in-memory, isolated from the app's
`/metrics`):

| Metric | Meaning |
|---|---|
| `requests` | `shadowGet` calls |
| `comparisons` | times legacy vs kernel were actually compared |
| `matches` / `mismatches` | comparison outcomes |
| `verificationFailures` | kernel/adapter errors during a shadow read |
| `latency` | `{ samples, avgMs, maxMs }` of comparison latency |
| `parityPct` | `matches / comparisons * 100` |
| `mismatches_log` | bounded ring of (redacted) mismatch/failure descriptors |

Recording a metric has **no** runtime effect — it never alters the returned value and is not
wired into the application's metrics endpoint. This satisfies "shadow statistics must never
affect runtime behavior."

## 6. Verified parity categories

Environment variables, hierarchy/precedence (kernel precedence resolves the seeded layer),
default values, missing values (presence parity), boolean parsing, numeric parsing, arrays,
objects, startup configuration, health/metrics configuration keys, and runtime-reload behavior
(re-running `verifyAll` after a kernel reload stays 100%). All exercised in
`tests/unit/config-shadow.test.js` and the boot smoke.
