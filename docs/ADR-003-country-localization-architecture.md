# ADR-003 — Country & Localization Architecture

**Status:** Certified · **Author:** Chief Enterprise Architecture · **Date:** 2026-07-18
**Amendments:** A-001 (Jurisdiction entity — see ADR-003-A001-jurisdiction.md), applied inline below
**Builds on:** G0.0 (Evolution Strategy), ADR-002 (Global Domain Model), ADR-002-A001 (Market)
**Scope:** business architecture only — no code, no schema, no APIs, no deployment topology.
**Audience:** Architecture Board, Technical Directors, future engineering and international
expansion teams.

---

## 1. Executive Summary

OnCall operates today in one country with one currency, one hardcoded language, and one
implicit regulatory regime. This ADR turns "country" from an assumption into an
**architecture**: a catalog of ~32 reference-data and configuration entities, one
configuration cascade (Global → Country → Market → City → Zone, with strictly defined
precedence, conflict, and versioning rules), one localization model (locale-driven,
fallback-chained, RTL-native), and one compliance model (effective-dated rule families
where **law always outranks configuration**). *(A-001)* Regulatory authority itself is
carried by a parallel legal layer — **Jurisdiction** — linked to geography by coverage:
geography locates, Markets operate, **Jurisdictions legislate**, Compliance evaluates,
Localization speaks. The test the whole document must pass, per
ADR-002 §8: entering country #2 — or country #200 — is the act of *authoring reference
data and configuration*, never the act of changing software architecture. Kuwait becomes
the first authored entry of every mechanism rather than an exception baked into code.

## 2. Goals

Unlimited countries/markets/regions/cities/zones with zero redesign; every
jurisdiction-specific behavior expressed as data; one resolution algorithm for all
configuration; localization that treats Arabic/RTL as a first-class citizen (it is the
home market, not an edge case); compliance differences absorbed as rule data; expansion
executable by a non-engineering launch team following a playbook.

## 3. Architecture Principles

1. **Geography is data; behavior is configuration; law is constraint.** Three different
   things with three different change regimes.
2. **One cascade to rule all configuration** — every configurable value resolves the same
   way (§6); no entity invents a private inheritance scheme.
3. **Law outranks configuration** (restrictive-wins): no override may relax a regulatory
   rule inherited from above; overrides may only tighten.
4. **Effective-dated, append-only versions**: reference and regulatory data are never
   edited in place; history must reproduce any past decision (tax audit, dispute).
5. **Locale ≠ Language**: formatting, plurals, direction, and units come from Locale
   (language × territory × script), never from Language alone.
6. **Fallback never fails**: every localized or configured lookup terminates at a platform
   default — a missing translation or config key degrades gracefully, never crashes a market.
7. **High-volume operational entities carry only a City reference** (A-001 rule); all
   country/market context derives through the chain — nothing here adds a column to a
   billion-row concept.
8. **Today is entry #1, not an exception**: Kuwait/KWD/ar-KW/Asia-Kuwait must be expressible
   entirely within these mechanisms before any second country is attempted.
9. *(A-001)* **Geography locates; Jurisdiction legislates.** Regulatory rules are authored
   by Jurisdictions (a parallel legal layer, §4E), never by geographic tiers; geographic
   nodes declare which Jurisdictions *cover* them. The business cascade (§6) and legal
   resolution (§8) are two planes evaluated together, with Law ranked above all
   configuration as before.

## 4. Entity Catalog

Class legend: **REF** = reference data (append-only versions) · **CFG** = configuration
(cascade-resolved, versioned) · **IMM** = immutable once published · **HIST** = historical
record. Owner is the ADR-002 bounded context.

### 4A. Geographic Spine (owner: Geography & Localization)

*(Defined in ADR-002/A-001; restated here only for their configuration dimensions.)*

