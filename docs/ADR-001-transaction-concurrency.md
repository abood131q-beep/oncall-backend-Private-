# ADR-001 — Transaction Concurrency & C-1 (Financial Consistency on Trip Completion)

**Status:** RATIFIED (Accepted) — 2026-07-20 · **Decision:** Option **A + D** ("C-1 fix")
**Date:** 2026-07-16 · **Ratified:** 2026-07-20 (Chief Enterprise Architect, opening Phase 11 Commerce)
**Scope:** oncall-backend only (no API, schema, Flutter, or MCP changes in any option except E)

---

## 0. Ratification Record (2026-07-20)

ADR-001 is **formally ratified** with the recommended decision from §4: **Option A + D together**
(the "C-1 fix"). This ratification is the governance gate that authorizes **Phase 11 (Commerce:
Wallet & Payments)** to begin.

**The decision is already implemented and validated in the repository** (not a forward promise):
- **Option A** — the in-process serialization mutex (promise-chain) inside `dbTransaction`
  (`src/config/database.js`) is live; it also removed the admin double-approve 500s (M-4).
- **Option D** — trip completion settles payment inside the single serialized transaction boundary
  (reused via the Trips `completionGateway`), so completion+payment is one idempotent unit —
  eliminating the double-charge window and the cross-request ROLLBACK hazard.
- **Validation (§5) executed across Phases 4–10:** lint/format clean; the full unit suite green; the
  live race re-tests pass (double-complete ⇒ exactly one 200 + one clean 4xx, one wallet deduction,
  one `trip_payment` row; double-approve ⇒ no 500); wallet-insufficient and cash paths regression-
  clean; every A/B harness byte-identical.

**E** (PostgreSQL migration) remains a post-launch roadmap item, not part of this decision. With the
financial-consistency substrate ratified and proven, the Commerce bounded context may now be
migrated under ADR-005 with its settlement invariants frozen.

---

## 1. Problem Statement (verified in code)

All DB access flows through **one shared `sqlite3` connection** (`database.js` → `src/config/database.js`).

Verified facts:

1. `dbTransaction()` (`src/config/database.js:61`) runs `BEGIN IMMEDIATE / COMMIT / ROLLBACK` on the
   shared connection. Two concurrent transactions → second `BEGIN` fails with
   `cannot start a transaction within a transaction` → HTTP 500 (proven live, P6-06 §3, §5).
2. Trip completion (`src/routes/taxi.js:285-356`) is **not atomic**:
   - `tripRepo.completeTrip()` (line 324) commits `status='completed'` **outside any transaction**,
     with **no status guard** in its `UPDATE ... WHERE id = ?` (TripRepository.js:243).
   - Payment then runs inside a raw `BEGIN TRANSACTION` (line 327, deferred — not even IMMEDIATE).
   - Concurrent completion: trip is completed but payment block 500s → `payment_status` stuck
     `pending` → **financial inconsistency (C-1)**.
3. **Additional hazard found during this review:** the `catch` at taxi.js:352 issues a raw
   `ROLLBACK` on the shared connection. If request B's `BEGIN` failed because request A's
   transaction was open, B's `ROLLBACK` **rolls back A's in-flight transaction** — cross-request
   corruption of an unrelated payment. Also, because `completeTrip` has no status guard, a
   double-complete that is serialized in time (not simultaneous) can **charge the wallet twice**.
4. WAL mode is already ON (`PRAGMA journal_mode=WAL`, database.js config).

Two distinct defects therefore exist:
- **(i) Structural:** shared-connection transactions collide (affects admin approval races too).
- **(ii) Boundary:** trip completion + payment are split across two non-atomic steps with no
  idempotency guard.

Any complete fix for C-1 must address both.

---

## 2. Options

### Option A — Serialize transactions with an in-process mutex queue

