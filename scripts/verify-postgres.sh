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
echo "   waiting for readiness…"
for i in $(seq 1 60); do
  if docker exec "$PGC" pg_isready -U oncall -d oncall_test >/dev/null 2>&1; then break; fi
  sleep 1
done

cleanup() { echo "▶ teardown: removing $PGC"; docker rm -f "$PGC" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "▶ 3/6  Applying PostgreSQL migrations…"
DB_ENGINE=postgres DATABASE_URL="$PG_URL" node scripts/migrate.js

echo "▶ 4/6  Architecture verifier…"
node architecture/compliance/verify-architecture.mjs | tail -2

echo "▶ 5/6  Unit tests…"
node --test tests/unit/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)"

echo "▶ 6/6  Cross-engine A/B — SQLite baseline vs PostgreSQL…"
PG_URL="$PG_URL" node tests/integration/engine-ab.mjs

echo ""
echo "✅ PostgreSQL verification gate complete. Review the A/B result above:"
echo "   PASS only if it printed 'N/N byte-identical (SQLite ≡ PostgreSQL)'."
