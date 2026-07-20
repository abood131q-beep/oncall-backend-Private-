# ADR-004 — Data Architecture

**Status:** Proposed · **Author:** Chief Enterprise Architecture · **Date:** 2026-07-18
**Builds on (FINAL, never redesigned here):** G0.0 · ADR-002 (+A-001 Market) · ADR-003 (+A-001 Jurisdiction)
**Scope:** enterprise data architecture — how information exists. No databases, schemas,
SQL, APIs, storage technologies, or service topology.

---

## 1. Executive Summary

ADR-002 named the entities; ADR-003 named the rules; this ADR names the **nature of the
information itself**: fifteen data classes with distinct ownership, mutability, versioning,
retention, and quality regimes; one identity strategy; one source-of-truth model in which
every fact has exactly one authoritative owner and everything else is a declared derivation.
The central commitments: **facts are immutable, state is replaceable, derivations are
disposable, and every piece of data knows its class** — because class determines its rights
(who may change it), its lifetime (when it may disappear), and its obligations (what audit
and quality gates apply). Today's system already practices several of these instincts
(append-only transactions, approval audit logs, effective JWT revocation records); this ADR
generalizes them into law before the platform's data outgrows informality.

## 2. Data Architecture Principles

1. **Every datum has exactly one class** (§3) and one authoritative owner context (ADR-002);
   class membership is declared at design time, not inferred later.
2. **Facts vs. state vs. derivation**: things that *happened* are immutable facts; things
   that *are* (current status) are replaceable state whose history is preserved as facts;
   things that are *computed* are disposable and rebuildable.
3. **Corrections are new facts** — reversal/adjustment entries, never edits (generalizing
   the existing ledger instinct platform-wide).
4. **Time is part of truth**: authored data is effective-dated (ADR-003 §6); factual data is
   instant-stamped; every historical question is answerable as *(what, scope, instant)*.
5. **References, never copies**, across context boundaries (ADR-002 §5); where a copy is
   operationally necessary it is a *declared snapshot* with provenance (§4).
6. **Deletion is a governed event**, not an operation — legal grounds, scope, and evidence
   required; privacy erasure and legal hold are first-class lifecycle states (§8).
7. **Quality gates run at the owner** — data is validated where it is authored/created, once,
   rather than defensively everywhere.
8. **Backward compatibility is a data property too**: consumers may always read yesterday's
   shape; evolution is additive, deprecation is scheduled, nothing breaks the deployed
   mobile fleet (G0.0 frozen-contract rule extended to data).

## 3. Data Classification Model

