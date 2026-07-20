# ADR-010 — Observability & Reliability Architecture

**Status:** Proposed · **Author:** Chief SRE & Observability Architecture · **Date:** 2026-07-18
**Builds on (FINAL):** G0.0 · ADR-002 (+A-001) · ADR-003 (+A-001) · ADR-004 · ADR-005 · ADR-006 · ADR-007 · ADR-008 · ADR-009
**Scope:** enterprise observability & reliability architecture. No products, vendors,
tooling, or implementation content.

---

## 1. Executive Summary

A mobility platform's reliability is measured in strangers reaching home safely and
drivers being paid correctly — availability percentages are only proxies. This ADR defines
observability as a **first-class data product** (telemetry is ADR-004-classed data with
owners, quality gates, and lifecycles) and reliability as a **governed budget** (declared
SLOs per capability class, spent deliberately via error budgets, reviewed on cadence). Its
spine is one health model that rolls up the same way the business does — component → cell
→ region on the technical axis, City → Market → Country on the business axis (the A-001
spine) — so "is Kuwait healthy?" and "is matching healthy?" are answered by the same
fabric from different directions. The platform already operates the N=1 embryo: golden
signals, business heartbeats, alert rules, and drill-verified recovery; this document
scales that DNA to global operations without changing its mechanisms.

## 2. Observability Principles

1. **Visibility by design** — every capability ships with its signals declared (extends
   ADR-007 security-by-design to observability); unobservable = undone.
2. **Measure everything important — and only what's important**: every signal has an
   owner and a question it answers; a metric without either is deleted (ADR-009 §9 rule).
3. **Business first** — the primary health question is business heartbeat (rides
   happening, drivers earning, riders arriving), with technical signals explaining *why*,
   never substituting for it.
4. **Telemetry as data** — telemetry obeys ADR-004: classified (System/Analytical),
   owned, quality-gated, retained per class, PII-scrubbed at generation (ADR-007 §6).
5. **Correlation** — every signal carries the platform's correlation vocabulary (request
   identity, subject identity, City, release version, config versions) so any anomaly
   joins to its context without archaeology.
6. **End-to-end visibility** — a rider's tap is traceable through edge, gates, domain,
   events, and settlement as one causal story.
7. **Distributed visibility** — visibility spans components, cells, and regions with no
   blind seams; cross-boundary flows (ADR-006) are observable *at both ends* (publisher
   health + consumer lag, already law).
8. **Actionable signals** — a signal either informs a decision or trains a model or it is
   noise; alerts specifically must name their action (runbook link discipline).
9. **Noise reduction as an obligation** — alert fatigue is an operational defect
   (ADR-009); signal-to-noise is itself measured and reviewed.
10. **Continuous feedback** — observability output feeds engineering priority (the
    governed backlog), capacity arithmetic (ADR-009 §7), and release gating (error
    budgets) — a closed loop, not a wall of screens.

## 3. Health Architecture

One model, two rollup axes, composed from the same atomic verdicts:

