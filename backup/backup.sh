#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# OnCall — backup agent (P7-05)
#
#   backup.sh frequent   # SQLite only (tier-0 live data) — every 15 min, RPO≤15m
#   backup.sh daily      # full set: sqlite + postgres + redis + configs
#   backup.sh weekly     # full set → weekly retention tier
#   backup.sh monthly    # full set → monthly retention tier
#
# Every artifact: verified → sha256 manifest → gpg AES256 encrypted bundle.
# Retention: frequent 96 (24h) · daily 7 · weekly 4 · monthly 12.
# Components degrade independently: an unreachable postgres/redis marks the
# component SKIPPED (logged) but never silently — sqlite failure is always fatal.
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail

TIER="${1:?usage: backup.sh frequent|daily|weekly|monthly}"
TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
ARCHIVE="${ARCHIVE_ROOT:-/archive}/$TIER"
WORK="$(mktemp -d "${WORK_ROOT:-/work}"/bk.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$ARCHIVE"

SQLITE_DB="${SQLITE_DB:-/data/oncall.db}"
PG_HOST="${PG_HOST:-postgresql}"  PG_USER="${PG_USER:-oncall}"  PG_DB="${PG_DB:-oncall}"
REDIS_HOST="${REDIS_HOST:-redis}"
ENC_KEY_FILE="${ENC_KEY_FILE:-/run/secrets/backup_encryption_key}"
RETAIN_frequent=96 RETAIN_daily=7 RETAIN_weekly=4 RETAIN_monthly=12

log() { echo "[backup][$TIER][$(date -u +%H:%M:%SZ)] $*"; }
fail() { log "FATAL: $*"; exit 1; }

# ── 1. SQLite — the live production data (always; fatal on error) ────────────
[ -f "$SQLITE_DB" ] || fail "SQLite DB not found at $SQLITE_DB"
sqlite3 "$SQLITE_DB" ".backup '$WORK/oncall.db'" || fail "sqlite .backup failed"
ic=$(sqlite3 "$WORK/oncall.db" 'PRAGMA integrity_check;')
[ "$ic" = "ok" ] || fail "sqlite integrity_check: $ic"
gzip -9 "$WORK/oncall.db"
log "sqlite: OK (integrity_check=ok)"

if [ "$TIER" != "frequent" ]; then
  # ── 2. PostgreSQL — pg_dump custom format, compressed, verified ────────────
  if PGPASSWORD="$(cat /run/secrets/postgres_password)" \
     pg_dump -h "$PG_HOST" -U "$PG_USER" -d "$PG_DB" -Fc -Z 6 \
       -f "$WORK/postgres.dump" 2>>"$WORK/pg.err"; then
    pg_restore --list "$WORK/postgres.dump" >/dev/null || fail "pg_dump verification failed"
    log "postgres: OK ($(pg_restore --list "$WORK/postgres.dump" | wc -l) TOC entries)"
  else
    log "postgres: SKIPPED ($(tail -1 "$WORK/pg.err" 2>/dev/null || echo unreachable))"
  fi

  # ── 3. Redis — remote RDB snapshot, integrity-checked ──────────────────────
  if redis-cli -h "$REDIS_HOST" --pass "$(cat /run/secrets/redis_password)" \
       --no-auth-warning --rdb "$WORK/redis.rdb" >/dev/null 2>>"$WORK/redis.err"; then
    redis-check-rdb "$WORK/redis.rdb" >/dev/null || fail "redis RDB integrity failed"
    log "redis: OK (rdb verified)"
  else
    log "redis: SKIPPED ($(tail -1 "$WORK/redis.err" 2>/dev/null || echo unreachable))"
  fi

  # ── 4. Configuration — compose/nginx/monitoring/env templates ──────────────
  # Secrets METADATA only (names + checksums), never values.
  if [ -d /config ]; then
    (cd /config && find secrets -type f -name '*.txt' -exec sh -c \
       'echo "$(sha256sum "$1" | cut -d" " -f1)  $1"' _ {} \; 2>/dev/null) \
       > "$WORK/secrets-metadata.txt" || true
    tar czf "$WORK/configs.tar.gz" -C /config \
      --exclude='secrets/*.txt' --exclude='.env*' --exclude='certs/privkey.pem' \
      $(cd /config && ls -d docker-compose*.yml nginx monitoring .env.example deploy.sh 2>/dev/null) \
      || fail "config archive failed"
    tar tzf "$WORK/configs.tar.gz" >/dev/null || fail "config archive corrupt"
    log "configs: OK ($(tar tzf "$WORK/configs.tar.gz" | wc -l) files)"
  fi

  # App-level backups made by backend (backup.js) — capture the latest one too
  latest_app=$(ls -1t /app-backups/oncall_*.db 2>/dev/null | head -1 || true)
  [ -n "$latest_app" ] && cp "$latest_app" "$WORK/app-level-backup.db" && log "app-level backup captured: $(basename "$latest_app")"
fi

# ── 5. Checksums + encrypted bundle ──────────────────────────────────────────
(cd "$WORK" && sha256sum -- * > MANIFEST.sha256)
BUNDLE="$ARCHIVE/oncall-$TIER-$TS.tar.gz.gpg"
tar czf - -C "$WORK" . \
  | gpg --batch --yes --symmetric --cipher-algo AES256 \
        --passphrase-file "$ENC_KEY_FILE" -o "$BUNDLE" \
  || fail "encryption failed"
sha256sum "$BUNDLE" > "$BUNDLE.sha256"
log "bundle: $(basename "$BUNDLE") ($(du -h "$BUNDLE" | cut -f1))"

# ── 6. Retention cleanup (count-based per tier) ──────────────────────────────
keep_var="RETAIN_$TIER"; keep="${!keep_var}"
ls -1t "$ARCHIVE"/oncall-"$TIER"-*.tar.gz.gpg 2>/dev/null | tail -n +$((keep+1)) | while read -r old; do
  rm -f "$old" "$old.sha256"
  log "retention: pruned $(basename "$old")"
done

touch /tmp/last-backup-ok
log "COMPLETE"