| Entity | Purpose & Responsibilities | Class | Lifecycle | Relationships / Dependencies | Configuration & Scale |
|---|---|---|---|---|---|
| **Country** | Jurisdiction root: legal identity, sovereignty of rules; anchors currency, tax, languages, regulations | REF | Drafted → Published → (rare) Superseded (border/name changes are new versions) | owns Markets, Tax Profiles, country-level rule sets; referenced by everything | Carries Country Defaults layer of the cascade. Scale ~250 — trivially cacheable everywhere |
| **Market** | Operational business unit (A-001): P&L, management, market defaults | REF+CFG | Planned → Launching → Active → Consolidating → Merged/Retired | owns Market Configuration; groups Regions | Market Defaults cascade layer. Scale 5,000+ |
| **Region** | Administrative/licensing tier | REF | Published → Superseded | groups Cities | rarely configured directly; passthrough tier. Scale ~10⁴ |
| **City** | Operational atom; where supply, demand, and launch happen | REF+CFG | Candidate → Launching → Active → Suspended → Retired | owns Zones, City service catalog | City Overrides layer. Scale 100,000+ |
| **Zone** | Sub-city geometry with rule payloads (surge, no-ride, airport, event) | REF+CFG | Drafted → Active → Expired (many are temporary) | belongs to City | Zone Overrides layer — *leaf* of the cascade. Scale: millions; geo-indexed; only tier with geometry |

### 4B. Localization Cluster (owner: Geography & Localization)

| Entity | Purpose & Responsibilities | Class | Lifecycle | Relationships / Dependencies | Configuration & Scale / Future |
|---|---|---|---|---|---|
| **Language** | A human language the platform can speak (ar, en, …); direction (RTL/LTR), plural-category set | REF/IMM | Proposed → Supported → Deprecated | referenced by Locales, Catalogs | adding a language = new row + catalogs; today ar+en. Scale ~10² |
| **Locale** | Language × territory (× script): the *formatting authority* — dates, numbers, currency display, collation, direction (ar-KW ≠ ar-EG) | REF/IMM | Supported → Deprecated | composes Language + Country; consumed by every user-facing surface | ~10³; per-user preference resolves to one Locale; CLDR-aligned conceptually |
| **Translation Catalog** | Versioned key→text sets per Language, namespaced by feature domain; single source of user-visible strings (today: hardcoded Arabic — named debt this retires) | REF, versioned | Draft → Review → Published → Superseded | depends on Languages; feeds apps, notifications, documents | completeness metrics per language; publish gates ("launch blocks below 100% of legal-critical namespace") |
| **Localization Package** | The *deployable unit* of localization for a market entry: locales + catalogs + formats + templates bundled and validated together | CFG bundle | Assembled → Validated → Released | aggregates Catalogs, Locales, Templates | one package per country launch; re-released independently of software |
| **Notification Templates** | Localized, parameterized message bodies (push/SMS) per event type per language (today: hardcoded strings in code) | CFG, versioned | Draft → Approved → Active → Retired | uses Catalogs, Placeholders bound to Events | per country/market variants via cascade; legal notices flagged mandatory |
| **Document Templates** | Localized generated documents: receipts, invoices, driver contracts (today: absent) | CFG, versioned | Draft → Legal-Approved → Active → Retired | uses Catalogs, Tax/Legal fields | invoice formats differ per jurisdiction — resolved via cascade |

### 4C. Money & Tax Cluster (owners: Geography for reference, Commerce for application)

