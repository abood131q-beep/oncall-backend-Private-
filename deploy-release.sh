#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# OnCall — progressive deployment engine (P7-06)
#
#   ./deploy-release.sh <version> [rolling|blue-green|canary] [canary_weight%]
#   ./deploy-release.sh rollback              # manual rollback to last-good
#
# Strategies
#   rolling    : swap backend to new image, health-gate, verify, auto-rollback
#   blue-green : boot a GREEN candidate (isolated scratch DB) → full health
#                validation → only then swap traffic → verify → auto-rollback.
#                NOTE: true parallel blue/green awaits the Postgres migration
#                (SQLite is single-writer); this is candidate-validate-then-swap.
#   canary     : new-image canary container joins the nginx upstream at
#                <weight>% (default 10) sharing the SQLite volume (WAL
#                multi-process). Bake CANARY_BAKE_SECONDS (default 300),
#                health-gate throughout, then promote or auto-rollback.
#
# AUTO-ROLLBACK triggers on: health check failure, unhealthy container,
# deployment timeout (HEALTH_TIMEOUT), or verification failure.
# Last known-good version is tracked in .last-good-release.
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")"

COMPOSE="docker compose -f docker-compose.prod.yml -f docker-compose.monitoring.yml -f docker-compose.backup.yml"
IMAGE_REPO="${ONCALL_IMAGE:-oncall-backend}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
CANARY_BAKE="${CANARY_BAKE_SECONDS:-300}"
STATE_FILE=".last-good-release"
UPSTREAM=nginx/upstream.conf

log() { echo "[deploy][$(date -u +%H:%M:%SZ)] $*"; }

current_version() {
  docker inspect oncall-backend --format '{{.Config.Image}}' 2>/dev/null | sed 's/.*://' || echo ""
}

wait_healthy() { # $1=container $2=timeout_s
  local t=0
  while [ "$t" -lt "$2" ]; do
    s=$(docker inspect "$1" --format '{{.State.Health.Status}}' 2>/dev/null || echo missing)
    [ "$s" = "healthy" ] && return 0
    [ "$s" = "unhealthy" ] && { log "$1 is UNHEALTHY"; return 1; }
    sleep 5; t=$((t+5))
  done
  log "$1 health TIMEOUT after $2 s"; return 1
}

restore_upstream() {
  cat > "$UPSTREAM" <<'EOF'
# OnCall — backend upstream (P7-06)
# THIS FILE IS MANAGED BY deploy-release.sh — canary deployments rewrite it
# (weighted two-server form) and restore it on promote/rollback.
upstream oncall_backend {
    server oncall-backend:3000;
    keepalive 32;
    keepalive_timeout 60s;
}
EOF
  $COMPOSE exec -T nginx nginx -t && $COMPOSE exec -T nginx nginx -s reload || true
}

remove_canary() {
  docker rm -f oncall-backend-canary >/dev/null 2>&1 || true
  restore_upstream
}

smoke_tests() {
  log "smoke tests (through nginx TLS edge)"
  curl -fsSk https://localhost/health | grep -q '"status"' || { log "SMOKE FAIL: /health"; return 1; }
  curl -fsSk https://localhost/test | grep -q '"success":true' || { log "SMOKE FAIL: /test"; return 1; }
  # Socket.IO polling handshake must answer (Engine.IO open packet starts with '0{')
  curl -fsSk 'https://localhost/socket.io/?EIO=4&transport=polling' | grep -q '^0{' \
    || { log "SMOKE FAIL: socket.io handshake"; return 1; }
  # Auth surface responds (401/400 = alive and enforcing, which is correct)
  ac=$(curl -sk -o /dev/null -w '%{http_code}' https://localhost/auth/verify)
  case "$ac" in 400|401|403) ;; *) log "SMOKE FAIL: /auth/verify returned $ac"; return 1;; esac
  log "✔ smoke tests passed"
}

prometheus_gate() { # fail if any critical alert is firing or backend probe is down
  local api="http://127.0.0.1:9090/api/v1"
  local firing
  firing=$(curl -fsS "$api/query?query=ALERTS%7Bseverity%3D%22critical%22%2Calertstate%3D%22firing%22%7D" 2>/dev/null \
    | python3 -c "import json,sys;print(len(json.load(sys.stdin)['data']['result']))" 2>/dev/null || echo "unknown")
  if [ "$firing" = "unknown" ]; then log "WARN: Prometheus unreachable — gate skipped"; return 0; fi
  [ "$firing" = "0" ] || { log "PROMETHEUS GATE FAIL: $firing critical alert(s) firing"; return 1; }
  local up
  up=$(curl -fsS "$api/query?query=probe_success%7Bjob%3D%22backend-health%22%7D" 2>/dev/null \
    | python3 -c "import json,sys;r=json.load(sys.stdin)['data']['result'];print(r[0]['value'][1] if r else '')" 2>/dev/null || echo "")
  [ "$up" = "0" ] && { log "PROMETHEUS GATE FAIL: backend probe down"; return 1; }
  log "✔ prometheus gate clean (0 critical firing)"
}

verify_deployment() {
  log "running full platform verification (P7-02..P7-05 battery + smoke + prometheus)"
  ./deploy.sh verify && smoke_tests && prometheus_gate
}

