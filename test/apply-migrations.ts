import { applyD1Migrations, env } from 'cloudflare:test';

// `applyD1Migrations()` only applies migrations that haven't already been
// applied (tracked in a `d1_migrations` table), so it's safe and cheap to
// call this before every test file — including 0003_import_logs.sql.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