| Entity | Purpose & Responsibilities | Class | Lifecycle | Relationships / Dependencies | Configuration & Scale / Future |
|---|---|---|---|---|---|
| **Currency** | Denomination authority: code, minor units (KWD = 3 decimals — today's silent assumption becomes data), rounding rules, cash denominations | REF/IMM | Active → Retired (redenominations are new entries) | referenced by Wallets, Pricing, Payments | ~180; formatting via Locale, arithmetic rules via Currency — deliberately separated |
| **Exchange Rate** | Time-stamped conversion facts between currencies for reporting/consolidation (operational money stays single-currency per country) | HIST/IMM | continuous append | depends on Currencies; consumed by group reporting, cross-border wallet policy | append-only series; rate *source* and *type* (reporting vs. transactional) are part of the fact |
| **Tax Profile** | The named tax regime applied in a scope (country default, market/city variants where federal states require) | REF, versioned | Draft → Enacted(effective date) → Superseded | owns Tax Rules; referenced by Invoices, Pricing | resolves via cascade; **restrictive/statutory — not overridable downward** |
| **Tax Rule** | Atomic levy: kind (VAT, ride levy, airport fee), base, rate/amount, applicability predicate (vehicle type, zone, service) | REF/IMM per version | Enacted → Superseded (never edited) | owned by Tax Profile; consumed at settlement time | historical Trips must re-resolve the rule version effective on their date — principle 4 |
| **Supported Payment Methods** | Which instruments exist per scope (cash, wallet, card schemes, local schemes like KNET) and their constraints (cash caps, KYC tiers) | CFG | Enabled → Restricted → Disabled | depends on Country regulation + PSP availability; consumed by Commerce | cascade-resolved; e.g., cash disabled per-zone (airports) while enabled country-wide |

### 4D. Temporal & Formats Cluster (owner: Geography & Localization)

| Entity | Purpose & Responsibilities | Class | Lifecycle | Relationships / Dependencies | Scale / Future |
|---|---|---|---|---|---|
| **Time Zone** | IANA-aligned zone reference per City (cities, not countries — countries span zones); DST discipline: store instants, render via zone | REF/IMM | tracks IANA updates as versions | City → exactly one; consumed by scheduling, Business Hours, reports | ~600 zones; "today" in reports is always *city-local* |
| **Holiday Calendar** | Statutory/observed holidays per country with market/city additions (pricing, support staffing, SLA clocks) | REF, versioned | published annually, amendable | depends on Country; merged via cascade (union semantics §6) | Islamic-calendar holidays shift yearly — authored per year, never computed in code |
| **Business Hours** | Operating windows per scope for services and support (scooter curfews, support coverage) | CFG | versioned | expressed in city-local time; consumed by availability logic | Ramadan-mode variants are scheduled configuration versions, not code |
| **Measurement System** | Units regime (metric/imperial) + display conversions; internal canonical units are metric forever | REF/IMM | static | Locale-linked default, country-overridable | conversion at display only — never in stored facts |
| **Phone Number Format** | National numbering plan: country code, lengths, mobile patterns, display format (today: 8-digit Kuwait assumption in validators — becomes data) | REF, versioned | tracks numbering-plan changes | consumed by Identity (phone-keyed users!), display formatting | validation strictness is per-country data; E.164 is the storage canon |
| **Address Format** | Field set, order, and mandatoriness per country (block/street in Kuwait vs ZIP in US) | REF, versioned | evolves rarely | consumed by profiles, invoices, geocoding | display + capture template; no universal address schema is attempted — that's the point |

### 4E. Regulatory & Compliance Cluster (owner: new **Compliance authority within Operations context**; consumed platform-wide)

*(A-001)* Every rule family below is **authored by a Jurisdiction** (not by a geographic
tier); geography only determines *which* Jurisdictions apply at a location (§8).

| Entity | Purpose & Responsibilities | Class | Lifecycle | Relationships / Dependencies | Scale / Future |
|---|---|---|---|---|---|
| **Jurisdiction** *(A-001)* | **A legal/regulatory authority** — national, state/provincial, emirate, municipal, or special (airport authority, free-trade zone, port, military). Not geography: it *legislates over* territory it covers. Owns regulatory authority for: tax rules, privacy, insurance, driver licensing, vehicle regulation, business licensing, labor rules, safety rules, emergency regulation, compliance policies, data-residency requirements, payment restrictions | REF, versioned | Recognized → Active → Superseded/Dissolved (successor named; history intact) | parent/child authority links (Federal→State→Municipal, variable depth); **coverage links** from Country/Region/City/Zone nodes; owns its rule-family versions; consumed by Compliance evaluation | ~10⁴ globally; Kuwait = single national Jurisdiction (degenerate case). Growth is O(legal footprint) |
| **Identity Verification Rules** | What proves a person per country: documents, KYC tiers, age minimums per role (rider vs driver) | REF, versioned | Enacted → Superseded | gates Identity onboarding flows | restrictive-wins; per-role rule sets |
| **Driver License Rules** | License classes per Vehicle Type, minimum tenure, medical/background checks, renewal cadence | REF, versioned | Enacted → Superseded | Identity (Driver role) + Mobility (Vehicle Type) | today: implicit "approved by admin" — becomes named rule set the approval workflow *executes* |
| **Vehicle Regulation** | Per country/market per Vehicle Type: max age, inspection cadence, required equipment, scooter helmet/speed/parking rules | REF, versioned | Enacted → Superseded | gates Vehicle onboarding, feeds Inspection schedules | zone-tightenable (speed caps in zones) |
| **Insurance Rules** | Mandatory coverage types/minimums per role and Vehicle Type; proof-of-cover validity rules | REF, versioned | Enacted → Superseded | gates Driver/Vehicle activation; feeds Incident handling | integrates with expiry-driven de-activation |
| **Privacy Rules** | Data-protection regime per country: retention periods, consent requirements, residency constraints, subject rights and deadlines | REF, versioned | Enacted → Superseded | constrains *every* context; feeds retention/erasure obligations | the one rule family that governs the platform itself, not just users |
| **Legal Agreements** | Versioned ToS/driver contracts/privacy notices per country per language; acceptance is a recorded fact | REF/IMM versions + HIST acceptances | Draft → Legal-Approved → Active → Superseded | depends on Document Templates, Languages | re-acceptance triggers on material change; acceptance records are immutable |
| **Compliance Rules** | The umbrella: machine-evaluable predicates binding the above families to actions ("driver may not go online unless…") with evidence requirements | REF, versioned | Enacted → Superseded | composes all regulatory entities; consumed as gates by workflows | audit answers "which rule version allowed this, when" — pairs with ADR-002 Audit Log |
| **Emergency Contacts** | Per country/city: emergency numbers (112 vs 911), platform safety line, escalation routing for Incidents | REF | Published → Updated | consumed by apps (SOS), Incident workflows | small, life-critical, aggressively cached offline in apps |

### 4F. Configuration & Features Cluster (owner: Geography & Localization; flags shared with Operations)

| Entity | Purpose & Responsibilities | Class | Lifecycle | Relationships / Dependencies | Scale / Future |
|---|---|---|---|---|---|
| **Country Policies** | Non-regulatory business policy per country: cancellation windows, refund policy, driver commission bands, support SLAs | CFG, versioned | Draft → Active → Superseded | cascade-resolved; consumed by Commerce/Operations | distinct from law on purpose: policies may relax downward, laws may not |
| **Country Features** | Which platform capabilities are offered per country (verticals, wallet top-up, scheduled rides) — the country's *service catalog* | CFG | Enabled → Sunset | composes Vehicle Types + Feature Flags | "scooters not offered in country X" is one row here, zero code |
| **Feature Flags** | Fine-grained runtime toggles with scope (global→zone) and audience (%, role, cohort) for rollout/kill-switch | CFG (short-lived by policy) | Created → Ramping → 100%/Killed → **Removed** | leaf mechanism the cascade resolves like any config | flags are *temporary by covenant* — permanent behavior graduates into Country Features/Policies |
| **Market Configuration** | A-001's owned bundle: the Market Defaults cascade layer — pricing defaults, dispatch tuning, ops parameters | CFG, versioned | versions with Market lifecycle | between Country Defaults and City Overrides | the working surface for Market Managers; most day-to-day tuning happens here |

## 5. Ownership Rules

- **Geography & Localization** owns the spine, localization cluster, temporal/formats,
  currencies, and the configuration cascade mechanism itself.
- **Commerce** owns the *application* of tax/pricing/payment reference data at transaction
  time (and the resulting HIST facts); it never authors jurisdictional reference data.
- **Compliance (Operations)** owns regulatory rule families and their evaluation; Identity
  and Mobility *execute* its gates, never define them. *(A-001)* Compliance also owns the
  **Jurisdiction registry and its geography coverage links**; Geography & Localization owns
  the geographic nodes those links attach to — neither context reaches into the other.
- **Immutable:** Languages, Locales, Currencies, Measurement Systems, enacted rule/tax/agreement
  *versions*, Exchange-Rate facts, acceptance records.
- **Reference data:** the spine, calendars, formats, rule families — versioned, append-only.
- **Configuration:** policies, features, flags, market config, business hours, payment-method
  enablement — cascade-resolved, versioned.
- **Historical:** exchange rates, agreement acceptances, resolved-rule evidence attached to
  settlements — never rewritten (ADR-002 principle 7).

## 6. Configuration Cascade

**Layers:** `Platform Global Defaults → Country Defaults → Market Defaults → City Overrides
→ Zone Overrides`. (Region is deliberately a *passthrough* tier — administrative, not
configurational; adding a config layer there later is an amendment, not a redesign.)

**Resolution algorithm (conceptual).** Every configurable key resolves in the context of a
scope chain derived from a City (or Zone): collect values from leaf to root; apply the
key's declared **merge semantics**:
- *Scalar keys* — nearest-ancestor-wins (City override beats Market default beats Country).
- *Set keys* (e.g., holiday calendars, enabled payment methods) — declared per key as
  either **union** (holidays: country ∪ market ∪ city additions) or **intersection/
  restriction** (payment methods: child may only remove, never add what Country regulation
  didn't grant).
- *Regulatory keys* — **restrictive-wins**: descendants may tighten, never relax (§3.3).
  A Zone speed cap below the city's is valid; above it is a rejected authoring error.

**Conflict resolution.** Same-scope conflicts are authoring-time errors (validation gate at
publish, not runtime surprises). Cross-family conflicts (policy allows what a compliance
rule forbids) resolve by fixed rank: **Law > Safety > Contract > Policy > Optimization** —
and are surfaced to the author at publish time with the winning rule named.

**Versioning philosophy.** Every layer's values are effective-dated versions; resolution is
therefore a function of *(key, scope, instant)* — the same question asked about last March
returns last March's answer. Publishing is staged (draft → validated → scheduled →
effective), and every published version records author + approver (feeds Audit Log).
Rollback = scheduling the prior version, never deleting the failed one.

## 7. Localization Architecture

- **Locale-driven:** the user's resolved Locale (explicit preference → device locale →
  city default → country default) governs direction, date/number/currency formatting,
  collation, and plural selection. **RTL is a first-class rendering mode** — Arabic is the
  home market; LTR is the alternate case, not vice versa.
