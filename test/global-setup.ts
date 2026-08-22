// Runs once before the whole e2e suite: apply pending migrations to soms_test so
// its schema is current. Idempotent — safe to run repeatedly.
import 'dotenv/config';
import {
  ensureDatabase,
  recreateDatabaseFromTemplate,
  resetAndMigrateDatabase,
} from './database.js';
import { E2E_MAX_WORKERS } from './e2e-config.js';

function toTestDatabase(url: string): string {
  return url.replace(/^(.*\/)[^/?]*(\?.*)?$/, '$1soms_test$2');
}

export default async function globalSetup(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL missing — copy .env.example to .env and configure it.',
    );
  }
  const testUrl = toTestDatabase(process.env.DATABASE_URL);
  await ensureDatabase(process.env.DATABASE_URL, 'soms_test');
  await resetAndMigrateDatabase(testUrl);

  // Clone the fully migrated, empty template before workers start. PostgreSQL
  // database cloning is both faster and more deterministic than launching a
  // migration process from every spec while the suite is under load.
  await Promise.all(
    Array.from({ length: E2E_MAX_WORKERS }, async (_, index) => {
      const poolId = index + 1;
      for (const database of [
        `soms_test_fork${poolId}`,
        `soms_test_fork${poolId}_a`,
        `soms_test_fork${poolId}_b`,
      ]) {
        await recreateDatabaseFromTemplate(
          process.env.DATABASE_URL!,
          database,
          'soms_test',
        );
      }
    }),
  );

  // Federation specs fork compiled Node processes. Build their entry once,
  // before Vitest starts its worker pool, so a stale build cannot make every
  // worker launch its own concurrent TypeScript compilation.
  const { ensureCompiledEntry } = await import('./federation-harness.js');
  ensureCompiledEntry();
}
