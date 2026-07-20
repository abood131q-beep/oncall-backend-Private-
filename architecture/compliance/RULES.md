# Engineering Rules — Automatable Architecture Constraints

**Phase:** 3.5 (Architecture Governance) · **Authority:** ADR-005, ADR-008, ADR-012, ADR-015
**Enforced by:** `architecture/compliance/verify-architecture.mjs` (run in CI — ADR-009 quality gate)

These are the architecture rules that can be verified **mechanically**. Each is checked by the
verifier over every file in the enterprise layers (`src/{domain,application,infrastructure,presentation}`),
auto-discovered so the rule set stays valid as new bounded contexts migrate. A CRITICAL
violation fails the build (non-zero exit).

Severity: **CRITICAL** blocks merge · **MAJOR** blocks release · **MINOR** tracked as debt.

| ID | Description | Verification method | Severity | ADR |
|----|-------------|---------------------|:--------:|:---:|
| **R1** | No web framework (Express / Socket.IO) inside Domain or Application | Static: scan `require(...)` in `src/domain`, `src/application` for `express`/`socket.io` | CRITICAL | ADR-005 §18 |
| **R2** | No SQL outside Infrastructure | Static: regex for `SELECT/INSERT/UPDATE…SET/DELETE/CREATE TABLE/BEGIN` (comments stripped) in Domain/Application/Presentation | CRITICAL | ADR-004, ADR-005 |
| **R3a** | Presentation must not import Domain (no business decisions in controllers) | Static: no `require('.../domain/...')` in any `src/presentation` file | CRITICAL | ADR-005 §4 |
| **R3b** | Controllers must not import Infrastructure or the database (composition roots `*Routes.js` excepted) | Static: no `infrastructure`/`database`/`sqlite` require in non-`*Routes.js` presentation files | CRITICAL | ADR-005 §4 |
| **R4** | Domain depends on nothing above it (pure) | Static: Domain files import no `application`/`infrastructure`/`presentation` path | CRITICAL | ADR-005 §18 |
| **R5** | Application depends only downward (Domain + own ports), never Infrastructure/Presentation | Static: Application files import no `infrastructure`/`presentation` path | CRITICAL | ADR-005 §2 |
| **R6** | No circular dependencies among enterprise-layer files | Graph: DFS colouring over the local `require` graph of all enterprise files | CRITICAL | ADR-005, ADR-008 |
| **R7** | Every application composition root asserts its ports at startup (fail-fast) | Static: `*/application/*/index.js` calls `assertPorts` (or equivalent) | MAJOR | ADR-005 §2 |

## Rules enforced by discipline + tests (not yet fully static)

These are architectural laws from the corpus that are currently proven by **tests and review**
rather than the static verifier; candidates for future automation are noted.

| ID | Description | Current verification | Severity | ADR |
|----|-------------|----------------------|:--------:|:---:|
| **R8** | One command = one context's state within one transaction boundary | Review + `dbTransaction` serialization; C-1 concurrency tests | CRITICAL | ADR-005 §3, ADR-001 |
| **R9** | One use case per business capability (one owner) | Review: `useCases.js` per context; A/B parity | MAJOR | ADR-005 §1 |
| **R10** | Queries never mutate | Review: query use cases return `{ ok, value }`, no writes | MAJOR | ADR-005 §2 |
| **R11** | Gates (authorization/validation) run before domain logic | Review + unit tests (e.g. `balanceReadAuthorization` before read) | CRITICAL | ADR-005 §4 |
| **R12** | Response contract is frozen (status, JSON, key order, messages) | A/B compatibility harnesses (Identity 35/35, Users 17/17) | CRITICAL | ADR-006, G0.0 |
| **R13** | Cross-context knowledge only via references, never copies | Review: adapters delegate to owning repositories | MAJOR | ADR-002 §5, ADR-004 |
| **R14** | User-facing strings resolve through the localization catalog | Review: enterprise controllers use injected `translate` | MINOR | ADR-003 |
| **R15** | Facts are immutable; corrections are new facts | Review: append-only transactions / audit logs | MAJOR | ADR-004 |

## How to run

```
node architecture/compliance/verify-architecture.mjs        # human report, exit 1 on CRITICAL
node architecture/compliance/verify-architecture.mjs --json  # machine-readable
```

Wire into CI alongside `npm run lint`, `npm test`, and the A/B harnesses (ADR-009 quality
pipeline). The verifier is intentionally dependency-free and does not import the application.
