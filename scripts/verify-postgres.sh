#!/usr/bin/env bash
# verify-postgres.sh — one-command PostgreSQL verification gate (Phase 13).
#
# Provisions a THROWAWAY PostgreSQL (Docker), runs migrations, then executes the
# full cross-engine verification: SQLite-baseline vs PostgreSQL A/B + unit tests
# + architecture verifier. Tears the DB down at the end. Run this in ANY
# environment that has Docker + network (your Mac, CI). It is the real gate that
# this migration must pass before a production Go.
#
# Usage:  bash scripts/verify-postgres.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PGC=oncall_pg_verify
PG_URL="postgres://oncall:oncall@127.0.0.1:5433/oncall_test"
export JWT_SECRET="${JWT_SECRET:-verify-secret-0123456789abcdef0123456789abcdef}"

echo "▶ 1/6  Ensuring dependencies (pg is pure-JS, no native build)…"
node -e "require('pg')" 2>/dev/null || npm install pg --no-audit --no-fund

echo "▶ 2/6  Starting throwaway PostgreSQL (docker)…"
docker rm -f "$PGC" >/dev/null 2>&1 || true
docker run -d --name "$PGC" \
  -e POSTGRES_USER=oncall -e POSTGRES_PASSWORD=oncall -e POSTGRES_DB=oncall_test \
  -p 5433:5432 postgres:16-alpine >/dev/null
echo "   waiting for readiness (real server on the published TCP port)…"
# ROOT CAUSE of the earlier "Connection terminated unexpectedly" during migrations:
# postgres:*-alpine first boots a TEMPORARY bootstrap server (unix socket only, no TCP) to run
# initdb, then RESTARTS as the real server. `docker exec pg_isready` can report ready against that
# bootstrap server, so migrations connected in the window where the server restarts and dropped the
# connection. A HOST→TCP `SELECT 1` on the published port only succeeds against the REAL server (the
# bootstrap server never listens on the mapped port), so it cannot race the restart.
ready=0
for i in $(seq 1 90); do
  if PG_URL="$PG_URL" node -e "const{Client}=require('pg');const c=new Client({connectionString:process.env.PG_URL,connectionTimeoutMillis:2000});c.connect().then(()=>c.query('SELECT 1')).then(()=>c.end()).then(()=>process.exit(0)).catch(()=>process.exit(1));" 2>/dev/null; then
    ready=1; break
  fi
  sleep 1
done
if [ "$ready" != 1 ]; then
  echo "❌ PostgreSQL never accepted a TCP connection on $PG_URL after ~90s"
  docker logs "$PGC" 2>&1 | tail -20
  docker rm -f "$PGC" >/dev/null 2>&1 || true
  exit 1
fi

cleanup() { echo "▶ teardown: removing $PGC"; docker rm -f "$PGC" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "▶ 3/6  Applying PostgreSQL migrations…"
DB_ENGINE=postgres DATABASE_URL="$PG_URL" node scripts/migrate.js

echo "▶ 4/6  Architecture verifier…"
node architecture/compliance/verify-architecture.mjs | tail -2

echo "▶ 5/6  Unit tests…"
# Gate on node --test's EXIT CODE (reporter-agnostic). The previous `| grep "^# tests"` broke under
# `set -o pipefail` on Node 24, whose default reporter no longer emits TAP `# tests` lines, so grep
# matched nothing and failed the script even though every test passed. Running directly still fails
# the job on any real test failure (non-zero exit) — nothing is weakened.
node --test tests/unit/*.test.js

echo "▶ 6/6  Cross-engine A/B — SQLite baseline vs PostgreSQL…"
PG_URL="$PG_URL" node tests/integration/engine-ab.mjs

echo ""
echo "✅ PostgreSQL verification gate complete. Review the A/B result above:"
echo "   PASS only if it printed 'N/N byte-identical (SQLite ≡ PostgreSQL)'."
