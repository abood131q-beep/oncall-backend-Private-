# Enterprise Shadow Framework — Overview & Developer Guide

> **Companion to G1.0.** G1.0 defines the *rules* (what a compliant shadow integration must
> guarantee). This document explains the *framework* that implements those rules in code: how
> the shared pieces work, who is responsible for what, how to add a new kernel using the
> framework, and when to extend the framework vs. just use it.
>
> **Type:** Practical engineering reference (non-normative). Where this document and G1.0
> disagree, **G1.0 wins**.
> **Status:** Living. Update it whenever the framework's public surface changes.
> **Reference implementations:** Jobs (Phase 17.5) and Scheduler (Phase 17.6) are the canonical
> round-trip examples; Configuration (17.3) and Observability (17.4) are the read-through
> examples.

---

## 1. The big picture

Every kernel integration is a **shadow**: the legacy system stays authoritative, the Enterprise
kernel runs beside it, and a verifier compares the two and reports parity — without ever
changing behavior. The framework exists so each new kernel is *configuration*, not new control
flow.

```
                 ┌──────────────────────── src/platform-adapters/ ───────────────────────┐
                 │                                                                          │
  legacySource ──┼─► <kernel>/shadow.js ──► _shadow (shared) ──► <kernel>/index.js (adapter)│──► Kernel (port)
   (Source of    │        (thin config)      deepEqual/flatten     (only kernel seam)        │
    Truth list)  │                            metrics/verifier     record()/readRef()        │
                 └──────────────────────────────────────────────────────────────────────────┘
                                   ▲                                        ▲
        src/enterprise/<kernel>Shadow.js (flags + attach)      src/enterprise/index.js (compose + gate)
```

Two shadow **shapes** exist, and every kernel is one of them:

| Shape | What the kernel is | Verifier | Examples |
|---|---|---|---|
| **Round-trip** | a store you feed and read back | shared `createRoundTripShadow` | Jobs, Scheduler |
| **Read-through** | a value provider compared on demand | small per-kernel verifier over `core` | Configuration, Observability |

New round-trip kernels should reuse `createRoundTripShadow` verbatim. New read-through kernels
currently write a tiny verify loop over the shared primitives (a generic read-through helper is
a candidate future extension — see §6).

---

## 2. The shared framework — `src/platform-adapters/_shadow/`

| File | Responsibility |
|---|---|
| `core.js` | Pure primitives: `deepEqual`, `flatten`, `typeOf`, `isSensitiveKey`, `redactValue`, `SENSITIVE`, and **`createShadowMetrics`** (the full G1.0 §5 metric set). |
| `roundTripShadow.js` | **`createRoundTripShadow`** — the generic "for each legacy item: `record → readRef → compare`" verifier, plus `compareViews`. |
| `index.js` | Public surface: re-exports `core` + the generic verifier. Import from here (`require('../_shadow')`). |

### 2.1 `createShadowMetrics(opts)` — the metrics contract

```js
const m = createShadowMetrics({ declaredSurface, confidenceN = 20, mismatchLogLimit = 100 });
m.recordRequest();
m.recordComparison(matched /*bool*/, latencyMs /*number*/, key /*string, for coverage*/);
m.recordMismatch({ ...descriptor });          // redact sensitive values yourself
m.recordVerificationFailure({ error });        // on kernel/adapter error
m.setDeclaredSurface(n);                        // total distinct leaf keys (coverage base)
m.snapshot();  // → { requests, comparisons, matches, mismatches, verificationFailures,
               //     parityPct, confidenceLevel, coveragePct, declaredSurface, coveredKeys,
               //     latency:{samples,avgMs,maxMs}, mismatches_log }
```

- **`confidenceLevel`** = `matchRatio × min(1, comparisons / confidenceN)` — low sample counts
  cap confidence (so "100% over 2 comparisons" is not over-trusted).
- **`coveragePct`** = `distinct compared leaf keys / declaredSurface × 100` — how much of the
  declared verification surface you actually exercised.
- Recording **never affects runtime**; metrics are in-memory and isolated from the app's
  `/metrics`.

### 2.2 `createRoundTripShadow(deps)` — the generic verifier

