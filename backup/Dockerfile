# OnCall — backup & DR agent (P7-05)
# Small alpine image with every client needed: sqlite (tier-0 data), pg_dump,
# redis-cli/redis-check-rdb, gpg (encryption), bash, coreutils. Runs crond.
FROM alpine:3.21

RUN apk add --no-cache bash sqlite postgresql17-client redis gnupg coreutils tzdata \
    && addgroup -S backup && adduser -S -G backup backup \
    && mkdir -p /archive /work && chown -R backup:backup /archive /work

COPY --chmod=0755 backup.sh restore.sh restore-test.sh entrypoint.sh /usr/local/bin/
COPY crontab /etc/crontabs/backup

# crond must run as root to read /etc/crontabs; jobs drop to `backup` user
ENTRYPOINT ["entrypoint.sh"]

HEALTHCHECK --interval=5m --timeout=10s --start-period=30s \
    CMD ["sh", "-c", "test -f /tmp/last-backup-ok && find /tmp/last-backup-ok -mmin -30 | grep -q ."]
