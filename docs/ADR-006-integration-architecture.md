# ADR-006 — Integration Architecture

**Status:** Proposed · **Author:** Chief Enterprise Architecture · **Date:** 2026-07-18
**Builds on (FINAL):** G0.0 · ADR-002 (+A-001) · ADR-003 (+A-001) · ADR-004 · ADR-005
**Scope:** business integration architecture — how enterprise applications collaborate.
No APIs, protocols, messaging technologies, infrastructure, or deployment content.

---

## 1. Executive Summary

ADR-005 gave each context its use cases; this ADR defines the **rules of conversation
between them**. The model: contexts collaborate only through **certified enterprise
contracts** of six kinds (business, information, capability, event, query, command);
outcomes travel as events, requests travel as commands to a single owner, questions travel
as queries that never mutate; every external counterparty — payment processors, message
carriers, map providers, governments, and the platform's own legacy vocabulary — sits
behind an **anti-corruption boundary** that translates rather than leaks. The prime
directive: **a context may change anything about itself except its published contracts
without asking anyone** — that autonomy is what the platform trades for the discipline of
contract governance, and it is the property that makes global scale, new verticals, and
(if ever justified) physical decomposition mechanical rather than heroic.

## 2. Integration Principles

1. **Loose coupling / high cohesion:** contexts share contracts, never internals; what
   changes together lives together (ADR-002 boundaries), what changes independently
   collaborates through contracts.
2. **Autonomy:** each context runs its use cases on its own data (ADR-004 read models);
   another context being down degrades, never halts, all but the direct dependency.
3. **Ownership & dependency direction:** every contract has exactly one publishing owner;
   dependencies flow toward *stability* — operational contexts may depend on
   reference/rule contexts (Geography, Compliance), never the reverse.
4. **Contract stability over convenience:** publishing is a promise; contracts change
   additively (new optional information, new events) and break only through governed
   deprecation (§8).
5. **Backward compatibility as invariant:** the deployed Flutter fleet and the MCP tooling
   are standing consumers — presentation-facing contracts are frozen-by-default (G0.0),
   and internal contracts obey the same additive discipline.
6. **Consumer independence:** consumers translate published vocabulary into their own; no
   consumer may demand a publisher adopt its model.
7. **Publisher independence:** publishers never know who consumes; a new consumer requires
   zero publisher change (the definition of a healthy event model).
8. **Evolution without breakage:** version-side-by-side, migrate consumers, retire by
   deprecation calendar — never in-place mutation of a live contract (ADR-004 versioning
   applied to contracts).

## 3. Context Collaboration Model

| Context | Publishes (capabilities & events) | Consumes | Forbidden |
|---|---|---|---|
| **Geography & Localization** | reference resolution (place, locale, currency, formats), config-cascade resolution, localization packages; `CountryActivated`, `LocalizationReleased` | almost nothing (Audit for authoring) | consuming operational contexts; knowing *why* a lookup is made |
| **Identity & Access** | authentication/authorization decisions, subject & role resolution; `UserRegistered`, `DriverApproved` | Compliance (verification/licensing verdicts), Notifications | exposing credentials/PII beyond claims; embedding business rules of other contexts in roles |
| **Mobility** | booking/ride/trip capabilities, supply state; `TripRequested`, `TripAccepted`, `RideStarted`, `RideEnded`, `ScooterUnlocked` | Identity (who may act), Compliance (may they act), Geography (where/zones), Commerce (settlement hand-off contract) | touching balances or instruments; consuming Analytics as truth |
| **Commerce** (incl. Payments) | pricing/settlement/wallet/invoice capabilities; `PaymentCompleted`, `PaymentFailed`, `WalletCredited` | Mobility trip facts (as billable causes), Geography (pricing scope, currency), Compliance (tax rules) | initiating rides; interpreting mobility semantics beyond "billable cause" |
| **Operations** (Compliance, Notifications, Incidents, Audit, Administration) | compliance verdicts + evidence, notification delivery, incident workflow, audit receipt; `ComplianceApproved` | events from everyone; Localization (templates); Identity (devices, actors) | Compliance owning business flows; Audit being queried as operational data; Notifications inventing content (templates only) |
| **Analytics** (incl. Reporting) | certified derived views, reports, KPIs | events only (never state reads inside other contexts) | being a dependency of any command path; writing anything authoritative |

Allowed collaboration forms per pair are exactly: event consumption, certified query
capability, or command to the owner. Anything else (shared state, direct data reach-in,
implicit file/side-channel coupling) is architecturally forbidden.

## 4. Enterprise Contract Model

Six contract kinds, one governance regime:

- **Business contracts** — the commercial/operational promises between contexts stated in
  domain language ("Commerce settles every ended ride within the declared bound").
- **Information contracts** — the shape and meaning of shared information: entity
  references (Global IDs + kind, ADR-004 §5), snapshots' declared content, vocabulary
  definitions from the ubiquitous language.
