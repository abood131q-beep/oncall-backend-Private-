# Versioned Database Migrations (Phase 12: C1)

Ordered, forward-only SQL migrations applied by `src/infrastructure/db/migrator.js`.
Each file is `NNNN_description.sql`; applied files are recorded in `schema_migrations`
so each runs exactly once, in order, reproducibly across environments.

- **Engine-neutral by convention:** keep DDL to the intersection of SQLite/Postgres
  where possible; engine-specific files may be suffixed `.pg.sql` / `.sqlite.sql`.
- **Forward-only:** never edit an applied migration — add a new one.
- **Baseline:** the current live schema is created by `database.js` / `src/config/migrate.js`
  (the legacy path, still the default under `DB_ENGINE=sqlite`). `0001_baseline.sql`
  documents that schema as the Postgres starting point; it is applied only under
  `DB_ENGINE=postgres` where the imperative bootstrap does not run.

Run: `node scripts/migrate.js` (uses the configured `DB_ENGINE`).
