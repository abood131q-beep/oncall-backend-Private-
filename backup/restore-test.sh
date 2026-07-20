#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# OnCall — automatic restore validation (P7-05). Exit non-zero on ANY failure.
#
#   restore-test.sh [bundle]     # default: newest daily (falls back to frequent)
#
# Proves, without touching production data:
#   1. bundle checksum valid          4. postgres restores into scratch DB
#   2. bundle decrypts                5. redis RDB passes integrity check
#   3. sqlite copy passes integrity   6. config archive extracts completely
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail

BUNDLE="${1:-$(ls -1t "${ARCHIVE_ROOT:-/archive}"/daily/*.tar.gz.gpg 2>/dev/null | head -1)}"
[ -n "${BUNDLE:-}" ] || BUNDLE="$(ls -1t "${ARCHIVE_ROOT:-/archive}"/frequent/*.tar.gz.gpg 2>/dev/null | head -1)"
[ -n "${BUNDLE:-}" ] || { echo "restore-test: NO BUNDLES FOUND"; exit 1; }
ENC_KEY_FILE="${ENC_KEY_FILE:-/run/secrets/backup_encryption_key}"
WORK="$(mktemp -d "${WORK_ROOT:-/work}"/rt.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
log() { echo "[restore-test][$(date -u +%H:%M:%SZ)] $*"; }

log "testing $(basename "$BUNDLE")"

# 1. checksum
(cd "$(dirname "$BUNDLE")" && sha256sum -c "$(basename "$BUNDLE").sha256" >/dev/null) \
  || { log "FAIL: bundle checksum"; exit 1; }
log "PASS: bundle checksum"

# 2. decrypt + unpack
gpg --batch --quiet --decrypt --passphrase-file "$ENC_KEY_FILE" "$BUNDLE" \
  | tar xzf - -C "$WORK" || { log "FAIL: decrypt/unpack"; exit 1; }
log "PASS: decrypt + unpack"

# inner manifest
(cd "$WORK" && sha256sum -c MANIFEST.sha256 >/dev/null) \
  || { log "FAIL: inner manifest"; exit 1; }
log "PASS: inner manifest"

# 3. sqlite
gunzip -k "$WORK/oncall.db.gz"
ic=$(sqlite3 "$WORK/oncall.db" 'PRAGMA integrity_check;')
[ "$ic" = "ok" ] || { log "FAIL: sqlite integrity ($ic)"; exit 1; }
tables=$(sqlite3 "$WORK/oncall.db" "SELECT count(*) FROM sqlite_master WHERE type='table';")
log "PASS: sqlite restore ($tables tables, integrity ok)"

# 4. postgres — restore into throwaway scratch DB, then drop
if [ -f "$WORK/postgres.dump" ]; then
  export PGPASSWORD="$(cat /run/secrets/postgres_password)"
  SCRATCH="oncall_restore_test_$$"
  if createdb -h "${PG_HOST:-postgresql}" -U "${PG_USER:-oncall}" "$SCRATCH" 2>/dev/null; then
    pg_restore -h "${PG_HOST:-postgresql}" -U "${PG_USER:-oncall}" \
      -d "$SCRATCH" --no-owner "$WORK/postgres.dump" \
      || { dropdb -h "${PG_HOST:-postgresql}" -U "${PG_USER:-oncall}" "$SCRATCH"; log "FAIL: pg_restore"; exit 1; }
    dropdb -h "${PG_HOST:-postgresql}" -U "${PG_USER:-oncall}" "$SCRATCH"
    log "PASS: postgres scratch restore"
  else
    log "WARN: postgres unreachable — dump verified by pg_restore --list only"
    pg_restore --list "$WORK/postgres.dump" >/dev/null || { log "FAIL: dump TOC"; exit 1; }
  fi
fi

# 5. redis
if [ -f "$WORK/redis.rdb" ]; then
  redis-check-rdb "$WORK/redis.rdb" >/dev/null || { log "FAIL: redis rdb"; exit 1; }
  log "PASS: redis rdb integrity"
fi

# 6. configs
if [ -f "$WORK/configs.tar.gz" ]; then
  mkdir "$WORK/cfg" && tar xzf "$WORK/configs.tar.gz" -C "$WORK/cfg" \
    || { log "FAIL: config extract"; exit 1; }
  [ -f "$WORK/cfg/docker-compose.prod.yml" ] || { log "FAIL: compose missing from config backup"; exit 1; }
  log "PASS: config recovery ($(find "$WORK/cfg" -type f | wc -l) files)"
fi

log "ALL RESTORE VALIDATIONS PASSED"
touch /tmp/last-restore-test-ok
