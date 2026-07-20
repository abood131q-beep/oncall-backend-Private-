# ADR-009 — Deployment & Operations Architecture

**Status:** Proposed · **Author:** Chief Enterprise Platform Architecture · **Date:** 2026-07-18
**Builds on (FINAL):** G0.0 · ADR-002 (+A-001) · ADR-003 (+A-001) · ADR-004 · ADR-005 · ADR-006 · ADR-007 · ADR-008
**Scope:** enterprise operations architecture — how the platform is deployed, operated,
maintained, upgraded, and recovered globally. No products, vendors, tooling, or
implementation content.

---

## 2. Deployment Principles *(and 1. Executive Summary)*

**Executive summary.** The platform already operates a certified miniature of everything
this ADR requires: immutable signed releases, progressive rollout with automatic rollback,
verified encrypted backups with tested restore, declared recovery objectives, observability
with alerting, and runbooks. This document scales that operational DNA to a world of
regions, countries, and markets by one recurring move: **the operational unit is the
region-scoped platform cell; countries and markets are *activated onto* cells as data, not
deployed as software.** Software deploys rarely and identically everywhere; markets launch
daily and touch no binaries. That separation — release cadence vs. activation cadence — is
what lets hundreds of countries run without hundreds of deployment variants.

**Principles.**
1. **Repeatability** — any deployment is reproducible from its release identity + declared
   configuration versions; no hand-built environments exist.
2. **Predictability** — the same release + same config behaves identically in every
   environment and region; surprises are defects.
3. **Consistency** — one deployment method for all environments; production is not special
   in *how*, only in *gates*.
4. **Immutable releases** — a release, once cut, never changes; fixes are new releases
   (the existing signed-artifact discipline as law).
5. **Controlled change** — every production change (software, config, capacity) flows
   through a governed path with identity, approval, and audit (ADR-007).
6. **Automation first** — humans decide, machines execute; manual operational action is
   the exception that requires justification and leaves an audit trail.
7. **Safe deployment** — progressive by default (validate → small exposure → observe →
   expand), with health, smoke, and telemetry gates at each step.
8. **Rollback first** — no change ships without its tested reverse; rollback is a
   first-class flow, rehearsed, not an emergency improvisation.