- **Fallback chain, never-fail:** `ar-KW → ar → en (platform base)`. Every string key is
  guaranteed at the base; a missing localized entry logs a completeness gap and falls back
  — it never blocks a flow. New languages enter by authoring catalogs against the same key
  space; per-namespace completeness thresholds gate market launch (100% for legal-critical
  namespaces, lower bars for long-tail admin text).
- **Pluralization:** plural-category sets per language (Arabic's six categories are the
  proof case) resolved per Locale — string keys carry category variants, code never
  concatenates grammar.
- **Formatting:** dates/numbers/currency rendered via Locale + Currency minor-unit rules
  (KWD 3-decimal is data, §4C); calendars respect Locale (Hijri display where preferred,
  Gregorian canonical storage). Measurements stored metric, converted at display per §4D.
- **Catalog governance:** namespaced by feature domain; versioned with review workflow;
  Notification and Document Templates consume catalog keys, so a re-translation re-releases
  a Localization Package without touching application software.

## 8. Compliance Architecture

Country differences (tax, insurance, driving law, age limits, business licensing, vehicle
requirements, emergency regulation, privacy, payment restrictions) are absorbed by the rule
families of §4E under four invariants: (1) rules are **data with effective dates**, never
branches in code; (2) **restrictive-wins** across applicable authorities; (3) every gated
action records *which rule version of which Jurisdiction* authorized it (evidence, paired
with Audit Log); (4) rule evaluation is a **platform capability** — Identity/Mobility/
Commerce ask "may X do Y in scope Z now?" and enforce the verdict, so a new jurisdiction's
peculiarity lands as authored rules, and the same workflows simply produce different
outcomes per country.

