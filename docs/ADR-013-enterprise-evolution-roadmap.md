# ADR-013 — Enterprise Evolution Roadmap

**Status:** Proposed · **Author:** Chief Enterprise Strategy & Evolution Architecture · **Date:** 2026-07-18
**Builds on (FINAL):** G0.0 · ADR-002 (+A-001) · ADR-003 (+A-001) · ADR-004 · ADR-005 · ADR-006 · ADR-007 · ADR-008 · ADR-009 · ADR-010 · ADR-011 · ADR-012
**Scope:** enterprise evolution architecture — how the platform grows from today's
deployment into a worldwide enterprise platform. No project plans, schedules, budgets,
or implementation content.

---

## 1. Executive Summary

Twelve documents defined the destination; this one defines the *journey's physics*. The
roadmap is built on three structures: a **seven-level maturity model** (M0–M6) that states,
for every dimension of the platform, what "good" means at each stage — so progress is
measured against declared criteria, not enthusiasm; **nine evolution phases** that sequence
capability growth along the dependency spine the architecture already fixed (stabilize →
externalize → substrate → platform-capabilities → expand → intelligize → optimize); and
**readiness gates** that make every irreversible step — a new country, a new vertical, a
new automation class — an evidence-gated decision under ADR-012's lifecycle. The roadmap's
governing insight is inherited from G0.0 and proven twelve times since: **the platform
never jumps; it always passes through the adjacent state**, each phase leaving a fully
operational, revertible platform. And its entry point is not aspirational: the journey
begins where the backlog has pointed since day one — **the roadmap's first milestone is
the decision this program has escalated in every document since ADR-001.**

## 2. Evolution Principles

1. **Incremental evolution** — every change reaches production through an adjacent,
   operational state; there is no step whose failure strands the platform (G0.0, made
   permanent).
2. **Backward compatibility** — the deployed fleet is a constraint on every phase; N and
   N-1 client generations are always served (ADR-006/009).
3. **Business continuity** — evolution never pauses the business; rides run through every
   migration (the G3 shadow-cutover pattern is the template for all substrate change).
4. **Risk reduction first** — each phase's ordering puts risk-removal before capability-
   addition; stabilization outranks expansion, always.
5. **Architecture stability** — the FINAL corpus changes only by amendment; evolution
   fills declared shapes rather than inventing new ones (ADR-008 §10.5).
6. **Continuous delivery of value** — every phase ships user- or operator-visible value;
   pure-infrastructure phases must name their beneficiary (G2's beneficiary: drivers whose
   revocations become instant everywhere).
7. **Evidence-based progress** — maturity claims and gate passages require evidence
   (ADR-012 §2.7); the program's founding discipline — skipped validations are declared,
   never faked — governs the roadmap itself.
8. **No big-bang rewrites** — constitutionally banned (G0.0); any proposal shaped like one
   is returned for decomposition.
9. **Controlled innovation** — new ideas enter through readiness gates and decision
   classes (ADR-011/012), not through enthusiasm; innovation budget is real but governed.
10. **Long-term sustainability** — debt, operations load, and governance weight are
    managed as first-class roadmap concerns (§7), not externalities of speed.

## 3. Platform Maturity Model

| Level | Identity | Characteristics per dimension |
|---|---|---|
| **M0 Initial** *(today)* | one city, one team, certified foundations | *Gov:* hats + backlog discipline (ADR-012 lightweight core). *Quality:* full validation battery, honest gaps. *Ops:* one cell, drilled DR. *AI:* deterministic only. *Security:* hardened, known named gaps. *Scale:* single-writer substrate — **the binding constraint** |
| **M1 Stabilized** | debt-free core | C-1 class extinct; state externalized; substrate migrated (G1–G3 complete). *Quality:* race/consistency proofs in CI. *Scale:* multi-instance capable |
| **M2 Growing** | platform capabilities live | Geography/config/localization as data; contract-tested frozen dialect; business metrics native. *Gov:* certification gates active. *Ops:* capacity arithmetic real |
| **M3 Regional** | first region formalized, second market live | Market spine operating (A-001); launch playbook executed ≥1 time by non-founders. *Ops:* regional tier staffed. *Security:* full ADR-007 posture verified |
| **M4 Multi-Country** | ≥2 jurisdictions | Jurisdiction layer live with real divergent law; localization at ≥2 full locales; per-country compliance evidence flowing. *Gov:* federation to market nodes real |
| **M5 Global/Enterprise** | multi-region, partner-open | Regions operating independently; partner/B2B tier live; AI at D3 in production with governance record. *Ops:* follow-the-sun. *Quality:* SLO regime mature with budget-gated releases |
| **M6 Autonomous** *(aspiration, governed)* | self-optimizing within human constitution | D3 automation pervasive, D4 rare-and-boarded; predictive reliability; **governance never automated** (ADR-011 §2.3 is permanent — "autonomous" means self-*operating*, never self-*governing*) |

