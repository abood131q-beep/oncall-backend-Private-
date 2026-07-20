# OnCall Platform — Architecture

## 1. Purpose

This directory is the **official architectural source of truth** for the OnCall Global
Mobility Platform. Every significant architectural decision, principle, and constraint
governing the platform is recorded here. When a question arises about *why* the platform
is built the way it is — or *whether* a proposed change is permissible — this directory
holds the authoritative answer.

Code expresses the architecture; it does not define it. If the code and this directory
disagree, one of them has a defect, and the discrepancy is resolved through the
contribution process below — never by silently accepting the drift.

## 2. Repository Structure

| Path | Purpose |
|---|---|
| `architecture/` | Root of the architectural source of truth. Contains this README and all architectural records. Nothing in this directory is implementation; everything in it governs implementation. |
| `architecture/G0.0/` | The **Evolution Strategy** artifacts — the foundational document set establishing how the platform evolves: incremental, preserve-and-evolve, no rewrites. G0.0 is the philosophical starting point of the entire corpus and the required first read for new engineers. |
| `architecture/ADR/` | The **Architecture Decision Records** — the numbered, permanent record of every significant architectural decision (ADR-001 onward), including amendments. ADRs are append-only history: they are amended or superseded through governed process, never edited in place or deleted. |

> **Note on current corpus location:** the authored corpus (G0.0, ADR-001…ADR-015,
> amendments) currently resides in `../docs/`. Migration into this structure is a
> separate, explicitly approved step; until then, this README indexes intent and the
> documents in `docs/` remain authoritative.

## 3. Architectural Decision Records (ADR)

An **ADR** is a short, permanent document that captures one significant architectural
decision: the context that made the decision necessary, the options considered, the
decision taken, its consequences, and the evidence supporting it. ADRs exist so that
future engineers inherit not only *what* was decided but *why* — preventing both
accidental reversal of deliberate choices and cargo-cult preservation of obsolete ones.

**Every significant architectural decision must be documented as an ADR.** "Significant"
means any decision that: changes a public contract, crosses a bounded-context boundary,
affects data classification or lifecycle, alters security or compliance posture, adds or
removes a platform mechanism, or would be expensive to reverse. If reasonable engineers
could later ask "why is it like this?", it needs an ADR.

ADRs follow a strict lifecycle: **Proposed → Certified → FINAL → Amended / Superseded.**
FINAL ADRs are never rewritten — they change only by amendment (see ADR-002-A001 for the
canonical amendment pattern) or by an explicit superseding ADR that states what changed
in the world to justify it.

## 4. Engineering Rules

These rules bind all engineering work on the platform:

1. **No rewrite without an approved ADR.** Working systems are never discarded or
   rebuilt from scratch on engineering preference. A rewrite of any component requires
   an approved ADR stating the compelling architectural reason.
2. **Evolution over replacement.** Change proceeds through adjacent, operational,
   revertible states. Prefer strengthening an existing seam over introducing a new
   mechanism.
3. **Backward compatibility whenever possible.** The deployed clients and published
   contracts are standing parties to every change. Compatibility is broken only through
   governed deprecation with a migration path — never by surprise.
4. **Every major feature must reference one or more ADRs.** A feature that cannot cite
   its governing ADRs is either missing its architectural grounding or requires a new
   ADR before implementation begins.
5. **Architecture drives implementation, not the opposite.** Implementation convenience
   never silently reshapes the architecture. When implementation reveals that the
   architecture is wrong, the correct response is an ADR amendment — in the open,
   before the code lands.

## 5. Contribution Process

All architecturally significant work follows this workflow:

```text
Requirement
    ↓
Architecture Discussion
    ↓
ADR Approval
    ↓
Implementation
    ↓
Code Review
    ↓
Merge
```

**Requirement** — the need is stated in business terms: what must become possible, for
whom, and why now.
**Architecture Discussion** — the proposal is examined against the existing corpus:
impact analysis, affected contexts and contracts, options with trade-offs. Proposals
must pass the standing decision test (ADR-015 §5) before advancing.
**ADR Approval** — the decision is recorded as an ADR (or an amendment to an existing
one) and approved by the owning authority. Decisions carry an owner and a deadline; an
expired undecided decision is escalated, not forgotten.
**Implementation** — code is written *to* the approved ADR, referencing it explicitly.
**Code Review** — review verifies both code quality and **ADR conformance**: boundary
discipline, contract compatibility, and evidence (tests, validation results) for every
claim.
**Merge** — only after review passes and all validation gates are green. The merge
record links back to the governing ADR, closing the traceability loop from requirement
to running code.

## 6. Future Documents

**ADR-002 through ADR-015** — covering the global domain model, country and localization
architecture, data, application, integration, security, technical, deployment and
operations, observability and reliability, AI and automation, governance, the evolution
roadmap, the platform reference architecture, and the architecture manifesto — will
become the **permanent architectural references** for the platform, housed in
`architecture/ADR/`. Together with G0.0 they form the constitutional corpus that every
future decision, feature, and review is measured against.

---

*Maintained under the OnCall architecture governance process (ADR-012). Open decision
register — ADR-001: awaiting decision.*
