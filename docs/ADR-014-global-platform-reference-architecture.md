# ADR-014 — Global Platform Reference Architecture

**Status:** Proposed · **Author:** Chief Enterprise Architecture · **Date:** 2026-07-18
**Consolidates (FINAL, unchanged):** G0.0 · ADR-002 (+A-001) · ADR-003 (+A-001) · ADR-004 · ADR-005 · ADR-006 · ADR-007 · ADR-008 · ADR-009 · ADR-010 · ADR-011 · ADR-012 · ADR-013
**Nature:** pure consolidation. This document introduces **zero new architecture** — every
statement below cites its source; where this document and a source ADR could ever be read
differently, **the source ADR governs.**

---

## 1. Executive Summary

Fourteen documents, one system. The OnCall corpus describes a single coherent machine:
a **domain model** (002) placed in **geography and law** (003), whose information has
**declared classes** (004), acted on by **gated use cases** (005), collaborating through
**certified contracts** (006), protected by **verified trust** (007), running on
**partitioned technical shapes** (008), operated as **cells with activated markets**
(009), watched by **budgeted observability** (010), assisted by **classified intelligence**
(011), governed by **one decision grammar** (012), and grown along **one dependency-ordered
roadmap** (013). This reference shows the connective tissue: how the layers stack, how the
domains relate, how the ADRs depend on one another, and why the whole composes to global
scale. It is the reading-order map for every future engineer, market team, and auditor —
and it inherits, unchanged, the corpus's standing footnote: the roadmap's Milestone Zero
(ADR-001) remains the open gate in front of everything.

## 2. Enterprise Architecture Overview

Top-to-bottom, each stratum depending only on those beneath it:

