# Enterprise Architecture Migration — Phase 10 Record (AI / Automation Cutover)

**Pattern:** Strangler Fig (ownership establishment) · **Authority:** G0.0 · ADR-002…015 (esp. ADR-011)
**Date:** 2026-07-20 · **Status:** Context established and A/B-proven **zero-drift** (16/16). Registration reversible via `AI_LEGACY=1`.

---

## 1. Migration Report (summary)

The **AI / Automation bounded context** is established as the platform's ADR-005 owner of its
intelligence surface. Per the mission's explicit provision — *"if no production AI runtime exists
today, establish the AI bounded context as the official architectural owner of the existing AI
integrations and infrastructure without changing runtime behavior"* — this phase is an **ownership
establishment**, not an endpoint cutover.

**What already exists (and is now owned).** A full-repository audit found **no LLM/model/vendor
runtime, no prompt store, no inference routing, and no AI HTTP endpoint** anywhere under `src/`
(the only AI-adjacent artifact, `tools/oncall-mcp`, is external operator tooling, not an in-app
capability). What the platform *does* run — and what ADR-011 §1 explicitly names as automation
"embryos" of classes 1–2 — are three **deterministic automations**: dispatch matching
(`driverMatcher`), rule-based fare computation (`fareCalculator`), and auto-rollback. Phase 10 gives
these a formal architectural home: the AI/Automation context **classifies** them under the ADR-011
§4 decision taxonomy (all **D3** — automated-reversible, each with a mandatory deterministic
fallback) and encodes ADR-011's participation rules as pure Domain policies.

**Behavior is unchanged — provably.** The context is **dormant by design**: it composes at boot,
asserts its ports, and is exposed on the DI container (`services.ai`) as forward-provisioning, but
it **mounts no HTTP route and calls no inference provider** (none is configured — ADR-011 §8: the
deterministic fallback is the tested default). The provider adapter honestly reports the disabled
posture, so every routed decision resolves to its deterministic fallback and inference is never
invoked. The compatibility proof is therefore a **zero-drift** A/B: the platform is byte-identical
whether the context is registered (default) or not (`AI_LEGACY=1`).

**Scope honored:** no autonomous agents, no new LLM feature, no new business workflow, no new
user-facing endpoint. **Wallet and Payments remain untouched, pending ADR-001** (ADR-011 §10 risk
C-1: intelligence atop an unratified settlement path optimizes the production of wrong numbers).

## 2. Files Created (9)

**Domain (pure):** `src/domain/ai/aiValues.js` · `aiPolicies.js` · `AI.js`
**Application:** `src/application/ai/ports.js` · `commands.js` · `useCases.js` · `index.js`
**Infrastructure:** `src/infrastructure/ai/aiProviderAdapter.js` · `aiGateways.js`
**Tests:** `tests/unit/ai.test.js` · `tests/integration/ai-ab.mjs`

*(Domain/Application/Infra = 9 source files; plus 2 test files. The Phase-1 scaffolding dirs
`src/application/ai` and `src/infrastructure/ai` are now populated.)*

## 3. Files Modified (1)

`server.js` — a single guarded, dormant registration block (after `setupSocket`): the AI context is
composed and attached to `services.ai`; `AI_LEGACY=1` skips it entirely. No route is mounted; no
other runtime code changed.

## 4. Mounted Components (carrying traffic)

**None by HTTP** — intentionally. The composed context (`services.ai` → `src/application/ai/*` →
`src/domain/ai/*` → ports → `aiProviderAdapter` [disabled] + `aiGateways` [prompt=null,
config=env, audit→existing `logger`]) is registered but dormant. It carries no request traffic; it
is the official owner and a forward-provisioned capability for future, separately-governed consumers.

## 5. Legacy Components Remaining

**None to retire.** There was no prior AI implementation to strangle — the deterministic automations
(`driverMatcher`, `fareCalculator`, auto-rollback) remain **exactly as-is** in their owning contexts
and are now *classified/owned* by the AI context, not moved or rewritten (ADR-011 §8: matching's
deterministic matcher *is* its declared fallback). `AI_LEGACY=1` is the immediate rollback of the
context registration itself.