**Design:** Add a promise-chain mutex inside `dbTransaction()`. Every caller awaits the previous
transaction's completion before `BEGIN IMMEDIATE`. ~10 lines in `src/config/database.js`. No call-site
changes (admin.js's 4 usages and all future usages benefit automatically). Optional timeout to
surface stalled transactions.

| Criterion | Assessment |
|---|---|
| Advantages | Smallest possible diff; fixes ALL nested-BEGIN 500s platform-wide; no call-site changes; works identically under node-sqlite3 and the node:sqlite lab adapter |
| Disadvantages | Does NOT fix defect (ii) by itself; write transactions queue behind each other |
| Performance | Negligible: SQLite is single-writer anyway; queueing replaces errors, not parallelism. Reads (`dbGet/dbAll` outside transactions) unaffected |
| Scalability | Single-process only (fine: one Node process today). Meaningless beyond ~1 process — see E |
| Risk | Low. A hung `fn()` stalls the queue → mitigate with timeout |
| Backward compat | 100% — same function signature, same semantics |
| Effort | ~0.5 day incl. validation |
| Regression risk | Very low (one function, behavior-preserving for the non-concurrent path) |

### Option B — One SQLite connection per transaction

**Design:** `dbTransaction()` opens a fresh `sqlite3.Database` per transaction; `BEGIN IMMEDIATE` on
it waits on `busy_timeout` and losers get `SQLITE_BUSY` → mappable to 409. Requires `fn(tx)` to
receive transaction-scoped `get/run/all` — **every call site inside every transaction must switch
from the global `dbGet/dbRun` to the passed handle**, or writes silently escape the transaction.

| Criterion | Assessment |
|---|---|
| Advantages | True concurrent readers during write transactions; natural 409 mapping via SQLITE_BUSY; closer to "real DB" semantics |
| Disadvantages | Changes the `dbTransaction(fn)` contract; all 4 admin.js transactions + the new payment transaction must be rewritten to use `tx.*`; easy to leak a global `dbRun` inside `fn` (silent atomicity bug — the worst failure mode); connection-open cost per transaction; PRAGMAs must be reapplied per connection |
| Performance | Slightly better read concurrency; per-tx connection overhead (~ms) |
| Scalability | Same single-writer ceiling as A (SQLite WAL = 1 writer) |
| Risk | Medium — silent transaction-escape bugs are hard to catch in review |
| Backward compat | API of dbTransaction changes (breaking for internal callers) |
| Effort | 2–3 days incl. auditing every statement inside every transaction |
| Regression risk | Medium |

### Option C — WAL + busy_timeout improvements only

**Design:** Tune `PRAGMA busy_timeout`, keep WAL, retry on SQLITE_BUSY.

| Criterion | Assessment |
|---|---|
| Advantages | Trivial to apply |
| Disadvantages | **Does not fix the bug.** The failure is `cannot start a transaction within a transaction` on the SAME connection — that is an API-misuse error, not SQLITE_BUSY. busy_timeout only arbitrates BETWEEN connections; we have one. WAL is already enabled |
| Performance / Scalability | No change |
| Risk | Creates false confidence |
| Backward compat | Full |
| Effort | Hours |
| Regression risk | None (because it changes nothing relevant) |
| Verdict | **Rejected as ineffective** |

### Option D — Refactor payment transaction boundaries

**Design:** Fix defect (ii) at the source: in taxi.js `status === 'completed'`, replace
`completeTrip()` + raw `BEGIN` block with **one** `dbTransaction()` containing:
1. Guarded completion: `UPDATE trips SET status='completed', ... WHERE id=? AND status != 'completed'`
   (idempotency: `changes===0` → 409 "already completed", no double charge).
2. `processPayment()` (wallet deduct + transaction log).
3. `payment_status` update.
Removes the dangerous raw `BEGIN/COMMIT/ROLLBACK` (hazard §1.3). Notification send moves after
commit (side effect, not part of atomicity).

| Criterion | Assessment |
|---|---|
| Advantages | Directly eliminates C-1's financial inconsistency AND the double-charge AND the cross-request ROLLBACK hazard; makes completion idempotent (correct 409 semantics) |
| Disadvantages | **Alone it is insufficient**: two simultaneous `dbTransaction`s still collide (defect i) → loser still 500s. Touches payment-critical code (requires the full validation battery per platform rules) |
| Performance | Neutral (same statements, one transaction instead of implicit-commit + transaction) |
| Scalability | Neutral |
| Risk | Low–medium (payment path — mitigated by guarded UPDATE + full race re-test) |
| Backward compat | Full — same endpoint, same response shapes; only loser status code improves (500→409) |
| Effort | ~1 day incl. validation |
| Regression risk | Low, concentrated in one route handler |

### Option E — Migrate affected flow to PostgreSQL

**Design:** Move trips/wallets/transactions to Postgres with real row locking (`SELECT ... FOR UPDATE`),
connection pool, `SERIALIZABLE`/`READ COMMITTED` as needed.

| Criterion | Assessment |
|---|---|
| Advantages | Real concurrency, real 40001/409 semantics, horizontal app scaling, the correct end-state for an enterprise-grade ride-sharing platform |
| Disadvantages | New infra dependency (violates current zero-infra deployment); dual-store or big-bang migration; every repository rewritten (sqlite3 API → pg); test/CI/backup/restore tooling all rebuilt; MCP + integration tests re-validated |
| Performance | Better under real load; worse at current scale (network hop) |
| Scalability | Excellent |
| Risk | High — largest possible blast radius; directly conflicts with "never perform massive refactors" |
| Backward compat | API-compatible but operationally breaking (deployment, backups, /admin/db/* endpoints assume SQLite) |
| Effort | 2–4 weeks |
| Regression risk | High |
| Verdict | Right long-term direction; **wrong vehicle for closing C-1 now**. Keep as separate roadmap item |

---

## 3. Decision Matrix

| | Fixes 500-collisions (i) | Fixes payment atomicity (ii) | Fixes double-charge | Effort | Regression risk |
|---|:--:|:--:|:--:|:--:|:--:|
| A | ✅ | ❌ | ❌ | 0.5d | Very low |
| B | ✅ | ❌ | ❌ | 2–3d | Medium |
| C | ❌ | ❌ | ❌ | — | — |
| D | ❌ | ✅ | ✅ | 1d | Low |
| E | ✅ | ✅* | ✅* | 2–4w | High |

\* only after full migration and rewrite of the flow.

**No single option among A–D closes C-1.** A and D fix disjoint halves of the defect; E fixes both
at unacceptable cost/risk today.

---

## 4. Recommendation

**Adopt A + D together as one atomic task** ("C-1 fix"):

- **A** makes `dbTransaction` collision-free platform-wide (also fixes the admin race 500s — M-4)
  with a ~10-line, zero-call-site change.
- **D** makes completion+payment a single idempotent transaction, eliminating the financial
  inconsistency, the double-charge window, and the cross-request ROLLBACK hazard.

Combined blast radius: 2 files (`src/config/database.js`, `src/routes/taxi.js`). No API shape,
schema, Flutter, or MCP changes. Loser responses become clean 400/409 instead of 500.
E is recorded as a roadmap item (post-launch), not part of this decision.

**Rejected:** C (ineffective), B (higher risk for no additional correctness over A at current
scale), E-now (violates minimal-change safety rules).

---

## 5. Validation Plan (on approval)

1. `npm run lint`, `npm run format:check`
2. `node --test tests/unit` (55 tests)
3. `bash run_tests.sh` (integration)
4. Live race re-test: double-complete same trip (assert: one 200, one 4xx, exactly ONE wallet
   deduction, exactly ONE trip_payment transaction row, `payment_status='completed'`); double-approve
   driver (assert: no 500)
5. MCP smoke (`test-mcp.mjs`) against live server
6. Wallet-insufficient and cash paths regression check
