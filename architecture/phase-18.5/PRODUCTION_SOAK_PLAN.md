# Phase 18.5 — Configuration Authoritative Production Soak Plan

**Purpose:** define the production soak that must pass **before** `CONFIG_AUTHORITATIVE=1` is
enabled globally in production. This is a *plan* — it is not simulated here. It gates the final
operational flip authorized by ADR-048.

## Scope

Soak the authoritative Configuration read path (`CONFIG_AUTHORITATIVE=1`) against the legacy path
(`=0`) in a production or production-mirror environment, proving zero drift and zero regression
over a sustained window before global enablement.

## Confidence Threshold

- **Parity:** `verify:shadow` Configuration parity and coverage remain **100%** (0 mismatches, 0
  verification failures) for the entire window. The Configuration shadow (`SHADOW_CONFIG=1`) runs
  alongside so the kernel snapshot is continuously compared to `env.js`.
- **Confidence level:** G1.0 §10 "High" — ≥ the standard's minimum sample/coverage over the window
  with no downgrade event.
- **Window:** ≥ 7 consecutive days (or the org's standard soak window, whichever is longer) on a
  canary/subset first, then fleet-wide observation before global flip.

## Drift Threshold

- **Zero tolerance.** Any single observed divergence between `config.get(key)` under ON vs the
  `env.js` value for the same key is a **drift event** → immediate rollback and investigation.
- Drift is detected by (a) the live Configuration shadow parity metric, and (b) a periodic
  `config.diagnostics()` scrape comparing `mode`, `version`, and key count against expectation.

## Rollback Trigger

Roll back (`CONFIG_AUTHORITATIVE=0`, restart) immediately on ANY of:
- Configuration shadow parity < 100% or any mismatch logged.
- Any config-derived behavior change (CORS rejection, auth/JWT anomaly, payment/OTP gating change,
  Firebase/FCM init change) correlated with the flag.
- Startup regression beyond the ADR-048 budget (>1% of baseline boot) attributable to the flag.
- `config.diagnostics().mode !== 'authoritative'` on a host expected to be ON (silent fallback =
  investigate), or `authoritative.ready === false`.
- Any unhandled exception traced to the config subsystem.

Rollback is lossless (no kernel-owned persistent state) and flag-only.

## Monitoring Metrics

| Metric | Source | Alert |
|---|---|---|
| `config_shadow_parity_pct` | Configuration shadow metrics | < 100% |
| `config_shadow_mismatches_total` | shadow metrics | > 0 |
| `config_mode` (legacy/authoritative) | `config.diagnostics()` scrape | unexpected `legacy` on an ON host |
| `config_authoritative_ready` | `config.diagnostics().authoritative.ready` | false |
| `config_snapshot_version` | diagnostics | unexpected change |
| process startup time | orchestrator | > baseline + 1% |
| process restarts / exit-code 1 | orchestrator | any spike after flip |
| 5xx rate, auth failure rate | app metrics | any rise correlated with flip |

## Procedure

1. Ship with `CONFIG_AUTHORITATIVE=0` (no behavior change) + `SHADOW_CONFIG=1` (continuous parity).
2. Enable `CONFIG_AUTHORITATIVE=1` on a **single canary** host; verify `mode=authoritative`,
   `ready=true`, parity 100%, no error/startup delta for ≥ 24h.
3. Expand to a subset, then the fleet, holding the confidence window at each step.
4. On a clean window with zero drift, declare the soak passed and record it in
   `architecture/phase-18.5/PROMOTION_HISTORY.md`.
5. Keep the shadow (`SHADOW_CONFIG=1`) running post-flip as an ongoing guardrail.

## Exit Criteria (all required)

- Zero drift events across the full window.
- Parity/coverage 100% throughout.
- No flag-correlated startup, memory, error, or behavior regression.
- CI `ab-compat` (config-authoritative) green on the shipped revision.
- Standard Owner sign-off (G1.0 §13) recorded in the promotion history.
