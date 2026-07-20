#!/bin/sh
# OnCall backup agent entrypoint — run one backup immediately, then crond.
set -e
echo "[backup-agent] starting — running initial daily backup"
backup.sh daily || echo "[backup-agent] WARNING: initial backup failed (will retry on schedule)"
echo "[backup-agent] crond starting (frequent 15m / daily / weekly / monthly + weekly restore-test)"
exec crond -f -l 2
