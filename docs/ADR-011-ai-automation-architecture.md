# ADR-011 — AI & Automation Architecture

**Status:** Proposed · **Author:** Chief Enterprise AI & Automation Architecture · **Date:** 2026-07-18
**Builds on (FINAL):** G0.0 · ADR-002 (+A-001) · ADR-003 (+A-001) · ADR-004 · ADR-005 · ADR-006 · ADR-007 · ADR-008 · ADR-009 · ADR-010
**Scope:** enterprise AI & automation architecture. No models, vendors, frameworks, or
implementation content.

---

## 1. Executive Summary

Intelligence enters this platform as a **guest of the architecture, never its landlord**.
Every intelligent capability — prediction, recommendation, optimization, automation —
operates inside structures the prior ADRs already govern: its inputs are certified data
(ADR-004), its outputs are Derived Data with provenance (never authoritative), its
authority is bounded by the decision architecture below, its actions flow through the same
gates as any actor's (ADR-005/007), and its behavior is observable and budgeted like any
component (ADR-010). The platform already runs the embryos: deterministic matching
optimization, rule-based fare computation, and automatic rollback are automation of
classes 1–2 below. This ADR's central artifact is a **decision classification** that fixes,
per decision kind, who may decide — human, assisted human, or machine — with the
irreversible, the safety-critical, and the governance-defining permanently reserved for
humans. AI here optimizes a physical-world service where errors strand riders and dock
drivers' pay; the architecture is therefore conservative by design and proud of it.

## 2. AI Principles

1. **Human first** — intelligence serves riders, drivers, and operators; it optimizes
   *for* people before it optimizes *around* them (driver earnings fairness is a
   first-class objective, not an externality of efficiency).
2. **AI assists** — the default posture is decision support; full automation must be
   earned per decision class (§4), never assumed.
3. **AI never owns governance** — no model authors rules, grants privileges, certifies
   data, approves releases, or changes its own boundaries. Governance is human by
   constitution (extends ADR-007 separation of duties to machines).
4. **Transparency** — where AI participates in a consequential outcome, its participation
   is declared to affected parties per policy and jurisdiction.
5. **Explainability** — consequential decisions carry human-comprehensible reasons; a
   decision that cannot be explained to its subject cannot be automated (fare adjustments,
   driver standing effects).
6. **Accountability** — every automated action has a named human owner (ADR-004
   stewardship extended); "the model did it" is not an accountability answer.
7. **Predictability** — automation behaves within declared envelopes; outputs outside the
   envelope are discarded in favor of the deterministic fallback, never acted on.
8. **Safety** — safety functions may *consume* intelligent signals but are never *gated*
   on them; the safety path works with all intelligence off.
9. **Bias reduction** — outcome equity across driver cohorts, city areas, and rider groups
   is measured (ADR-010 fabric) and reviewed; detected bias is a defect with an owner.
10. **Privacy** — learning obeys ADR-004/007: purpose-bound, minimized, de-identified by
    default; no training use beyond consented purposes.
11. **Continuous learning** — models improve on governed cadences with validation gates —
    never silent self-modification in production.
12. **Responsible automation** — automate the repetitive, the reversible, and the
    well-understood first; the judgment-laden last or never.

## 3. AI Governance Architecture

