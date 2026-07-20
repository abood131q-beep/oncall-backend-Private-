# ADR-015 — Enterprise Architecture Manifesto
## The Constitution of the OnCall Platform

**Status:** Constitutional · **Date:** 2026-07-18
**Distills (FINAL, untouched):** G0.0 · ADR-002…ADR-014 with amendments
**Nature:** philosophy only. Nothing here is new; everything here was earned in the
corpus and, before that, in the running system. Where philosophy and a source ADR seem
to differ, the ADR governs the practice and this manifesto governs the *next* ADR.

---

## 1. Preamble

This platform began as one city's working system: a backend, two apps, a database file,
and the discipline to protect what worked. Everything since — sixteen documents, two
amendments, an enterprise blueprint reaching from Kuwait to a designed world — grew from
that discipline, never against it. This manifesto fixes the beliefs that made that
possible, so that decades from now, when every technology named in our validation
reports is a museum piece, the people maintaining this platform will still know what we
knew: *why* it is shaped the way it is, and what must never be traded away.

## 2. The Purpose of Architecture

Architecture exists here for exactly one reason: **so that strangers can trust the
platform with their journeys and their money, at any scale, in any country, indefinitely.**
Everything else — layers, contracts, classes, gates — is instrumental to that trust.
Architecture serves the business; the business serves riders, drivers, and the cities
they move through. An architectural decision that cannot trace itself to protected trust
is decoration, and decoration is debt.

## 3. Core Architectural Beliefs

Extracted from the corpus, each proven before it was written down:

- **Evolution over replacement.** The platform never jumps; it passes through adjacent,
  operational, revertible states. Preservation of working systems is not conservatism —
  it is respect for accumulated proof.
- **The business is data; the mechanisms are few.** Countries, markets, verticals,
  prices, languages, and laws are authored entries; the machinery that serves them
  changes rarely and identically everywhere. Growth is authorship, not construction.
- **Everything has one owner.** Every entity, datum, contract, decision, risk, and alert
  answers to exactly one accountable name. Shared ownership is abandonment with extra
  steps.
- **Boundaries are meaning.** A bounded context is a promise about vocabulary and
  responsibility; crossing one is a conversation between sovereigns, conducted by
  contract, translated at the door.
- **Facts are forever.** What happened, happened: trips, payments, verdicts, audits, and
  acceptances are immutable; corrections are new facts that name their cause. The
  present is merely the newest fact plus current state.
- **Identity is permanent; attributes change.** A person is one identity for life on
  this platform; roles, phones, vehicles, and standing all evolve around an unchanging
  anchor. Meaning encoded in identifiers rots; meaning belongs in attributes.
- **Trust is never ambient.** No actor — human, device, service, partner, government,
  or our own operator — is trusted for position, tenure, or title. Trust is established
  with evidence, re-verified continuously, and revocable instantly.
- **Law outranks everything we configure.** Jurisdictions legislate; the platform obeys
  as data. Down every hierarchy, descendants may tighten and never relax.
- **One promise, one boundary.** A command completes one party's promise atomically;
  anything spanning promises is a process with declared compensation. The platform never
  pretends two sovereigns can commit as one — it learned this from its own oldest bug.
- **Machines execute; humans govern.** Automation acts within registered classes, always
  with a tested deterministic fallback; it may restrict pending review, never punish
  finally; and no machine ever authors the rules it runs under.
- **Reliability is a budget, safety is a floor.** Everything degrades in a declared
  order, and safety functions are what everything else degrades *toward* protecting.
- **Observability is a duty of existence.** What cannot be seen cannot be owned; silence
  is a signal; a number without provenance is a rumor.
- **Evidence outranks opinion, seniority, and enthusiasm.** Certifications require
  proof; gaps are declared, never faked; what could not be verified is stated as such.
  This belief predates the corpus — it was the working rule of the platform's first
  honest validation report, and it is the reason the corpus can be trusted at all.
- **Debt is confessed at birth.** Every shortcut is registered as named legacy the day
  it is taken; correctness debt outranks all features; a platform whose oldest
  correctness debt is aging is failing, whatever else it ships.
- **Simplicity is the scaling strategy.** Scale is more partitions of unchanged shapes.
  Any mechanism that must grow cleverer as traffic grows is a defect of design.

## 4. Architectural Laws

The constitutional layer. Every future ADR, amendment, and consequential decision must
comply or explicitly amend:

1. **No rewrite law.** The platform evolves through adjacent operational states; big-bang
   replacement of working systems is constitutionally prohibited.
2. **Single-owner law.** Nothing governed may have zero owners or two.
3. **Immutable-fact law.** Facts append; corrections reference; history is never
   rewritten — in data, in audit, and in the ADR corpus itself.