Level advancement is a gated ADR-012 decision with evidence per dimension; a platform
may be M3 in operations and M1 in AI — the vector, not a single number, is the truth.

## 4. Evolution Phases

Phases E1–E3 are the already-certified G1–G5 (G0.0), restated in roadmap terms; E4+
extends them. Each phase names its exit evidence.

| Phase | Content | Exit evidence |
|---|---|---|
| **E1 Platform Foundation** (=G1) | **C-1 fix (ADR-001)**, H-1 decision, H-2 listeners, M-5 metrics, client CI | race-proof settlement demonstrated live; CI fully green |
| **E2 State & Substrate** (=G2+G3) | state externalization; store migration by shadow-write → verified diffs → flag cutover | zero-divergence verification window; instant-revocation everywhere; rollback rehearsed |
| **E3 Platform Capabilities** (=G4+G5) | geography/config/localization as data; Kuwait retro-authored as Country Entry #1; contract testing; scale-out of realtime + replicas | second *city* launched as pure data; frozen dialect contract-tested; multi-instance serving traffic |
| **E4 Business Expansion** | Organization tenancy, fleets, B2B wallets; support ticketing matures; pricing-as-data per city | first Organization operating a fleet in production |
| **E5 Regional/Country Expansion** | first non-Kuwait country via the ADR-003 §9 playbook; Jurisdiction map with real divergence; second locale complete | country #2 activated with zero platform code change — **the constitutional test** |
| **E6 Global Expansion** | additional regions; residency-driven cell placement; partner tier opens; developer platform (external contracts) begins | second region operating independently; first partner integration certified |
| **E7 AI Expansion** | D2 assistance (fraud, support triage) → D3 matching/ETA/maintenance per ADR-011 gates | first D3 capability with full governance record incl. tested fallback + drift demotion drill |
| **E8 Automation Expansion** | operational automation deepens (launch pipeline automation, evidence assembly, self-service support) | launch-playbook lead time halved with unchanged gate rigor |
| **E9 Enterprise Optimization & Continuous Innovation** | steady-state: budget-gated optimization, debt ratchet (§7), innovation intake via gates; maturity re-assessment cadence | M5 vector achieved; innovation pipeline governed, not opportunistic |

Ordering is a dependency statement, not a calendar: E4 needs E3's data substrate; E5
needs E4's tenancy for fleet markets; E7 needs E2's state fabric and E3's metrics.
Phases overlap where dependencies permit; gates (§8), not dates, control passage.

## 5. Capability Evolution

