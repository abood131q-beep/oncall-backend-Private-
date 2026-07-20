# ADR-002 · Amendment 001 — Market as a Core Geography Entity

**Status:** Certified · **Amends:** ADR-002 (Global Domain Model) · **Date:** 2026-07-18
**Nature:** pure extension. No philosophy change, no redesign, no implementation.

---

## 1. Amendment Summary

Introduces **Market** — an operational business unit — into the Geography & Localization
context, extending the hierarchy from Country→Region→City→Zone to
**Country→Market→Region→City→Zone**. Affected ADR-002 sections (§1 Executive Summary,
§3.1 Geography catalog + ownership rule, §4 Relationships, §7 Scalability, §8 Expansion)
have been updated inline and tagged *(A-001)*. All other sections untouched.

## 2. Updated Executive Summary (delta)

ADR-002's summary now reads: place resolves through the chain
Country→Market→Region→City→Zone, with **operational accountability through Market** —
alongside the existing rules (tenancy through Organization, money through immutable
Transactions, history through append-only Events). Markets join the list of things added
as data, not redesign.

## 3. New Entity: Market

- **Purpose.** The unit at which the business is *run*: P&L accountability, local
  management, growth targets, policy, and configuration. Country is where the platform is
  *legal*; City is where it *operates*; **Market is where it is *managed***. It is not mere
  geography — a Market references territory but owns operations.
- **Responsibilities.** Owns: Regional Operations; Market Manager role scopes; Market
  Policies (local rules within Country law); Market Configuration; Market Pricing Defaults
  (inherited by Cities, overridable per City); Market Analytics & KPIs; Market Business
  Goals. Groups its Regions (and, through them, Cities).
- **Ownership.** Owned by exactly one Country. Owns its Regions. Core Entity.
- **Lifecycle.** `Planned → Launching → Active → Consolidating → (Merged | Retired)`.
  Markets can split (Riyadh spins out of a national launch market) or merge — Cities
  re-parent; Cities themselves never die because a Market reorganizes, and historical
  facts (Trips, Transactions) keep their original City references, so reorganization
  rewrites no history.
- **Relationships.** Country 1→N Market; Market 1→N Region; City belongs to exactly one
  Market (via its Region); Market Manager = Identity-context Role scoped to a Market;
  Organizations may hold market-level agreements; Reports/KPIs aggregate per Market.
- **Dependencies.** Depends on Country (jurisdiction) and Currency/Tax Profiles (via
  Country). Depended on by: management reporting, pricing-default resolution,
  policy resolution, Analytics rollups, Identity role scoping.
- **Global uniqueness.** ✔ globally unique.
- **Expected growth.** ~10³ (bounded by business expansion, not user growth).
- **Today:** implicit single "Kuwait Market" — the degenerate case, mirroring how personal
  use is the degenerate Organization. Nothing in production changes.

## 4. Updated Geography Hierarchy

```
Country  → legal & regulatory boundary            (pure reference)
 Market  → operational business unit  (A-001)     (operational overlay)
  Region → administrative tier                    (pure reference)
   City  → the operational atom                   (pure reference + city config)
    Zone → sub-city geometry & rules              (pure reference)
```

**Why this scales better.** (a) *Management mirrors reality*: global operators run Markets
(GM of Riyadh Market), not countries or single cities — the model now has a home for that
accountability instead of forcing it into Country (too coarse: one US ≠ one operation) or
City (too fine: 10⁴ cities can't each carry a P&L organization). (b) *Configuration
cascades*: pricing/policy defaults set once per Market serve dozens of Cities,
nearest-ancestor-wins — launching City #30 in an existing Market inherits nearly
everything. (c) *Reporting has a natural spine*: City→Market→Country rollups replace ad-hoc
groupings. (d) *Reorganization is cheap*: growth restructurings re-parent references
without touching a single historical fact.

## 5. Updated Ownership Rules

Geography chain = Country→Market→Region→City→Zone. The pure tiers (Country, Region, City,
Zone) remain reference data owned solely by Geography & Localization; **Market is the
operational overlay within the chain** — business configuration and accountability live
there, territorial facts do not. Other contexts hold references, never copies. Resolution
rule: City settings → Market defaults → Country defaults (nearest ancestor wins).
Market Managers are Identity-context Roles *scoped to* a Market — Identity still owns all
people and permissions (no ownership-boundary change).

## 6. Updated Relationships

Added to ADR-002 §4: every City belongs to exactly one Market; Managers, policies, pricing
defaults, KPIs, and P&L roll up City→Market→Country; a Ride is operationally accountable to
its City's Market **transitively** — operational entities (Rides, Trips, Vehicles) carry
only their City reference; Market context derives through the chain. No new references on
high-volume entities.

## 7. Updated Scalability Notes

Market becomes the natural **rollup tier** (analytics aggregation, management reporting)
and, where law requires, a **data-residency grouping** — all without changing transactional
partitioning, which remains City/User/Organization-keyed. Market count (~10³) is small
enough that market-level configuration is trivially cacheable platform-wide.

## 8. Migration Impact

**Zero production impact now.** No code, schema, or API changes; Kuwait becomes the single
implicit Market when Geography lands as reference data (G4 of the Evolution Strategy —
sequenced after G1 stabilization and G3 PostgreSQL, per G0.0). Because operational entities
reference only City, introducing Market later is purely additive: create Market rows,
parent the Regions/City, done. The deployed Flutter fleet is unaffected (frozen contract).
Cost of the amendment: one extra resolution hop in future config lookup — negligible and
cacheable.

## 9. Final Recommendation

Adopt. The amendment adds the one concept ADR-002's expansion test (§8) could not absorb as
data — operational accountability between Country and City — while preserving every ADR-002
principle: geography stays data, high-volume entities gain no new references, history stays
immutable, and today's production system needs nothing changed.

---

**ADR-002 Amendment-001 — MARKET DOMAIN CERTIFIED**