```js
const shadow = createRoundTripShadow({
  name: 'jobs-shadow',            // used in logs
  adapter,                        // { consumed(), record(item)->ref, readRef(ref)->view }
  legacy,                         // { list(): item[] }
  buildLegacyView: (item) => ({ /* expected comparable object */ }),
  itemKey: (item) => item.id,     // for mismatch labels: `${id}.${leaf}`
  countLabel: 'jobs',             // report count field name
  enabled: () => boolean,         // the SHADOW_<KERNEL> gate
  logger,                         // optional
});
await shadow.verify();
// → { enabled, [countLabel]:N, fields, matched, mismatched, mismatchKeys,
//     parityPct, confidenceLevel, coveragePct }   (or { parityPct:0, error } on failure)
shadow.stats();   // metrics snapshot
shadow.enabled(); // enabled() && adapter.consumed()
```

**Guarantees inherited for free** (G1.0 §1): `verify()` never throws to the caller, never
blocks beyond one awaited out-of-band pass, never mutates app/persistent state; when disabled
or the adapter isn't consuming, it performs **no** kernel interaction and short-circuits.

---

## 3. Responsibilities of each part (separation of concerns)

| Part | Owns | Must NOT |
|---|---|---|
| `legacySource.js` | the Source-of-Truth inventory (`list()`), reusing a shared inventory where one exists | touch the kernel; execute anything |
| `<kernel>/index.js` (adapter) | the ONLY kernel seam: pure translators + `record`/`readRef`; inert without a port | hold business logic, persistence, or authoritative behavior; execute/own timers; expose a `repo/db` surface |
| `<kernel>/shadow.js` | `buildLegacyView` + wiring to the generic verifier | re-implement the verify loop, metrics, or comparison |
| `_shadow/core.js` + `roundTripShadow.js` | comparison, metrics, generic verify | know anything kernel-specific |
| `src/enterprise/<kernel>Shadow.js` | flag selection (`select…Flags`) + `attach…Shadow` | compose the platform |
| `src/enterprise/index.js` | compose/gate: inject port only if `PLATFORM_<K>`, run verify only if `SHADOW_<K>`, return report | contain kernel logic |
| `src/hosted-service/onCallAppService.js` | allow a consumed adapter to remain **shadow-only** (`SHADOW_ONLY_ADAPTERS`) | make a kernel authoritative |

---

## 4. Cookbook — adding a new **round-trip** kernel

Assume kernel `Foo` (ADR-0XX). Ten steps, each a small, testable change.

1. **Adapter** `src/platform-adapters/foo/index.js`
   - Export `createFooAdapter({ port })` returning a frozen object with: `name:'foo'`,
     `kernel:'foo (ADR-0XX)'`, `consumed()`, pure translators (`toKernelSpec`,
     `fromKernelModel`, any `expected…`), and the round-trip contract:
     `async record(item) → ref` and `async readRef(ref) → view`.
   - Guard every active method with `requirePort('foo', port)` (inert ⇒ `AdapterNotWiredError`).
   - **Never** call any kernel method that executes/owns resources (e.g. `tick`/`start`). Carry
     lossless data on a serializable field (`payload`/`metadata`); verify identity + lifecycle
     natively to prove non-execution.
   - Avoid member names matching `/repo|db|sqlite|database/i` (use `readRef`, not `readBack`).

2. **Legacy source** `src/platform-adapters/foo/legacySource.js`
   - Export `createLegacyFooSource({ items } = {})` with `list()`, `get(id)`, `ids()`,
     `categories()`. Reuse an existing canonical inventory if the data already exists (as
     Scheduler reuses the Jobs timer inventory).

3. **Shadow** `src/platform-adapters/foo/shadow.js`
   ```js
   const { createRoundTripShadow } = require('../_shadow');
   function createFooShadow({ adapter, legacy, enabled, metrics, logger }) {
     const buildLegacyView = (item) => ({ descriptor: item, kernel: { /* expected native */ } });
     const rt = createRoundTripShadow({ name:'foo-shadow', adapter, legacy, buildLegacyView,
       itemKey:(i)=>i.id, countLabel:'foos', enabled, metrics, logger });
     return Object.freeze({ name:'foo-shadow', enabled: rt.enabled, legacyView: buildLegacyView,
       verify: rt.verify, stats: rt.stats, metrics: rt.metrics });
   }
   ```

4. **Export** from `src/platform-adapters/index.js` (`createLegacyFooSource`, `createFooShadow`).
   The aggregator already injects `ports.foo` into `createFooAdapter`.

5. **Enterprise wiring** `src/enterprise/fooShadow.js`: `selectFooFlags(env, opts)` (enforce
   `SHADOW_FOO ⊂ PLATFORM_FOO`) + `attachFooShadow({ adapters, shadowFoo, logger })`.

