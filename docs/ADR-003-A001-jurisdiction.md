# ADR-003 · Amendment 001 — Jurisdiction as a Core Regulatory Entity

**Status:** Certified · **Amends:** ADR-003 (Country & Localization Architecture) · **Date:** 2026-07-18
**Nature:** pure extension. Geography hierarchy unchanged. No philosophy change, no implementation.

---

## 1. Amendment Summary

Introduces **Jurisdiction** — a legal/regulatory authority — as a **parallel legal layer**
alongside (never inside) the geography hierarchy. Geography remains
Country→Market→Region→City→Zone. Regulatory rule families (ADR-003 §4E) are now *authored
by Jurisdictions*; geographic nodes carry **coverage links** declaring which Jurisdictions
apply. Affected ADR-003 sections (§1, §3 principle 9, §4E, §5, §8, §9, §10, §11, §12) are
updated inline and tagged *(A-001)*; all other sections untouched.

## 2. Updated Executive Summary (delta)

ADR-003's summary now closes its model sentence with the five-layer separation:
**geography locates, Markets operate, Jurisdictions legislate, Compliance evaluates,
Localization speaks.** Law is carried by the parallel Jurisdiction layer, linked to
geography by coverage — so legally non-uniform countries (US, UAE, UK, Australia, Canada)
are the general case and unitary Kuwait the degenerate one.

## 3. New Entity: Jurisdiction

- **Purpose.** Represents a body with the power to make rules the platform must obey:
  national government, state/province/emirate, municipality, or special authority
  (airport, port, free-trade zone, military). It is *not geography* — it legislates over
  territory; it isn't territory.
- **Responsibilities.** Sole authoring authority for its versions of: Tax Rules, Privacy
  Rules, Insurance Rules, Driver Licensing, Vehicle Regulations, Business Licensing,
  Labor Rules, Safety Rules, Emergency Regulations, Compliance Policies, Data-Residency
  Requirements, Payment Restrictions.
- **Ownership.** Registered and governed by the Compliance authority (Operations context).
  Owns its rule-family versions. Core Entity, REF class, versioned.
- **Lifecycle.** `Recognized → Active → Superseded / Dissolved` — dissolution names a
  successor; rule history and past verdicts remain intact (append-only, ADR-003 principle 4).
- **Relationships.** Parent/child *authority* links of **variable depth** (Federal→State→
  Municipal; unitary countries have depth 1); **coverage links** attached from geographic
  nodes (Country, Region, City, or Zone) — a Zone-level link is how an airport authority or
  free-trade zone binds; a City may be covered by 1–4+ Jurisdictions.
- **Dependencies.** Depends on nothing operational. Depended on by: Compliance evaluation,
  Tax Profile resolution, launch validation, audit evidence.
- **Configuration.** Jurisdictions are not configuration and do not participate in the §6
  business cascade; they carry *law*, resolved by the legal model below. (This separation
  is the amendment's core discipline.)
- **Global uniqueness.** ✔ globally unique.
- **Expected growth.** ~10⁴ (≈200 national + ~3,000 state/provincial + municipal/special
  authorities where the platform actually operates) — O(legal footprint).
- **Today.** Kuwait = one national Jurisdiction covering the whole country: the degenerate
  case, consistent with the established pattern (single Market, single-member Organization).

## 4. Regulatory Resolution Model

For a location L and instant T:

1. **Locate:** derive L's geographic chain (Zone→City→Region→Country).
2. **Collect:** union the coverage links along the chain → the **applicable Jurisdiction
   set** (e.g., a US airport pickup: Federal + State + Municipal + Airport Authority).
3. **Gather:** for the rule family in question, take each Jurisdiction's rule version
   **effective at T**.
4. **Resolve precedence:** higher-authority rules are *floors* — a lower authority may
   tighten, never relax (State ≥ Federal floor; Municipal ≥ State floor). Where a higher
   authority legally preempts lower rule-making, preemption is **authored explicitly on the
   rule**, never inferred.
5. **Resolve conflict:** among rules of overlapping non-hierarchical authorities (municipal
   vs. airport authority), **restrictive-wins** — same rank rule as ADR-003 §6, now applied
   across the Jurisdiction set. Authoring-time validation flags contradictions that
   restrictive-wins cannot order (true legal conflicts) for human legal resolution before
   publish.
6. **Record:** every gated verdict stores the winning Jurisdiction + rule version + T —
  **historical traceability**: resolution is a pure function of *(location, family,
  instant)* over immutable versions, so any past verdict is exactly reproducible;
  **auditability**: evidence pairs with the ADR-002 Audit Log and answers regulators'
  "under which authority and rule was this permitted?"

Effective dates govern everything: enacted-not-yet-effective rules are visible for
readiness planning; supersession never deletes.

## 5. Updated Ownership Rules

Compliance (Operations) owns the **Jurisdiction registry and coverage links**; Geography &
Localization owns the geographic nodes the links attach to — neither reaches into the
other. Rule families move from "per-country scope" to "per-Jurisdiction authorship"
without changing their owner context, class, or lifecycle. Tax Profiles remain Commerce-
consumed but are now resolved through the Jurisdiction set rather than a geographic scope.

## 6. Updated Compliance Architecture

Invariant (2) is generalized from "restrictive-wins down the cascade" to
"restrictive-wins **across applicable authorities**", and invariant (3) now records *which
Jurisdiction's* rule version authorized each action. The four-invariant structure, the
Law > Safety > Contract > Policy > Optimization rank, and the single ask-the-platform
evaluation capability are unchanged — Jurisdiction slots in as *who authors the law*,
not a new way of obeying it.

## 7. Updated Scalability Notes

Adds ~10⁴ entities and one set-collection step. The applicable set per City is small
(1–4 typical), changes rarely, and caches exactly like cascade results (immutable
versions ⇒ version-keyed caches). Special cases — SEZs, autonomous regions, free-trade
zones, airports, ports, military zones — are *coverage links at the right geographic
node*, mostly Zone; **future regulatory models** (supranational unions, interstate
compacts) are authority nodes above Country in the variable-depth chain. None of the ten
required scale cases needs redesign; all are rows and links.

## 8. Migration Impact

**Zero production impact now.** No code, schema, or API changes; sequencing unchanged —
this remains G4 blueprint material behind G1 (C-1 fix, still open) and G3 (PostgreSQL).
When Geography lands as reference data, Kuwait is authored with one national Jurisdiction
and one country-level coverage link — the retro-authoring dry run (ADR-003 §9) now also
proves the legal layer. Operational entities are untouched: they still carry only a City
reference; the Jurisdiction set derives at evaluation time. Cost: one additional authored
artifact per launch (the jurisdiction map) — which federal-market launches needed anyway.

## 9. Final Recommendation

Adopt. ADR-003 modeled *where law differs*; this amendment models *who makes the law* —
the missing half for the US/UAE/UK/AU/CA class of markets — while preserving every prior
principle: geography stays pure, high-volume entities gain nothing, history stays
immutable, and Kuwait remains expressible as the simplest possible case.

---

**ADR-003 Amendment-001 — JURISDICTION DOMAIN CERTIFIED**
