import type { D1Migration } from '@cloudflare/vitest-pool-workers/config';
import type { Env as WorkerEnv } from '../src/types';

declare module 'cloudflare:test' {
  // ProvidedEnv controls the type of `import("cloudflare:test").env`
  interface ProvidedEnv extends WorkerEnv {
    // Set in vitest.config.ts, used by test/apply-migrations.ts
    TEST_MIGRATIONS: D1Migration[];
  }
}
