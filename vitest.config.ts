import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrationsPath = path.join(__dirname, 'migrations');
      const migrations = await readD1Migrations(migrationsPath);

      return {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            // Used by test/apply-migrations.ts to seed the isolated test DB.
            TEST_MIGRATIONS: migrations,
            // Secrets aren't read from wrangler.jsonc (see README §4) — supply
            // fixed values here so admin/turnstile-gated routes are testable
            // without real credentials.
            ADMIN_API_KEY: 'test-admin-key',
            TURNSTILE_SECRET_KEY: 'test-turnstile-key',
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
  },
});