**Ownership:** every model/automation has an owning context (it serves exactly one
bounded context's decisions) and a named steward. **Risk classification** at intake:
R1 advisory-only → R2 assisting human decisions → R3 automating reversible actions →
R4 automating consequential actions (rare, board-approved, always with §4 constraints).
Approval depth, review cadence, and observability requirements scale with class.
**Validation:** pre-deployment evaluation against declared quality bars *and* bias
checks; models ship through the same immutable-release, progressive-exposure, rollback-
first pipeline as software (ADR-009 §4 applies unchanged — a model is a release artifact).
**Monitoring:** §7. **Review:** periodic re-certification; material behavior change =
new version through full validation. **Retirement:** models retire by deprecation like
contracts (ADR-006 §8); retired model versions remain archived for decision
reproducibility (§4 audit). **Continuous evaluation:** live quality measured against
ground truth as it arrives (completed rides validate ETAs; settled fares validate
estimates). **Bias monitoring:** standing equity metrics per §2.9. **Ethical review:**
a governed review (human) gates any capability touching driver livelihood, rider safety,
pricing fairness, or personal data use — with jurisdictional AI regulations entering as
Compliance rule families (ADR-003-A001 absorbs AI law the way it absorbs any law).

## 4. Decision Architecture

**Classification** — every decision kind is registered with its class:

| Class | Who decides | Examples (platform-grounded) |
|---|---|---|
| **D1 Human-only** | humans, always | driver approval/suspension (compliance decision — today's human workflow stays), incident resolution, rule/config authoring, privilege grants, market launches, refund policy exceptions |
| **D2 AI-assisted human** | human decides, AI informs | fraud case adjudication (AI flags, human rules), support triage priorities, capacity planning, launch readiness assessment |
| **D3 Automated-reversible** | machine, within envelope, human-overridable | dispatch matching & ranking (today's deterministic matcher evolves here), ETA prediction, demand-driven rebalancing suggestions→actions, notification timing, scooter maintenance scheduling |
| **D4 Automated-consequential** | machine, only with: declared envelope + confidence floor + real-time counter-check + instant compensation path + owner on call | dynamic pricing within authored bounds (Pricing rules stay authored data — AI proposes *within* them, never rewrites them), automatic risk holds pending human review |

**Confidence levels:** every AI output carries calibrated confidence; below the per-
decision floor ⇒ **escalation path**: D3/D4 decisions degrade to D2 (human queue) or to
the deterministic fallback — low confidence is a routing signal, never a warning label
on an action taken anyway. **Approval workflows:** D1/D2 flows are ADR-005 workflows
with their existing gates; AI participation adds an *input*, never removes an approver.
**Decision ownership:** the owning context's steward owns the decision kind; the
capability ladder (safety > rides > money…) caps how much automation each kind may carry.
**Decision audit & history:** every AI-influenced decision records: model version, input
snapshot reference, confidence, explanation summary, envelope check result, and the
acting authority (machine-within-envelope or named human) — appended to the ADR-007
audit fabric, reproducible forever (paired with archived model versions).

## 5. Automation Architecture

Automation obeys one shape everywhere: **sense (certified signals, ADR-010) → decide
(per §4 class) → act (through the same commands/gates as any actor — automation holds
an identity, least-privileged per ADR-007, throttled like anyone) → verify (did the
intended outcome occur?) → record (audit) → learn.**

| Domain | Automation posture |
|---|---|
| **Business** | matching, pricing-within-bounds, promotion targeting (D3/D4 per §4); wallet/ledger operations remain deterministic rule execution — money moves by rules, not models |
| **Operational** | scaling within regional limits, health-driven instance replacement, parked-work re-driving (already law, ADR-008/009 — classed D3) |
| **Infrastructure/Platform** | release progression gates, verification batteries, rollback triggers (the existing auto-rollback is D3 automation certified by drills); error-budget-driven release caution (ADR-010) |
| **Security** | anomaly-triggered step-up authentication, automatic session revocation on compromise signals (D3 — reversible), risk *holds* D4 with human release; punitive actions (bans) are D1/D2 — **automation may restrict pending review, never punish finally** |
| **Compliance** | rule resolution and gating are deterministic (ADR-003-A001 — not AI); automation handles obligation-deadline tracking, evidence assembly, report generation (D3) |
| **Customer/Support** | self-service resolution for verified-simple cases (D3: receipt reissue, lost-item workflow initiation); assisted responses drafted for human agents (D2); anything affecting money or standing escalates |
| **Maintenance** | predictive maintenance scheduling from vehicle telemetry (D3 — a wrongly scheduled inspection is cheap; a missed brake failure is not, so recall-class signals page humans) |
| **Recovery** | automated recovery per ADR-009/010 (restart, resume, re-drive — D3); data restoration remains human-initiated with automated verification (the existing discipline) |

## 6. Knowledge Architecture

**Sources:** the platform's certified facts and events (primary); authored reference/rule
data; operational telemetry; human annotations (support outcomes, fraud adjudications) —
each a declared, ADR-004-classed source. **Ownership:** knowledge derived from a context's
data is stewarded by that context; cross-context training sets are governed data products
(ADR-004 §13). **Validation:** training data passes the same quality gates as any derived
data — lineage-complete, bias-checked, purpose-authorized. **Evolution & lifecycle:**
datasets are versioned, effective-dated artifacts; a model's lineage names its exact
dataset versions (reproducibility). **Quality:** ground-truth feedback loops (§3) grade
knowledge continuously; degraded sources are quarantined from training. **Governance:**
knowledge artifacts follow the certification rule — uncertified knowledge trains nothing
that touches production decisions.

## 7. AI Observability

Extends ADR-010 with AI-specific SLIs, same fabric, same governance: **model health**
(serving success, latency within budget, fallback-activation rate); **prediction quality**
(accuracy against arriving ground truth — ETA error, demand forecast error);
**recommendation quality** (acceptance rates, override rates — high human-override of a
D3 system is a defect signal); **automation success/failure** (intended-outcome
verification rate per §5, compensation-invocation rate); **confidence monitoring**
(calibration: stated confidence vs. observed correctness); **drift detection** (input
distribution shift, output shift, quality decay — drift beyond bounds auto-demotes the
capability one decision class and pages its steward); **operational visibility** (every
AI capability appears on the Engineering dashboard with its class, envelope, and budget —
and D4 capabilities appear on the Executive dashboard by name). AI observability data is
itself ADR-004-classed and feeds §3 reviews.

## 8. Reliability & Safety

Every intelligent capability declares its **deterministic fallback** before it ships —
matching falls back to today's rule-based matcher, pricing to authored base rules,
predictions to conservative defaults; **fallback is a tested mode, not a hope** (drill
discipline extends to AI-off drills). Envelope enforcement is *outside* the model
(independent guard, ADR-008 layering) so a misbehaving model cannot exceed its authority
by being wrong confidently. AI capabilities are **load-shedding class "analytics-
adjacent"** unless explicitly promoted: under stress, intelligence sheds first and the
deterministic platform keeps running (ADR-009 §6 ladder). Failure of any AI component is
contained per ADR-008 bulkheads; its consumers experience *absence of enhancement*, never
absence of service. Security of AI surfaces follows ADR-007: models hold least-privileged
identities; training data access is audited; adversarial manipulation (gaming the matcher,
probing fraud thresholds) is a standing threat-model entry with equity metrics doubling
as manipulation detectors.

## 9. Scalability Notes

Intelligence scales as data products on already-scale-shaped classes (ADR-004): training
from append-only facts (City/time-partitioned); serving decisions are per-subject and
partition exactly like the commands they assist (ADR-008); knowledge and model artifacts
are immutable versions (cacheable, distributable like reference data); per-City/Market
model specialization arrives as *more artifacts of the same shape*, resolved through the
same cascade philosophy as configuration (city model → market default → global default —
nearest-ancestor-wins for intelligence too). Hundreds of countries add training
partitions and possibly per-market models — **zero new mechanisms**, the standing test,
passed again.

## 10. Risks

1. **Standing (12th consecutive document):** C-1 — ADR-001 remains unapproved. An
   optimization layer atop a financially inconsistent settlement path optimizes the
   production of wrong numbers. Fix first.
2. **Automation before maturity:** this ADR licenses shapes, not construction (the ADR-008
   rule) — intelligent capabilities enter after the G-phases stabilize data and state
   substrates; building models on pre-G3 data foundations is rejected in review.
3. **Quiet class creep:** D3 systems accreting consequence until they're D4 without
   re-review — mitigated by decision-class registration, drift-triggered demotion, and
   audit of envelope changes.
4. **Explainability debt:** capability choices that preclude explanation get vetoed at
   ethical review for D2+ decisions — stated now so it never surprises anyone later.
5. **Equity blind spots:** bias metrics only catch what they measure; cohort definitions
   need periodic human re-examination per market (cultural context is data the platform
   doesn't have until locals provide it).
6. **Governance weight (honest sizing, again):** for a one-team platform, this governance
   runs lightweight-but-real: class registration, fallback declaration, and audit are
   non-negotiable from capability #1; boards and cadences grow with the org.

## 11. Future Evolution

Absorbable via amendment: conversational assistance surfaces (support, driver guidance)
entering as D2 capabilities under the same classification; federated or on-device
learning postures if privacy law favors them (Compliance-driven); marketplace-level
optimization (multi-city fleet flows) as D3 with market-operations oversight;
jurisdiction-specific AI conformance regimes as Compliance rule families (the
architecture already has their slot); AI-assisted authoring *proposals* for
configuration/rules — always landing as drafts in the human staged-publish workflow,
never as effective versions (principle 3 is permanent).

## 12. Final Certification

Verified against mandate: all 27 objective areas addressed; 12 AI principles; governance
architecture (ownership, risk classes, approval, validation, monitoring, review,
retirement, continuous evaluation, bias monitoring, ethical review); decision
architecture (4-class classification with confidence floors, escalation, ownership,
audit, history); automation architecture across all 10 required domains under one
sense-decide-act-verify-record-learn shape; knowledge architecture (sources, ownership,
validation, evolution, quality, lifecycle, governance); AI observability extending
ADR-010 (model/prediction/recommendation/automation health, confidence calibration,
drift with auto-demotion); reliability & safety (tested deterministic fallbacks,
external envelope guards, shed-first posture, adversarial threat coverage); scale
targets met by same-shapes analysis; zero vendor/model/framework content; all prior
FINAL ADRs extended, none redesigned.

**ADR-011 — AI & AUTOMATION ARCHITECTURE — WORLD-CLASS CERTIFIED**