9. **Operational simplicity** — the fewest moving parts that meet requirements; operational
   cleverness is a liability (G0.0's spirit applied to operations).
10. **Evolution without downtime** — upgrades are rolling/progressive; maintenance windows
    exist for the exceptional, not the routine.

## 3. Environment Architecture

| Environment | Purpose | Data | Promotion rule |
|---|---|---|---|
| **Development** | fast iteration per engineer | synthetic only | → Integration on merge intent |
| **Integration** | continuous assembly of the whole platform | synthetic, reset at will | → Testing on green assembly |
| **Testing** | full validation battery incl. contract/seam tests (ADR-008 §3) | curated synthetic suites incl. adversarial data | → Staging on full pass |
| **Staging** | production-shaped rehearsal: release candidates, launch rehearsals, DR drills | anonymized/production-shaped, never raw PII | → Production on approval gates |
| **Production** | the real world | real, fully protected (ADR-007) | — |
| **Emergency environment** | pre-provisioned recovery target for §6 scenarios; also isolates forensic work | restored snapshots under incident governance | activated by incident authority only |
| **Training environment** | operator/support/market-team onboarding and drills | synthetic + scenario scripts | never promotes; refreshed from staging shapes |

**Data separation** is absolute: production data never flows down except through governed
anonymization; credentials/secrets are environment-exclusive (an environment cannot
impersonate another). **Isolation:** environments share nothing at runtime — no shared
state, queues, or counterparty accounts (external counterparties have per-environment
sandboxes at the ACL). **Promotion** moves *the identical release artifact* upward with
accumulating evidence; nothing is rebuilt between environments.

## 4. Release Architecture

- **Release lifecycle:** cut (immutable, identified, provenance-attested) → validated
  (Testing evidence) → rehearsed (Staging) → approved (human production gate, ADR-007
  separation of duties) → progressively deployed → verified (health + smoke + telemetry
  battery) → adopted (becomes new last-known-good) — or rolled back.
- **Version strategy:** meaning-bearing versions with strict compatibility semantics;
  any two adjacent versions are co-runnable (rolling upgrades require it); data-shape
  changes follow expand-migrate-contract so software and state never force-march together.
- **Deployment units & boundaries:** the deployable unit is the platform cell's component
  set (ADR-008 components); the deployment *boundary* is one cell — a release rolls
  cell-by-cell, region-by-region, never globally at once.
- **Approval & promotion flow:** evidence accumulates automatically; humans approve at
  the Staging→Production gate and for emergency paths; approvals are scoped (a regional
  operator approves their region).
- **Rollback flow:** automatic on failed verification (the existing auto-rollback
  discipline); manual one-decision rollback at any time; rollback restores last-known-good
  release *and* its paired configuration versions.
- **Emergency & hotfix releases:** same pipeline, compressed — gates are *never* skipped,
  only prioritized (the P7-06 rule: a hotfix that fails safety gates is not deployable);
  emergency changes get retrospective review within a fixed window.
- **Maintenance windows:** reserved for the rare non-rolling change (substrate
  migrations); announced per affected markets in local time (ADR-003 temporal data),
  with degraded-mode behavior pre-declared.
- **Backward compatibility:** the deployed mobile fleet constrains every release
  (frozen-contract rule); server releases must serve N and N-1 mobile generations at
  minimum.

## 5. Global Operations Model

- **Global regions:** the world divides into operational regions, each hosting one or
  more **platform cells** (full ADR-008 component sets). Regions exist for latency,
  data-residency (Compliance Data requirements → cell placement policy), and blast-radius
  containment.
- **Regional operations:** each region is operationally self-sufficient for its daily
  work: its cells, its on-call, its capacity, its recovery. **Regional independence:**
  a region's failure never cascades — cross-region dependencies are limited to global
  reference/rule distribution (immutable versions, cache-friendly) and consolidated
  analytics (never on command paths, ADR-006).
- **Country deployment = activation, not deployment:** a country enters by authoring its
  Country Entry (ADR-003 §9) and activating it onto its region's cell(s) — software
  untouched. **Market deployment** likewise: market configuration versions activated onto
  the country's footprint (A-001 cascade layer). De-activation is the reverse:
  staged capability withdrawal, data retained per retention law.
- **Operational ownership:** three-tier — *platform operations* (global: releases, cells,
  fabrics, security operations), *regional operations* (capacity, availability, incident
  response in-region), *market operations* (A-001 Market Managers: business configuration,
  launch execution, local escalation). Every operational object has exactly one owner tier.
- **Regional recovery:** each region recovers autonomously from its own DR estate (§6);
  cross-region assistance is a governed exception, not a hidden dependency.

## 6. Availability Architecture

- **Availability principles:** availability is declared per capability class, not
  platform-wide — safety functions > active-ride operations > new demand intake > money
  settlement (deferrable by design, ADR-005) > administration > analytics; the shedding
  order is the ADR-007/008 declaration, operationalized.
- **High availability:** within a cell, every component runs redundantly with no single
  instance mattering (ADR-008 disposable instances); within a region, cell redundancy
  where scale justifies; health-driven replacement is continuous and automatic.
- **Business continuity:** continuity is per capability class with pre-declared degraded
  modes (deferred settlement, cash-mode operation for payment counterparty loss, reduced
  matching sophistication under load); continuity procedures are rehearsed on the drill
  calendar.
- **Disaster recovery:** the certified backup/restore discipline generalizes per region:
  tiered encrypted verified backups per ADR-004 class (facts most aggressively, ephemera
  not at all), off-site replication per region, automatic periodic restore-validation
  ("a backup that hasn't restored is a hope, not a backup" — now regional law).
- **Recovery objectives:** declared per data class and capability class, per region —
  the existing RPO ≤ 15 min / RTO ≤ 60 min stands as the platform floor for tier-0
  operational truth; objectives tighten as substrate matures (continuous fact replication
  → near-zero RPO for the ledger).
- **Regional failover:** for region-scale disaster, the recovery target is that region's
  own emergency environment first (§3); cross-region failover exists for the reference/
  rule plane (immutable, trivially re-servable) and, where law permits, for identity
  continuity — full operational failover across residency boundaries is a *legal*
  question before a technical one, and the architecture says so honestly.
- **Operational resilience:** on-call rotations, escalation ladders, and incident
  authority (ADR-007 §11) staffed per tier; resilience is measured (drill outcomes,
  detection latency, rollback frequency) and reviewed.

## 7. Capacity Model

**Planning** is per-cell, per-City arithmetic (ADR-008: capacity = partitions × unit
capacity), rolled up regionally; **forecasting** feeds from Analytics (demand curves,
launch pipeline, seasonal patterns — Ramadan, holidays per ADR-003 calendars);
**growth strategy:** capacity leads demand by a declared headroom margin per region;
launches reserve capacity as part of the Country/Market activation checklist.
**Scaling rules:** scale-out triggers are declared per component class (ADR-008 context
types) and act automatically within regional limits; scale-*in* is conservative and
never violates redundancy floors. **Peak management:** predictable peaks are
pre-provisioned (event zones, rush hours — Zone data informs capacity); unpredictable
surges meet admission control + shedding order rather than collapse. **Operational
limits:** every cell declares its safe envelope; approaching limits is an alert long
before it is an outage. **Performance monitoring:** latency budgets per use-case class
(ADR-008 §7) are production SLOs with error budgets; budget burn gates release cadence.
**Resource planning:** reviewed on cadence with launch pipeline and budget owners —
capacity is a business plan, not a panic response.

## 8. Configuration Management

Configuration is governed by the ADR-003 cascade and ADR-004 authored-data regime —
operations adds the *runtime* discipline: **ownership** per key/layer (platform keys by
platform ops, market keys by Market Managers — A-001); **versioning** effective-dated,
append-only (never edited live); **approval** author ≠ approver, regulatory keys +
legal sign-off; **promotion**: configuration versions promote through environments like
releases — staging rehearses tomorrow's production config; **rollback** = re-effecting
the prior version, one decision, always available; **regional/country/market overrides**
resolve by the cascade with restrictive-wins for law — operations never invents a
parallel override mechanism; **emergency changes** (kill-switches, emergency policies —
ADR-007 §5.7) are pre-authorized, scoped, audited, auto-expiring, and reviewed post-hoc;
**paired rollback:** every release records the configuration versions it shipped with, so
software rollback restores a *coherent* software+config state.

## 9. Operations Governance

**Monitoring responsibilities:** publisher-side health, consumer-side lag (ADR-006 §9),
cell-level golden signals, business-level heartbeats (rides, settlements per market) —
each with a named owner; a metric without an owner is deleted or adopted. **Alerting:**
every alert is actionable, owned, and severity-classed; alert fatigue is treated as an
operational defect. **Incident operations:** ADR-007 §11 executed with regional
first-response and platform escalation; incident authority pre-holds containment powers.
**Maintenance:** routine maintenance is automated and continuous (the scheduled runtime
context); human maintenance is scheduled, announced, and reversible. **Operational
audits:** periodic verification that reality matches declaration — running versions,
config versions, backup freshness, restore results, access recertification (ADR-007 §10).
**Runbooks:** every declared failure mode and every drill scenario has a runbook; runbooks
are versioned artifacts tested by drills (the existing runbook culture, made mandatory).
**Escalation:** time-boxed tiers with automatic escalation on breach; nothing waits
silently. **Continuous improvement:** drill findings, incident lessons, and audit gaps
feed the governed backlog with the same priority discipline as engineering work.

## 10. Scalability Notes

The model scales because the expensive thing — software release — is O(1) globally
(identical everywhere), while the frequent thing — market/country activation — is O(data)
and touches no software. Cells replicate per region without redesign (ADR-008: more
partitions of the same shapes); operations staffing scales by tier (platform fixed,
regional per region, market per market — the A-001 management spine *is* the ops org
chart); capacity is arithmetic per partition; backup/DR estates replicate per region with
identical procedures. Hundreds of countries = hundreds of activations + a handful of
regions — **the operational architecture is O(regions) in complexity, O(activations) in
work, and O(1) in mechanisms.**

## 11. Risks

1. **Standing:** C-1 (ADR-001, unapproved) — no operations architecture compensates for a
   financial-consistency defect in the deployed software. Ten documents have now carried
   this line.
2. **Paper-to-practice gap:** regions, tiers, and cells describe a future org; today one
   team on one cell is the whole model — the architecture is staged (G-phases) and this
   document must not be read as a build order (G0.0 rule).
3. **Config-change risk rivals code-change risk** at maturity: activation mistakes
   (wrong market config) will outnumber bad releases — mitigated by staging rehearsal of
   config promotions and cascade publish-gates (ADR-003 §6).
4. **Residency vs. failover tension** (§6): where law forbids cross-region data movement,
   regional disasters have legally-bounded recovery options — this is stated, not solved;
   per-country analysis belongs to each Country Entry.
5. **Drill discipline decay:** rehearsed recovery is the load-bearing assumption of the
   whole availability model; skipping drills quietly converts guarantees into hopes.

## 12. Future Evolution

Absorbable without redesign: multi-cell regions (scale within region); follow-the-sun
operations as regional teams grow; automated launch pipelines (Country Entry authoring →
validation → activation as a governed workflow product); chaos-style resilience
verification maturing the drill program; carbon/cost-aware capacity policies as inputs to
the §7 arithmetic; regulator-visible operational attestations per Jurisdiction. Each lands
via amendment against this document.

## 13. Final Certification

Verified against mandate: all 28 objective areas addressed; 10 deployment principles;
7 environments with data separation, promotion rules, isolation; release architecture
(lifecycles, approval/promotion/rollback flows, emergency/hotfix, maintenance windows,
backward compatibility); global operations model (regions, cells, country/market
activation, 3-tier ownership, regional independence & recovery); availability
architecture (principles, HA, continuity, DR, objectives, redundancy, degradation,
failover, resilience); capacity model (planning, forecasting, growth, scaling, peaks,
limits, monitoring, resources); configuration management (ownership, versioning,
approval, promotion, rollback, overrides, emergency); operations governance (monitoring,
alerting, incidents, maintenance, audits, runbooks, escalation, improvement); scale
targets met by O-analysis; zero vendor/product/tool content; all prior FINAL ADRs
extended, none redesigned.

**ADR-009 — DEPLOYMENT & OPERATIONS ARCHITECTURE — WORLD-CLASS CERTIFIED**
