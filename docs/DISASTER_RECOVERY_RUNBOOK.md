# OnCall — Disaster Recovery Runbook (P7-05)

**Objectives: RPO ≤ 15 minutes · RTO ≤ 60 minutes.**
How they're met: SQLite (the live production data) is snapshotted every 15 min
("frequent" tier); full sets (SQLite + PostgreSQL + Redis + configs) run daily/
weekly/monthly with retention 96/7/4/12 and automatic weekly restore validation.
All bundles are gpg-AES256 encrypted; checksummed outside and inside.

**Prerequisites for ANY recovery** (store OFF the server, e.g. password manager):
`secrets/backup_encryption_key.txt` · `secrets/*.txt` values · `.env.production`
values · TLS private key (or ability to reissue). Backups never contain secret
values — losing the encryption key means losing the backups.

---

## 1. Complete server loss
Expected downtime: **≤ 60 min** (assuming off-site archive copy, runbook §8).

1. Provision new Docker host (Linux, docker + compose). ~10 min
2. `git clone` the repo (or `restore.sh configs` from the newest bundle to
   recover compose/nginx/monitoring config). ~5 min
3. Re-provision secrets + `.env.production` from the off-server store. ~5 min
4. `./deploy.sh` — brings up the full hardened stack (self-signed certs
   auto-generate; replace with real certs per §4). ~10 min
5. Copy the off-site archive onto the host, mount into the backup container
   volume (`dr-archive`), then:
   `docker compose ... stop oncall-backend`
   `docker compose ... exec backup sh -c 'RESTORE_CONFIRM=yes restore.sh sqlite <newest bundle>'`
   `docker compose ... start oncall-backend` ~10 min
6. Verify: `./deploy.sh verify` + spot-check admin stats. ~10 min

## 2. Database corruption (SQLite — production data)
Symptoms: `/health` shows `database:error`; sqlite errors in backend logs.

1. `docker compose ... stop oncall-backend`  (stops writes)
2. Inspect: `docker compose ... exec backup sqlite3 /data/oncall.db 'PRAGMA integrity_check;'`
3. `docker compose ... exec backup restore.sh list` — pick newest bundle
   (frequent tier = at most 15 min old).
4. `docker compose ... exec -e RESTORE_CONFIRM=yes backup restore.sh sqlite <bundle>`
   (the tool snapshots the corrupt DB to /archive/pre-restore first — nothing is lost)
5. `docker compose ... start oncall-backend` → verify `/health`.
Expected downtime: **≤ 15 min**. Data loss: ≤ 15 min (RPO).

## 3. PostgreSQL corruption (forward-provisioned service)
1. `docker compose ... exec backup restore.sh postgres <bundle>` (uses
   `--clean --if-exists`; restores into the `oncall` DB).
2. If the cluster itself is corrupt: `docker compose ... stop postgresql`,
   `docker volume rm <project>_postgres-data`, `up -d postgresql`, then restore.
Expected downtime: ≤ 15 min (no app impact today — backend does not use PG yet).

## 4. Redis corruption / loss
Follow `restore.sh redis <bundle>` — it verifies and stages the RDB, then prints
the stop → copy-into-volume → start sequence (RDB must be in place before redis
boots). Expected downtime: ≤ 10 min (no app impact today).

## 5. Certificate replacement (expired/compromised)
1. Place new `fullchain.pem` + `privkey.pem` in `certs/` (Let's Encrypt,
   wildcard, or `deploy.sh`-generated self-signed for emergencies).
2. `docker compose ... exec nginx nginx -s reload` (zero downtime).
3. Verify: `curl -sIk https://<host>/health` + Grafana "TLS days left" panel.
If compromised: also revoke the old cert with the CA and rotate any secrets
that may have transited during the exposure window.

## 6. Failed deployment (bad image/config)
1. Images are tagged + signed (P7-01 pipeline): redeploy the previous tag —
   `docker compose ... up -d` with the prior image version.
2. Config regression: `restore.sh configs <bundle> /tmp/known-good` and diff.
3. DB is decoupled from deploys (volume) — no restore needed unless a migration
   misfired; then follow §2.
Expected downtime: ≤ 10 min.

## 7. Accidental data deletion
Same as §2 (SQLite restore) — the frequent tier bounds loss to ≤ 15 min.
For surgical recovery (single user/trip), restore the bundle to a scratch file
(`restore-test.sh` leaves the method documented) and copy rows manually via
`sqlite3 ATTACH`.

## 8. Off-site replication (REQUIRED for real disaster survival)
The `dr-archive` volume lives on the same host — sufficient for corruption/
deletion/failed-deploy, NOT for disk/server loss. Sync it off-host (bundles are
already encrypted, safe for untrusted storage):
`docker run --rm -v <project>_dr-archive:/archive:ro -v ~/.ssh:/root/.ssh:ro \
  instrumentisto/rsync-ssh rsync -az /archive/ user@offsite:/oncall-dr/`
Add as a host cron (hourly). S3-compatible alternative: rclone with the same mount.

## 9. Verification cadence
- Automatic: weekly `restore-test.sh` (Sunday 05:00 UTC) — checksums, decrypt,
  SQLite integrity, PG scratch-restore, RDB check, config extraction. The backup
  container goes **unhealthy** if backups stop (30-min freshness healthcheck).
- Manual: quarterly full DR drill of §1 on a scratch host. Record actual RTO.