## 6. Security Report (ADR-007 + ADR-011)

| Control | Status | Evidence |
|---|---|---|
| JWT authentication | ✅ unchanged | no AI endpoint added; every existing gate intact (zero-drift A/B) |
| Authorization / RBAC | ✅ unchanged | A/B `admin:stats:noauth → 401`, `admin:stats:passenger → 403` identical in both arms |
| AI never owns governance | ✅ enforced | `aiSafetyPolicy` forbids automating D1 (human-only) decisions (unit) |
| Safety not gated on AI | ✅ enforced | provider disabled ⇒ all decisions resolve to deterministic fallback; "intelligence off" path proven (unit) |
| Prompt validation | ✅ present | `promptValidationPolicy` (non-empty, length envelope) — dormant, no prompt runtime today |
| Audit logging | ✅ reused | `aiAuditRepository` appends AI-decision records to the existing `logger` fabric (ADR-011 §4) |
| Rate limiting | ✅ unchanged | global limiter untouched |
| No security regression | ✅ | 16/16 zero-drift A/B + full regression suite unchanged |

## 7. Architecture Compliance Report

Verifier: **PASS, 0 violations**, now scanning **93 enterprise-layer files** across ten contexts
(domain ~26 · application 37 · infrastructure 24 · presentation 16). Rules R1–R7 green: Domain pure
(no SDK/HTTP/framework), no SQL outside Infra, Application downward-only, ports asserted, no cycles.
The CI Architecture Gate enforces this on every PR/push.

## 8. ADR Compliance Addendum

- **ADR-011 (AI & Automation):** decision classification (§4, D1–D4), deterministic fallback (§8),
  safety-not-gated-on-AI (§2.8), AI-never-owns-governance (§2.3), audit fabric (§4) — all encoded as
  pure Domain policies + registry. Existing automations classified (matching/fare/rollback = D3).
  → **Impl** (owner established; provider runtime deferred by design).
- **ADR-002:** Capability aggregate + AIRequest/AIResponse/Prompt/Provider VOs + 5 policies (pure). → **Impl**
- **ADR-003:** no AI strings surfaced; Arabic-default/English-additive discipline unchanged (A/B
  `user:missing:ar` / `user:missing:en` identical in both arms). → **Impl**
- **ADR-004:** audit records routed to the existing logger fabric; no new store/schema. → **Part**
- **ADR-005:** four layers, ports/fail-fast composition, gates before domain. → **Impl**
- **ADR-006:** no contract added or changed; full surface byte-identical. → **Part**
- **ADR-007:** §6 above. → **Impl**
- **ADR-008:** layout + DI composition root; envelope guard sits outside any model. → **Impl**
- **ADR-009/010:** unchanged; audit feeds the existing observability fabric. → **Part**
- **ADR-012/013/014/015:** governance synced; roadmap advanced; manifesto upheld. → **Impl**

## 9. Updated Traceability Matrix