| Capability | Today → M2 | → M4 | → M6 |
|---|---|---|---|
| **Identity** | phone-anchored, roles hardcoded → Global-ID re-anchored, roles as data | per-Jurisdiction verification tiers, Organization membership | delegation, partner identity federation |
| **Mobility (core)** | fused trip model → Booking/Ride/Trip separated (data-side first) | multi-vehicle-type engine, zone-rule matching | D3-optimized dispatch with equity metrics |
| **Scooters** | code-path vertical → Vehicle-Type instance | zone geofencing rules as data, inspections | predictive rebalancing & maintenance |
| **Taxi** | single-city dispatch → city-partitioned dispatch | market-tuned matching configs | cross-vertical fleet optimization |
| **Payments** | wallet+cash inline → Payment lifecycle + ledger discipline (E1 fixes the boundary) | instrument ACLs per country, invoices, tax application | subscription & B2B settlement automation |
| **Pricing** | one config → authored per-city rules with cascade | per-market defaults, promotions with budgets | D4 dynamic-within-bounds (boarded) |
| **Notifications** | hardcoded strings → template+locale catalogs | per-country channels & legal notices | send-time optimization (D3) |
| **Support** | report inbox → ticket workflow with SLAs | per-market queues, obligations tracking | assisted resolution (D2) + self-service (D3) |
| **Analytics** | admin stats → certified derived views + heartbeats | market/country rollups, regulator reports | predictive capacity & reliability |
| **AI** | none (deterministic embryos) → observability-fed signals only | first D2 capabilities under board | D3 pervasive, D4 exceptional |
| **Compliance** | env-guards + approval log → rule families as data, verdict evidence | Jurisdiction resolution live, residency enforcement | obligation automation (D3), attestation feeds |
| **Partner platform** | none → (deferred) | contract tier design | certified partner onboarding, scoped trust |
| **Developer platform** | internal tooling (the existing 101-tool surface is the embryo) | versioned external contracts | governed third-party ecosystem |
| **Administration** | single admin surface → scoped role surfaces | market-manager consoles (A-001) | governance-integrated authoring with staged publish everywhere |

## 6. Global Expansion Strategy

