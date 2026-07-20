# ADR-002 — OnCall Global Domain Model

**Status:** Certified · **Author:** Chief Domain Architecture · **Date:** 2026-07-18
**Amendments:** A-001 (Market entity — see ADR-002-A001-market-entity.md), applied inline below
**Scope:** business domain model only. No code, no schema, no APIs, no service topology.
**Relation to reality:** every abstraction is anchored to something that exists in production
today (noted as *today:*), so the model is reachable by evolution (G0.0), never by rewrite.

---

## 1. Executive Summary

OnCall today is a single-city (Kuwait), two-vertical (taxi, scooter) product whose implicit
domain concepts — user, driver, trip, taxi, scooter, wallet — are healthy but flat: geography
is an assumption, organizations don't exist, vehicle types are hardcoded verticals, and
pricing lives in one config. This ADR names the full domain, assigns every concept to one of
six bounded contexts with single ownership, and establishes the rules (tenancy through
Organization, place through the Geography chain Country→Market→Region→City→Zone,
**operational accountability through Market** *(A-001)*, money through immutable
Transactions, history through append-only Events) that let countries, markets, cities,
companies, fleets, vehicle types, and whole new services be **added as data and
configuration, not as redesign**.

## 2. Core Domains (Bounded Contexts)

| # | Context | Purpose | Today |
|---|---|---|---|
| 1 | **Geography & Localization** | Where and in what terms service happens: places, languages, currencies, taxes | implicit (Kuwait, KWD, Arabic hardcoded) |
| 2 | **Identity & Access** | Who anyone is and what they may do | users/drivers/admin phones, JWT+RBAC |
| 3 | **Mobility** | Physical movement: vehicles, fleets, demand, matching, journeys | trips, taxis, scooters, driverMatcher |
| 4 | **Commerce** | Every movement of monetary value | wallets, transactions, fareCalculator |
| 5 | **Operations** | Keeping the platform running and customers cared for | notifications, reports, logs, admin tooling |
| 6 | **Analytics** | Learning from the platform without burdening it | analytics service, metrics middleware |

Contexts are **logical boundaries inside the existing modular monolith** — they become
deployment boundaries only if and when load justifies it (G0.0 rule).

## 3. Entity Catalog

Legend: **C** = Core entity, S = Supporting. "GU" = must be globally unique across the whole
platform (vs. unique within its owner). Growth = expected cardinality at global scale.

### 3.1 Geography & Localization

| Entity | Why it exists | Owns | Depended on by | C/S | GU | Growth |
|---|---|---|---|---|---|---|
| **Country** | Legal, regulatory, and currency boundary; nothing operates outside one | Markets, Tax Profiles, default Language/Currency | everything place-bound | C | ✔ | ~10² (bounded) |
| **Market** *(A-001)* | **The operational business unit** between Country and Region: where P&L accountability, management, policy, and growth targets live. Not mere geography — a Market *references* territory but *owns* operations (e.g., Riyadh Market, Eastern Market; today: implicit single "Kuwait Market") | Regional Operations, Market Managers (role scope), Market Policies, Market Configuration, Market Pricing Defaults, Market Analytics/KPIs, Business Goals, its Regions | Regions/Cities (operationally), Organizations (market agreements), Reports (market P&L), city Pricing (inherits defaults) | C | ✔ | ~10³ |
| **Region** | Administrative tier between market and city (state/governorate) for licensing and reporting | Cities | reporting, compliance | S | ✔ | ~10³ |
| **City** | **The operational atom.** Launch, pricing, supply, and P&L happen per city | Zones, city service catalog, city pricing config | Fleets, Rides, Pricing, Drivers' operating scope | C | ✔ | ~10⁴ |
| **Zone** | Sub-city geometry for surge, restrictions (e.g., scooter no-ride/no-park), airport rules | its geometry, zone rules | matching, pricing, scooter parking | S | within city | ~10⁶ |
| **Language** | Localized UX and messages are market-entry requirements (today: Arabic hardcoded — named debt) | translation catalogs | all user-facing text | S | ✔ | ~10² |
| **Currency** | Money is always denominated; multi-country ⇒ multi-currency (today: implicit KWD, 3-decimal) | rounding/denomination rules | Commerce entirely | C | ✔ | ~10² |
| **Tax Profile** | VAT/levies differ per jurisdiction and vehicle class; must be swappable per country/city | tax rules, rates, effective dates | Invoice, Pricing | S | ✔ | ~10³ |

