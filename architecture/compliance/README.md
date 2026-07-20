# Architecture Governance Layer

**Phase 3.5** · The permanent engineering authority of this repository (ADR-012, ADR-015).
It makes conformance to the Enterprise Architecture Corpus **measurable, traceable, auditable,
and enforceable** — before any further bounded-context migration.

## Contents

| File | Purpose |
|---|---|
| `verify-architecture.mjs` | **Executable** verifier — 8 automatable rules over the enterprise layers; exits non-zero on CRITICAL. Run in CI. |
| `RULES.md` | The rule registry (R1–R15): description, verification method, severity, ADR reference. |
| `MATRIX.md` | Traceability matrix — 11 bounded contexts × 14 ADRs, every cell defined. |
| `EVIDENCE.md` | Maps every ADR requirement to source, phase, tests, reports, and proof. |
| `ADR-002.md … ADR-015.md` | One compliance document per ADR (purpose, scope, status, components, remaining, evidence, source, tests, %, risks, actions). |
| `VERIFICATION-REPORT.md` | The executed compliance report across all 14 ADRs. |
| `REPOSITORY-READINESS.md` | Readiness verdict + recommended next phase. |

## Run the verifier

```
node architecture/compliance/verify-architecture.mjs          # human report (exit 1 on CRITICAL)
node architecture/compliance/verify-architecture.mjs --json   # machine-readable
```

## Rule of the layer

> No implementation may violate the corpus. The ADRs are authority; these documents govern
> conformance to them and are never a substitute for them. Do not edit the ADRs here.

This layer is additive: it changed no `src/` runtime code and regressed no test.