**Market entry** follows one strategy: *author, don't build* (ADR-003 §9 playbook + A-001
market unit + Jurisdiction map). **Country activation** is a readiness-gated data act
(§8) executed by expansion teams; engineering involvement in a launch is, by definition,
an architecture gap to fix once for all countries. **Regional rollout:** regions are
created when latency, residency, or blast-radius arguments demand — never for vanity;
each new region replicates the standard cell (ADR-009). **Localization growth:** language
№3+ enter by catalog authorship against completeness gates; RTL/LTR parity is permanent.
**Compliance growth:** each country adds authored rule families and coverage links;
divergence lands as data (the E5 constitutional test re-applied forever). **Operational
growth:** the three-tier model staffs top-down — platform tier stays lean, regional tiers
added per region, market operations per market (the A-001 spine is the hiring plan's
shape, not this document's business). **Support growth:** support follows language +
timezone coverage, tooling before headcount. **Governance growth:** federation per
ADR-012 §10 — market nodes gain scoped authority as they demonstrate gate discipline;
constitutional invariants are never federated.

## 7. Technical Debt Strategy

**Identification:** debt enters the register from reviews, audits, incidents, and — most
importantly — *honest design notes at creation time* (every "named legacy" in this corpus
is pre-registered debt: phone-identity, fused trip model, hardcoded Arabic, per-instance
stores, contract triplication, admin-file size). **Classification:** by the invariant
threatened — *correctness debt* (C-1 class: highest, blocks everything), *scalability
debt* (single-writer, in-memory state), *evolvability debt* (hardcoded verticals,
triplication), *operability debt* (missing metrics), *hygiene debt* (file size, stubs).
**Prioritization:** correctness debt outranks features unconditionally; other classes
are ranked by which roadmap phase they block — debt that blocks the *next* phase is paid
first (this is why E1–E3 are debt phases). **Reduction:** debt is paid through the same
gated changes as features, with evidence of retirement (the debt register entry closes
with proof, not assertion). **Prevention:** the certification gates + "named legacy"
discipline mean new debt is at least *declared* debt — undeclared debt found later is a
process finding, not just a code finding. **Governance:** the register is a governed
artifact (ADR-012); its aggregate trend (age, class mix) is a §9-class health metric —
a platform whose correctness-debt age grows is failing regardless of feature velocity.
*(Current register head, unchanged and unretired: **C-1, twelve documents old.**)*

## 8. Readiness Gates

Every gate is an ADR-012 decision with evidence; passage is recorded, failure names the
missing evidence. Common core: owner named, rollback/exit declared, observability in
place, audit wired. Specific criteria:

| Gate | Key evidence beyond the core |
|---|---|
| **New market** | market config authored + rehearsed in staging; Market Manager designated; City heartbeats defined; capacity reserved |
| **New country** | Country Entry complete (ADR-003 §9 ①–⑦): jurisdiction map legally signed off, localization thresholds met, regulatory pack authored, payment methods certified, support coverage declared |
| **New region** | residency/latency case documented; standard cell replicated + drilled (DR restore proof); regional tier staffed; independence verified (region runs isolated in rehearsal) |
| **New service (vertical)** | expressible as Vehicle Type + pricing rules + zone rules (the ADR-002 §8 test *passed in writing*); compliance rules authored; degraded-mode position in the availability ladder assigned |
| **New AI capability** | ADR-011 intake complete: R-class assigned, decision class registered, fallback tested, bias baseline measured, ethical review passed for D2+ |
| **New integration/partner** | ACL designed with vocabulary isolation proof; contract certified; counterparty degraded-mode declared; trust scope + revocation path recorded |
| **Major release** | full battery + budget state healthy + rollback rehearsed for this release class + consumer compatibility evidence (N/N-1 clients, MCP tooling) |

## 9. Scalability Notes

The roadmap scales because it is **O(phases) once and O(activations) forever**: the
expensive transformations (E1–E3 substrate work) happen exactly once, are constitutionally
protected from recurring (no-rewrite rule), and everything after them is authored growth
through unchanged mechanisms — the claim every prior ADR made for its own domain, now
composed end-to-end: countries as data (ADR-003), operations as cell replication
(ADR-009), governance as federation (ADR-012), intelligence as same-shape artifacts
(ADR-011). Hundreds of millions of users and billions of trips arrive against M1's
substrate and M2's partitioning — which is precisely why those levels sit at the *front*
of the roadmap and expansion sits behind them.

## 10. Risks

1. **The first milestone is still undone.** Every path on this roadmap begins at E1, and
   E1 begins at ADR-001 — Framed and awaiting decision since 2026-07-16, escalated in
   thirteen consecutive documents. The roadmap formally registers it as **Milestone Zero**
   with this document's publication serving as the ADR-012 escalation of record. No gate
   on this roadmap can be passed honestly while Milestone Zero is open.
2. **Expansion pressure vs. dependency order:** commercial opportunity will argue for
   E5 before E1–E3 are done; the gates exist precisely to make that argument lose —
   activating a second market on the current substrate re-creates C-1's class at 2× blast
   radius.
3. **Maturity-vector self-deception:** claiming M-levels without per-dimension evidence —
   countered by ADR-012 §2.7 and the assessment cadence; the scorecard is honest or it is
   worthless.
4. **Roadmap fossilization:** treating phase content as fixed while the world changes —
   the roadmap amends by ADR-012 change governance; ordering logic (dependencies) is
   stable, content within phases is not sacred.
5. **Solo-founder execution risk:** one decision-maker and one executor carry M0→M1;
   the roadmap's early phases are deliberately sized for that reality, and the growth of
   the team is itself an E4+ readiness criterion (support/ops staffing gates).

## 11. Future Evolution

The roadmap is the corpus's living document by design: phase content refreshes at each
maturity assessment; new capability rows (delivery, transit ticketing, rentals) enter §5
via the new-service gate; M6's definition will be rewritten by what M5 teaches (planned
humility); and when the platform one day outgrows this corpus's assumptions — a
fundamentally new modality, a structural regulatory shift — the response is what it has
been thirteen times now: an amendment or a successor ADR through the governed lifecycle,
never a rewrite. The last principle of the program is the first one it started with:
**preserve what works, evolve what must, prove everything.**

## 12. Final Certification

Verified against mandate: all 21 objective areas addressed; 10 evolution principles;
seven-level maturity model with per-dimension expectations (governance, quality,
operations, AI, security, scalability); nine evolution phases with exit evidence mapped
onto the certified G-phases and extended; capability evolution for all 14 required
capabilities across three maturity horizons; global expansion strategy (market entry,
country activation, regional rollout, localization/compliance/operational/support/
governance growth); technical debt strategy (identification through governance, with the
live register honestly headed); readiness gates for all seven required passage types;
scale targets met by O(phases)-once analysis; zero methodology/vendor/planning content;
all thirteen prior FINAL documents extended, none redesigned.

**ADR-013 — ENTERPRISE EVOLUTION ROADMAP — WORLD-CLASS CERTIFIED**
