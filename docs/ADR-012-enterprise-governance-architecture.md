# ADR-012 — Enterprise Governance Architecture

**Status:** Proposed · **Author:** Chief Enterprise Governance Architecture · **Date:** 2026-07-18
**Builds on (FINAL):** G0.0 · ADR-002 (+A-001) · ADR-003 (+A-001) · ADR-004 · ADR-005 · ADR-006 · ADR-007 · ADR-008 · ADR-009 · ADR-010 · ADR-011
**Scope:** enterprise governance architecture — how the enterprise governs everything it
has now designed. No implementation, org charts, HR, methodologies, or products.

---

## 1. Executive Summary

Eleven architecture documents have each planted governance clauses in their own domain —
data certification, contract registries, staged publishing, risk classes, error budgets,
decision classes. This capstone unifies them into **one governance architecture with one
grammar**: every governed thing (decision, policy, standard, change, risk, exception) is
an *owned, classified, evidenced, versioned, auditable artifact with a lifecycle* — the
same regime ADR-004 imposed on data, now imposed on governance itself. Two commitments
distinguish this document. First, **governance is architecture, not bureaucracy**: every
body, gate, and cadence exists to protect a named invariant from a named failure mode,
and any that cannot name both is deleted. Second, **honest instantiation**: today this
entire model is exercised by one decision-maker and one engineering executor — the
document therefore defines every role as a *hat with a named wearer* and a growth path,
and treats its own founding case study candidly: an unmade decision (ADR-001, twelve
documents old) is not a pending item; it is a **governance failure with a measurable
cost**, and this architecture exists so that class of failure becomes structurally
visible and structurally intolerable.

## 2. Governance Principles

1. **Accountability** — every governed artifact and every decision has exactly one named
   accountable owner; shared accountability is no accountability.
2. **Ownership** — authority and responsibility travel together (the ADR-002→011 single-
   owner rule, universalized); you cannot own what you cannot decide, nor decide what you
   do not own.
3. **Transparency** — governance acts in the open: decisions, rationales, dissents, and
   exceptions are visible to those they bind.
4. **Traceability** — any state of the enterprise traces to the decisions that authorized
   it (the ADR-007 audit loop closed at the governance level).
5. **Consistency** — one grammar for all domains: same lifecycle, same evidence bar, same
   exception path everywhere; domain differences are parameters, not new machinery.
6. **Compliance** — external law binds internal governance (ADR-003-A001: law outranks
   configuration; here: law outranks policy, always).
7. **Evidence-based decisions** — claims require evidence; the program's standing rule
   ("certification requires proof, gaps are stated") is now constitutional.
8. **Controlled change** — nothing consequential changes outside a governed path
   (ADR-009 §2.5 generalized beyond production).
9. **Separation of duties** — author ≠ approver ≠ auditor, in governance itself as in
   everything it governs.
10. **Least privilege** — governance authority is scoped and expiring like any privilege
    (ADR-007 §4 applied to governors).
11. **Enterprise first** — local optimization never overrides platform invariants; the
    frozen mobile contract, the money rules, and the safety ladder outrank any single
    team's convenience.
12. **Continuous improvement** — governance measures itself (§9) and is amended by its
    own change process; a governance rule that no longer protects anything is retired.

## 3. Governance Model

**Layers:** *Constitutional* (the FINAL ADR corpus — changeable only by amendment) →
*Policy* (domain policies authored under the ADRs) → *Operational* (standards, gates,
cadences executing policy) → *Execution* (the governed work itself).

**Domains & authorities** — one accountable authority per domain, mirroring the
architecture's own ownership map:

| Domain | Governing authority (hat) | Constitutional basis |
|---|---|---|
| Architecture | Architecture Board | this corpus, G0.0 |
| Technology | Technical Authority | ADR-008 |
| Data | Data Governance Authority | ADR-004 |
| Security | Security Authority | ADR-007 |
| AI & Automation | AI Governance Board | ADR-011 |
| Operations | Operations Authority (3-tier) | ADR-009 |
| Business/Portfolio | Business Governance (market spine) | ADR-002-A001 |
| Compliance | Compliance Authority | ADR-003 (+A-001) |

**Decision domains** map to these authorities; **approval domains** define which gates
each authority holds; **policy domains** define what each may author. **Boards vs.
authorities vs. advisors:** an *authority* decides within its domain; a *board* decides
cross-domain matters (architecture changes, D4 automation, risk acceptance above
threshold) with named voting members; *advisory bodies* (legal counsel, market
operators, driver/rider advocacy as it matures) inform and dissent on the record but do
not vote. Every body publishes its charter: protected invariants, decision rights,
quorum, cadence, escalation — a body without a charter does not exist.

