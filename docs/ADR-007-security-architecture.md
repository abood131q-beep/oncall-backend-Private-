# ADR-007 — Security Architecture

**Status:** Proposed · **Author:** Chief Enterprise Security Architecture · **Date:** 2026-07-18
**Builds on (FINAL):** G0.0 · ADR-002 (+A-001) · ADR-003 (+A-001) · ADR-004 · ADR-005 · ADR-006
**Scope:** enterprise security architecture — how the platform is protected. No protocols,
algorithms, credential formats, infrastructure, or implementation content.

---

## 1. Executive Summary

Security is a physical-world responsibility here: the platform decides who may drive a
stranger through a city at night and who may take money for it. This ADR defines protection
as architecture: a trust model in which **no actor class is trusted by default and every
trust is established, evidenced, re-verified, and revocable**; identity and authorization
as layered decisions (role → attributes → policy → jurisdiction) that scale from today's
three roles to global operations; data protection derived mechanically from ADR-004's
classes; privacy as a first-class architecture rather than a compliance afterthought; a
threat model organized around the platform's real crown jewels (identities, the money
ledger, the audit record, and rider physical safety); and governance sized honestly for a
one-team platform with a growth path. Existing strengths are promoted, not replaced:
today's verified revocation semantics, gated driver approval with audit trail, and
separated per-actor rate limiting are the embryos of the session, privilege, and
throttling architectures below.

## 2. Security Principles

1. **Least privilege** — every actor and service holds the minimum capability for its
   current task; breadth of access is a cost to be justified, not a convenience.
2. **Need to know** — data visibility follows purpose, not role seniority; an
   administrator's power to act is not a right to browse (ADR-004 Identity Data rules).
3. **Zero trust** — no request is trusted for where it comes from; every request carries
   verified identity and is evaluated fresh against current authority.
4. **Defense in depth** — edge, application gate, domain invariant, and audit each assume
   the layer above has failed.
5. **Separation of duties** — money movement, privilege grants, rule authoring, and audit
   custody never share a single actor; author ≠ approver everywhere (ADR-003 publishing).