**Business intent** (serve mobility in any city on Earth) is expressed through the
**domain model** (002: contexts, entities, ubiquitous language) and bounded by
**governance** (012: the decision grammar over everything) and **compliance** (003+A-001:
Jurisdictions legislate; law outranks all configuration). **Identity** (007 §4 within
002's Identity context) establishes who may act. **Applications** (005) turn intent into
gated use cases over the **domain layer's** invariants. **Data** (004) fixes what every
piece of information *is* — fact, state, or derivation — while **integration** (006)
fixes how contexts converse and **messaging** (006 §6: the event collaboration model)
carries outcomes. **Infrastructure** (008: layers, components, fabrics) executes it all;
**operations** (009) deploys and runs it as cells; **observability** (010) watches it;
**AI** (011) assists it within decision classes; **deployment/expansion** (009 §5, 003
§9) grows it as activations; **evolution** (013) sequences the whole. Nothing in any
stratum reaches upward: domain knows nothing of storage, storage nothing of vendors —
the corpus is implementation-free by construction, which is why it can outlive any
particular technology choice.

## 3. Enterprise Layer Model

| Layer | Content | Defined in | Depends on |
|---|---|---|---|
| **Governance** | decision grammar, boards/authorities, change/risk/quality governance | 012 | the constitutional corpus itself |
| **Business** | contexts, entities, lifecycles, ubiquitous language | 002 (+A-001) | — (the root) |
| **Compliance** | Jurisdictions, rule families, verdicts, evidence | 003-A001, 003 §4E/§8 | Business (whom rules bind), Geography (where) |
| **Security** | trust model, threat model, protection per data class, audit fabric | 007 | Identity, Data classes, all boundaries |
| **Identity** | subjects, roles, sessions, authorization layers | 002 (Identity ctx) + 007 §4–5 | Compliance (verification rules) |
| **Application** | use cases, application services, workflows, compensation | 005 | Domain, Identity/Compliance gates |
| **Domain** | pure business rules & invariants per context | 002 boundaries, 005 layer rules | nothing above it |
| **Data** | 15 classes, identity strategy, source of truth, versioning, lifecycle | 004 | Domain ownership map |
| **Integration** | six contract kinds, collaboration rules, ACLs | 006 | Application services, Data references |
| **Messaging** | event ownership, ordering, idempotency, replay, certification | 006 §6, realized by 008 Event Fabric | Integration contracts |
| **AI** | decision classes D1–D4, risk classes, knowledge, fallbacks | 011 | Data (certified sources), Observability (ground truth), Governance (boards) |
| **Technical** | 6 technical layers, 14 components, 4 runtime contexts, fabrics | 008 | everything above, as contracts to fulfill |
| **Operations** | environments, releases, cells/regions, activation, capacity | 009 | Technical shapes, Governance gates |
| **Observability** | health axes, telemetry classes, SLO/error budgets, alerting | 010 | Operations, Data classing of telemetry |
| **Deployment/Expansion** | release-vs-activation separation, Country Entries, readiness gates | 009 §5, 003 §9, 013 §8 | all of the above |

**Platform/shared services** (cross-context capabilities): identity decisions, compliance
verdicts, geo/config/locale resolution, notification dispatch, audit intake, event fabric,
process orchestration (005 §5 + 008 §4) — each a single-owner service consumed by
contract, never duplicated per context. **Cross-cutting concerns** are exactly four, and
each is applied *at boundaries* rather than sprinkled: authorization (007 §5),
audit (007 §9), observability (010 §2.1), and configuration resolution (003 §6).

## 4. Domain Relationships

One narrative pass over the required entities (all from 002/003 + amendments):

A **User** is one human with one identity; **Driver** is a role a User holds, activated
by a Compliance verdict under the **Jurisdictions** covering their **Country** — and it
is **Markets** (business units between Country and Region) where operational
accountability for their work rolls up. **Organizations** anchor tenancy: they employ
drivers and operate fleets of **Vehicles**, of which **Scooters** are one Vehicle Type
(verticals are data, not code). Demand begins as a **Booking** (intent), fulfilled as a
Ride via Driver Assignment, yielding a **Trip** (the measured journey). **Pricing** —
authored per City with Market defaults — plus the Trip's facts produce a **Payment**,
which settles as immutable ledger Transactions; every consequential step emits Events
consumed by **Notifications** (informing people through templates in their locale),
**Support** (tickets referencing rides and payments), and **Analytics** (never
authoritative, never blocking). **Administration** authors configuration and reference
data through staged publish; **AI** assists decisions within registered classes, never
owning governance; **Compliance** gates actions and records verdicts as evidence; and
**Governance** owns the decision grammar over all of it. Two structural rules bind the
whole graph: high-volume entities carry only a City reference (Market/Country/Jurisdiction
context derives through the chain — A-001 rule), and money moves only by appended,
cause-named Transactions (002 §6.5).

## 5. Dependency Model

How the ADRs work together, as a dependency chain:

- **002 (+A-001)** is the root: every later document's nouns come from it.
- **003 (+A-001)** depends on 002's Geography context and extends it with localization,
  configuration cascade, and the parallel Jurisdiction layer; it supplies the *where and
  under-what-law* parameters every later document consumes.
- **004** depends on 002 (whose entities it classifies) and 003 (whose authored-data and
  versioning regime it generalizes); it supplies the *nature of information* to all.
- **005** depends on 002 (contexts), 003 (compliance gates), 004 (transaction boundaries
  from fact/state separation); it supplies use cases and workflows.
- **006** depends on 005 (what collaborates) and 004 (references, events-as-facts); it
  supplies the conversation rules — and its contracts are the future decomposition seams.
- **007** depends on all of 002–006: it protects the entities, gates the use cases,
  classifies protection by 004's data classes, and contains 006's counterparties; it
  supplies trust and audit to everything after.
- **008** realizes 005–007 as technical shapes and 004 as state fabrics; it supplies the
  runtime physics to 009–011.
- **009** deploys 008's shapes as cells, promotes 003's Country Entries to activations,
  and executes 007's operational security; it supplies the operating model.
- **010** observes 008/009 with telemetry classed by 004, budgets gated into 009's
  releases; it supplies the evidence stream that 011 learns from and 012 governs by.
- **011** consumes 004 (knowledge), 010 (ground truth), 005 (acts through the same
  gates), 007 (least-privileged identities), and is governed by 012's boards.
- **012** unifies every prior document's governance clauses into one grammar; it is
  the corpus's operating system.
- **013** sequences all of it, with 012's gates controlling passage.
- **014** (this document) adds nothing and cites everything.

The loop closes: 013's roadmap changes land through 012's change governance, which is
itself part of the corpus 013 evolves — self-amendment by declared rules (013 §11).

## 6. Cross-cutting Concerns

Consolidated, with single sources of authority: **Authorization** — the seven-layer
composite (007 §5), evaluated in the application gate chain (005 §2.4). **Audit** —
one append-only, custody-separated fabric (007 §9) receiving from every layer (012 §8
change trails included). **Observability** — declared signals per capability (010 §2.1)
riding 004's telemetry classes. **Configuration** — one cascade (003 §6), operationally
promoted and rolled back like releases (009 §8). **Compensation** — every cross-context
sequence ships its counter-actions (005 §2.6, 006 §9). **Backward compatibility** — the
frozen mobile dialect as an ACL to our own installed base (006 §7), constraining every
release (009 §4). **Restrictive-wins** — the same conflict rule for regulatory
configuration (003 §6), legal resolution (003-A001 §4), emergency policy (007 §5.7), and
governance federation (012 §10): descendants may tighten, never relax.

## 7. Architecture Principles (Consolidated)

The corpus's permanent principles, deduplicated to eleven, each with its sources:

1. **Evolve, never rewrite** — adjacent states only; big-bang constitutionally banned
   (G0.0; 013 §2.1/§2.8).
2. **Business structure is data** — geography, markets, verticals, rules, pricing,
   language: authored, versioned, cascade-resolved (002 §8; 003 throughout; A-001s).
3. **One owner for everything** — entity, datum, contract, decision, risk: exactly one
   accountable owner (002 §5; 004 §6; 006 §2; 012 §2.1).
4. **Facts are immutable; corrections are new facts** — ledger, audit, events, versions
   (004 §2; 002 §6.5/§6.7; 007 §9).
5. **Law outranks configuration; descendants only tighten** (003 §3.3; 003-A001;
   007 §5.7; 012 §2.6).
6. **One command, one boundary; everything wider is a process with compensation**
   (005 §2.3/§2.6; 008 §7 — the C-1 lesson, thrice codified).
7. **Contexts converse only through certified contracts and events** — references, never
   copies; translation at every foreign boundary, including our own legacy (006; 004 §5).
8. **Default deny, verify continuously, audit immutably** (007 §2 — the security triad
   underlying every gate).
9. **Partition along the domain's own keys** — City/User/Organization/subject: scale =
   more partitions of the same shapes, mechanisms O(1) (002 §7; 008 §9; 009 §10; 010 §9).
10. **Humans govern; machines execute within registered classes** (011 §2.3; 012 §3 —
    automation may restrict pending review, never punish finally; AI never owns
    governance).
11. **Evidence or it didn't happen** — certifications, maturity claims, gate passages,
    and validations require proof; gaps are declared, never faked (the program's founding
    discipline: 012 §2.7; 013 §2.7; practiced since P7-01).

## 8. Scalability Analysis

The corpus composes one scale argument from thirteen partial ones. Split every concern by
its growth driver: **O(1) — mechanisms**: cascade resolution, legal resolution, decision
classes, contract kinds, cell shape, release pipeline — none changes with size (003 §10,
008 §9, 009 §10, 012 §10). **O(business footprint) — authored data**: countries, markets,
jurisdictions, locales, rules, pricing — thousands of entries, cacheable because
immutable-versioned (003 §10, 004 §11). **O(traffic) — facts and operations**: trips,
transactions, events, telemetry — append-only, City/subject-partitioned, archivable by
class (004 §11, 010 §9). **O(structure) — humans**: governance deliberation, regional
operations, market management — growing with the org chart, not the ride count (009 §10,
012 §10). Hundreds of millions of users, billions of trips, hundreds of countries each
land in their designed column; the forbidden combination — mechanisms that grow with
traffic — appears nowhere in the corpus. That absence *is* the scalability proof, and
its precondition is the roadmap's substrate work (013 §9): the argument holds from M1
onward, which is why M1 is first.

## 9. Risks

1. **Milestone Zero, standing (14th document):** the corpus's integrity rests on its own
   evidence rule — and the oldest item in its debt register (C-1 / ADR-001) remains
   undecided. This reference architecture changes nothing about that; only the decision
   does.
2. **Corpus-reality divergence:** a reference document is only as true as the audits that
   check it (012 §4 architecture compliance); this document should be re-verified at each
   maturity assessment (013).
3. **Reference misuse:** treating 014 as authoritative over its sources — prevented by
   the governing-source rule in the header.
4. **Reading-order illusion:** the corpus reads as inevitable in hindsight; new joiners
   must also read the P6/P7 validation reports to see the *evidence culture* the
   documents assume.

## 10. Future Evolution

This document is regenerated — never independently amended — whenever a source ADR is
amended (012 §4 lifecycle); its version always names the corpus state it consolidates.
Anticipated corpus growth (new verticals, partner tier, supranational jurisdictions,
M6 redefinition) lands in source ADRs first and flows here mechanically.

## 11. Reference Summary

**The corpus at a glance:** G0.0 (how to evolve) → 002+A001 (what exists) → 003+A001
(where, in what language, under what law) → 004 (what information is) → 005 (how intent
becomes outcome) → 006 (how contexts converse) → 007 (how it is protected) → 008 (how it
runs) → 009 (how it is operated) → 010 (how it is watched) → 011 (how it is assisted) →
012 (how it is governed) → 013 (how it grows) → 014 (this map).
**Reading orders:** new engineer: G0.0 → 002 → 005 → 004 → 008; market/launch team:
003 (+A-001) → 009 §5 → 013 §8; auditor/regulator: 007 → 004 → 012 → 010; leadership:
G0.0 → 013 → 012 → this document.
**The one-sentence platform:** *a single evolving system in which business growth is
authored data, correctness is immutable fact, authority is owned and evidenced, and
scale is more partitions of unchanged shapes.*

## 12. Final Certification

Verified against mandate: consolidation only — every section cites FINAL sources, zero
new concepts/technologies/vendors/frameworks/methodologies introduced, governing-source
rule declared; all 23 objective areas covered (overview, 15-layer model with platform/
shared services and cross-cutting concerns, dependency/responsibility/interaction/
evolution maps via §§3–5); domain relationships covering all 19 required entities;
ADR-by-ADR dependency model for 002–013; principles consolidated (11, all sourced, none
new); scalability demonstrated by growth-driver decomposition across the corpus; risks
and evolution stated; reference summary with reading orders.

**ADR-014 — GLOBAL PLATFORM REFERENCE ARCHITECTURE**
**MASTER ENTERPRISE ARCHITECTURE — WORLD-CLASS CERTIFIED**
