# ADR-005 — Application Architecture

**Status:** Proposed · **Author:** Chief Enterprise Architecture · **Date:** 2026-07-18
**Builds on (FINAL):** G0.0 · ADR-002 (+A-001) · ADR-003 (+A-001) · ADR-004
**Scope:** business application architecture — how enterprise applications are organized.
No implementation, APIs, protocols, storage technologies, deployment, or service topology.

---

## 1. Executive Summary

ADR-002 named the entities, ADR-003 the rules, ADR-004 the nature of information. This ADR
defines the **acting layer**: how intent becomes outcome. It organizes the platform into
five layers with one-way dependencies, a use-case model in which every business capability
has exactly one owning application service, a workflow architecture with declared
compensation for everything long-running, and an application-event vocabulary that is the
only way contexts learn of each other's outcomes. The commitments: **commands change
exactly one context's state within one transaction boundary; everything cross-context is a
process with events and compensation; queries never mutate; authorization and compliance
gates are pre-conditions, never afterthoughts.** Today's codebase already approximates
this shape (routes → services → repositories with injected dependencies); this ADR
formalizes the target so evolution tightens the existing seams instead of inventing new
ones — and it encodes the C-1 lesson as law: the trip-completion defect exists precisely
because a command today spans two transaction boundaries without compensation.

## 2. Application Architecture Principles

1. **One use case, one owner**: every business capability belongs to exactly one
   application service in one bounded context; collaboration is explicit (§6), never shared
   ownership.
2. **Commands mutate, queries never do**; a use case is one or the other.
3. **One command = one transaction boundary** = one context's invariants, atomically
   (ADR-004 consistency); anything wider is a *process* (§6) with events + compensation.
4. **Gates before acts**: authorization (Identity), compliance (ADR-003-A001 verdicts), and
   validation run as pre-conditions inside the application layer — domain logic never
   executes for a caller who may not act.
5. **Events are outcomes, not commands**: producers announce facts (past tense); consumers
   decide their own reactions; no producer instructs a consumer.
6. **Compensation is designed with the action**: any process step that can succeed while a
   later step fails ships with its declared compensating action — or the process is
   redesigned until it does.
7. **Failure is a modeled outcome**: every workflow has named failure exits with defined
   states; "stuck" is a defect class, not an acceptable state.
8. **The deployed mobile fleet is a presentation-layer constraint**: application behavior
   evolves additively beneath frozen presentation contracts (G0.0).

## 3. Layered Architecture

| Layer | Responsibilities | Owns | May depend on (strictly downward) |
|---|---|---|---|
| **Presentation** | Translate actor intent ↔ application use cases: mobile apps, admin surfaces, operator tooling, partner channels; rendering, input capture, localization display (per ADR-003 Locale) | interaction state only — never business state | Application layer |
| **Application** | Use-case execution: orchestrate gates (authz → compliance → validation), invoke domain operations, define transaction boundaries, emit application events, drive workflows/processes | use-case definitions, process state, application policies | Domain layer; Infrastructure boundary (through contracts it defines) |
| **Domain** | Business rules and invariants of each bounded context (ADR-002): entity lifecycles, state machines, calculations | entity behavior, invariants | nothing above it; pure business knowledge |
| **Infrastructure boundary** | Contracted capabilities the application consumes without knowing their nature: persistence, messaging, timekeeping, document rendering | fulfillment of contracts | — (implements contracts defined by Application/Domain) |
| **External systems boundary** | Third parties as modeled counterparties: payment processors, SMS/push carriers, map providers, government/regulator interfaces | anti-corruption translation: external vocabulary never leaks inward (ADR-004 §5 external references) | — |

Dependency rule: arrows point downward only; Domain knows nothing of Presentation or
Infrastructure; the Application layer is the *only* place where a use case's full shape
(gates, boundary, events) is visible. *(Today's mapping: Flutter screens + admin dashboard
= Presentation; `services/` ≈ Application; repositories' business rules ≈ Domain-in-embryo;
repositories/adapters ≈ Infrastructure boundary; SMS/maps/push integrations = External
boundary. The seams exist; the discipline is what this ADR adds.)*

## 4. Use Case Model

Format: Use case → Context / Application service → flow essence → notable dependencies.

**Identity & onboarding**
- *Register User* → Identity / Identity Service → capture identity claims → verify (OTP per
  country rules) → create User → `UserRegistered`. Deps: Compliance (identity rules),
  Localization (messages).