**Ownership rule (as amended by A-001):** the Geography chain is
**Country → Market → Region → City → Zone**. Country/Region/City/Zone remain pure reference
data owned by this context alone; **Market is the operational overlay in the chain** — it
owns business configuration and accountability, while territorial facts stay in the pure
tiers. Other contexts hold references, never copies. City pricing/policy resolve through
Market defaults before Country defaults (nearest-ancestor-wins).

### 3.2 Identity & Access

| Entity | Why it exists | Owns | Depended on by | C/S | GU | Growth |
|---|---|---|---|---|---|---|
| **User** | The person. One identity across countries, roles, and services (today: phone-keyed passenger) | credentials, profile, consents, linked Devices | Rides, Wallet, Notifications, everything personal | C | ✔ | 10⁸+ |
| **Driver** | A *role/capability* a User holds: licensed to supply mobility, with an approval lifecycle (today: separate drivers table with approval workflow — converges to role-on-User) | licenses, approval state, vehicle qualifications, performance record | Assignment, Fleet, payouts | C | ✔ (via User) | 10⁶ |
| **Fleet Manager** | Role managing a Fleet's vehicles/drivers on behalf of an Organization (new capability) | fleet-scoped permissions | Fleet operations | S | via User | 10⁵ |
| **Support Agent** | Role handling Tickets/Incidents with scoped data access (today: admin does everything — must be separated) | ticket queues | Operations context | S | via User | 10⁴ |
| **Administrator** | Platform/city governance role (today: ADMIN_PHONES env — becomes managed role) | elevated permissions, audit obligations | all contexts (governed) | S | via User | 10³ |
| **Organization** | **The tenancy anchor.** Companies: fleet operators, corporate customers, franchise partners. Absence today is the largest gap between OnCall and a platform | Fleets, org Wallets, members' org-roles, Subscriptions | Mobility supply, B2B Commerce | C | ✔ | 10⁵ |
| **Role** | Named bundle of permissions; the vocabulary of authority (today: 3 hardcoded roles) | its Permission set | every authorization decision | S | per scope | ~10² |
| **Permission** | Atomic capability; roles compose them so new roles need no code | — | Roles | S | ✔ | ~10³ |

**Ownership rule:** a person is exactly one User; Driver/Manager/Agent/Admin are roles scoped
to a City or Organization — never duplicate identities (the current user/driver split is a
named legacy to converge, not to replicate globally).

### 3.3 Mobility

| Entity | Why it exists | Owns | Depended on by | C/S | GU | Growth |
|---|---|---|---|---|---|---|
| **Vehicle Type** | Makes verticals data, not code: taxi, scooter, bike, van, luxury… each with capacity/licensing/pricing traits (today: taxi & scooter are code paths — the key unlock) | type traits, requirements | Vehicles, Pricing, Booking options | C | ✔ | ~10² |
| **Vehicle** | The physical asset with identity, ownership, and history (today: taxis + scooters tables — converge) | its state, position, Maintenance/Inspection history | Assignment, Rides, Fleet | C | ✔ | 10⁷ |
| **Fleet** | Operated group of Vehicles under one Organization in one City; unit of supply management | vehicle memberships, fleet policies | Organization P&L, city supply | C | ✔ | 10⁵ |
| **Booking** | The customer's *intent*: what, where, when (now or scheduled) — exists before and independent of fulfillment (today: fused into trip request — separating enables scheduling, multi-modal offers) | request details, offer/acceptance state | Ride creation, demand analytics | C | ✔ | 10⁹/yr |
| **Ride** | The *fulfillment engagement*: one service episode connecting Booking ↔ supply; owns the customer-facing state machine (today: `trips` rows ≈ Booking+Ride+Trip fused) | status lifecycle, Driver Assignment, resulting Trip | Payment, Rating, support context | C | ✔ | 10⁹/yr |
| **Trip** | The *physical journey record*: route actually driven, distance, duration — the measured fact used for pricing and disputes (distinct from Ride: a Ride can end with no Trip — cancellation) | Route, telemetry summary | fare settlement, Analytics | C | ✔ | 10⁹/yr |
| **Route** | Planned vs. actual path; navigation and evidence | waypoints, deviations | Trip, ETA models | S | per Trip | 10⁹/yr |
| **Driver Assignment** | The matching *decision* as first-class record: who was offered/accepted/rejected and why (today: implicit in driverMatcher + rejected_drivers JSON) | offer/response events | dispatch fairness, driver earnings, ML | S | ✔ | 10¹⁰/yr |

**Ownership rule:** Mobility owns movement state; it references money (Commerce) and people
(Identity) but never stores balances or credentials.

### 3.4 Commerce