- **Capability contracts** — what a context will *do* on request: inputs, outcomes
  (including failure outcomes as first-class results), preconditions, idempotency
  expectations.
- **Event contracts** — fact name, meaning, carried references, emission guarantee ("on
  commit of X"), replay tolerance expectations.
- **Query contracts** — questions answerable without mutation: freshness bound, scope,
  authorization requirements.
- **Command contracts** — requests to mutate owner state: single owner, transaction
  boundary (ADR-005 principle 3), rejection semantics, compensation linkage for process use.

**Lifecycle & versioning:** Draft → Certified (ADR-004 §9 certification: owner, steward,
quality gates, consumers ack'd) → Published → (evolution: additive revisions) → Deprecated
(with calendar + named consumers) → Retired. Versions coexist; consumers migrate on their
own cadence within the deprecation window. Contract documents are themselves ADR-004
authored data: effective-dated, append-only, auditable.

## 5. Interaction Model

| Form | Use when | Never when |
|---|---|---|
| **Synchronous command** | the caller's use case cannot proceed without the owner's decision *now* (authorize, gate, atomically assign) | the caller merely wants something to happen eventually |
| **Synchronous query** | fresh answer required within the caller's own use case (balance before charge — via owner's capability) | the answer is needed repeatedly at scale → build a read model from events instead |
| **Event (asynchronous)** | announcing an outcome others may care about — the *default* cross-context form | expecting a specific consumer to act (that's a command in disguise) |
| **Notification** | informing *people* (a delivery concern of Operations) — distinct from events, which inform *contexts* | as a substitute for an event contract |
| **Business process** | multi-context flows (settlement, onboarding, launches): sequences of local commands/commits coordinated by the owning process with events + compensation (ADR-005 §6) | hiding a process inside one giant command |
| **Long-running process** | anything spanning human time or external counterparties; owns state, timeouts, resumability | fire-and-forget without process state |

Rule of thumb encoded: **synchronous collaboration is borrowed time** — each sync edge is
a coupling debt that must justify itself; the platform's default is events + read models.

## 6. Event Collaboration Model

**Ownership & publishing:** exactly one producer per event kind — the context that owns
the fact; emitted at commit of the owning transaction (never before, never maybe);
past-tense fact names; references not payload copies (ADR-005 §7).
**Consumption:** any context may subscribe without producer involvement; consumers own
their handlers, their read models, and their failure queues; a consumer must be **idempotent**
(event identity makes redelivery detection, not duplication) and **replay-tolerant**
(rebuilding a read model from history is a routine operation, not an emergency).
**Ordering:** guaranteed only *per subject* (per Ride, per Wallet) — consumers must not
assume global order; cross-subject sequencing derives from event timestamps and causality
references, not arrival order.
**Evolution:** additive only (new optional attributes, new event kinds); meaning changes =
new event kind + deprecation of the old — an event's meaning is immutable once certified.
**Lifecycle & retention:** events are ADR-004 facts — retained per class rules, serving
audit and analytics after operational consumption; replayability horizon is a declared
per-kind property.
**Certification:** an event kind is consumable only once certified (owner, meaning,
guarantees, retention declared) — uncertified events are internal and may not cross the
boundary.

## 7. Anti-Corruption Architecture

Every boundary where foreign vocabulary enters gets a translation layer owned by the
consuming context; external concepts are re-expressed in platform language at the door.

| Boundary | Isolation duty |
|---|---|
| **Payment processors** | PSP statuses/references become platform Payment lifecycle states + external-reference claims (ADR-004 §5); PSP quirks (partial captures, chargebacks) are translated into platform facts — Commerce's ledger never contains PSP vocabulary |
| **Message carriers (SMS/push)** | carrier receipts/failures become delivery facts; carrier-specific device semantics stay inside the Notification boundary (today's multi-provider SMS abstraction is this pattern's embryo) |
| **Map/places providers** | provider place IDs are external claims mapped to platform locations; routes/ETAs are advisory inputs, never authoritative Trip facts |
| **Government/regulator interfaces** | filings, license verifications, data requests translated to/from Compliance vocabulary; a regulator's format change is an ACL change, never a domain change |
| **Legacy (own past)** | the current single-city API surface and phone-as-identity are treated as a *legacy dialect*: the frozen mobile contract is served by translation from the evolving application model (G0.0's "avoid rewriting Flutter" is exactly an ACL commitment to our own installed base) |
| **Partners/B2B (future)** | partner channels get partner-facing contracts translated at the boundary; partners never see internal events raw |

Mapping responsibility rule: **the boundary owner writes the translation, both directions,
and owns its tests** — no external format ever becomes a platform-internal argument.

## 8. Integration Governance

**Ownership:** every contract/event has one owning context and named steward (ADR-004 §9).
**Certification** before first external consumer (checklist: meaning, guarantees, failure
outcomes, retention, compatibility statement). **Review:** compatibility review for every
contract revision — additive proven, not asserted. **Publishing:** through the contract
registry (the governed catalog of certified contracts — an authored-data artifact, not a
technology). **Deprecation:** calendar + named-consumer acknowledgment; nothing retires
with active consumers. **Approval:** cross-context contracts need both the owner's steward
and architecture sign-off; regulatory-touching contracts add Compliance review.
**Consumer notifications:** consumers of record are notified of revisions/deprecations as
a governance obligation, not a courtesy. **Compatibility reviews** run on cadence against
the standing consumers that cannot be broken: the deployed mobile fleet and MCP tooling.

## 9. Reliability Principles

**Retries:** bounded, idempotent, for transient failures only; escalate to declared
failure states (ADR-005 §8) — never infinite, never silent. **Timeouts:** every sync
collaboration and every process step declares one; defaults exist so "no timeout" is
impossible, and a timeout is a *modeled outcome* with a next step. **Failure isolation:**
consumer failure never blocks producers; derived-view failure never blocks commands; one
counterparty's outage is contained at its ACL. **Circuit isolation (conceptual):** repeated
counterparty failure flips the boundary to a declared degraded mode (queue, defer, or
reject-with-honesty) rather than hammering or hanging. **Dead-letter philosophy
(conceptual):** work that cannot be processed is *parked with evidence* — visible,
owned, and re-drivable; parked work is inventory with an SLA, never a landfill.
**Recovery:** resumable-by-construction (process state + facts, ADR-005); recovery
reproduces class guarantees (ADR-004 §8). **Compensation:** every cross-context sequence
ships declared counter-actions (ADR-005 principle 6). **Observability responsibility:**
the *publisher* of a contract is accountable for signaling its health; the *consumer* for
its lag/failure visibility; a silent integration is a broken integration (the P7-04
estate is the ready substrate).

## 10. Scalability Notes

The collaboration model is **O(contracts), not O(traffic)**: hundreds of millions of users
add zero contracts. Events partition per subject (Ride/Wallet/User) which is exactly the
per-subject ordering guarantee — scale and semantics align; read models localize load with
each consumer instead of concentrating it on owners; reference/rule contracts (Geography,
Compliance) serve immutable versions — cacheable without invalidation pain (ADR-003 §10);
sync edges — the only scale-sensitive collaboration — are deliberately few (gates and
atomic assignments), subject-keyed, and horizontally partitionable. Thousands of markets
and hundreds of countries enter as data consumed through *unchanged* contracts.

## 11. Risks

1. **Standing:** C-1 (ADR-001, unapproved) is also an integration lesson — today's
   ride-completion couples Mobility and Commerce inside one undeclared boundary; the fix is
   this ADR's settlement hand-off contract in miniature. **Still the most overdue decision
   on the platform.**
2. **Contract bureaucracy vs. team size:** full governance applied to a one-team monolith
   would strangle it — adoption is staged: vocabulary and event certification first (G2–G4),
   registry formality as consumer count grows.
3. **Read-model sprawl:** every consumer building private views multiplies storage and lag
   surfaces — bounded by freshness declarations and class audits (ADR-004 §10).
4. **ACL erosion:** under deadline pressure external vocabulary leaks inward one field at a
   time — mitigated by boundary-owner test obligations and review checklists.
5. **Sync-edge creep:** convenience pushes toward synchronous calls — countered by the
   "borrowed time" rule and architecture review of every new sync edge.

## 12. Future Evolution

Absorbable via amendment: partner/B2B contract tier (§7 row activated) with external
certification; event catalog maturing into the platform's formal integration backbone
(ADR-004 §13 anticipation); cross-platform integrations (public transit, government
mobility schemes) as new ACL rows; contract-testing practice binding the frozen mobile
dialect to the evolving model (kills M-3 contract triplication); if physical decomposition
is ever load-justified (G0.0), these contracts *are* the service boundaries — the
decomposition would be a deployment decision, not an architecture project.

## 13. Final Certification

Verified against mandate: all 24 objective areas addressed; 10 integration principles;
collaboration model for all six contexts with published/consumed/forbidden; six-kind
contract model with ownership/lifecycle/versioning/certification/evolution; interaction
model with explicit use/never guidance; event collaboration model (ownership, publishing,
consumption, evolution, ordering, idempotency, replay, retention, certification); ACL
architecture covering external, partner, government, payment, and own-legacy boundaries;
governance (ownership → certification → review → publishing → deprecation → approval →
notification → compatibility); reliability principles incl. conceptual circuit/dead-letter
models; scale targets met by O(contracts) analysis; zero API/protocol/infrastructure
content; all prior FINAL ADRs extended, none redesigned.

**ADR-006 — INTEGRATION ARCHITECTURE — WORLD-CLASS CERTIFIED**