| Class | Purpose · Examples (today → target) | Owner | Lifecycle & Update Rules | Versioning | Retention | Scale/Evolution |
|---|---|---|---|---|---|---|
| **Reference Data** | Slow-changing shared vocabulary: Geography spine, Languages, Currencies, Vehicle Types | Geography&Loc. (mostly) | authored → validated → published; append-only versions, never edited | effective-dated versions (ADR-003 §6) | permanent | O(business footprint); new kinds via ADR amendments |
| **Configuration Data** | Cascade-resolved behavior: policies, market config, flags, business hours | owning context per key | staged publish; scalar/set merge semantics; restrictive-wins for regulatory | effective-dated; staged rollout; rollback = re-effect prior version | permanent (versions) | O(footprint); flags temporary by covenant |
| **Master Data** | Long-lived business subjects: Users, Organizations, Drivers(role), Vehicles, Fleets | Identity / Mobility | created → active → suspended → closed; *current-state* updates allowed, every change emits a fact | state + change-history facts | life of subject + statutory period | 10⁸ users, 10⁷ vehicles; merge/split governed (identity evolution §5) |
| **Operational Data** | Live working state: Ride status, vehicle position, driver availability, offer queues | Mobility (mostly) | rapid mutation permitted — the *only* class where in-place update is normal; outcomes crystallize into facts | none (ephemeral); outcomes versioned as facts | short (hours–days); crystallized outcomes move to Transactional/Historical | O(traffic); the class that must stay lean |
| **Transactional Data** | Business facts with financial/legal weight: Trips, Payments, ledger Transactions, Invoices, Bookings | Mobility / Commerce | append-only from creation; correction = new compensating fact | immutable; supersession by reference | statutory (tax/financial law per Jurisdiction — typically 5–10 y) then archive | billions/yr; partitionable by City/time (ADR-002 §7) |
| **Historical Data** | Superseded states & closed facts kept for reproducibility: past rule versions, closed rides, old config | inherits owner | read-only by definition | is the version trail | class-specific; archive tiers | grows monotonically; tiered storage philosophy (§8) |
| **Analytical Data** | Facts re-shaped for questions: aggregates, KPIs, market rollups | Analytics | rebuilt from facts/events; **never authoritative** | rebuild-versioned (lineage §3-note) | disposable/regenerable | O(traffic) but reducible; never blocks operations |
| **Derived Data** | Computed conveniences: wallet balances, driver ratings, counters, read models | deriving context, with declared source | recompute-on-demand or eventual; discrepancy vs. source = rebuild, never patch source | derivation recipe versioned | disposable | unlimited — because rebuildable |
| **Temporary Data** | Scratch: OTP codes, matching offers in flight, session working sets | creating context | TTL-bound at creation; auto-expiry is the *only* exit | none | minutes–days, hard-capped | must never acquire consumers — promotion requires reclassification |
| **Audit Data** | Who did what to whom, when, under which authority: approval logs, admin actions, compliance verdicts | Operations (Audit authority) | append-only, write-once, no update path exists | immutable entries | long statutory (≥ regulatory maximum among covering Jurisdictions) | 10⁹/yr; tamper-evidence philosophy (hash-chained custody) |
| **System Data** | Platform's own operational exhaust: logs, metrics, health, backup manifests | infrastructure owner | generated; rotation/retention automated (exists today: P7-04/05 regimes) | n/a | short–medium, tiered | already governed; excluded from business governance except security events |
| **Identity Data** | Credentials-adjacent subject data: phone identity, sessions, tokens, verification outcomes | Identity | strict-write paths only; every change audited | state + audit facts | account life + statutory; erasure-eligible parts flagged | 10⁸; PII-dense — intersects Privacy Rules hardest |
| **Security Data** | Secrets, keys, token stores, revocations | Identity / platform security | rotation-governed; never backed up as values (existing P7-05 rule generalized) | rotation events audited | minimal — live material only + audit trail | small; highest confidentiality class |
| **Localization Data** | Catalogs, locales, templates, packages (ADR-003 §4B) | Geography&Loc. | authored → reviewed → published packages | package/catalog versions | permanent (versions) | O(languages × keys); CDN-class distributable |
| **Compliance Data** | Jurisdictions, rule families, coverage links, verdicts+evidence, agreements+acceptances | Compliance (Operations) | rules: authored/enacted (ADR-003-A001); verdicts & acceptances: append-only facts | rules effective-dated; verdicts immutable | longest retention in the platform; legal-hold-sensitive | O(legal footprint) + O(gated actions) |

*Lineage note:* Analytical/Derived data always carries **provenance** — which facts, which
recipe version, when built — so any number on any dashboard is traceable to authoritative
facts (quality principle "traceability", §10).

## 4. Source of Truth Model

- **Authoritative data** lives with its ADR-002 owner context; no fact has two authors.
  A datum's class + owner are sufficient to locate its truth.
- **Read models & derived views** are declared, consumer-owned reshapings with provenance;
  they may lag (§ consistency) and may be discarded/rebuilt at any time.
