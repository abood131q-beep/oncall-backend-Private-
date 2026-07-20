#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# OnCall — DR restore tool (P7-05). See docs/DISASTER_RECOVERY_RUNBOOK.md.
#
#   restore.sh list                        # show available bundles
#   restore.sh sqlite   <bundle>           # restore live SQLite DB (STOPS backend first!)
#   restore.sh postgres <bundle>           # pg_restore into the oncall DB
#   restore.sh redis    <bundle>           # print RDB restore steps (requires redis restart)
#   restore.sh configs  <bundle> <destdir> # extract config archive
#
# SAFETY: sqlite restore refuses to run unless RESTORE_CONFIRM=yes is set,
# and always snapshots the current live DB to /archive/pre-restore/ first.
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail
CMD="${1:-list}"
ENC_KEY_FILE="${ENC_KEY_FILE:-/run/secrets/backup_encryption_key}"
SQLITE_DB="${SQLITE_DB:-/data/oncall.db}"
log() { echo "[restore][$(date -u +%H:%M:%SZ)] $*"; }

unpack() { # $1 bundle → echoes workdir
  local w; w="$(mktemp -d "${WORK_ROOT:-/work}"/rs.XXXXXX)"
  (cd "$(dirname "$1")" && sha256sum -c "$(basename "$1").sha256" >/dev/null) || { log "checksum FAILED"; exit 1; }
  gpg --batch --quiet --decrypt --passphrase-file "$ENC_KEY_FILE" "$1" | tar xzf - -C "$w"
  (cd "$w" && sha256sum -c MANIFEST.sha256 >/dev/null) || { log "manifest FAILED"; exit 1; }
  echo "$w"
}

case "$CMD" in
  list)
    find "${ARCHIVE_ROOT:-/archive}" -name '*.tar.gz.gpg' -printf '%TY-%Tm-%Td %TH:%TM  %s bytes  %p\n' 2>/dev/null | sort -r | head -40
    ;;
  sqlite)
    BUNDLE="${2:?bundle path required}"
    [ "${RESTORE_CONFIRM:-}" = "yes" ] || { log "refusing: set RESTORE_CONFIRM=yes (and STOP the backend container first)"; exit 2; }
    W=$(unpack "$BUNDLE")
    gunzip -k "$W/oncall.db.gz"
    [ "$(sqlite3 "$W/oncall.db" 'PRAGMA integrity_check;')" = "ok" ] || { log "backup integrity FAILED"; exit 1; }
    mkdir -p "${ARCHIVE_ROOT:-/archive}"/pre-restore
    if [ -f "$SQLITE_DB" ]; then
      sqlite3 "$SQLITE_DB" ".backup '"${ARCHIVE_ROOT:-/archive}"/pre-restore/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).db'" \
        || cp "$SQLITE_DB" ""${ARCHIVE_ROOT:-/archive}"/pre-restore/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).db"
    fi
    rm -f "$SQLITE_DB-wal" "$SQLITE_DB-shm"
    cp "$W/oncall.db" "$SQLITE_DB"
    log "SQLite restored from $(basename "$BUNDLE") — start the backend and verify /health"
    ;;
  postgres)
    BUNDLE="${2:?bundle path required}"
    W=$(unpack "$BUNDLE")
    [ -f "$W/postgres.dump" ] || { log "bundle has no postgres.dump"; exit 1; }
    export PGPASSWORD="$(cat /run/secrets/postgres_password)"
    pg_restore -h "${PG_HOST:-postgresql}" -U "${PG_USER:-oncall}" -d "${PG_DB:-oncall}" \
      --clean --if-exists --no-owner "$W/postgres.dump"
    log "PostgreSQL restored from $(basename "$BUNDLE")"
    ;;
  redis)
    BUNDLE="${2:?bundle path required}"
    W=$(unpack "$BUNDLE")
    [ -f "$W/redis.rdb" ] || { log "bundle has no redis.rdb"; exit 1; }
    redis-check-rdb "$W/redis.rdb" >/dev/null
    cp "$W/redis.rdb" "${ARCHIVE_ROOT:-/archive}"/pre-restore/redis-restore-candidate.rdb
    cat <<'STEPS'
Redis RDB verified and staged at /archive/pre-restore/redis-restore-candidate.rdb
Manual completion (RDB must be in place BEFORE redis starts):
  1. docker compose -f docker-compose.prod.yml stop redis
  2. docker run --rm -v oncall-backend_redis-data:/rd -v oncall-backend_dr-archive:/archive alpine \
       sh -c 'cp /archive/pre-restore/redis-restore-candidate.rdb /rd/dump.rdb'
  3. docker compose -f docker-compose.prod.yml start redis
STEPS
    ;;
  configs)
    BUNDLE="${2:?bundle path required}"; DEST="${3:?dest dir required}"
    W=$(unpack "$BUNDLE")
    mkdir -p "$DEST" && tar xzf "$W/configs.tar.gz" -C "$DEST"
    [ -f "$W/secrets-metadata.txt" ] && cp "$W/secrets-metadata.txt" "$DEST/"
    log "configs extracted to $DEST (secrets must be re-provisioned — values are never backed up)"
    ;;
  *) echo "usage: restore.sh list|sqlite|postgres|redis|configs ..."; exit 2 ;;
esac