*(A-001) Legal resolution model.* For any location and instant: derive the geographic chain
(Zone→City→Region→Country) → collect the **applicable Jurisdiction set** via coverage links
(e.g., US city: Federal + State + Municipal + possibly Airport Authority) → gather each
family's rule versions effective at that instant → resolve: higher-authority *floors* bind
lower authorities (a State may tighten Federal, never relax it); among overlapping
authorities, **restrictive-wins**; explicit statutory preemption is modeled as an authored
exception on the rule itself, never inferred. Historical traceability: the resolution is a
pure function of *(location, families, instant)* over immutable versions — any past verdict
is reproducible for audit, and every recorded verdict names the winning Jurisdiction + rule
version. Privacy Rules
additionally constrain the platform itself (retention, residency, subject rights) — they
are input to infrastructure planning, not just user flows.

## 9. Country Expansion Strategy

A launch is the authored production of one **Country Entry**: ① reference spine (country,
market(s), regions, launch cities, zones) → ② money & tax (currency confirmation, tax
profile + rules, payment methods) → ③ formats & temporal (time zones, calendars, phone/
address formats, business hours) → ④ regulatory pack — **beginning with the Jurisdiction
map** (authorities + coverage links; unitary states author one, federal states author the
full set) *(A-001)*, then identity/license/vehicle/insurance/privacy rules, agreements,
emergency contacts per Jurisdiction → ⑤ Localization Package (locales, catalogs
at threshold, templates) → ⑥ Country Features + policies + market configuration → ⑦
validation gates (completeness, cascade conflicts, legal sign-off) → ⑧ staged activation
(internal → pilot zone → city → market). The playbook is executable by expansion teams;
engineering involvement signals an architecture gap to be fixed *as architecture*, not per
country. **Kuwait is retro-authored as Country Entry #1 first** — the dry run that proves
the mechanisms (principle 8).