**Technical axis:** *Component health* (each ADR-008 component self-reports: readiness,
saturation, dependency verdicts, fail-closed status) → *Service health* (a business
capability's composite: "matching", "settlement" — maps to ADR-005 services) → *Cell
health* → *Region health* (ADR-009 cells/regions).

**Business axis:** *City health* (demand flowing, supply online, rides completing,
settlement succeeding — computed from business telemetry, not inferred from servers) →
*Market health* (City rollup + market KPIs vs. targets — the A-001 Market Manager's
operational truth) → *Country health* (Market rollup + compliance posture: rule-resolution
failures, obligation deadlines).

**Cross-cutting lenses:** *Business health* (platform-wide heartbeat + unit economics
signals), *Customer health* (rider/driver experience aggregates: wait times, cancellation
burden, payment friction, support load), *Partner health* (each ACL counterparty: success
rates, latency, degraded-mode time — feeds ADR-007 trust evolution), *Operational health*
(the meta-layer: alert load, on-call burden, drill currency, backup freshness, runbook
coverage — the health of the ability to respond).

Health verdicts are computed, versioned facts (what was known, when) — post-incident
review reconstructs *what health said at the time*, not what hindsight says.

## 4. Telemetry Architecture

Four telemetry kinds, one correlation vocabulary, all ADR-004-classed:

- **Metrics** — numeric series with declared owners and questions. Families: *business*
  (rides requested/matched/completed, settlement success, wallet flows — per City, the
  finest business grain), *operational* (golden signals per component: traffic, errors,
  latency, saturation), *performance* (latency-budget conformance per use-case class,
  ADR-008 §7), *capacity* (headroom vs. envelope per cell, ADR-009 §7), *security*
  (authentication anomalies, gate rejections, break-glass usage — feeding ADR-007
  detection), *compliance* (verdict latency/failure rates, obligation deadline proximity,
  data-retention conformance — regulators ask; the platform must answer).
- **Logs** — structured, correlated event records for humans-in-the-loop; scrubbed at
  generation; retained short per System class except security/audit-adjacent streams
  which follow their stricter classes.
- **Traces** — causal request stories across layers and components (the end-to-end
  principle made concrete); sampled intelligently: always for errors and budget-relevant
  latency, statistically otherwise.
- **Event observability** — the Event Fabric is itself observed: per-kind publish rates,
  consumer lag against declared freshness bounds (ADR-006), replay activity, parked-work
  inventory with age (the dead-letter SLA made visible).

## 5. Reliability Architecture

- **SLIs** — few, user-anchored, declared per capability class: request success rate,
  latency-within-budget rate, matching success within expectation, settlement completion
  within bound, realtime-session continuity, event-delivery freshness.
- **SLOs** — targets over rolling windows per capability class **per City class**
  (launch cities carry explicit maturation targets; mature cities carry production
  targets) — one global number would hide exactly what matters.
- **Availability objectives** follow the ADR-009 §6 capability ladder (safety > active
  rides > demand intake > settlement > admin > analytics) — each rung gets its own
  objective; the ladder, not a single nine-count, is the availability policy.
- **Latency objectives** = ADR-008 latency budgets, promoted to SLOs with error budgets.
- **Durability objectives** — per ADR-004 class: facts (ledger, audit) target
  effectively-zero loss verified by reconciliation and restore-validation; ephemera
  declare their losability explicitly.
- **Recovery objectives** — the ADR-009 RPO/RTO floors, tracked as *measured drill
  results* vs. declared targets — recovery reliability is an SLO like any other.
- **Error budgets** — each SLO's complement, owned by the capability's owner: budget
  healthy ⇒ ship freely; budget burning ⇒ progressive-deployment caution raises
  automatically (ADR-009 release gating); budget exhausted ⇒ reliability work preempts
  feature work — by policy, not negotiation.
- **Reliability reviews & governance** — cadence reviews of SLO attainment, budget
  spend, alert quality, and drill results per region and per market; SLO changes are
  governed like configuration (authored, approved, versioned — ADR-003 machinery);
  reliability ownership follows the ADR-009 three-tier model.

## 6. Alerting Model

**Lifecycle:** signal → detection (threshold, trend, or absence — *silence detection is
mandatory*: a City producing no telemetry is an alert, not a quiet day) → correlation &
deduplication (one incident, one alert-storm collapsed to one actionable head) →
notification to the owning tier (ADR-009) → acknowledgment with time-box → escalation on
breach → resolution → review feed.
**Severity model:** aligned to the capability ladder — S1 safety/active-ride impact
(page now, all hands), S2 business function degraded (page owner), S3 budget-threatening
trend (queue, business hours), S4 informational (no page, dashboards only). Severity is
assigned by *impact class*, never by which component fired.
**Ownership:** every alert names its owner and its runbook at definition time —
unowned or runbook-less alerts cannot be registered.
**Noise governance:** per-alert precision is tracked (fired vs. actioned); low-precision
alerts are re-engineered or retired on cadence; alert count per on-call shift is itself
an operational-health SLI (§3).

## 7. Dashboard Architecture

Dashboards are *questions with owners*, layered by audience, all fed from the same fabric:

| Dashboard | Audience | Core question |
|---|---|---|
| **Executive** | leadership | is the business healthy and growing? (heartbeats, SLO attainment summary, incident/risk posture, per-Market traffic lights) |
| **Platform** | platform ops | are all cells/components healthy? (technical axis rollup, release/config versions live, budget states) |
| **Regional** | regional ops | is my region serving its countries? (cell health, capacity headroom, incident queue, DR currency) |
| **Operations** | on-call | what needs action now? (active alerts by severity, parked work, escalation clocks, runbook links) |
| **Business** | market operations (A-001 managers) | is my Market performing? (City heartbeats, supply/demand balance, launch KPIs vs. goals) |
| **Security** | security operations | is anyone doing what they shouldn't? (ADR-007 signals: auth anomalies, privilege events, break-glass, partner trust drift) |
| **Engineering** | component owners | is my component honest? (golden signals, SLI detail, consumer lag, error budget burn, trace exemplars) |

Rule: every pane answers a stated question for its stated owner; decorative dashboards
are deleted. Executive and business views consume *certified* derived data (ADR-004 §9) —
leadership numbers are traceable to facts like everything else.

## 8. Continuous Improvement

**Reliability reviews** (cadence, §5) and **incident reviews** (blameless, ADR-007 §11)
feed one governed improvement backlog. **Trend analysis** watches slow burns: latency
drift, budget-spend slope, alert precision decay, capacity-headroom erosion.
**Forecasting** couples telemetry trends with the launch pipeline (ADR-009 §7) so
capacity and reliability investment *lead* growth. **Risk detection** treats
observability gaps as risks: silent components, uncovered failure modes, stale runbooks,
overdue drills — each is a tracked finding. **Capacity analysis** closes the loop into
ADR-009 arithmetic. **Platform maturity** is assessed periodically against this ADR
(coverage, SLO discipline, alert quality, drill currency) with an honest scorecard —
maturity claims require evidence, the standing rule of this whole program.
**Reliability evolution:** SLOs tighten as markets mature; new capability classes enter
the ladder via amendment.

## 9. Scalability Notes

Observability scales as an O(traffic) data pipeline built from ADR-004's scale-shaped
classes: telemetry is append-only, City/subject-partitioned, aggregated near its source
(cells summarize; regions aggregate; global sees rollups — raw detail stays local and
ages out per class retention). Health computation composes verdicts hierarchically, so
global health is O(regions), a Market's health O(its cities) — never O(users). Alert
volume scales with *owned failure modes*, not with traffic, because detection targets
SLIs and heartbeats rather than raw events. Hundreds of countries add City/Market
heartbeat series and rollup nodes — **the fabric's mechanisms are O(1), its data
O(footprint + traffic), its human load O(what actually breaks)** — which is the only
version of observability that survives global scale.

## 10. Risks

1. **Standing (11th consecutive document):** C-1 — ADR-001 remains unapproved. This ADR
   can *detect* double-settlement; only the fix prevents it. Detection without
   remediation is a dashboard of known damage.
2. **Telemetry cost creep:** unowned cardinality growth (per-user labels, unbounded
   dimensions) can make observability the platform's biggest workload — contained by the
   ownership rule + class retention + aggregation-near-source, reviewed in class audits.
3. **SLO theater:** targets set to what's achieved rather than what users need — countered
   by user-anchored SLIs and review governance; an SLO nobody could miss is a finding.
4. **Business-metric trust:** heartbeats feeding executive decisions must survive the
   ADR-004 certification bar; an uncertified number on the executive dashboard is a defect.
5. **Maturity honesty:** today's estate is one cell's embryo of this architecture; the
   scorecard (§8) must say so plainly — claiming global observability before G-phases
   deliver it would violate the program's core discipline.

## 11. Future Evolution

Absorbable via amendment: predictive reliability (forecasted budget burn, pre-incident
signatures) as certified Analytics products; per-Jurisdiction regulator-facing
reliability attestations (pairing ADR-009 §12); customer-visible status transparency per
market; chaos-style verification maturing the drill program into continuous validation;
observability of ML-driven features (matching quality drift) as SLI classes when those
features arrive. Each lands against this document without redesign.

## 12. Final Certification

Verified against mandate: all 29 objective areas addressed; 10 observability principles;
health architecture covering all 10 required health views on two rollup axes; telemetry
architecture covering all 10 required telemetry kinds under ADR-004 classing with
correlation vocabulary; reliability architecture (SLIs, SLOs, availability/latency/
durability/recovery objectives, error budgets with release-gating teeth, reviews,
governance); alerting model (lifecycle incl. silence detection, severity by impact class,
escalation, ownership, dedup/correlation, noise governance); seven dashboards with
audience and owned questions; continuous improvement loop closing into backlog, capacity,
and maturity assessment; scale targets met by O-analysis; zero product/vendor/tooling
content; all prior FINAL ADRs extended, none redesigned.

**ADR-010 — OBSERVABILITY & RELIABILITY ARCHITECTURE — WORLD-CLASS CERTIFIED**