6. **Compose/gate** in `src/enterprise/index.js`: read flags; `if (platformFoo) ports.foo =
   runtime.platform().getKernel('foo')`; `attachFooShadow(...)`; after `host.start()` run
   `if (fooShadow && shadowFoo) fooParity = await fooShadow.verify()`; add `fooShadow/fooParity`
   and the two flags to the returned object; bump the `phase` label.

7. **Shadow-only allowance**: add `'foo'` to `SHADOW_ONLY_ADAPTERS` in `onCallAppService.js`.

8. **Flags** in `.env.example`: document `PLATFORM_FOO` / `SHADOW_FOO` (default `0`, both-off ≡
   previous phase).

9. **Tests** `tests/unit/foo-shadow.test.js` (adapter inert; translators; 100% parity +
   non-execution proof; disabled = no interaction; failure path; mismatch; flags; boot OFF ≡
   prev; boot both-ON; all-shadows-together) and `tests/integration/foo-shadow-ab.mjs`.

10. **Docs**: the six G1.0 documents (`00_…`–`05_…`) + `README.md` with the §0 compliance
    checklist filled.

**Verify:** `node --test --test-force-exit tests/unit/foo-shadow.test.js` and the full CI lint;
confirm parity/coverage 100% and the kernel proof (nothing executed/owned).

---

## 5. Cookbook — adding a new **read-through** kernel

For kernels queried on demand (config `get`, identity `verify`, policy `decide`): the adapter
exposes a read method; the shadow reads the legacy value **and** the kernel value, compares with
`deepEqual`, records via `createShadowMetrics`, and **returns the legacy value**. See
`configuration/shadow.js` (`shadowGet`/`verifyAll`) and `observability/shadow.js`
(`verify`/`shadowObserve`) as templates. The hard rules are identical (never throw/block/mutate;
legacy always returned; redact sensitive values; isolated metrics).

---

## 6. When to **extend** the framework vs. just **use** it

**Just use it (no framework change) — the common case:**
- The kernel fits an existing shape (round-trip or read-through). Provide the adapter, legacy
  source, and `buildLegacyView`/verify config. This is the default and should cover most
  kernels.

**Extend the framework — only when a genuinely new need appears:**
- A **new comparison pattern** not covered today, e.g.:
  - a generic **read-through** verifier (to remove the small per-kernel loops in
    Configuration/Observability) — a clean, additive candidate;
  - **streaming/event parity** (compare a sequence of events over time) — needs a new verifier;
  - a **new metric** required across all kernels — add it to `createShadowMetrics` once.
- A **new cross-cutting guarantee** (e.g. sampling, rate-limited comparison) that every shadow
  should inherit — implement it in `_shadow`, not per kernel.

**How to extend safely (governance):**
1. Add the capability to `_shadow/` (new file or an additive option), keeping existing exports
   backward-compatible.
2. Cover it with its own unit tests; keep every existing shadow green (the Jobs refactor onto
   `createRoundTripShadow` is the model — 14 tests unchanged).
3. Prefer **additive** changes (a new helper/option) over modifying a shared function's
   behavior. Per G1.0 §13: additive = MINOR + Owner approval; changing a shared contract that
   others depend on = MAJOR + ADR.
4. Update this overview's §2 surface table.

**Anti-patterns (do not do):**
- Copy `deepEqual`/metrics into a new kernel instead of importing `_shadow`.
- Put kernel-specific logic inside `_shadow`.
- Make the adapter do more than translate (no business logic, no persistence, no execution).
- Widen `createRoundTripShadow` with kernel-specific branches — configure it via
  `buildLegacyView` instead.

---

## 7. Quick reference

| Need | Reach for |
|---|---|
| Compare two values/objects | `deepEqual` (from `_shadow`) |
| Turn an object into comparable leaves | `flatten` |
| Redact a sensitive value in a record | `redactValue(key, value)` |
| Track parity + confidence + coverage | `createShadowMetrics(...)` |
| A store you feed & read back | `createRoundTripShadow(...)` + adapter `record`/`readRef` |
| A value compared on demand | small verify over `deepEqual`/`createShadowMetrics` (read-through) |
| Flags for a kernel | `select<Kernel>Flags` (SHADOW ⊂ PLATFORM), default OFF |
| Prove non-execution | assert kernel `running===0` + no `tick`/`start` called + statuses `scheduled/queued` |

*This document describes the framework as of Phase 17.6. Keep it in sync with
`src/platform-adapters/_shadow/` and the reference integrations.*