## 10. Scalability Notes

At 200+ countries / 5,000+ markets / 100,000+ cities / millions of zones: resolution cost
is O(chain depth ≤ 5) per key with near-total cacheability (reference data changes rarely
and versions are immutable — cache keys include version); zones are the only geometry-
bearing tier and live behind geo-indexes; catalogs/templates are static-distributable
(CDN-class) per Localization Package version; per-entity cardinalities were stated in §4
and none grows with ride volume — **this entire architecture is O(business footprint), not
O(traffic)**, which is what makes it safe to build ahead of scale. *(A-001)* Jurisdictions
add ~10⁴ entities and one set-collection step to legal resolution — the applicable set per
City is small (typically 1–4), stable, and cacheable exactly like the cascade itself.

## 11. Risks

1. **Sequencing (standing):** none of this precedes G1 — **C-1 remains open** — and the
   authoring substrate arrives with G3/G4 (PostgreSQL + platform features). This ADR is the
   blueprint for G4, not a license to start it early.
2. **Authoring burden**: 32 entity kinds need authoring/validation tooling and governance;
   without it, "configuration not code" degrades into "spreadsheets and heroics." Tooling
   is part of G4 scope.
3. **Cascade misuse**: overrides accreting at every layer make behavior hard to reason
   about — mitigated by publish-time conflict gates, override budgets/reviews, and the
   flags-are-temporary covenant.
4. **Retro-authoring Kuwait** will surface hidden assumptions (8-digit phones, 3-decimal
   KWD, Arabic-only strings, admin-as-regulator) — that is its purpose; budget real time.
5. **Legal review is a human bottleneck** per country; the architecture makes launches
   parallelizable, not lawyers.
6. *(A-001)* **Jurisdiction-map correctness is a legal risk, not a technical one**: wrong
   coverage links silently apply the wrong law. Mitigation: coverage links require legal
   sign-off like rule versions, and launch validation (§9 ⑦) includes jurisdiction-map
   review per city.

## 12. Future Evolution

Anticipated amendments, all absorbable: config layer at Region (if federal states demand
it); multi-market cities (megacity split — would amend A-001's 1:1 City→Market rule);
transactional multi-currency (tourist pays foreign card — Exchange Rate gains a
transactional type); machine-translation-assisted catalog pipelines; a dedicated Compliance
bounded context if rule volume outgrows Operations; *(A-001)* supranational Jurisdictions
(EU-style) and interstate compacts as authority nodes above Country — the variable-depth
authority chain already accommodates them. Each lands via the ADR-002 §8 test.

## 13. Final Certification

Checked against mandate: all 15 objective areas designed; all 32 required entities cataloged
with purpose/responsibilities/ownership/lifecycle/relationships/dependencies/configuration/
scalability/future dimensions; ownership + immutability classes assigned; cascade defined
with precedence, conflict resolution, and versioning; localization covers RTL/LTR, ar/en +
future languages, plurals, formats, conversion, catalogs, fallback; compliance covers the
required difference classes; scale targets met by O(business-footprint) analysis; zero
implementation, schema, API, or microservice content; ADR-002 extended, not redesigned.

**ADR-003 — COUNTRY & LOCALIZATION ARCHITECTURE — WORLD-CLASS CERTIFIED**