rollback() {
  local prev; prev=$(cat "$STATE_FILE" 2>/dev/null || echo "")
  [ -n "$prev" ] || { log "FATAL: no last-good release recorded — manual intervention required"; exit 1; }
  log "⏪ ROLLING BACK to $prev"
  remove_canary
  ONCALL_VERSION="$prev" $COMPOSE up -d oncall-backend
  wait_healthy oncall-backend "$HEALTH_TIMEOUT" || { log "FATAL: rollback target unhealthy — see runbook §6"; exit 1; }
  log "✅ rollback to $prev complete and healthy"
}

deploy_target() { # $1=version — swap main service and verify, rollback on failure
  ONCALL_VERSION="$1" $COMPOSE up -d oncall-backend
  if ! wait_healthy oncall-backend "$HEALTH_TIMEOUT" || ! verify_deployment; then
    rollback; exit 1
  fi
}

main() {
  local VERSION="$1" STRATEGY="${2:-rolling}" WEIGHT="${3:-10}"
  local PREV; PREV=$(current_version)
  log "deploying $IMAGE_REPO:$VERSION (strategy=$STRATEGY, previous=$PREV)"

  docker pull "$IMAGE_REPO:$VERSION" 2>/dev/null || log "pull skipped (local image?)"
  # Signature verification (supply-chain gate) — set COSIGN_CERT_IDENTITY to enforce
  if command -v cosign >/dev/null && [ -n "${COSIGN_CERT_IDENTITY:-}" ]; then
    cosign verify "$IMAGE_REPO:$VERSION" \
      --certificate-identity-regexp "$COSIGN_CERT_IDENTITY" \
      --certificate-oidc-issuer https://token.actions.githubusercontent.com \
      || { log "FATAL: image signature verification FAILED"; exit 1; }
    log "✔ image signature verified"
  fi

  [ -n "$PREV" ] && echo "$PREV" > "$STATE_FILE"

  case "$STRATEGY" in
    rolling)
      deploy_target "$VERSION"
      ;;
    blue-green)
      log "starting GREEN candidate (isolated scratch DB — image bootability gate)"
      docker rm -f oncall-backend-green >/dev/null 2>&1 || true
      docker run -d --name oncall-backend-green \
        --network "$($COMPOSE ps -q oncall-backend | head -1 | xargs docker inspect --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' 2>/dev/null || echo oncall-backend_internal)" \
        --env-file .env.production --read-only --tmpfs /tmp --tmpfs /data \
        "$IMAGE_REPO:$VERSION" >/dev/null
      if ! wait_healthy oncall-backend-green "$HEALTH_TIMEOUT"; then
        docker rm -f oncall-backend-green >/dev/null 2>&1 || true
        log "GREEN candidate failed — BLUE untouched, aborting (no rollback needed)"; exit 1
      fi
      log "✔ GREEN validated — swapping traffic"
      docker rm -f oncall-backend-green >/dev/null
      deploy_target "$VERSION"
      ;;
    canary)
      log "starting canary at ${WEIGHT}% (shared SQLite volume, WAL multi-process)"
      docker rm -f oncall-backend-canary >/dev/null 2>&1 || true
      docker run -d --name oncall-backend-canary \
        --network oncall-backend_internal \
        --env-file .env.production --read-only --tmpfs /tmp \
        -v oncall-backend_backend-data:/data \
        -v oncall-backend_backend-logs:/app/logs \
        -v oncall-backend_backend-backups:/app/backups \
        "$IMAGE_REPO:$VERSION" >/dev/null
      wait_healthy oncall-backend-canary "$HEALTH_TIMEOUT" || { remove_canary; log "canary failed pre-traffic — aborted"; exit 1; }
      local MAIN_W=$((100-WEIGHT))
      cat > "$UPSTREAM" <<EOF
# CANARY IN PROGRESS — managed by deploy-release.sh
upstream oncall_backend {
    server oncall-backend:3000 weight=$MAIN_W;
    server oncall-backend-canary:3000 weight=$WEIGHT;
    keepalive 32;
    keepalive_timeout 60s;
}
EOF
      $COMPOSE exec -T nginx nginx -t && $COMPOSE exec -T nginx nginx -s reload
      log "canary receiving ${WEIGHT}% — baking for ${CANARY_BAKE}s"
      local t=0
      while [ "$t" -lt "$CANARY_BAKE" ]; do
        sleep 15; t=$((t+15))
        s=$(docker inspect oncall-backend-canary --format '{{.State.Health.Status}}' 2>/dev/null || echo missing)
        [ "$s" = "healthy" ] || { log "canary became $s during bake"; rollback; exit 1; }
        prometheus_gate || { log "critical alert during canary bake"; rollback; exit 1; }
        log "  bake ${t}/${CANARY_BAKE}s — canary healthy, prometheus clean"
      done
      log "✔ canary bake passed — promoting to 100%"
      remove_canary
      deploy_target "$VERSION"
      ;;
    *) echo "unknown strategy: $STRATEGY"; exit 2 ;;
  esac

  echo "$VERSION" > "$STATE_FILE"
  log "✅ $IMAGE_REPO:$VERSION deployed via $STRATEGY — recorded as last-good"
}

case "${1:-}" in
  "") echo "usage: deploy-release.sh <version> [rolling|blue-green|canary] [weight] | rollback"; exit 2 ;;
  rollback) rollback ;;
  *) main "$@" ;;
esac
