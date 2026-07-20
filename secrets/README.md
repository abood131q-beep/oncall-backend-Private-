# Production Secrets (P7-02)

File-based Docker secrets consumed by `docker-compose.prod.yml`.
Everything here except this README and `.gitignore` is **git-ignored** — never commit secret material.

Create before first `up`:

```bash
openssl rand -hex 24 > secrets/postgres_password.txt
openssl rand -hex 24 > secrets/redis_password.txt
chmod 600 secrets/*.txt
```

App-level secrets (JWT_SECRET, SMS_API_KEY, …) stay in `.env.production` (also git-ignored).

Kubernetes migration path: these map 1:1 to `Secret` objects mounted at
`/run/secrets/<name>` — the compose layout is intentionally identical.