`architecture/compliance/MATRIX.md` — AI row upgraded from all-`Plan` to `Impl` for
ADR-002/003/005/007/008 **and ADR-011** (the AI row's 011 cell moves `Plan → Impl`). Fully
ADR-005-compliant contexts now **10/11**.

## 10. Updated Evidence Mapping

`architecture/compliance/EVIDENCE.md` — AI rows added (ADR-011/002/005/007) pointing at the new
sources, `tests/unit/ai.test.js`, and `tests/integration/ai-ab.mjs` (16/16 zero-drift).

## 11. Updated Repository Readiness Report

`architecture/compliance/REPOSITORY-READINESS.md` — AI context established; the only remaining
legacy contexts are **Wallet** and **Payments**, both **gated on ADR-001** (Commerce).

## 12. Test Results (executed)

- **Unit:** 165/165 pass (added the 13-case AI slice; coverage increased).
- **A/B compatibility:** AI **16/16 byte-identical (zero drift)** — the platform behaves identically
  with the AI context registered vs `AI_LEGACY=1`, across health, identity, fleet, trips, admin
  auth/RBAC, notifications, and Arabic/English localization.
- **Regression (no existing test failed):** Identity 35 · Users 17 · Drivers 14 · Scooters 24 ·
  Trips 31 · Notifications 21 · Admin 43 · Fleet 14 — all still byte-identical (215 A/B scenarios total).
- **Architecture:** verifier PASS (93 files). **Lint + Format:** clean (whole tree).
- **Security:** the decisive invariants (provider never invoked; all decisions fall back; D1 cannot
  be automated) are locked by unit tests over pure fakes.

## 13. Rollback Procedure

`AI_LEGACY=1` + restart → the AI context is not composed (`services.ai` absent). Because it mounts
nothing and is consumed by nothing, this is a **true no-op rollback** — proven by the 16/16
zero-drift A/B (the harness's "legacy" arm *is* `AI_LEGACY=1`). Full code rollback: revert the one
`server.js` block. No data migration; no schema touched.

## 14. Technical Debt

1. The context is dormant (no consumer). When a governed model provider is approved, wiring
   `aiProviderAdapter` to it + a real `promptRepository`/config source is a future capability under
   ADR-011 §3 intake — not this phase.
2. The deterministic automations (`driverMatcher`, `fareCalculator`, auto-rollback) are *classified*
   but still *physically* live in their contexts; routing them through the AI context's
   `decide`/audit path (so every automated decision emits an ADR-011 §4 audit record) is a
   behavior-preserving follow-up deferred to avoid touching working lifecycle code.
3. `aiAuditRepository` writes to the general logger; a dedicated, ADR-004-classed AI decision-audit
   store arrives with the observability/Postgres cutover.

## 15. Architecture Drift Report

**Zero drift** — in the strongest sense: mechanically proven that registering the entire AI context
changes no byte of the existing surface (16/16), verifier green at 93 files, CI gate active. The
platform's intelligence surface now has a single, pure, ADR-011-faithful owner with the envelope
guard *outside* any model (ADR-008 layering), exactly as the ADR mandates — and it cannot exceed its
authority by being confidently wrong, because it invokes nothing.

## 16. ADR Coverage Delta (this phase)

| ADR | Before (AI) | After (AI) |
|---|---|---|
| 002 Domain | Plan | **Impl** |
| 003 Global | Plan | **Impl** |
| 005 App | Plan | **Impl** |
| 007 Sec | Plan | **Impl** |
| 008 Tech | Plan | **Impl** |
| 011 AI | Plan | **Impl** |
| 013/014/015 | Plan/Part | **Impl** |

Platform: fully ADR-005-compliant contexts **9 → 10 / 11**.

## 17. Commerce (Wallet / Payments) Readiness Assessment

**BLOCKED — by governance, not by engineering.** Nine bounded contexts (Identity, Users, Drivers,
Scooters, Notifications, Trips, Admin, Fleet, AI) are migrated, byte-compatible, verifier-clean,
CI-gated, and instantly reversible; the migration machinery (layering, ports, A/B harness, verifier,
governance artifacts) is proven ten times over. The **only** remaining contexts are **Wallet** and
**Payments**, and they are **gated on ADR-001 (Commerce), which remains unratified** — the standing
C-1 risk cited unchanged across ADR-005…011.

Readiness posture:
- **Architecturally ready:** the pattern is proven; Wallet/Payments have been deliberately *reused,
  never migrated*, in every prior phase (Trips settled payment inside the C-1 serialized transaction
  via a reused gateway) precisely to keep the ADR-001 gate intact.
- **Governance-blocked:** money must move by ratified rules, not by an unratified settlement model
  (ADR-011 §5/§10). Migrating Wallet/Payments before ADR-001 would encode a contested financial
  contract into the enterprise architecture — the one thing every ADR forbids.
- **Recommended action:** **ratify ADR-001 first.** Only then open Phase 11 (Commerce) under an
  approved bounded-context mandate + A/B plan, migrating Wallet and Payments together with the
  settlement invariants frozen. Until ratification, the correct state is exactly today's: reused,
  contract-frozen, untouched.

---

*Migration executed under the Strangler Fig pattern (ownership-establishment variant). Every PASS is
backed by an executed test or a mechanical check. No runtime behavior changed; no AI capability
introduced; no endpoint added; the existing deterministic automations preserved and now formally
owned; Wallet and Payments untouched pending ADR-001.*
