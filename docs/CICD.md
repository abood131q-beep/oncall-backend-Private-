# OnCall — CI/CD & Release Engineering (P7-06)

## 1. CI/CD Architecture

Five workflows, separation of concerns:

| Workflow | Trigger | Purpose |
|---|---|---|
| `ci.yml` | PR + push (main/dev/staging) | npm audit, lint, format, syntax, unit tests, full integration suite (`run_tests.sh`), MCP build+tests. Fails on any error/warning. |
| `quality.yml` | PR + push (main) | Secret scanning (gitleaks, full history), dependency review (PR, fail on high), **Trivy filesystem scan** (fail Crit/High), **license validation** (fail on GPL/AGPL/LGPL/SSPL/CC-NC), SBOM artifacts (**CycloneDX + SPDX**), **Docker build verification** (image builds, boots, and reaches `healthy` — no push), coverage (lcov) + SonarQube with **blocking Quality Gate** (auto-skips with a warning until `SONAR_TOKEN` is configured). |
| `emergency-rollback.yml` | manual dispatch | One-click restore of last known-good (or named version) through the `production` approval gate; serialized with deploys. |
| `release-please.yml` | push to main | Automatic **semantic versioning** from conventional commits: maintains a release PR; merging it creates the semver tag + GitHub Release with generated **release notes**. |
| `docker-release.yml` | version tags | Build (amd64) → **Trivy gate (0 Critical/High)** → syft SBOM → multi-arch push (amd64+arm64) with **SLSA provenance + BuildKit SBOM attestations** → **cosign keyless sign by digest** → **signature verification gate** → release artifacts (deployment manifest, build metadata, SHA256SUMS) attached to the Release. |
| `deploy.yml` | manual dispatch | Production deploy through the **`production` GitHub Environment** (configure required reviewers there → human approval is mandatory). Verifies the image signature *again* before SSH-ing to the host and invoking `deploy-release.sh`. |

Secrets: GitHub Secrets only (`DEPLOY_HOST/USER/SSH_KEY/PATH`, optional `SONAR_TOKEN`/`SONAR_HOST_URL`). No secret ever appears in an image, artifact, or log.

## 2. Release Process

1. Merge work to `main` with conventional commit messages (`fix:`, `feat:`, `feat!:`).
2. release-please opens/updates the release PR (version bump + CHANGELOG).
3. Merging the release PR tags `vX.Y.Z` → `docker-release.yml` builds, scans, signs, publishes; artifacts land on the GitHub Release.
4. Deploy: Actions → *deploy* → run with version + strategy → approve in the `production` environment → progressive rollout with auto-rollback.

## 3. Versioning Policy

Semantic Versioning 2.0 automated by release-please: `fix:` → patch, `feat:` → minor, `!`/`BREAKING CHANGE:` → major. Images are tagged `vX.Y.Z` + `latest`; the deployed digest is pinned in `deployment-manifest.json`; `.last-good-release` on the host tracks the rollback target. API compatibility rule: no major bump may break the deployed Flutter app (backward compatibility is a platform invariant).

## 4. Deployment Guide

On the host, `deploy-release.sh <version> [strategy] [weight]`:

- **rolling** (default): swap → health-gate (120 s) → full platform verification (`deploy.sh verify`: HTTPS, health, **Socket.IO handshake**, Prometheus targets + alert rules, Grafana, network isolation, backup + restore validation) → **smoke tests** (health/test/socket.io/auth surface through the TLS edge) → **Prometheus gate** (zero firing critical alerts) → auto-rollback on any failure.
- **blue-green**: GREEN candidate boots from the new image against an isolated scratch DB and must reach `healthy` before BLUE is touched; then traffic swaps and full verification runs. *Limitation (documented): SQLite is single-writer, so this is candidate-validate-then-swap rather than parallel blue/green — true parallel arrives with the ADR-001 Postgres migration.*
- **canary**: canary container (new image, shared SQLite volume — WAL multi-process) joins the nginx upstream at N% (default 10) via the managed `nginx/upstream.conf`; bakes `CANARY_BAKE_SECONDS` (default 300) with continuous health-gating; then promotes to 100% or auto-rolls-back. *Limitation: in-memory stores (rate-limit, token-revocation cache) are per-process until the Redis migration; revocations during a canary window apply per-instance.*

Signature enforcement: with `COSIGN_CERT_IDENTITY` set, the script refuses images whose cosign keyless signature doesn't verify.

## 4b. Branch Strategy

Trunk-based: short-lived feature branches → PR → `main`. PRs require the full
`ci.yml` + `quality.yml` suites green. Releases cut exclusively from `main` via
release-please tags — no long-lived release branches (compose + immutable tagged
images make any released version redeployable at any time).

**Required GitHub repository settings** (cannot be set from files — configure once
in Settings): branch protection on `main` (require PRs, require status checks:
`CI Summary`, `Secret Scanning`, `Trivy Filesystem Scan`, `License Validation`,
`Docker Build Verification`; dismiss stale approvals; no force-push), **required
signed commits** on `main`, `production` environment with required reviewers,
GHCR **tag immutability** for release tags. Deploys additionally pin the image
**digest** in `deployment-manifest.json`, so even a mutated tag cannot silently
change what runs.

## 4c. Emergency Deployment Guide

Situation: production is broken and a fix (or a known-good version) must ship NOW.

1. **Fastest path — emergency rollback** (no build): Actions → *emergency-rollback*
   → enter reason (+ optional explicit version) → approve → the host restores the
   last known-good image and health-gates it. Serialized with normal deploys via
   the shared concurrency group. Typical duration: 2–3 min.
2. **Emergency fix-forward**: commit fix → merge release PR (or push tag
   `vX.Y.Z-hotfix.1`) → `docker-release.yml` still runs the full scan/sign gates
   (never bypass them — a hotfix that fails the Trivy/signature gates is not
   deployable, by design) → deploy with `rolling`.
3. **Host unreachable / GitHub down**: SSH directly, `./deploy-release.sh rollback`
   (or `<version> rolling`). Signature enforcement still applies via
   `COSIGN_CERT_IDENTITY`.
4. If the rollback target itself is unhealthy → DR runbook §6, then §2 if data
   is implicated.

## 5. Rollback Procedure

Automatic — any of: health check failure, container `unhealthy`, deployment timeout, verification failure → `deploy-release.sh` restores `.last-good-release`, health-gates it, removes any canary, and restores the single-server upstream.

Manual — `./deploy-release.sh rollback` at any time. If the rollback target itself fails health checks, escalate to the DR runbook §6 (failed deployment) — images are immutable and data lives in volumes, so restoring service = starting a known-good tag; data rollback (if a migration misfired) = runbook §2.

Rollback drill: rehearse by deploying a deliberately broken tag to observe the auto-rollback path (documented in §9 of the DR runbook's quarterly drill).