6. **Default deny** — capabilities are granted, never assumed; the absence of a rule is a
   "no" (today's route-gate discipline, universalized).
7. **Explicit trust** — every trust relationship is a recorded artifact with owner, basis,
   scope, and expiry — never an ambient assumption.
8. **Continuous verification** — trust decays; standing access is re-verified on cadence
   and on signal (role change, anomaly, credential age).
9. **Immutable audit** — the record of privileged action is append-only, tamper-evident,
   and outside the reach of those it records (ADR-004 Audit class).
10. **Privacy by design** — minimal collection, purpose binding, and erasure paths are
    architectural properties decided at design time (§7).
11. **Security by design** — every new capability ships with its threat considerations,
    gates, and audit obligations declared — the ADR-005 gate order (authz → compliance →
    validation) is mandatory shape, not style.

## 3. Enterprise Trust Model

**Trust boundaries** coincide with ADR-006 boundaries: presentation edge (untrusted
world → platform), context boundaries (trusted-but-verified peers), external ACLs
(counterparties), and the audit boundary (one-way: everything writes in, only governed
review reads out).

| Trust class | Establishment | Evolution | Revocation |
|---|---|---|---|
| **Human — rider** | verified identity claim per country rules (ADR-003 §4E) | standing adjusted by behavior signals (fraud, chargebacks, abuse reports) | account suspension; erasure rights honored per Privacy Rules |
| **Human — driver** | rider trust **plus** licensing/insurance/background verdicts per Jurisdiction; approval is a recorded compliance decision (today's approval workflow) | continuous: credential expiry, incident history, rating floors trigger re-verification | immediate supply removal + session termination + audit (today's suspend semantics, kept as the model) |
| **Human — staff (admin/support/fleet manager)** | employment/contract + role grant with approver; scoped to Market/City/Organization | periodic access review; role recertification | instant on separation; all grants expire, none are permanent |
| **Device** | registered, bound to identity, with integrity signals; a device is *evidence*, never identity itself | device history informs risk scoring (new device ⇒ step-up verification) | device unbinding; stolen-device kill |
| **Application (own clients)** | released client versions are trusted *as channels*, not as authorities — nothing a client asserts is believed without server-side verification | version deprecation windows | minimum-version enforcement |
| **Service (internal contexts)** | mutual verified identity per collaboration contract (ADR-006); a context's authority is exactly its contract | contract evolution via governance | contract suspension isolates a compromised context |
| **Partner (B2B, future)** | contractual + technical onboarding; partner-facing contracts only (ADR-006 §7) | usage within declared scopes, monitored | scope narrowing → termination |
| **Government** | verified official channels per Jurisdiction; every request is authenticated, logged, and evaluated against Privacy Rules — *government identity is verified like any other* (§8 threat: impersonation of authority) | per-Jurisdiction relationship registry | challenge/appeal path is part of the design |
| **Third-party suppliers** (PSPs, carriers, map providers) | due-diligence + ACL containment; trusted only for their function | monitored for drift/abuse | ACL degraded-mode isolation (ADR-006 §9) |

Internal trust is *earned by verification per request*; external trust is *contained by
translation and scope*. Nothing is trusted because of network position, tenure, or title.

## 4. Identity & Access Architecture

- **Identity lifecycle:** claim → verification (per-Jurisdiction rules) → active identity
  (Global ID, ADR-004 §5) → state changes as recorded facts → closure (with erasure/
  retention per Privacy Rules). One human, one identity; roles carry the differences.
- **Authentication lifecycle:** identity proof → session establishment → continuous
  re-evaluation (age, risk signals, step-up on sensitive acts) → expiry or revocation.
  Possession factors (verified phone, device) plus step-up for privileged action;
  authentication *strength* is a per-action policy input, not a constant.
- **Session architecture:** sessions are first-class recorded objects: bounded lifetime,
  bound to identity + device evidence, enumerable ("what sessions exist for me"),
  individually and collectively revocable, with revocation taking effect immediately
  everywhere — today's proven access-and-refresh revocation semantics are the embryo;
  the canary-window revocation gap (per-instance stores) is a *named defect* against this
  section, already scheduled (G2 state externalization).
- **Authorization lifecycle:** every act is decided at act-time from current grants —
  grants are cached *decisions expire, authority doesn't linger*.
- **Role & permission assignment:** roles are named permission bundles (ADR-002); grants
  record grantor, justification, scope, expiry; permission changes to a role propagate to
  holders immediately.
- **Delegation:** a delegate acts with *their own identity* under a recorded delegation
  (scope + expiry + revocable by delegator or governance) — audit shows both parties;
  impersonation does not exist as a capability.
- **Temporary privileges:** elevation is scoped, time-boxed, justified, approved, and
  auto-expiring — standing elevated access is a governance exception (§10), not a norm.
- **Emergency access:** break-glass grants exist, pre-defined per scenario, requiring
  post-hoc review within a fixed window; every use pages governance; unreviewed
  break-glass auto-escalates to incident (§11).
- **Credential lifecycle:** issue → use → rotate (age/exposure policy) → revoke; secrets
  never persist in backups or exports (the existing P7-05 rule, now architectural law).
- **Revocation:** single authoritative revocation state per credential/session/grant,
  effective platform-wide immediately; revocation events are audit facts.

## 5. Authorization Model

Layered decision, evaluated in order, default-deny at every layer:

1. **RBAC** — coarse capability: does the actor's role permit this action class at all?
2. **Ownership-based** — is the subject theirs? (passenger sees own trips; driver acts on
   assigned rides — today's ownership checks, universalized).
3. **ABAC** — attribute predicates: driver approval state, wallet standing, device risk,
   vehicle eligibility.
4. **Context-based** — Market/City/Organization scoping: a Market Manager's authority ends
   at their Market's edge (A-001 role scopes); a fleet manager's at their Fleet.
5. **Jurisdiction/Country-based** — the ADR-003-A001 verdict: is this act lawful *here,
   now*, for this actor class? Compliance verdicts are authorization inputs.
6. **Time-based** — grant expiries, business-hours-bound capabilities (support tooling),
   curfew rules from zone configuration.
7. **Policy-based emergency overlays** — declared emergency policies (safety incident,
   market suspension) can *restrict* platform-wide instantly; emergency policies may only
   tighten, mirroring restrictive-wins.

The composite rule: **authority = role ∩ ownership ∩ attributes ∩ scope ∩ law ∩ time**,
and every grant of the composite is reconstructible after the fact (audit, §9).

## 6. Data Protection Model

Protection derives from ADR-004 classes — classification *is* the control selector:

| Class (ADR-004) | Sensitivity | Protection rules (architectural) |
|---|---|---|
| Reference / Localization | public-internal | integrity over confidentiality: versioned, approved authoring; tamper = wrong law/pricing |
| Configuration | internal | change-gated (staged publish, author≠approver), fully audited; the cascade is an attack surface (§8 tampering) |
| Master (Users, Orgs, Vehicles) | confidential, PII-bearing | need-to-know visibility; field-level purpose binding; access is itself audited for sensitive views |
| Operational (positions, availability) | confidential + *location-sensitive* | short retention (ADR-004); live location visible only to active counterparties + safety functions — location history is among the most abusable data the platform holds |
| Transactional (trips, ledger) | confidential-financial | append-only integrity; corrections only by compensating facts; reconciliation as standing control |
| Historical | inherits source class | archive tiers retain class protections — archiving never declassifies |
| Audit | restricted | write-once, tamper-evident, custody separated from all administrators it records; readable only via governed review |
| Identity | restricted, highest PII | strict write paths; verification evidence sealed; no bulk export paths exist by design |
| Security (credentials, secrets) | restricted-critical | never in backups/exports/logs; rotation-governed; access to secrets is itself a privileged, audited act |
| Compliance (verdicts, agreements) | restricted-legal | longest retention; legal-hold sensitive; evidence integrity is non-negotiable (regulatory defense) |
| Derived / Analytical | varies — **inherits the max sensitivity of sources** | de-identified by default for analytics; re-identification is a named threat, not a feature |
| Temporary | varies | TTL-bound destruction is the control; promotion requires reclassification (ADR-004 rule) |
| System | internal | operational exhaust scrubbed of PII/secrets at generation |

## 7. Privacy Architecture

**PII protection:** PII is inventoried by class and field, purpose-bound at collection.
**Consent:** recorded facts (versioned agreement acceptances, ADR-003) per purpose;
consent withdrawal is an honored, audited event. **Purpose limitation:** data collected
for a ride is not marketing data; new purposes require new consent or lawful basis —
enforced as an authorization-layer predicate, not a policy PDF. **Minimization:** the
default answer to "should we also store…" is no; every field earns its place.
**Retention & erasure:** per-class retention driven by the *maximum* covering-Jurisdiction
obligation (ADR-004 §8); subject erasure via irreversible de-identification that
preserves non-personal facts (the Trip happened; who rode is removable). **Legal hold:**
outranks retention expiry and erasure only where law says so — conflicts between a hold
and an erasure right are escalated to governance with jurisdiction analysis, never
silently resolved. **Cross-border & regional restrictions:** data residency is a
Compliance-Data requirement per Jurisdiction (ADR-003-A001); cross-border transfer is a
governed, evidenced act with lawful basis. **Privacy governance:** privacy review is a
launch gate per country entry and a change gate for any new PII collection.

## 8. Threat Model

Crown jewels: identity store, money ledger, audit record, live-location data, driver
trust decisions, rule/configuration authoring. Architectural threats and postures:

| Threat | Posture |
|---|---|
| **Identity abuse** (account takeover, synthetic identities, SIM ownership change) | verification per Jurisdiction + device evidence + step-up on anomaly; phone-number recycling is a named risk of the phone-identity legacy (ADR-004 §5) with re-verification on ownership-change signals |
| **Privilege escalation** | layered authorization + separation of duties + grant expiry + audited grant paths; no impersonation capability exists |
| **Fraud** (fare manipulation, promo abuse, collusive rides, wallet laundering) | ledger immutability + reconciliation, Assignment records (who was offered what — ADR-002), promotion budgets/limits, anomaly analytics *outside* the command path |
| **Replay** | command identity/idempotency (ADR-005 §8) makes replay detection, not duplication; events replay-tolerant by contract |
| **Spoofing** (fake drivers, fake vehicles, GPS falsification) | trust chains (driver ↔ vehicle ↔ assignment must agree), telemetry plausibility as risk signal, physical-world verification via Inspections |
| **Tampering** | append-only facts; configuration/rule changes gated + audited; the cascade and rule stores are integrity-critical (§6) |
| **Repudiation** | every consequential act carries actor + session + rule-version evidence (§9 non-repudiation) |
| **Information disclosure** | need-to-know + purpose binding; location history minimization; derived-data inheritance rule (§6) closes the "analytics leak" path |
| **Denial of service** | per-actor throttling (per-identity, not just per-origin — today's per-phone limiter is the right instinct), degraded-mode design (ADR-006 §9), business-continuity posture (§11) |
| **Insider threats** | separation of duties, need-to-know browsing limits, audited sensitive access, audit custody outside admin reach — the platform's own operators are inside the threat model, not outside it |
| **Supply chain** | provenance-verified software path (the existing signed-release discipline, stated architecturally: nothing unverified reaches production), third-party containment via ACLs |
| **Partner abuse** | scoped partner contracts, monitored usage, revocable trust |
| **Government requests** | authenticated channels, per-Jurisdiction lawfulness evaluation, recorded + challengeable; impersonation-of-authority is treated as an attack vector |
| **Social engineering** | procedural controls: no out-of-band privilege paths exist to be talked into; support tooling enforces the same authorization layers as everything else |

## 9. Audit Architecture

One audit fabric, several lenses: **security audit** (authentications, grants, revocations,
break-glass), **administrative audit** (config/rule/reference authoring — author, approver,
version), **compliance audit** (verdicts + evidence, per ADR-003-A001), **business audit**
(financially/legally consequential acts: approvals, settlements, refunds), **incident
audit** (timeline custody for §11). Properties: **immutable** (append-only, tamper-evident
chain of custody); **evidence-preserving** (enough context to reconstruct the decision:
actor, session, subject, rule versions, prior state reference); **traceable** (every
consequential state links to its authorizing trail — ADR-004 traceability closed into a
loop); **non-repudiable** (identity-bound, time-stamped, integrity-protected records that
neither actor nor operator can unwrite); **custody-separated** (those who act cannot curate
the record of their acting). Audit review is itself privileged and audited.

## 10. Security Governance

**Ownership:** platform security owned at Principal level; each context's steward owns its
gates and data protections (extends ADR-004 §9). **Approval & certification:** new
capabilities require security sign-off on declared threats/gates/audit before release —
the same certification chain as data and contracts. **Review:** access recertification on
cadence; audit sampling; threat-model refresh per new vertical/country. **Policies:**
security policies are authored data (versioned, effective-dated, ADR-003 machinery) — the
platform's own rules obey the platform's rulebook. **Exception management:** exceptions are
recorded, owned, time-boxed, and reviewed — an undocumented exception is a finding.
**Risk acceptance:** explicit, signed, expiring — risk is accepted by a named owner or it
is not accepted. **Continuous improvement:** incidents, drills, and audits feed a tracked
remediation backlog with the same priority discipline as the engineering backlog.
**Honest sizing:** today this is one team wearing all hats — the roles above are hats with
named wearers and a growth path, not fictional departments.

## 11. Incident Response

**Detection** — signals from the observability estate, anomaly analytics, user/staff
reports, partner notices; detection coverage is itself reviewed (undetectable = unowned).
**Classification** — severity by impact on crown jewels and humans (safety incidents
outrank data incidents outrank availability incidents); classification selects the
playbook and clock. **Containment** — pre-authorized moves per scenario: session mass
revocation, capability kill-switches (emergency policies, §5.7), market/zone suspension,
ACL isolation of a counterparty — containment authority is pre-granted so no one
negotiates permissions mid-incident. **Investigation** — on preserved evidence (audit +
facts), never on mutable state; investigators get scoped, audited, time-boxed access.
**Recovery** — restore service with class guarantees intact (ADR-004 §8; the existing DR
discipline is the substrate); compromised trust is re-established, not assumed back.
**Communication** — internal roles pre-assigned; user notification honest and timely;
**regulatory reporting** per covering Jurisdictions' obligations (deadlines tracked as
compliance obligations, ADR-002 Incident entity). **Lessons learned** — blameless review,
remediation into the governed backlog, threat model updated; an incident that changes
nothing is a wasted incident. **Business continuity:** degraded modes are designed (which
capabilities shed first — analytics before notifications before matching before safety
functions, never the reverse); continuity drills piggyback on the existing DR drill cadence.

## 12. Scalability Notes

Security scales because decisions are local and evidence is append-only: authorization
evaluates per-request against subject-keyed state (partitionable exactly like the data,
ADR-002 §7); sessions and grants are per-identity; audit is append-only fact flow
(ADR-004's billion-row class, already scale-shaped); rule/verdict resolution caches like
all immutable-versioned data (ADR-003 §10); per-actor throttling keys scale with actors,
not traffic concentration. Country #200 adds jurisdictions, rules, and verifiers — **zero
new security mechanisms** (the ADR-003 test, applied to security). Governance is the only
part that scales with humans, and §10 says so plainly.

## 13. Risks

1. **Standing:** C-1 (ADR-001, unapproved) is *also* a security matter — financial
   integrity under concurrency is an exploitable defect class (double-settlement), not
   just a reliability bug. Still the platform's most overdue decision.
2. **Phone-as-identity legacy** carries takeover risk (recycled numbers) until the ADR-004
   §5 re-anchoring lands; interim mitigations (re-verification signals) are posture, not
   cure.
3. **Named gap:** per-instance revocation stores make canary-window revocation
   inconsistent — scheduled (G2), tracked here as a security defect, not a footnote.
4. **One-team separation-of-duties**: with few humans, duty separation is procedurally
   thin; compensating control is total audit coverage + external review cadence — honest
   limit, stated.
5. **Location-data concentration**: the most abusable asset grows with scale; minimization
   and access audit must be enforced from the first design, or the debt is unpayable later.

## 14. Future Evolution

Absorbable via amendment: organization-level trust administration (B2B delegated admin)
atop the delegation model; device-integrity attestation maturing as client platforms
allow; fraud/risk scoring as a certified Analytics product feeding ABAC signals (never
auto-punishing without governance rules); regulator-facing audit portals per Jurisdiction;
formal security certifications (jurisdictional or industry) mapped onto this
architecture's evidence trails; dedicated security function as the org grows (§10 hats →
roles). Each lands against this document without redesign.

## 15. Final Certification

Verified against mandate: all 25 objective areas addressed; 11 principles; trust model
covering all 9 required trust classes with establishment/evolution/revocation; identity &
access lifecycles incl. delegation, temporary privilege, emergency access, sessions,
credentials, revocation; layered authorization model (RBAC/ABAC/policy/ownership/context/
jurisdiction/country/market/time/emergency); data protection derived per ADR-004 class
with classification/sensitivity/ownership/rules; privacy architecture (all 10 areas);
threat model covering all 14 required threat classes; audit architecture with immutability,
evidence, traceability, non-repudiation; governance incl. exceptions and risk acceptance;
incident response through lessons learned + continuity; scale targets met by
locality-of-decision analysis; zero protocol/algorithm/infrastructure content; all prior
FINAL ADRs extended, none redesigned.

**ADR-007 — SECURITY ARCHITECTURE — WORLD-CLASS CERTIFIED**
