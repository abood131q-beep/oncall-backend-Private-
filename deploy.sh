#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# OnCall — one-command production bootstrap (P7-02)
#
#   ./deploy.sh          # bootstrap (secrets + env) → validate → up → verify
#   ./deploy.sh verify   # verification only (stack already running)
#
# Idempotent. Never overwrites existing secrets or .env.production.
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")"

COMPOSE="docker compose -f docker-compose.prod.yml -f docker-compose.monitoring.yml -f docker-compose.backup.yml"

bootstrap() {
  # ── Infra secrets (auto-generated, git-ignored) ────────────────────────────
  mkdir -p secrets
  for s in postgres_password redis_password grafana_admin_password backup_encryption_key; do
    if [ ! -s "secrets/$s.txt" ]; then
      openssl rand -hex 24 > "secrets/$s.txt"
      chmod 600 "secrets/$s.txt"
      echo "✔ generated secrets/$s.txt"
    fi
  done

  # ── App env (JWT auto-generated; SMS creds cannot be invented) ─────────────
  if [ ! -f .env.production ]; then
    cat > .env.production <<EOF
NODE_ENV=production
PORT=3000
JWT_SECRET=$(openssl rand -hex 32)
REQUIRE_OTP=true
# ↓ REQUIRED by the app's P6-04 production guards — fill these in:
SMS_PROVIDER=unifonic
SMS_API_KEY=
ADMIN_PHONES=
# Optional: ALLOWED_ORIGINS, SOCKET_CORS_ORIGIN, GOOGLE_MAPS_API_KEY,
#           FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_PROJECT_ID, LOG_LEVEL
EOF
    chmod 600 .env.production
    echo "✔ created .env.production (JWT_SECRET generated)"
  fi

  # ── TLS certs (P7-03): self-signed for dev if none present ────────────────
  # Production: replace with Let's Encrypt / wildcard certs at the same paths.
  mkdir -p certs
  if [ ! -s certs/fullchain.pem ] || [ ! -s certs/privkey.pem ]; then
    openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
      -keyout certs/privkey.pem -out certs/fullchain.pem \
      -subj "/CN=oncall.local" \
      -addext "subjectAltName=DNS:oncall.local,DNS:localhost,IP:127.0.0.1" 2>/dev/null
    chmod 600 certs/privkey.pem
    echo "✔ generated self-signed TLS cert (certs/) — replace for production"
  fi

  if ! grep -qE '^SMS_API_KEY=.+' .env.production; then
    echo "✖ SMS_API_KEY is empty in .env.production."
    echo "  The backend's P6-04 production guard will refuse to start without it."
    echo "  Edit .env.production, then re-run ./deploy.sh"
    exit 1
  fi
}

