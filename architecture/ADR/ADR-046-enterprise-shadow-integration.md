# ADR-046 — Enterprise Shadow Integration

- **Status:** Accepted
- **Date:** 2026-07-21
- **Deciders:** Principal Engineering
- **Supersedes:** —
- **Related:** ADR-042 (Platform Composition Root), ADR-043 (Bootstrap Runtime), ADR-044 (Host
  Runtime), ADR-019/020/032/033 (the kernels integrated so far),
  `architecture/G1.0/G1.0_ENTERPRISE_SHADOW_INTEGRATION_STANDARD.md`

---

## Context

Phases 17.2–17.6 introduced a repeatable way to adopt Enterprise Kernels (ADR-016…045) into the
OnCall backend **without changing behavior**: run each kernel in *Shadow Mode* beside the legacy
system, compare (parity), and always return the legacy result. The rules for this were codified
in the **G1.0 — Enterprise Shadow Integration Standard**. G1.0's own header names **ADR-046** as
its ratifying decision, but that ADR had not yet been written, leaving the standard formally
un-ratified (gap **A3** in the Project Gap Report).

Shadow Mode is a genuinely new architectural decision not covered by any existing ADR: existing
ADRs describe the kernels and the composition/runtime/host layers, but none establishes the
*integration discipline* (shadow, feature flags, parity, rollback, A/B) that governs how the
application adopts a kernel.

## Decision

We **ratify G1.0 as the governing standard for every Enterprise Kernel integration**, and record
the following as an architectural decision of record:

1. **Shadow-first adoption.** A kernel is integrated in Shadow Mode before it can ever become
   authoritative. In Shadow Mode the legacy system is authoritative; the kernel is read-only,
   non-authoritative, and never changes runtime behavior.
2. **Adapter Layer is the only seam.** `src/platform-adapters/` is the sole boundary permitted
   to touch a kernel. No application module imports a kernel. Adapters are stateless,
   deterministic translation-only.
3. **Two feature flags per kernel.** `PLATFORM_<KERNEL>` (compose/inject) and
   `SHADOW_<KERNEL>` (compare), both default OFF, with `SHADOW ⊂ PLATFORM`. With all flags OFF,
   the boot is byte-identical to the previous phase.
4. **Parity + confidence + coverage.** Every integration verifies parity field-by-field and
   reports `parityPct`, `confidenceLevel`, and `coveragePct` from the shared shadow metrics
   (`src/platform-adapters/_shadow/`).
5. **Rollback by flags only** and an A/B byte-identity gate (`tests/integration/*-ab.mjs` +
   `npm run verify:shadow`).
6. **Promotion is gated (see ADR-047).** No kernel advances past *Verified* toward
   *Authoritative* until its ownership preconditions are cleared.
7. **Governance.** Changes to the standard follow G1.0 §13 (editorial → PR; additive normative →
   PR + Owner; breaking normative / invariant change → ADR + MAJOR version).

## Consequences

**Positive**
- One consistent, reversible, low-risk path for adopting the remaining kernels.
- The legacy platform stays authoritative; zero client-visible risk during adoption.
- Compliance is mechanically enforceable (lint, adapter-surface guard, `verify:shadow`, A/B,
  and the architecture-compliance gate in CI).

**Negative / accepted trade-offs**
- Shadow work adds composed-but-inert kernels and out-of-band comparison passes at boot (one-time
  cost, memory-only).
- Real *migration* (a kernel owning behavior/data) is deferred and separately gated (ADR-047),
  so shadow phases deliver verification value, not yet functional migration.

## Compliance

Enforced in CI (`.github/workflows/ci.yml`): architecture-compliance gate, ESLint + Prettier,
unit tests, `verify:shadow` (parity), and `test:ab` (byte-identity). The shipped shadows
(Configuration, Observability, Jobs, Scheduler) conform; future kernels MUST follow G1.0 §8's
document set and §0 checklist.
