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
  // PostgreSQL requires the source database to have no competing sessions while CREATE DATABASE
  // copies it as a template. Parallel clone attempts therefore race with one another and can fail
  // with 55006 (or wait indefinitely behind a concurrent copy). Build the worker databases in a
  // deterministic sequence; Vitest still runs the completed databases in parallel afterwards.
  for (let index = 0; index < E2E_MAX_WORKERS; index++) {
    const poolId = index + 1;
    for (const database of [
      `soms_test_fork${poolId}`,
      `soms_test_fork${poolId}_a`,
      `soms_test_fork${poolId}_b`,
    ]) {
      await recreateDatabaseFromTemplate(
        process.env.DATABASE_URL,
        database,
        'soms_test',
      );
    }
  }

  // Federation specs fork compiled Node processes. Build their entry once,
  // before Vitest starts its worker pool, so a stale build cannot make every
  // worker launch its own concurrent TypeScript compilation.
  const { ensureCompiledEntry } = await import('./federation-harness.js');
  ensureCompiledEntry();
}