4. **Boundary law.** Contexts collaborate only through certified contracts and events;
   foreign vocabulary is translated at every boundary, including our own past.
5. **Gate law.** Authorization, compliance, and validation precede every consequential
   act — for humans, services, and machines identically.
6. **Restriction law.** In every hierarchy — configuration, law, emergency policy,
   governance federation — lower levels may only tighten what higher levels grant.
7. **Compensation law.** No multi-boundary process ships without its declared reverse;
   no change ships without its rollback.
8. **Human-governance law.** Governance — rule authoring, privilege granting, final
   punishment, self-modification of boundaries — is permanently human. No exception, no
   maturity level, no efficiency argument.
9. **Evidence law.** Claims of passing, readiness, maturity, or certification require
   evidence; absence of evidence is stated, never papered over.
10. **Decision law.** Every raised decision carries an owner and a deadline; an expired
    undecided decision is a recorded governance failure.
11. **Compatibility law.** The deployed fleet — every client in every pocket — is a
    standing party to every contract; breaking it requires its migration, never its
    abandonment.
12. **Scale law.** Mechanisms may be O(1), data may grow with footprint and traffic,
    deliberation may grow with structure — nothing may couple mechanism complexity to
    traffic volume.

## 5. The Decision Test

Before any future architectural proposal is approved, it answers, in writing:

1. **Trust:** which part of the platform's core trust does this protect or extend?
2. **Owner:** who is the one accountable owner of what this creates?
3. **Adjacency:** is every step from here operational and revertible? Where is the
   rollback?
4. **Data-or-mechanism:** could this land as authored data, a role, a Vehicle Type, or
   an event consumer instead of new machinery? (If yes, it must.)
5. **Boundary:** whose contract changes? Additively? Who is notified?
6. **Law:** which of the twelve laws does it touch, and how does it comply?
7. **Evidence:** what proof will certify it, and what gap will be declared if proof
   cannot be produced?
8. **Debt:** what named legacy does it create, and where is that registered?

A proposal that cannot answer all eight is not rejected — it is *unfinished*. A proposal
whose honest answers violate a law requires a constitutional amendment first, in the
open, by the decision lifecycle.

## 6. Long-Term Vision

Decades out, technologies unrecognizable, this platform intends to be: **a system whose
growth remained authorship** — where entering the two-hundredth country was as boring as
entering the second, because boring was the design goal; **a system whose history is
intact** — every trip, payment, verdict, and decision since Kuwait reconstructible with
its authorizing rule, because trust compounds only over unbroken records; **a system
whose machines grew capable while its humans stayed sovereign**; and **a system whose
architecture documents still tell the truth** — because every generation of maintainers
honored the evidence law over the temptation to look finished. Permanence is not a
property of any component; it is the property of the discipline. Components are
replaceable precisely because the discipline is not.

## 7. Responsibilities of Future Architects

You who inherit this: **read the validation reports, not just the ADRs** — the corpus's
authority comes from a culture that ran the tests and printed the failures. **Amend,
never rewrite** — your predecessors bound themselves to the same law; the A-001 pattern
is your template. **Keep the laws few** — this constitution has twelve; if you need a
thirteenth, retire one or be certain. **Protect the honest sentence** — the hardest
duty here is writing "this was not verified" and "this decision is overdue" in documents
people want to be triumphant; the platform's entire integrity rests on those sentences
surviving you. **And decide** — architecture that waits is architecture that decays;
the register of undecided decisions is your first reading, every time.

## 8. Closing Declaration

Sixteen documents rest on one working system and one discipline. We declare the
architecture of the OnCall platform constitutionally complete as a corpus — and
constitutionally *honest*, which obliges this final sentence of record: the corpus's own
decision law was written in the shadow of its founding counter-example, and **the first
act under this constitution should be the decision it has awaited since its second
document: ADR-001, Milestone Zero.** A constitution proves itself not by its prose but
by its first enforcement. The prose is done. The enforcement is a single word away.

*Preserve what works. Evolve what must. Prove everything. Decide.*

## 9. Final Certification

Verified against mandate: pure distillation — zero new architecture, concepts,
technologies, vendors, methodologies, or implementation content; all 26 required
principle areas absorbed into the beliefs and laws (each traceable to corpus sources via
ADR-014's consolidated principles); beliefs extracted, not invented; twelve immutable
laws forming the constitutional layer; universal eight-question decision test verifying
consistency with all prior architecture; technology-independent long-term vision;
responsibilities of future architects; closing declaration honoring the corpus's own
evidence and decision laws.

**ADR-015 — ENTERPRISE ARCHITECTURE MANIFESTO**
**THE CONSTITUTION OF THE ONCALL PLATFORM — WORLD-CLASS CERTIFIED**

**— END OF ARCHITECTURE CORPUS —**
