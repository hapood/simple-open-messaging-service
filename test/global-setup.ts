// Runs once before the whole e2e suite: migrate a uniquely named template and
// clone isolated databases for every worker and federation node.
import 'dotenv/config';
import {
  dropDatabase,
  ensureDatabase,
  recreateDatabaseFromTemplate,
  resetAndMigrateDatabase,
} from './database.js';
import { E2E_MAX_WORKERS } from './e2e-config.js';
import {
  e2eTemplateDatabaseName,
  e2eWorkerDatabaseName,
} from './e2e-database-names.js';

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL missing — copy .env.example to .env and configure it.',
    );
  }
  const baseUrl = process.env.DATABASE_URL;
  const templateDatabase = e2eTemplateDatabaseName();
  const testUrl = await ensureDatabase(baseUrl, templateDatabase);
  await resetAndMigrateDatabase(testUrl);

  // Clone the fully migrated, empty template before workers start. PostgreSQL
  // database cloning is both faster and more deterministic than launching a
  // migration process from every spec while the suite is under load.
  // PostgreSQL requires the source database to have no competing sessions while CREATE DATABASE
  // copies it as a template. Parallel clone attempts therefore race with one another and can fail
  // with 55006 (or wait indefinitely behind a concurrent copy). Build the worker databases in a
  // deterministic sequence; Vitest still runs the completed databases in parallel afterwards.
  const runDatabases = [templateDatabase];
  for (let index = 0; index < E2E_MAX_WORKERS; index++) {
    const poolId = index + 1;
    for (const database of [
      e2eWorkerDatabaseName(String(poolId)),
      e2eWorkerDatabaseName(String(poolId), 'a'),
      e2eWorkerDatabaseName(String(poolId), 'b'),
      e2eWorkerDatabaseName(String(poolId), 'c'),
    ]) {
      runDatabases.push(database);
      await recreateDatabaseFromTemplate(baseUrl, database, templateDatabase);
    }
  }

  // Federation specs fork compiled Node processes. Build their entry once,
  // before Vitest starts its worker pool, so a stale build cannot make every
  // worker launch its own concurrent TypeScript compilation.
  const { ensureCompiledEntry } = await import('./federation-harness.js');
  ensureCompiledEntry();

  return async () => {
    if (process.env.SOMS_E2E_KEEP_DATABASES === '1') return;
    for (const database of runDatabases.reverse()) {
      await dropDatabase(baseUrl, database);
    }
  };
}