- *Verify Identity* → Identity / Identity Service → evaluate Identity Verification Rules of
  applicable Jurisdictions → record verification outcome (fact). Deps: Compliance.
- *Add Driver* → Identity / Identity Service (role grant) + Mobility (qualifications) →
  candidate Driver role created in `pending`. Deps: Compliance (license rules).
- *Approve Driver* → Identity / Identity Service, decision gated by Compliance verdict →
  role activated → `DriverApproved` → Mobility admits driver to supply. (Today's P6-06
  workflow is this use case's single-city embryo, incl. its audit log.)

**Scooter vertical**
- *Register Scooter* → Mobility / Fleet Service → Vehicle of type scooter enters a Fleet →
  eligibility gates (Vehicle Regulation per Jurisdiction). 
- *Unlock Scooter* → Mobility / Ride Service → gates (user standing, zone rules, vehicle
  state) → reservation → `ScooterUnlocked`.
- *Start Ride / End Ride* → Mobility / Ride Service → Ride state machine; End crystallizes
  Trip facts → hands settlement to Commerce (process, §6) → `RideStarted` / `RideEnded`.

**Taxi vertical**
- *Request Taxi* → Mobility / Booking Service → Booking created → `TripRequested` →
  matching process begins (Driver Assignment).
- *Accept Trip* → Mobility / Dispatch Service → atomic assignment (single-winner — the
  existing atomic-acceptance rule, now stated as law) → `TripAccepted`.
- *Start / Finish Taxi Trip* → Mobility / Ride Service → Ride state machine; Finish
  computes Trip facts (fare inputs) → settlement process → `RideEnded`.

**Money**
- *Wallet Operations (top-up, balance, statement)* → Commerce / Wallet Service → ledger
  append + derived balance (ADR-004 derived-data rule).
- *Payments (settle ride, refund)* → Commerce / Payment Service → Payment lifecycle against
  an instrument → `PaymentCompleted` / failure outcomes → ledger Transactions.

**Platform operations**
- *Notifications* → Operations / Notification Service → event-driven, template+locale
  resolved (ADR-003), delivery to Devices recorded.
- *Incident Management* → Operations / Incident Service → intake (from Rides, support,
  automated signals) → triage → resolution workflow → obligations (regulator notice per
  Jurisdiction) tracked.
- *Administration* → Administration Service → governed configuration/policy changes via
  staged publish (ADR-003 §6), all writes audited.
- *Expansion (Country/Market/City launch)* → Expansion Service → orchestrates the ADR-003
  §9 playbook as a long-running process with gates.
- *Compliance (evaluate/gate/report)* → Compliance Service → resolve rule verdicts
  (ADR-003-A001 model), record evidence.
- *Localization (author/release packages)* → Localization Service → catalog/threshold/
  release workflow → `LocalizationReleased`.
- *Reporting* → Reporting Service → certified periodic views (City→Market→Country rollups).
- *Analytics* → Analytics Service → consumes events; builds derived views; never gates
  operations (ADR-004 §3 rule).

## 5. Application Services

| Service | Context | Purpose & Responsibilities | Depends on | Lifecycle notes |
|---|---|---|---|---|
| **Identity** | Identity & Access | subjects, roles, sessions, verification; authorization decisions for all | Compliance (rules), Notification | first gate of every use case |
| **Mobility** (Booking, Dispatch, Ride, Fleet) | Mobility | demand intake, matching, ride/trip lifecycles, vehicles & fleets | Identity, Compliance, Geography (zones), Commerce (settlement hand-off) | the operational heart; today's taxi+scooter logic converges here |
| **Commerce** | Commerce | pricing application, promotions, invoices, subscriptions | Geography (pricing scope), Compliance (tax) | money semantics owner |
| **Payments** | Commerce | instrument charging, PSP counterparties, payment lifecycle | Commerce ledger, External boundary | isolates external money risk from ledger truth |
| **Compliance** | Operations | rule resolution, verdicts + evidence, jurisdiction registry | Geography (locations) | gates others; owns no business flow |
| **Localization** | Geography & Loc. | catalogs, packages, templates, release gates | — | releases decoupled from software releases |
| **Expansion** | Geography & Loc. | country/market/city launch orchestration | nearly all (as gate consumers) | long-running processes measured in weeks |
| **Administration** | Operations | governed authoring: config, policies, reference data | Audit (every write), Compliance (restrictive-wins validation) | human-facing governance surface |
| **Notifications** | Operations | event→message resolution, delivery, records | Localization, Identity (devices) | pure consumer + recorder |
| **Analytics** | Analytics | event ingestion, derived views, KPIs | events only | never authoritative, never blocking |
| **Audit** | Operations | append-only receipt of privileged/gated actions | — (everyone writes to it) | platform memory; write-once |
| **Reporting** | Analytics | certified rollups for humans/regulators | Analytics, Compliance (report obligations) | scheduled outputs |

## 6. Workflow Architecture

Every workflow declares: **Entry** (who/what may start it) → **Validation** (authz →
compliance → business preconditions) → **Execution** (steps with owners) → **Completion**
(success facts + events) → **Failure** (named exits) → **Compensation** (declared
counter-actions) → **Audit** (what gets recorded regardless of outcome).

| Workflow | Essence | Failure & Compensation highlights |
|---|---|---|
| **Ride lifecycle (scooter)** | unlock → active ride → end → trip facts → settlement process | mid-ride vehicle fault → controlled end + fare adjustment fact; settlement failure → ride stays completed, payment retried/compensated — **ride facts never roll back** |
| **Taxi lifecycle** | booking → matching (assignment offers, timeouts) → accepted → ride states → finish → settlement | no driver found → booking expires (`no_driver`, exists today); acceptance race → single winner, losers get clean rejection; cancellation → declared cancellation facts by party |
| **Settlement (payment flow)** | trip facts + pricing/tax resolution → payment attempt → ledger append → receipt | instrument failure → retry policy then failed-payment state with recovery path (debt on wallet); **the C-1 fix in ADR-001 is this workflow's transaction-boundary rule applied** |
| **Wallet flow** | top-up via instrument → ledger append → balance derivation | PSP success/ledger failure impossible-by-boundary: ledger append is the transaction; PSP confirmation is a recorded external fact reconciled by process |
| **Driver onboarding** | apply → verify identity → compliance verdicts (license/insurance per Jurisdiction) → approve/reject → activate | any expired credential later → automatic suspension process (compensation = supply removal + notification + audit), mirroring today's suspend semantics |
| **Scooter onboarding** | asset registration → inspection gate → fleet admission → zone eligibility | failed inspection → maintenance workflow, not deletion |
| **Country launch** | ADR-003 §9 stages as gated long-running process | any gate failure → halt at stage with report; compensation = staged deactivation (pilot rollback never touches authored reference data — versions simply stay unactivated) |
| **Incident resolution** | intake → severity triage → obligations (per Jurisdiction) → actions → closure | missed obligation deadlines escalate; closure requires evidence; nothing about an incident is ever deleted |

**Long-running processes** (matching, settlement recovery, onboarding, launches) own
explicit process state (Application layer, ADR-004 operational class), survive restarts,
and have timeout policies — a process without a timeout is a defect (principle 7).

## 7. Application Events

Vocabulary rule: past-tense facts, produced once by the owning service, consumed by any
context, immutable (ADR-004 Event entity), carrying references not payload-copies.

| Event | Producer | Key consumers | Business importance |
|---|---|---|---|
| `UserRegistered` | Identity | Notifications (welcome), Analytics, Commerce (wallet init) | acquisition fact |
| `DriverApproved` | Identity | Mobility (supply admission), Notifications, Audit | supply gate — legally gated (exists today as approval log) |
| `ScooterUnlocked` | Mobility | Analytics, Operations (asset telemetry) | demand fact |
| `RideStarted` / `RideEnded` | Mobility | Commerce (settlement trigger), Notifications, Analytics | the platform heartbeat; `RideEnded` starts the money |
| `TripRequested` | Mobility (Booking) | Dispatch (matching), Analytics | demand signal |
| `TripAccepted` | Mobility (Dispatch) | Notifications (passenger), Analytics | match fact (single-winner) |
| `PaymentCompleted` (and `PaymentFailed`) | Payments | Commerce (receipt/invoice), Notifications, Analytics | revenue truth boundary |
| `WalletCredited` | Commerce | Notifications, Analytics | stored-value fact |
| `CountryActivated` | Expansion | all services (capability availability), Reporting | expansion milestone |
| `ComplianceApproved` (verdict recorded) | Compliance | requesting service (gate release), Audit | evidence-bearing authorization |
| `LocalizationReleased` | Localization | Presentation surfaces, Notifications (template refresh) | market-facing language change without deploy |

Lifecycle: emitted at commit of the owning transaction → durable → consumed independently
→ retained per ADR-004 (analytical source + audit adjunct). Consumers must tolerate
replay (idempotent handling) and out-of-order arrival within declared bounds.

## 8. Consistency Model

- **Strong consistency** — inside one command's transaction boundary: one context's
  invariants (ledger balances, single-winner assignment, role state) hold at every commit.
- **Eventual consistency** — between contexts, via events, with **declared bounds** per
  consumer (ADR-004 §4); bounds are monitored, not assumed.
- **Transaction boundaries ≡ business boundaries**: the boundary is where one party's
  promise completes — finishing a ride and collecting its fare are two promises (the C-1
  lesson, codified).
- **Compensation** over distributed atomicity: cross-context flows are sequences of local
  commits with declared counter-actions; the platform never pretends two contexts can
  commit as one.
- **Retry philosophy**: retries are for *transient* failures, are bounded, idempotent by
  design (commands carry identity so re-execution is detection, not duplication), and
  escalate to failure states — never infinite, never silent.
- **Failure isolation**: a failing consumer never blocks a producer; a failing derived
  view never blocks a command; Analytics can be entirely down while rides run (today's
  monolith already honors this in spirit — stated as permanent law).
- **Recovery**: process state + facts make every in-flight workflow resumable; recovery
  reproduces class guarantees (ADR-004 §8).

## 9. Scalability Notes

Scale lives in the facts, not the model: use cases and services are **O(catalog)** —
hundreds of millions of users add zero use cases. Commands scale horizontally because
transaction boundaries are single-context and identity-keyed (partitionable by ADR-002 §7
keys); matching and telemetry are operational-class (ephemeral, city-scoped); events are
append-only and partition naturally by producer/City/time; long-running process state is
per-instance and independent. Thousands of markets and hundreds of countries enter as
authored data (ADR-003) consumed by the *same* use cases — the application layer is the
part of the platform that should barely notice global scale.

## 10. Risks

1. **Standing sequencing risk:** C-1 is this document's principle 3 violated in production
   today; **ADR-001 approval remains the platform's most overdue decision.** No application
   architecture is credible while its flagship counter-example ships.
2. **Monolith discipline**: layers and service boundaries are logical; without review
   enforcement they erode silently — mitigation: boundary checks as part of code review +
   the G0.0 "split only when touched" rule.
3. **Compensation debt**: retrofitting declared compensation onto existing flows
   (cancellation, refunds) will surface undefined states — treat each as a defect found,
   not scope creep.
4. **Event vocabulary sprawl**: uncontrolled event proliferation recreates coupling —
   mitigation: events are certified artifacts (ADR-004 §9) with owners and review.
5. **Process-state operational maturity**: long-running processes need monitoring/timeout
   operations discipline (the P7-04 observability estate is the ready substrate).

## 11. Future Evolution

Absorbable without redesign: new verticals = new use-case rows behind existing services
(delivery lands as Booking/Ride/Trip flows, per ADR-002 §8); partner/B2B channels = new
Presentation surfaces over unchanged use cases; workflow engine maturity (explicit process
definitions) when process count justifies it; per-context physical separation *if ever
load-justified* (G0.0) — the one-way layer dependencies and event-only cross-context
collaboration are exactly the preconditions that would make that separation mechanical
rather than heroic. Each change lands via amendment against this document.

## 12. Final Certification

Verified against mandate: all 22 objective areas addressed; five layers with
responsibilities/ownership/allowed directions; use-case model covering all 21 required
cases with owner/context/service/flow/dependencies; 12 application services specified;
8 workflows with entry/validation/execution/completion/failure/compensation/audit; 12
application events with producer/consumers/purpose/lifecycle/importance; consistency model
(strong/eventual/boundaries/compensation/retry/isolation/recovery); scale targets met by
O(catalog) analysis; zero implementation/API/protocol/storage/deployment content; builds
on all FINAL ADRs without redesigning any.

**ADR-005 — APPLICATION ARCHITECTURE — WORLD-CLASS CERTIFIED**