| Entity | Why it exists | Owns | Depended on by | C/S | GU | Growth |
|---|---|---|---|---|---|---|
| **Wallet** | Stored value per owner (User or Organization) per Currency (today: phone-keyed single-currency) | balance, holds | Payments, refunds, payouts | C | ✔ | 10⁸ |
| **Transaction** | **Immutable ledger line** — the source of financial truth; balances are derivations (today: transactions table, correct instinct) | amount, type, links to cause (Ride/Invoice/Promotion) | audit, reconciliation, Invoice | C | ✔ | 10¹⁰/yr |
| **Payment** | An attempt to settle an obligation via an instrument (wallet, cash, card, external PSP); retries and failures are its lifecycle (today: wallet/cash inline in trip completion — C-1 taught us this must be explicit) | attempt state, PSP references | Ride settlement, Invoice | C | ✔ | 10⁹/yr |
| **Invoice** | The legal/tax document aggregating charges (required for B2B and many jurisdictions; absent today) | line items, Tax Profile application | Organizations, accounting export | S | ✔ | 10⁹/yr |
| **Pricing** | Versioned rule set per City × Vehicle Type (base, distance, time, surge, minimums) (today: single FARE_CONFIG — becomes data) | rule versions, effective windows | fare estimation & settlement | C | per city×type | 10⁵ versions |
| **Promotion** | Acquisition/retention incentives with rules, budgets, and fraud limits (absent today) | eligibility rules, redemption records | Pricing application, growth teams | S | ✔ | 10⁴ |
| **Subscription** | Recurring commercial relationships: passes for riders, SaaS-like plans for Organizations (absent today) | plan terms, renewal state | recurring billing | S | ✔ | 10⁷ |

**Ownership rule:** only Commerce mutates monetary state, and only by appending Transactions.
Every money movement names its cause. Nothing else in the platform touches a balance.

### 3.5 Operations

| Entity | Why it exists | Owns | Depended on by | C/S | GU | Growth |
|---|---|---|---|---|---|---|
| **Notification** | Auditable record of platform→person communication (today: notifications table + FCM) | content, delivery state | engagement, support evidence | S | ✔ | 10¹⁰/yr |
| **Device** | A person's app installation: push target, session context, fraud signal (today: device_tokens) | tokens, platform metadata | Notifications, security | S | ✔ | 10⁸ |
| **Support Ticket** | Tracked conversation to resolution (today: reports table — one-shot, no conversation; upgrade path) | thread, status, links to Ride/Payment | customer trust, SLAs | S | ✔ | 10⁸/yr |
| **Maintenance** | Scheduled/corrective work orders keeping Vehicles serviceable (absent today; fleets require it) | work records, costs | Vehicle availability, safety | S | ✔ | 10⁷/yr |
| **Inspection** | Point-in-time conformity check (regulatory, damage, onboarding) distinct from repair | findings, verdicts | Vehicle/Driver eligibility | S | ✔ | 10⁷/yr |
| **Incident** | Safety/security event (accident, assault claim, data issue) with severity and obligations (today: P6-03 crash reporting covers only software) | timeline, parties, resolution | legal, insurance, trust | C | ✔ | 10⁵/yr |
| **Audit Log** | **Append-only record of privileged actions** — who did what to whom, when (today: driver_approval_logs + security log; generalizes) | immutable entries | compliance, forensics | C | ✔ | 10⁹/yr |

### 3.6 Analytics

| Entity | Why it exists | Owns | Depended on by | C/S | GU | Growth |
|---|---|---|---|---|---|---|
| **Event** | Immutable business fact ("ride_completed") emitted by owning contexts; the raw material of learning and future integration | payload, provenance | Metrics, Reports, ML, future context-to-context integration | C | ✔ | 10¹¹/yr |
| **Metrics** | Aggregations answering operational questions (today: Prometheus + in-app metrics) | definitions, series | dashboards, alerts, SLOs | S | per definition | 10⁴ series |
| **Reports** | Curated periodic views for humans: city P&L, fleet utilization, regulator submissions | report definitions, generated instances | management, partners, compliance | S | ✔ | 10⁶/yr |

**Ownership rule:** Analytics is read-only downstream — it may never be a dependency of a
transaction path.

## 4. Domain Relationships (high level)

- Geography frames everything: User *lives in* / Ride *happens in* a City; Zone modulates it.
- *(A-001)* Markets frame **operations**: every City belongs to exactly one Market; Market
  Managers, policies, pricing defaults, KPIs, and P&L roll up City→Market→Country; a Ride
  is *operationally accountable* to its City's Market without carrying any new reference.