verify() {
  echo "── docker compose ps ──"
  $COMPOSE ps
  echo "── waiting for health (max 90s) ──"
  for _ in $(seq 1 45); do
    unhealthy=$($COMPOSE ps --format '{{.Name}} {{.Health}}' 2>/dev/null | grep -cv healthy || true)
    [ "$unhealthy" -eq 0 ] && break
    sleep 2
  done
  $COMPOSE ps --format 'table {{.Name}}\t{{.Status}}'
  echo "── HTTPS API through nginx (P7-03) ──"
  curl -fsSk https://localhost/health && echo && echo "✔ backend reachable via HTTPS"
  echo "── HTTP → HTTPS redirect ──"
  code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost/health)
  [ "$code" = "301" ] && echo "✔ HTTP redirects (301)" || { echo "✖ expected 301, got $code"; exit 1; }
  echo "── security headers ──"
  hdrs=$(curl -fsSkI https://localhost/health)
  for h in "strict-transport-security" "x-frame-options" "x-content-type-options" \
           "referrer-policy" "permissions-policy" "content-security-policy"; do
    echo "$hdrs" | grep -qi "^$h:" && echo "✔ $h" || { echo "✖ missing $h"; exit 1; }
  done
  echo "── TLS protocol check ──"
  curl -fsSk --tlsv1.2 --tls-max 1.2 https://localhost/health >/dev/null && echo "✔ TLS1.2 fallback"
  curl -fsSk --tlsv1.3 https://localhost/health >/dev/null && echo "✔ TLS1.3"
  echo "── rate limit trigger (auth zone: expect 429 within 45 attempts) ──"
  got429=0
  for _ in $(seq 1 45); do
    c=$(curl -sk -o /dev/null -w '%{http_code}' -X POST https://localhost/login \
        -H 'Content-Type: application/json' -d '{}')
    [ "$c" = "429" ] && { got429=1; break; }
  done
  [ "$got429" = "1" ] && echo "✔ rate limit triggers (429)" || { echo "✖ no 429 seen"; exit 1; }
  echo "── invalid method rejected ──"
  c=$(curl -sk -o /dev/null -w '%{http_code}' -X TRACE https://localhost/health)
  [ "$c" = "405" ] && echo "✔ TRACE → 405" || { echo "✖ TRACE got $c"; exit 1; }
  echo "── Socket.IO handshake through edge ──"
  curl -fsSk 'https://localhost/socket.io/?EIO=4&transport=polling' | grep -q '^0{' \
    && echo "✔ socket.io polling handshake OK" || { echo "✖ socket.io handshake failed"; exit 1; }

  echo "── observability (P7-04) ──"
  # Prometheus healthy + all targets up
  curl -fsS http://127.0.0.1:9090/-/healthy >/dev/null && echo "✔ prometheus healthy"
  down=$(curl -fsS 'http://127.0.0.1:9090/api/v1/targets' \
    | python3 -c "import json,sys;d=json.load(sys.stdin);ts=d['data']['activeTargets'];print('\n'.join(f\"{t['labels']['job']} {t['health']}\" for t in ts if t['health']!='up'))")
  [ -z "$down" ] && echo "✔ all scrape targets up" || { echo "✖ targets down:"; echo "$down"; exit 1; }
  # Alert rules loaded
  nrules=$(curl -fsS 'http://127.0.0.1:9090/api/v1/rules' \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print(sum(len(g['rules']) for g in d['data']['groups']))")
  [ "$nrules" -ge 8 ] && echo "✔ $nrules alert rules loaded" || { echo "✖ only $nrules rules"; exit 1; }
  # Grafana up + auth enforced (anonymous must be rejected)
  curl -fsS http://127.0.0.1:3001/api/health >/dev/null && echo "✔ grafana healthy"
  ac=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/dashboards/uid/oncall-health)
  [ "$ac" = "401" ] || [ "$ac" = "403" ] && echo "✔ grafana requires auth" || { echo "✖ grafana anon access: $ac"; exit 1; }
  # Metrics must NOT be public (only loopback-bound UIs + exporters internal)
  for p in 9090 3001; do
    if [ -n "$(hostname -I 2>/dev/null)" ]; then
      ip=$(hostname -I | awk '{print $1}')
      nc -z -w 2 "$ip" "$p" 2>/dev/null && { echo "✖ SECURITY: $p bound beyond loopback"; exit 1; } || echo "✔ $p loopback-only"
    fi
  done
  for p in 9100 9113 9121 9187 9115 8081; do
    nc -z -w 2 localhost "$p" 2>/dev/null && { echo "✖ SECURITY: exporter port $p on host"; exit 1; } || echo "✔ exporter $p internal-only"
  done
  echo "── network isolation (must all FAIL to connect) ──"
  for p in 3000 5432 6379; do
    if curl -m 2 -s "http://localhost:$p" >/dev/null 2>&1 || nc -z -w 2 localhost "$p" 2>/dev/null; then
      echo "✖ SECURITY: port $p is reachable from host"; exit 1
    else
      echo "✔ port $p not reachable from host"
    fi
  done
  echo "── restart policies ──"
  docker inspect --format '{{.Name}} {{.HostConfig.RestartPolicy.Name}}' \
    oncall-backend oncall-postgres oncall-redis oncall-nginx
  echo "── log rotation ──"
  docker inspect --format '{{.Name}} {{.HostConfig.LogConfig.Type}} {{.HostConfig.LogConfig.Config}}' \
    oncall-backend oncall-postgres oncall-redis oncall-nginx
  echo "── backup & DR (P7-05) ──"
  # run a real backup now, then prove it restores
  $COMPOSE exec -T backup backup.sh daily && echo "✔ backup runs"
  $COMPOSE exec -T backup restore-test.sh && echo "✔ restore validation passes"
  $COMPOSE ps backup --format '{{.Status}}' | grep -qi healthy && echo "✔ backup agent healthy" || echo "… backup agent health pending (30m window)"

  echo
  echo "✅ verification complete"
}

case "${1:-up}" in
  verify) verify ;;
  up)
    bootstrap
    $COMPOSE config -q && echo "✔ compose config valid"
    $COMPOSE up -d
    verify
    ;;
  *) echo "usage: ./deploy.sh [verify]"; exit 2 ;;
esac