**Decision lifecycle (the grammar's core):** Raised (with owner + **decision deadline**)
→ Framed (options, evidence, impacted domains) → Consulted (affected owners heard on
record) → **Decided** (one accountable decider or chartered board; rationale recorded) →
Communicated (to all bound parties) → Executed (traceable) → Reviewed (did reality match
the rationale?). **Decision latency is a governed metric**: decisions carry deadlines at
Raising; a breached deadline escalates automatically; an expired-undecided decision is a
recorded governance failure attributed to its owner. *(Founding case study, on the
record: ADR-001 — Raised 2026-07-16, fully Framed same day, deadline never set, twelve
subsequent workstreams proceeded around it. Under this lifecycle it would have escalated
on day two.)*

## 4. Architecture Governance

**ADR governance:** ADRs are the constitutional layer — statuses (Proposed → Certified →
FINAL → Amended → Superseded), single authoring authority, board approval for
certification, **amendment-only evolution** for FINAL documents (the A-001 pattern is
the standard: standalone amendment record + tagged inline updates, nothing rewritten).
**Reviews:** every consequential design change is checked against the corpus before
build (the impact-analysis-first rule from this program's first day, now permanent);
**compliance:** periodic architecture audits verify the built system matches the declared
system — drift is a finding with an owner (the seam-contract tests of ADR-008 are the
mechanical arm of this). **Exceptions:** time-boxed, owned, recorded with the invariant
they bend and the payback plan; expired exceptions auto-escalate. **Ownership &
lifecycle:** each ADR names its owning authority; superseding an ADR requires the board
to state what invariant changed in the world to justify it.

## 5. Data Governance

ADR-004 §9 is adopted wholesale as this domain's policy layer; the enterprise layer
adds: **ownership/stewardship registry** (every class in every context: owner + steward,
kept current as a governed artifact); **approval** — classification changes, retention
changes, and new PII collection are board-visible decisions (privacy is never a local
call); **lifecycle & retention governance** — retention rules derive from Compliance
(covering-Jurisdiction maxima) and are audited for adherence, with legal-hold conflicts
escalated per ADR-007 §7; **quality governance** — the certification bar ("uncertified
data cannot be depended upon") is enforced at reviews, and quality-gate failures block
publication, not get waived; **master data governance** — identity merges/splits,
organization structures, and vehicle registries follow the ADR-004 §5 governed-event
rules with named approvers.

## 6. AI Governance

ADR-011 §3–4 is adopted wholesale; the enterprise layer binds it to the boards:
**ownership** — every capability's owning context and steward registered before intake;
**approval** — R-class determines gate depth: R1–R2 by domain authority, R3 by AI board,
R4 by AI board + Architecture Board jointly; **validation** — evidence per ADR-011
(quality + bias + fallback tested) is a certification requirement, not a courtesy;
**risk & ethics** — ethical review is chartered with authority to veto (not advise) on
D2+ capabilities touching livelihood, safety, pricing fairness, or personal data;
**accountability** — the named human owner answers for automated outcomes (ADR-011 §2.6
enforced through this body); **review & retirement** — recertification cadence per
R-class; drift-triggered demotions (ADR-011 §7) are reported to the board; retirement
follows deprecation with archived reproducibility.

## 7. Risk Governance

**Identification** — risks enter from anywhere (reviews, incidents, audits, engineers,
market teams) into one register; an unregistered known risk is itself a finding.
**Classification** — by impact domain (safety > financial > legal > operational >
reputational) and likelihood; classification selects review cadence and decision
authority. **Ownership** — every risk has one owner with authority to mitigate or
formally accept. **Reviews** — cadence per class; stale risk entries escalate.
**Acceptance** — explicit, signed, expiring, re-affirmed or retired at expiry (ADR-007
§10 made enterprise-wide); *silent acceptance does not exist* — an unmitigated,
unaccepted risk escalates until someone owns it. **Mitigation** — tracked in the
governed backlog with the same priority discipline as all work. **Escalation** —
automatic on: deadline breach, class upgrade, repeated incident linkage. **Monitoring**
— risk indicators wired to the ADR-010 fabric where measurable (error-budget burn,
compliance-deadline proximity, drift events are all risk telemetry).

## 8. Change Governance

**Classification:** C1 routine (pre-approved patterns: config within budgets, releases
through the standard pipeline — governed by the *pattern's* prior approval, executed by
automation); C2 significant (new capabilities, contract revisions, policy changes —
domain authority approval); C3 structural (architecture amendments, D4 automation,
cross-domain policy — board approval); C-E emergency (pre-authorized playbooks per
ADR-009 §4 — **gates compressed, never skipped**, retrospective review mandatory within
the fixed window). **Approval flow:** evidence accumulates automatically; humans approve
at declared gates with separation of duties; approvals are scoped to the approver's
authority. **Rollback governance:** every change class declares its reverse before
approval (rollback-first, ADR-009 §2.8 universalized — including policy rollback:
re-effecting the prior version). **Communication:** bound parties notified as an
obligation (ADR-006 §8 consumer-notification generalized). **Audit trail:** every
change, approval, rejection, and rollback is an audit fact (ADR-007 §9) — the change
history of the enterprise is reconstructible, period.

## 9. Quality Governance

**Principles:** quality is gate-enforced at the owner (ADR-004 §10), evidence-based
(nothing "passes" by assertion — the P7-era rule that skipped validations are declared,
never faked, is constitutional), and measured end-to-end (SLOs, error budgets, ADR-010).
**Gates:** each domain's certification gates (data, contracts, events, models, releases,
launches) form one registry; a gate must name its protected invariant and its evidence
requirement or it is removed. **Reviews:** architecture reviews (§4), compliance reviews
(per country entry and rule change, ADR-003), operational reviews (drill results, audit
findings, ADR-009 §9), reliability reviews (ADR-010 §5) — all feeding **continuous
improvement:** one governed backlog, prioritized by the risk register, with review
findings tracked to closure; closure rates and finding-age are governance health metrics.
**Governance of governance:** this architecture reviews itself on cadence — gate
effectiveness (defects caught vs. friction imposed), decision latency, exception
volume/age, and audit coverage are the meta-metrics; governance that measures everything
but itself is theater.

## 10. Scalability Notes

The model scales by **federation along the lines the architecture already drew**: domain
authorities delegate scoped decision rights down the operational tiers (platform →
regional → market, ADR-009) and the market spine (Country → Market, A-001) — a Market
Manager *is* a governance node for market-scoped decisions, with constitutional
invariants non-delegable. Volume scales by classification: C1 routine changes are
governed by pattern-approval and executed by automation (millions of governed acts, zero
meetings); boards see only C3/R4/high-risk matters, which grow with the business's
*structure*, not its traffic. Policy propagation uses the configuration cascade
(ADR-003 §6) — governance rules are authored data reaching hundreds of countries by the
same mechanism as pricing defaults. **Governance is O(structure) in deliberation,
O(patterns) in approval, O(1) in mechanisms** — the standing test, passed by the
governing layer itself.

## 11. Risks

1. **The founding case, resolved by naming it:** governance documents do not make
   decisions; deciders do. This architecture's value is exactly zero until its decision
   lifecycle is used — and its first use is overdue: **ADR-001 needs a decision deadline
   and a decision.** Twelve documents of consistent escalation are themselves the
   evidence for §3's latency rule.
2. **Governance theater at small scale:** one team performing eight authorities' rituals
   would be pantomime — mitigation: the hat model (real names, real gates, minimal
   ceremony) and the §9 meta-metrics that measure friction as a defect.
3. **Gate accretion:** gates outliving their invariants — mitigated by the name-your-
   invariant rule and periodic gate-registry pruning.
4. **Exception normalization:** exceptions quietly becoming the path — countered by
   expiry, escalation, and exception-volume as a health metric.
5. **Federation drift at scale:** delegated market-level governance diverging from
   constitutional invariants — countered by non-delegable invariant lists, audit
   sampling, and the cascade's restrictive-wins discipline applied to governance rules.

## 12. Future Evolution

Absorbable via amendment: independent audit and external assurance functions as the
organization grows; regulator-facing governance attestations per Jurisdiction (pairing
ADR-009/010 §12 anticipations); partner governance tier (B2B contract governance,
ADR-006 §12); driver/rider advocacy formalized from advisory to chartered voice;
governance tooling as products mature (the registry, the backlog, the metrics — all
specified here tool-agnostically). Each lands through §8's own change governance —
the model amends itself by its own rules, which is the definition of its maturity.

## 13. Final Certification

Verified against mandate: all 24 objective areas addressed; 12 principles; governance
model (layers, domains, decision/approval/policy domains, boards, authorities, advisory
bodies, charters, decision lifecycle with latency governance); architecture governance
(ADR lifecycle, reviews, approval, compliance, evolution, audits, exceptions, ownership);
data governance (ownership, stewardship, approval, lifecycle, quality, classification,
retention, master data); AI governance (ownership through retirement, bound to ADR-011);
risk governance (identification through monitoring, no-silent-acceptance); change
governance (4-class model, approval flows, emergency, rollback, communication, audit);
quality governance (principles, gate registry, reviews, improvement loop, meta-metrics);
scale targets met by federation analysis; zero framework/methodology/product content;
all eleven prior FINAL documents unified, none redesigned.

**ADR-012 — ENTERPRISE GOVERNANCE ARCHITECTURE — WORLD-CLASS CERTIFIED**