- Identity supplies actors: User —(role)→ Driver; Organization —employs→ Drivers, —operates→ Fleets.
- Demand meets supply: User creates **Booking** → Mobility produces **Ride** via **Driver
  Assignment** (Driver + Vehicle) → Ride yields **Trip** (with Route).
- Movement becomes money: Trip + Pricing (+ Promotion, Tax Profile) → **Payment** →
  **Transaction**(s) → optionally **Invoice**; Wallets are views over Transactions.
- Everything emits: every state change publishes an **Event**; privileged acts also write
  **Audit Log**; people are reached via **Notification** to **Device**; exceptions become
  **Tickets/Incidents**; assets cycle through **Maintenance/Inspection**.

## 5. Bounded Contexts — boundaries & translation

Each context owns its entities exclusively; cross-context knowledge travels by **reference
(ID) + Events**, never by shared mutable state. Where vocabularies collide, the consumer
translates (e.g., Commerce sees a Ride only as "a billable cause"; Mobility sees a Wallet
only as "a payment capability"). Today all six live in one deployable — the boundary is a
discipline enforced in module structure and review, which is precisely what makes later
physical separation *possible* without being *mandatory*.

## 6. Domain Principles

1. **Geography is data.** Launching city #2 (or country #2) is configuration + reference
   data, never a branch in code.
2. **One person, one User; capabilities are roles.** No duplicate identities per vertical.
3. **Organization is the tenancy anchor** for everything B2B; personal use is the degenerate
   single-member case, not a separate model.
4. **Intent ≠ fulfillment ≠ journey ≠ money:** Booking, Ride, Trip, Payment are distinct
   lifecycles; fusing them is how today's C-1 class of defects became possible.
5. **Money moves only by appended Transaction with a named cause.** Balances are derived.
6. **Verticals are Vehicle Types.** "Add bikes" = new type row + pricing rules, no redesign.
7. **History is append-only** (Transactions, Events, Audit) — corrections are new records.
8. **Contexts integrate via Events + references**; synchronous coupling across contexts is
   the exception, justified case-by-case.
9. **Backward compatibility is a domain invariant** — the deployed Flutter fleet is part of
   the domain reality (G0.0 frozen-contract rule).

## 7. Scalability Notes

- Natural partition keys fall out of the model: operational data by **City**, personal data
  by **User**, commercial data by **Organization** — the PG-era sharding story needs no new
  concepts. *(A-001)* **Market is the natural rollup and residency tier above City**:
  analytics aggregation, management reporting, and (where law requires) data-residency
  groupings operate per Market without touching transactional partitioning.
- Unbounded-growth entities (Trips, Transactions, Events, Assignments) are append-only by
  principle 7, making them archivable/tierable without semantic loss.
- Hot-path entities (Ride state, Vehicle position, Assignment offers) are ephemeral-state
  candidates (Redis-era), while their outcomes persist as facts.

## 8. Future Expansion Strategy

New **service verticals** (delivery, rentals, shuttles, public-transit ticketing) reuse
Booking/Ride/Trip with new Vehicle Types and pricing rules; a parcel is a Booking whose
"passenger" is cargo. New **market entries** are Geography rows + a Market unit (managers,
policies, pricing defaults, goals) + Tax Profiles + localized catalogs *(A-001)*.
New **business models** (franchise, white-label) are Organization structures + Role scopes.
The test for any proposal: *can it land as new reference data, a new role, a new Vehicle
Type, or a new Event consumer?* If it demands a new fundamental concept, it returns here as
an ADR-002 amendment.

## 9. Risks

1. **Model ambition vs. migration order:** none of this may leapfrog G1 (C-1 fix) and G3
   (PostgreSQL) — the model waits for the substrate; attempting Organization/multi-city on
   SQLite would recreate the debt this ADR exists to retire.
2. **Legacy convergence (users vs. drivers, taxis vs. scooters)** requires careful additive
   migration under the frozen API contract — the app must never notice.
3. **Over-abstraction hazard:** entities marked *absent today* (Invoice, Subscription,
   Maintenance…) must be built when a real market demands them, not speculatively — the
   catalog is a map, not a work order.
4. Kuwait-specific assumptions (3-decimal KWD, phone-as-identity, Arabic-only) are deeper
   than they look; each is named debt with an owner context above.

## 10. Final Certification

Model reviewed against: unlimited countries/cities/users/companies/fleets/vehicle types/
future services — each satisfied by data-growth, not redesign (§8 test). Grounded in the
production system at every point; violates no G0.0 preservation rule; prescribes no
implementation.

**ADR-002 — GLOBAL DOMAIN MODEL CERTIFIED**