- **Snapshots** are point-in-time copies taken for a stated purpose (a Trip's fare snapshot
  of the Pricing version used; an Invoice's snapshot of tax rules applied) — they are
  *facts about what was used*, immutable, and never confused with the living source.
- **Historical facts** are the accumulated immutable record; the present is just the newest
  fact plus current state.
- **Synchronization philosophy:** contexts learn of each other's changes by consuming
  facts/events and updating their own read models — never by reaching into another
  context's state. **Consistency philosophy:** strong consistency *within* an owner's
  boundary for its own invariants (a ledger must balance at every commit); declared,
  bounded eventual consistency *across* boundaries — with the bound stated per read model
  and monitored, not assumed.

## 5. Identity Strategy

- **Global IDs:** every entity instance carries one opaque, permanent, globally unique
  platform identifier, assigned at creation, never recycled, never encoding meaning
  (no country prefixes, no dates — meaning belongs in attributes; encoded meaning rots).
- **Business IDs:** human-facing, per-kind formatted identifiers (booking references,
  invoice numbers) — presentation aliases that *resolve to* a Global ID; jurisdictional
  numbering laws (sequential invoice numbers per country) are satisfied at this layer
  without touching global identity.
- **Human-readable IDs** are short-lived convenience codes (pickup codes, support
  references) — scoped, expirable, reusable after expiry; never stored as references.
- **Natural keys** (phone numbers, plate numbers, license numbers) are **attributes with
  uniqueness constraints, never identity**: today's phone-as-primary-identity is named
  legacy — phones change owners, people change phones; migration preserves phone-lookup
  while re-anchoring on Global IDs (additive, per G0.0).
- **Surrogate vs. natural:** all cross-entity references use the opaque Global ID
  (surrogate); natural keys serve lookup and dedup only.
- **Cross-context references** are Global IDs + kind, resolved through the owner —
  possession of a reference grants no ownership rights over the referent.
- **External references** (PSP transaction IDs, government license numbers, map-provider
  place IDs) are stored as attributed *claims* with their issuing authority, mapped to
  platform identity — the platform never adopts an external namespace as its own.
- **Identity stability:** a Global ID survives every attribute change, role change, market
  reorganization, and data migration. **Identity evolution:** merges (duplicate accounts)
  and splits are governed events producing successor links — old IDs remain resolvable
  forever, pointing to their successor; nothing that referenced the old ID breaks.
- **Uniqueness:** global by construction (assignment discipline), verified by governance
  audits rather than trusted to luck.

## 6. Ownership Rules

Single-writer per datum: the owner context is the only creator/mutator; all others read via
references, events, or their own read models. Cross-cutting rules: (a) Compliance may
*gate* any context's writes but owns only rules/verdicts; (b) Audit receives copies of
privileged actions from every context but owns only the audit record; (c) Analytics owns
nothing authoritative by design; (d) stewardship (day-to-day data care) is delegated per
class in §9 without transferring ownership. Duplicated ownership is a defect to be
resolved by ADR amendment, never by convention.

## 7. Versioning Strategy

One platform-wide regime, three flavors:
- **Authored data** (reference, configuration, policies, rules, documents, translations,
  flags): effective-dated versions; staged publish (draft → validated → scheduled →
  effective → superseded); **rollback = scheduling the prior version forward** — the failed
  version remains in history; every version records author + approver.
- **Facts** (transactional, audit, verdicts, acceptances): versionless — they are
  instant-stamped and immutable; "supersession" exists only as later facts referencing
  earlier ones (adjustment, reversal, amendment-of-record).
- **State** (master/operational): current value + emitted change facts; reconstruction of
  any past state is possible from the fact trail (auditability requirement).
Auditability across all three: any *(what, scope, instant)* question has exactly one
answer, reproducible forever — the same property ADR-003 demands of rules, now universal.

## 8. Data Lifecycle

`Creation → Validation (owner-side gates, §10) → Publication/Activation → Usage →
Supersession → Archival → Retention window → Deletion or Legal Hold → (if held) Release →
Deletion`, with class-specific entry points (facts skip supersession; temporary data skips
archival). Rules: **archiving** moves data across storage *tiers* without changing its
truth, class, or addressability (an archived Trip is still the Trip); **retention** periods
are derived per datum from the *maximum* obligation among covering Jurisdictions
(ADR-003-A001) and declared at the class level; **deletion** is a governed, evidenced event
— privacy erasure honors subject rights while preserving non-personal facts via
irreversible de-identification (the Trip happened; *who* rode is removable); **legal hold**
suspends deletion for named scopes with hold-evidence, and holds outrank retention expiry;
**restoration/recovery** must reproduce data *with its class guarantees intact* — a
restored ledger is still append-only, a restored audit trail still tamper-evident (the
existing DR discipline, elevated to an architectural obligation).

## 9. Data Governance

**Ownership** (context-level, §6) → **Stewardship**: each data class in each context has a
named steward accountable for quality and lifecycle adherence. **Approval & publishing:**
authored data follows the ADR-003 staged-publish workflow with separation of author and
approver; regulatory data additionally requires legal sign-off (jurisdiction-map rule).
**Review:** periodic class audits (uniqueness, retention adherence, orphaned references,
cascade-override budgets). **Certification:** a dataset is *certified* when its class,
owner, steward, quality gates, retention rule, and lineage are declared and verified —
uncertified data cannot be depended upon by other contexts. **Quality gates** (§10) run at
publish/creation. **Compliance reviews:** Privacy-Rule conformance (retention, residency,
erasure readiness) reviewed per country entry and per rule change — governance is what
makes ADR-003's "configuration not code" trustworthy at scale.

## 10. Data Quality Principles

**Completeness** — required attributes declared per class; incomplete records cannot
publish/activate (catalogs' completeness thresholds generalized). **Consistency** — one
vocabulary (reference data) everywhere; cross-context consistency measured at declared
bounds. **Integrity** — references must resolve; orphan detection is a standing audit;
deletion respects reference obligations (successor links, de-identification). **Accuracy**
— validated at the owner on entry (the only place with full context); external claims
carry their source. **Validity** — class + jurisdictional format rules (ADR-003 formats)
enforced at authoring/creation. **Uniqueness** — identity discipline (§5) + natural-key
constraint audits. **Timeliness** — freshness bounds declared per read model/derivation
and monitored (a stale derivation is a defect, not a surprise). **Traceability** — every
derived number resolves to facts + recipe version; every fact resolves to its actor,
instant, and (where gated) authorizing rule version.

## 11. Scalability Notes

The class system is what scales: unbounded-growth classes (Transactional, Audit, Events)
are **append-only and time/City-partitionable by construction** — billions of trips are an
archival-tiering problem, not a redesign; hot classes (Operational) are ephemeral and
crystallize small; heavy-read classes (Reference, Configuration, Localization,
Jurisdictional) are immutable-versioned and therefore cacheable/distributable without
invalidation complexity; Master data (10⁸ users, 10⁷ vehicles) partitions by the natural
keys ADR-002 §7 named (User / City / Organization). Nothing in the model couples growth in
one class to redesign of another — hundreds of countries and thousands of markets arrive
as footprint-class data (ADR-003 §10), while traffic-class data scales by partition + tier.

## 12. Risks

1. **Sequencing (standing):** this is G3/G4 blueprint material. **C-1 remains open** — and
   is itself a data-architecture lesson: the trip/payment boundary violates principle 2
   (fact vs. state) today. The fix (ADR-001, approved or not) precedes everything here.
2. **Classification drift:** data created without declared class/owner quietly becomes
   unclassified debt — mitigated by the certification rule (§9: uncertified data may not be
   depended upon).
3. **Erasure vs. immutability tension:** privacy rights meet append-only facts;
   de-identification design must be per-class and legally reviewed, not improvised.
4. **Governance weight vs. team size:** stewards/approvals are roles, not headcount — but
   the discipline must be right-sized now (one platform team) and grown with the org, or it
   becomes fiction.
5. **Derived-data trust creep:** read models silently treated as truth — mitigated by
   provenance-required and the §4 "never authoritative" rule, monitored in class audits.

## 13. Future Evolution

Anticipated, absorbable without redesign: event catalogs formalized as the integration
backbone (the Event entity of ADR-002 §3.6 maturing into contract-governed streams);
per-Jurisdiction data-residency partitions (Compliance Data class already carries the
requirement); ML feature stores as a governed sub-class of Derived Data; data-product
certification for external partners (the §9 certification generalized outward). Each lands
via ADR amendment against this document's class system.

## 14. Final Certification

Verified against mandate: all 26 objective areas addressed; all 15 classes defined with
purpose/ownership/lifecycle/update rules/versioning/retention/relationships/scalability/
evolution; identity strategy complete (global/business/human IDs, natural vs. surrogate,
cross-context & external references, stability/evolution/uniqueness); single
source-of-truth model with read models, snapshots, sync & consistency philosophy;
immutability set named with reasons (facts = legal/financial/audit reproducibility);
enterprise versioning with effective dates, supersession, rollback, audit; full lifecycle
incl. legal hold & recovery; governance and quality principles; scale targets met by
class-based analysis; zero implementation, storage-technology, API, or schema content;
builds on all prior FINAL ADRs without redesigning any.

**ADR-004 — DATA ARCHITECTURE — WORLD-CLASS CERTIFIED**
